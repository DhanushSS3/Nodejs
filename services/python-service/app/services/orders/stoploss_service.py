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
from app.services.orders.id_generator import generate_stop_loss_id
from app.services.orders.order_registry import add_lifecycle_id
from app.services.orders.sl_tp_repository import remove_order_triggers, upsert_order_triggers, remove_stoploss_trigger
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


class StopLossService:
    async def add_stoploss(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        missing = [k for k in ("order_id", "user_id", "user_type", "symbol", "order_type", "stop_loss") if k not in payload]
        if missing:
            return {"ok": False, "reason": "missing_fields", "fields": missing}

        order_id = str(payload["order_id"])
        user_id = str(payload["user_id"])
        user_type = str(payload["user_type"]).lower()
        symbol = str(payload["symbol"]).upper()
        side = str(payload["order_type"]).upper()
        if side not in ("BUY", "SELL"):
            return {"ok": False, "reason": "invalid_order_type"}
        sl_raw = _safe_float(payload.get("stop_loss"))
        if sl_raw is None or sl_raw <= 0:
            return {"ok": False, "reason": "invalid_stop_loss"}

        # Check if stoploss already exists - user must cancel existing one first
        try:
            # Check order_data canonical
            order_data = await redis_cluster.hgetall(f"order_data:{order_id}")
            existing_sl = _safe_float(order_data.get("stop_loss"))
            if existing_sl is not None and existing_sl > 0:
                return {"ok": False, "reason": "stoploss_already_exists", "message": "Stoploss already exists for this order. Please cancel the existing stoploss before adding a new one."}
            
            # Check user_holdings
            hash_tag = f"{user_type}:{user_id}"
            order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
            holdings_data = await redis_cluster.hgetall(order_key)
            existing_sl_holdings = _safe_float(holdings_data.get("stop_loss"))
            if existing_sl_holdings is not None and existing_sl_holdings > 0:
                return {"ok": False, "reason": "stoploss_already_exists", "message": "Stoploss already exists for this order. Please cancel the existing stoploss before adding a new one."}
            
            # Check order_triggers
            triggers_data = await redis_cluster.hgetall(f"order_triggers:{order_id}")
            if triggers_data and (triggers_data.get("stop_loss") or triggers_data.get("stop_loss_compare") or triggers_data.get("stop_loss_user")):
                return {"ok": False, "reason": "stoploss_already_exists", "message": "Stoploss already exists for this order. Please cancel the existing stoploss before adding a new one."}
                
        except Exception as e:
            logger.warning("Failed to check existing stoploss for order %s: %s", order_id, e)
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
                score_sl = float(sl_raw + half_spread)  # compare against BID: trigger when bid <= score
            else:
                score_sl = float(sl_raw - half_spread)  # compare against ASK: trigger when ask >= score

            ok = await upsert_order_triggers(
                order_id=order_id,
                symbol=symbol,
                side=side,
                user_type=user_type,
                user_id=user_id,
                stop_loss=float(sl_raw),
                take_profit=None,
                score_stop_loss=score_sl,
                score_take_profit=None,
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
                    "stop_loss": str(sl_raw),
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
                    "stop_loss": str(sl_raw),
                }
                if account_number is not None:
                    holdings_mapping["account_number"] = account_number
                await redis_cluster.hset(order_key, mapping=holdings_mapping)
            except Exception:
                pass

            # Publish DB update intent
            try:
                db_msg = {
                    "type": "ORDER_STOPLOSS_SET",
                    "order_id": order_id,
                    "user_id": user_id,
                    "user_type": user_type,
                    "stop_loss": float(sl_raw),
                }
                await publish_db_update(db_msg)
            except Exception as e:
                logger.warning("Failed to publish DB update for stoploss set: %s", e)

            return {
                "ok": True,
                "flow": flow,
                "order_id": order_id,
                "symbol": symbol,
                "order_type": side,
                "stop_loss": float(sl_raw),
                "score_stop_loss": float(score_sl),
            }

        # Provider flow
        # Adjust before sending per requirements
        if side == "BUY":
            provider_sl = float(sl_raw + half_spread)
        else:
            provider_sl = float(sl_raw - half_spread)

        # Persist lifecycle id mapping if provided
        if payload.get("stoploss_id"):
            try:
                await add_lifecycle_id(order_id, str(payload.get("stoploss_id")), "stoploss_id")
            except Exception as e:
                logger.warning("add_lifecycle_id stoploss_id failed: %s", e)

        # Mark status=STOPLOSS in Redis for routing
        try:
            order_data_key = f"order_data:{order_id}"
            hash_tag = f"{user_type}:{user_id}"
            order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
            status_mapping = {"status": "STOPLOSS", "symbol": symbol, "order_type": side}
            holdings_status_mapping = {"status": "STOPLOSS"}
            if account_number is not None:
                status_mapping["account_number"] = account_number
                holdings_status_mapping["account_number"] = account_number
            pipe = redis_cluster.pipeline()
            pipe.hset(order_data_key, mapping=status_mapping)
            pipe.hset(order_key, mapping=holdings_status_mapping)
            await pipe.execute()
        except Exception:
            pass

        # Compose provider payload as requested
        order_status_in = str(payload.get("order_status") or "OPEN")
        qty = _safe_float(payload.get("order_quantity"))
        entry_price = _safe_float(payload.get("order_price"))
        # Try to fetch missing fields from Redis canonical
        if qty is None or entry_price is None:
            try:
                od = await redis_cluster.hgetall(f"order_data:{order_id}")
                if qty is None:
                    qty = _safe_float(od.get("order_quantity"))
                if entry_price is None:
                    entry_price = _safe_float(od.get("order_price"))
                cv_existing = _safe_float(od.get("contract_value")) if od else None
            except Exception:
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
            "status": "STOPLOSS",
            "order_type": side,
            "stoploss": provider_sl,
            "type": "order",
        }
        if contract_value is not None:
            provider_payload["contract_value"] = contract_value
        if qty is not None:
            provider_payload["order_quantity"] = qty
        if payload.get("stoploss_id"):
            provider_payload["stoploss_id"] = str(payload.get("stoploss_id"))
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
            "stop_loss_sent": provider_sl,
            "note": "Stoploss sent to provider; confirmation handled asynchronously",
        }

    async def cancel_stoploss(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        missing = [k for k in ("order_id", "user_id", "user_type", "symbol", "order_type", "stoploss_id") if k not in payload]
        if missing:
            return {"ok": False, "reason": "missing_fields", "fields": missing}

        order_id = str(payload["order_id"]).strip()
        user_id = str(payload["user_id"]).strip()
        user_type = str(payload["user_type"]).lower().strip()
        symbol = str(payload["symbol"]).upper().strip()
        side = str(payload["order_type"]).upper().strip()
        if side not in ("BUY", "SELL"):
            return {"ok": False, "reason": "invalid_order_type"}

        # Determine flow
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

        # Local flow: remove from local triggers and Redis canonical, publish DB cancel intent
        if flow == "local":
            try:
                await remove_stoploss_trigger(order_id)
            except Exception:
                pass
            try:
                # Remove from order_data and user_holdings
                order_data_key = f"order_data:{order_id}"
                hash_tag = f"{user_type}:{user_id}"
                order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
                pipe = redis_cluster.pipeline()
                pipe.hdel(order_data_key, "stop_loss")
                pipe.hdel(order_key, "stop_loss")
                # Ensure status remains OPEN for routing
                pipe.hset(order_data_key, mapping={"status": "OPEN", "symbol": symbol, "order_type": side})
                pipe.hset(order_key, mapping={"status": "OPEN"})
                await pipe.execute()
            except Exception:
                pass

            # Publish DB update intent (set stop_loss to NULL)
            try:
                import aio_pika  # type: ignore
                RABBITMQ_URL = __import__('os').getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
                ORDER_DB_UPDATE_QUEUE = __import__('os').getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")
                db_msg = {
                    "type": "ORDER_STOPLOSS_CANCEL",
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
                logger.warning("Failed to publish DB update for stoploss cancel: %s", e)

            return {
                "ok": True,
                "flow": flow,
                "order_id": order_id,
                "symbol": symbol,
                "order_type": side,
                "note": "Stoploss cancelled locally",
            }

        # Provider flow
        # Persist lifecycle id mapping if provided
        stoploss_cancel_id = str(payload.get("stoploss_cancel_id") or "").strip()
        if stoploss_cancel_id:
            try:
                await add_lifecycle_id(order_id, stoploss_cancel_id, "stoploss_cancel_id")
            except Exception as e:
                logger.warning("add_lifecycle_id stoploss_cancel_id failed: %s", e)

        # Compose provider cancel payload
        # NodeJS resolves stoploss_id from SQL/Redis; use it directly
        stoploss_id = str(payload.get("stoploss_id") or "").strip()
        provider_payload = {
            "order_id": order_id,
            "symbol": symbol,
            "order_type": side,
            "status": "STOPLOSS-CANCEL",
            "stoploss_id": stoploss_id,
            "stoploss_cancel_id": stoploss_cancel_id,
            "type": "order",
        }
        if account_number is not None:
            provider_payload["account_number"] = account_number
        if stoploss_cancel_id:
            provider_payload["stop_loss_cancel_id"] = stoploss_cancel_id

        # Send via persistent connection manager (same as other operations)
        from app.services.orders.service_provider_client import send_provider_order
        
        logger.info("Stoploss cancel sending via persistent connection for order_id=%s", order_id)
        ok, via = await send_provider_order(provider_payload)
        if not ok:
            return {"ok": False, "reason": f"provider_send_failed:{via}"}
        logger.info("Stoploss cancel sent via persistent connection (%s) for order_id=%s", via, order_id)

        # Mark routing status so dispatcher can route provider ACK correctly
        try:
            order_data_key = f"order_data:{order_id}"
            hash_tag = f"{user_type}:{user_id}"
            order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
            
            # Log before setting status
            logger.info("STOPLOSS-CANCEL setting Redis status for order_id=%s order_data_key=%s", order_id, order_data_key)
            
            status_mapping = {"status": "STOPLOSS-CANCEL", "symbol": symbol, "order_type": side, "stoploss_cancel_id": stoploss_cancel_id}
            holdings_status_mapping = {"status": "STOPLOSS-CANCEL"}
            if account_number is not None:
                status_mapping["account_number"] = account_number
                holdings_status_mapping["account_number"] = account_number
            pipe = redis_cluster.pipeline()
            pipe.hset(order_data_key, mapping=status_mapping)
            pipe.hset(order_key, mapping=holdings_status_mapping)
            result = await pipe.execute()
            
            logger.info("STOPLOSS-CANCEL status set in Redis for order_id=%s pipeline_result=%s", order_id, result)
            
            # Verify the status was actually set
            try:
                verification = await redis_cluster.hget(order_data_key, "status")
                logger.info("STOPLOSS-CANCEL status verification for order_id=%s current_status=%s", order_id, verification)
                if verification != "STOPLOSS-CANCEL":
                    logger.error("STOPLOSS-CANCEL status verification FAILED for order_id=%s expected=STOPLOSS-CANCEL actual=%s", order_id, verification)
            except Exception as verify_e:
                logger.error("STOPLOSS-CANCEL status verification error for order_id=%s: %s", order_id, verify_e)
                
        except Exception as e:
            logger.error("Failed to set STOPLOSS-CANCEL status in Redis for order_id=%s: %s", order_id, e)
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
            "note": "Stoploss cancel sent to provider; will be finalized on confirmation",
        }


async def _wait_for_provider_ack(any_id: str, expected_statuses=("CANCELLED",), timeout_ms: int = 6000) -> Optional[str]:
    import time, orjson  # local import to avoid circulars in some environments
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
