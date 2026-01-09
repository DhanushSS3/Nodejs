import asyncio
import logging
import time
from typing import Any, Dict, Optional

import orjson
from redis.exceptions import ResponseError

from app.config.redis_config import redis_cluster
from app.config.redis_logging import (
    log_connection_acquire, log_connection_release, log_connection_error,
    log_pipeline_operation, connection_tracker, generate_operation_id
)
from app.services.orders.order_repository import fetch_user_config, fetch_group_data
from app.services.orders.id_generator import generate_take_profit_id
from app.services.orders.order_registry import add_lifecycle_id
from app.services.orders.sl_tp_repository import remove_order_triggers, upsert_order_triggers, remove_takeprofit_trigger
from app.services.orders.service_provider_client import send_provider_order
from app.services.rabbitmq_client import publish_db_update

logger = logging.getLogger(__name__)


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


async def _compute_half_spread(symbol: str, group: str) -> float:
    try:
        g = await fetch_group_data(symbol, group)
        spread = _safe_float(g.get("spread"))
        spread_pip = _safe_float(g.get("spread_pip"))
        if spread is None or spread_pip is None:
            return 0.0
        return float(spread * spread_pip / 2.0)
    except Exception as e:
        logger.warning("half_spread compute failed for %s/%s: %s", group, symbol, e)
        return 0.0


class TakeProfitService:
    async def add_takeprofit(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        missing = [k for k in ("order_id", "user_id", "user_type", "symbol", "order_type", "take_profit") if k not in payload]
        if missing:
            return {"ok": False, "reason": "missing_fields", "fields": missing}

        order_id = str(payload["order_id"])
        user_id = str(payload["user_id"])
        user_type = str(payload["user_type"]).lower()
        symbol = str(payload["symbol"]).upper()
        side = str(payload["order_type"]).upper()
        if side not in ("BUY", "SELL"):
            return {"ok": False, "reason": "invalid_order_type"}
        tp_raw = _safe_float(payload.get("take_profit"))
        if tp_raw is None or tp_raw <= 0:
            return {"ok": False, "reason": "invalid_take_profit"}

        # Check if takeprofit already exists - user must cancel existing one first
        try:
            # Check order_data canonical
            order_data = await redis_cluster.hgetall(f"order_data:{order_id}")
            existing_tp = _safe_float(order_data.get("take_profit"))
            if existing_tp is not None and existing_tp > 0:
                return {"ok": False, "reason": "takeprofit_already_exists", "message": "Takeprofit already exists for this order. Please cancel the existing takeprofit before adding a new one."}
            
            # Check user_holdings
            hash_tag = f"{user_type}:{user_id}"
            order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
            holdings_data = await redis_cluster.hgetall(order_key)
            existing_tp_holdings = _safe_float(holdings_data.get("take_profit"))
            if existing_tp_holdings is not None and existing_tp_holdings > 0:
                return {"ok": False, "reason": "takeprofit_already_exists", "message": "Takeprofit already exists for this order. Please cancel the existing takeprofit before adding a new one."}
            
            # Check order_triggers
            triggers_data = await redis_cluster.hgetall(f"order_triggers:{order_id}")
            if triggers_data and (triggers_data.get("take_profit") or triggers_data.get("take_profit_compare") or triggers_data.get("take_profit_user")):
                return {"ok": False, "reason": "takeprofit_already_exists", "message": "Takeprofit already exists for this order. Please cancel the existing takeprofit before adding a new one."}
                
        except Exception as e:
            logger.warning("Failed to check existing takeprofit for order %s: %s", order_id, e)
            # Continue with the operation if check fails to avoid blocking valid requests

        # Determine flow
        cfg = await fetch_user_config(user_type, user_id)
        group = cfg.get("group") or "Standard"
        sending_orders = (cfg.get("sending_orders") or "").strip().lower()
        account_number = cfg.get("account_number")
        account_number = str(account_number) if account_number is not None else None
        if (user_type == "demo") or (user_type == "live" and sending_orders == "rock"):
            flow = "local"
        elif user_type == "live" and sending_orders == "barclays":
            flow = "provider"
        elif user_type in ["strategy_provider", "copy_follower"]:
            # Copy trading accounts respect sending_orders field like live accounts
            if sending_orders == "rock":
                flow = "local"
            elif sending_orders == "barclays":
                flow = "provider"
            else:
                # Default to provider flow for copy trading if sending_orders not set
                flow = "provider"
        else:
            return {"ok": False, "reason": "unsupported_flow", "details": {"user_type": user_type, "sending_orders": sending_orders}}

        half_spread = await _compute_half_spread(symbol, group)

        if flow == "local":
            # Adjust score for monitoring against market prices
            if side == "BUY":
                score_tp = float(tp_raw + half_spread)  # compare against BID
            else:
                score_tp = float(tp_raw - half_spread)  # compare against ASK

            ok = await upsert_order_triggers(
                order_id=order_id,
                symbol=symbol,
                side=side,
                user_type=user_type,
                user_id=user_id,
                stop_loss=None,
                take_profit=float(tp_raw),
                score_stop_loss=None,
                score_take_profit=score_tp,
            )
            if not ok:
                return {"ok": False, "reason": "upsert_triggers_failed"}

            # Persist for DB update backfill
            try:
                local_mapping = {
                    "symbol": symbol,
                    "order_type": side,
                    "user_type": user_type,
                    "user_id": user_id,
                    "take_profit": str(tp_raw),
                }
                if account_number is not None:
                    local_mapping["account_number"] = account_number
                await redis_cluster.hset(f"order_data:{order_id}", mapping=local_mapping)
            except Exception:
                pass

            # Also update user_holdings for immediate WS snapshot visibility
            try:
                hash_tag = f"{user_type}:{user_id}"
                order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
                holdings_mapping = {
                    "take_profit": str(tp_raw),
                }
                if account_number is not None:
                    holdings_mapping["account_number"] = account_number
                await redis_cluster.hset(order_key, mapping=holdings_mapping)
            except Exception:
                pass

            # Publish DB update intent
            try:
                db_msg = {
                    "type": "ORDER_TAKEPROFIT_SET",
                    "order_id": order_id,
                    "user_id": user_id,
                    "user_type": user_type,
                    "take_profit": float(tp_raw),
                }
                await publish_db_update(db_msg)
            except Exception as e:
                logger.warning("Failed to publish DB update for takeprofit set: %s", e)

            return {
                "ok": True,
                "flow": flow,
                "order_id": order_id,
                "symbol": symbol,
                "order_type": side,
                "take_profit": float(tp_raw),
                "score_take_profit": float(score_tp),
            }

        # Provider flow
        # Adjust before sending per requirements
        if side == "BUY":
            provider_tp = float(tp_raw + half_spread)
        else:
            provider_tp = float(tp_raw - half_spread)

        # Persist lifecycle id mapping if provided
        if payload.get("takeprofit_id"):
            try:
                await add_lifecycle_id(order_id, str(payload.get("takeprofit_id")), "takeprofit_id")
            except Exception as e:
                logger.warning("add_lifecycle_id takeprofit_id failed: %s", e)

        # Mark status=TAKEPROFIT in Redis for routing with proper connection management
        try:
            order_data_key = f"order_data:{order_id}"
            hash_tag = f"{user_type}:{user_id}"
            order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
            
            operation_id = generate_operation_id()
            connection_tracker.start_operation(operation_id, "cluster", f"takeprofit_status_{order_id}")
            log_connection_acquire("cluster", f"takeprofit_status_{order_id}", operation_id)
            
            status_mapping = {"status": "TAKEPROFIT", "symbol": symbol, "order_type": side}
            holdings_status_mapping = {"status": "TAKEPROFIT"}
            if account_number is not None:
                status_mapping["account_number"] = account_number
                holdings_status_mapping["account_number"] = account_number
            
            try:
                async with redis_cluster.pipeline() as pipe:
                    pipe.hset(order_data_key, mapping=status_mapping)
                    pipe.hset(order_key, mapping=holdings_status_mapping)
                    await pipe.execute()
                
                log_pipeline_operation("cluster", f"takeprofit_status_{order_id}", 2, operation_id)
                log_connection_release("cluster", f"takeprofit_status_{order_id}", operation_id)
                connection_tracker.end_operation(operation_id, success=True)
            except Exception as e:
                log_connection_error("cluster", f"takeprofit_status_{order_id}", str(e), operation_id)
                connection_tracker.end_operation(operation_id, success=False, error=str(e))
                raise
        except Exception:
            pass

        # Compose provider payload as requested
        order_status_in = str(payload.get("order_status") or "OPEN")
        qty = _safe_float(payload.get("order_quantity"))
        entry_price = _safe_float(payload.get("order_price"))
        # Try to fetch missing fields from Redis canonical with connection tracking
        if qty is None or entry_price is None:
            fetch_operation_id = generate_operation_id()
            connection_tracker.start_operation(fetch_operation_id, "cluster", f"fetch_order_data_{order_id}")
            log_connection_acquire("cluster", f"fetch_order_data_{order_id}", fetch_operation_id)
            
            try:
                od = await redis_cluster.hgetall(f"order_data:{order_id}")
                log_connection_release("cluster", f"fetch_order_data_{order_id}", fetch_operation_id)
                connection_tracker.end_operation(fetch_operation_id, success=True)
                
                if qty is None:
                    qty = _safe_float(od.get("order_quantity"))
                if entry_price is None:
                    entry_price = _safe_float(od.get("order_price"))
                cv_existing = _safe_float(od.get("contract_value")) if od else None
            except Exception as e:
                log_connection_error("cluster", f"fetch_order_data_{order_id}", str(e), fetch_operation_id)
                connection_tracker.end_operation(fetch_operation_id, success=False, error=str(e))
                cv_existing = None
        else:
            cv_existing = None

        # Compute contract_value if missing
        try:
            if cv_existing is not None:
                contract_value = float(cv_existing)
            else:
                gdata = await fetch_group_data(symbol, group)
                contract_size = _safe_float(gdata.get("contract_size")) or 1.0
                if qty is not None and entry_price is not None:
                    contract_value = float(contract_size * qty * entry_price)
                else:
                    contract_value = None
        except Exception:
            contract_value = None

        provider_payload = {
            "order_id": order_id,
            "symbol": symbol,
            "order_status": order_status_in,
            "status": "TAKEPROFIT",
            "order_type": side,
            "takeprofit": provider_tp,
            "type": "order",
        }
        if contract_value is not None:
            provider_payload["contract_value"] = contract_value
        if qty is not None:
            provider_payload["order_quantity"] = qty
        # Optional passthroughs
        if payload.get("takeprofit_id"):
            provider_payload["takeprofit_id"] = str(payload.get("takeprofit_id"))
        if account_number is not None:
            provider_payload["account_number"] = account_number

        ok, via = await send_provider_order(provider_payload)
        if not ok:
            return {"ok": False, "reason": f"provider_send_failed:{via}"}

        return {
            "ok": True,
            "flow": flow,
            "order_id": order_id,
            "symbol": symbol,
            "order_type": side,
            "take_profit_sent": provider_tp,
            "note": "Takeprofit sent to provider; confirmation handled asynchronously",
        }

    async def cancel_takeprofit(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        missing = [k for k in ("order_id", "user_id", "user_type", "symbol", "order_type", "takeprofit_id") if k not in payload]
        if missing:
            return {"ok": False, "reason": "missing_fields", "fields": missing}

        order_id = str(payload["order_id"]).strip()
        user_id = str(payload["user_id"]).strip()
        user_type = str(payload["user_type"]).lower().strip()
        symbol = str(payload["symbol"]).upper().strip()
        side = str(payload["order_type"]).upper().strip()
        if side not in ("BUY", "SELL"):
            return {"ok": False, "reason": "invalid_order_type"}

        cfg = await fetch_user_config(user_type, user_id)
        group = cfg.get("group") or "Standard"
        sending_orders = (cfg.get("sending_orders") or "").strip().lower()
        if (user_type == "demo") or (user_type == "live" and sending_orders == "rock"):
            flow = "local"
        elif user_type == "live" and sending_orders == "barclays":
            flow = "provider"
        elif user_type in ["strategy_provider", "copy_follower"]:
            # Copy trading accounts respect sending_orders field like live accounts
            if sending_orders == "rock":
                flow = "local"
            elif sending_orders == "barclays":
                flow = "provider"
            else:
                # Default to provider flow for copy trading if sending_orders not set
                flow = "provider"
        else:
            return {"ok": False, "reason": "unsupported_flow", "details": {"user_type": user_type, "sending_orders": sending_orders}}

        if flow == "local":
            try:
                await remove_takeprofit_trigger(order_id)
            except Exception:
                pass
            try:
                order_data_key = f"order_data:{order_id}"
                hash_tag = f"{user_type}:{user_id}"
                order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
                
                cancel_operation_id = generate_operation_id()
                connection_tracker.start_operation(cancel_operation_id, "cluster", f"takeprofit_cancel_{order_id}")
                log_connection_acquire("cluster", f"takeprofit_cancel_{order_id}", cancel_operation_id)
                
                try:
                    async with redis_cluster.pipeline() as pipe:
                        pipe.hdel(order_data_key, "take_profit")
                        pipe.hdel(order_key, "take_profit")
                        pipe.hset(order_data_key, mapping={"status": "OPEN", "symbol": symbol, "order_type": side})
                        pipe.hset(order_key, mapping={"status": "OPEN"})
                        await pipe.execute()
                    
                    log_pipeline_operation("cluster", f"takeprofit_cancel_{order_id}", 4, cancel_operation_id)
                    log_connection_release("cluster", f"takeprofit_cancel_{order_id}", cancel_operation_id)
                    connection_tracker.end_operation(cancel_operation_id, success=True)
                except Exception as e:
                    log_connection_error("cluster", f"takeprofit_cancel_{order_id}", str(e), cancel_operation_id)
                    connection_tracker.end_operation(cancel_operation_id, success=False, error=str(e))
                    raise
            except Exception:
                pass

            try:
                import aio_pika  # type: ignore
                RABBITMQ_URL = __import__('os').getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
                ORDER_DB_UPDATE_QUEUE = __import__('os').getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")
                db_msg = {
                    "type": "ORDER_TAKEPROFIT_CANCEL",
                    "order_id": order_id,
                    "user_id": user_id,
                    "user_type": user_type,
                }
                conn = await aio_pika.connect_robust(RABBITMQ_URL)
                try:
                    ch = await conn.channel()
                    await ch.declare_queue(ORDER_DB_UPDATE_QUEUE, durable=True)
                    msg = aio_pika.Message(body=__import__('orjson').dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await ch.default_exchange.publish(msg, routing_key=ORDER_DB_UPDATE_QUEUE)
                finally:
                    try:
                        await conn.close()
                    except Exception:
                        pass
            except Exception as e:
                logger.warning("Failed to publish DB update for takeprofit cancel: %s", e)

            return {
                "ok": True,
                "flow": flow,
                "order_id": order_id,
                "symbol": symbol,
                "order_type": side,
                "note": "Takeprofit cancelled locally",
            }

        takeprofit_cancel_id = str(payload.get("takeprofit_cancel_id") or "").strip()
        if takeprofit_cancel_id:
            try:
                await add_lifecycle_id(order_id, takeprofit_cancel_id, "takeprofit_cancel_id")
            except Exception as e:
                logger.warning("add_lifecycle_id takeprofit_cancel_id failed: %s", e)

        # NodeJS resolves takeprofit_id from SQL/Redis; use it directly to avoid NameError
        takeprofit_id = str(payload.get("takeprofit_id") or "").strip()
        provider_payload = {
            "order_id": order_id,
            "symbol": symbol,
            "order_type": side,
            "takeprofit_id": takeprofit_id,
            "takeprofit_cancel_id": takeprofit_cancel_id,
            "status": "TAKEPROFIT-CANCEL",
            "type": "order",
        }
        if account_number is not None:
            provider_payload["account_number"] = account_number
        if takeprofit_cancel_id:
            provider_payload["take_profit_cancel_id"] = takeprofit_cancel_id

        # Send via persistent connection manager (same as other operations)
        from app.services.orders.service_provider_client import send_provider_order
        
        logger.info("Takeprofit cancel sending via persistent connection for order_id=%s", order_id)
        ok, via = await send_provider_order(provider_payload)
        if not ok:
            return {"ok": False, "reason": f"provider_send_failed:{via}"}
        logger.info("Takeprofit cancel sent via persistent connection (%s) for order_id=%s", via, order_id)

        # Mark routing status so dispatcher can route provider ACK correctly
        try:
            order_data_key = f"order_data:{order_id}"
            hash_tag = f"{user_type}:{user_id}"
            order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
            
            # Log before setting status
            logger.info("TAKEPROFIT-CANCEL setting Redis status for order_id=%s order_data_key=%s", order_id, order_data_key)
            
            status_mapping = {"status": "TAKEPROFIT-CANCEL", "symbol": symbol, "order_type": side, "takeprofit_cancel_id": takeprofit_cancel_id}
            holdings_status_mapping = {"status": "TAKEPROFIT-CANCEL"}
            if account_number is not None:
                status_mapping["account_number"] = account_number
                holdings_status_mapping["account_number"] = account_number
            pipe = redis_cluster.pipeline()
            pipe.hset(order_data_key, mapping=status_mapping)
            pipe.hset(order_key, mapping=holdings_status_mapping)
            result = await pipe.execute()
            
            logger.info("TAKEPROFIT-CANCEL status set in Redis for order_id=%s pipeline_result=%s", order_id, result)
            
            # Verify the status was actually set
            try:
                verification = await redis_cluster.hget(order_data_key, "status")
                logger.info("TAKEPROFIT-CANCEL status verification for order_id=%s current_status=%s", order_id, verification)
                if verification != "TAKEPROFIT-CANCEL":
                    logger.error("TAKEPROFIT-CANCEL status verification FAILED for order_id=%s expected=TAKEPROFIT-CANCEL actual=%s", order_id, verification)
            except Exception as verify_e:
                logger.error("TAKEPROFIT-CANCEL status verification error for order_id=%s: %s", order_id, verify_e)
                
        except Exception as e:
            logger.error("Failed to set TAKEPROFIT-CANCEL status in Redis for order_id=%s: %s", order_id, e)
            # This is critical - if we can't set the status, the cancel worker won't know how to handle the response
            return {"ok": False, "reason": "redis_status_update_failed", "error": str(e)}

        # Fire-and-forget: do not wait for provider ACK; finalization handled by dispatcher/worker
        return {
            "ok": True,
            "flow": flow,
            "order_id": order_id,
            "symbol": symbol,
            "order_type": side,
            "provider_cancel_sent": True,
            "note": "Takeprofit cancel sent to provider; will be finalized on confirmation",
        }


async def _wait_for_provider_ack(any_id: str, expected_statuses=("CANCELLED",), timeout_ms: int = 6000) -> Optional[str]:
    import time, orjson
    deadline = time.time() + (timeout_ms / 1000.0)
    key = f"provider:ack:{any_id}"
    expect = {str(s).upper() for s in (expected_statuses or [])}
    while time.time() < deadline:
        try:
            raw = await redis_cluster.get(key)
            if raw:
                try:
                    data = orjson.loads(raw)
                except Exception:
                    data = None
                ord_status = str((data or {}).get("ord_status") or "").upper()
                if ord_status in expect:
                    return ord_status
        except Exception:
            pass
        try:
            import asyncio
            await asyncio.sleep(0.1)
        except Exception:
            time.sleep(0.1)
    return None
