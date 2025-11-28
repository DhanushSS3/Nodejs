import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import orjson
from redis.exceptions import ResponseError

from app.config.redis_config import redis_cluster
from app.config.redis_logging import (
    log_connection_acquire, log_connection_release, log_connection_error,
    log_pipeline_operation, connection_tracker, generate_operation_id
)
from app.services.orders.order_repository import fetch_user_config, fetch_user_portfolio
from app.services.orders.sl_tp_repository import remove_order_triggers
from app.services.orders.order_repository import (
    fetch_group_data,
    fetch_user_orders,
)
from app.services.portfolio.user_margin_service import compute_user_total_margin
from app.services.orders.commission_calculator import compute_exit_commission
from app.services.portfolio.conversion_utils import convert_to_usd
from app.services.orders.service_provider_client import send_provider_order
from app.services.orders.order_registry import add_lifecycle_id
from app.services.groups.group_config_helper import get_group_config_with_fallback
from app.services.logging.provider_logger import get_provider_errors_logger
from app.services.rabbitmq_client import publish_db_update

logger = logging.getLogger(__name__)
error_logger = get_provider_errors_logger()

# User-level locks to prevent race conditions during order operations
_user_locks = {}
_locks_lock = asyncio.Lock()


async def _save_close_id_to_database(order_id: str, close_id: str, user_type: str, user_id: str) -> bool:
    """
    Save close_id to database immediately when generated for manual closes.
    This ensures close_id is persisted BEFORE sending to provider.
    
    Returns:
        bool: True if successfully saved, False otherwise
    """
    try:
        # Create DB update message
        db_msg = {
            "type": "ORDER_CLOSE_ID_UPDATE",
            "order_id": str(order_id),
            "user_id": str(user_id),
            "user_type": str(user_type),
            "close_id": str(close_id),
        }
        
        await publish_db_update(db_msg)

        logger.info(
            "[CLOSE:CLOSE_ID_SAVED] order_id=%s close_id=%s user=%s:%s",
            order_id, close_id, user_type, user_id
        )
        return True
        
    except Exception as e:
        logger.error(
            "[CLOSE:CLOSE_ID_SAVE_FAILED] order_id=%s close_id=%s user=%s:%s error=%s",
            order_id, close_id, user_type, user_id, str(e)
        )
        return False


def build_close_confirmation_payload(
    *,
    order_id: str,
    user_id: str,
    user_type: str,
    symbol: Optional[str],
    order_type: Optional[str],
    result: Dict[str, Any],
    close_message: str,
    flow: str,
    close_origin: str,
    extra_fields: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    payload = {
        "type": "ORDER_CLOSE_CONFIRMED",
        "order_id": str(order_id),
        "user_id": str(user_id),
        "user_type": str(user_type),
        "order_status": "CLOSED",
        "close_price": result.get("close_price"),
        "net_profit": result.get("net_profit"),
        "commission": result.get("total_commission"),
        "commission_entry": result.get("commission_entry"),
        "commission_exit": result.get("commission_exit"),
        "profit_usd": result.get("profit_usd"),
        "swap": result.get("swap"),
        "used_margin_executed": result.get("used_margin_executed"),
        "used_margin_all": result.get("used_margin_all"),
        "symbol": symbol,
        "order_type": order_type,
        "close_message": close_message,
        "flow": flow,
        "close_origin": close_origin,
    }
    if extra_fields:
        payload.update(extra_fields)
    return payload


async def publish_close_confirmation(
    message: Dict[str, Any],
    channel=None,
    exchange=None,
) -> None:
    """Publish ORDER_CLOSE_CONFIRMED message (shared by local/provide flows)."""
    try:
        if channel is not None and exchange is not None:
            amqp_message = aio_pika.Message(  # type: ignore[name-defined]
                body=orjson.dumps(message),
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            )
            await exchange.publish(amqp_message, routing_key=os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue"))
        else:
            await publish_db_update(message)

        logger.info(
            "[CLOSE:DB_PUBLISHED] order_id=%s queue=%s",
            message.get("order_id"),
            os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue"),
        )
    except Exception as e:
        error_logger.error(
            "[CLOSE:DB_PUBLISH_FAILED] order_id=%s error=%s",
            message.get("order_id"),
            str(e),
        )

async def _get_user_lock(user_type: str, user_id: str) -> asyncio.Lock:
    """Get or create a lock for a specific user to prevent race conditions."""
    user_key = f"{user_type}:{user_id}"
    async with _locks_lock:
        if user_key not in _user_locks:
            _user_locks[user_key] = asyncio.Lock()
        return _user_locks[user_key]


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


async def _get_market_close_price(symbol: str, order_type: str) -> Optional[float]:
    try:
        px = await redis_cluster.hmget(f"market:{symbol}", ["bid", "ask"])  # [bid, ask]
        bid = _safe_float(px[0]) if px and len(px) > 0 else None
        ask = _safe_float(px[1]) if px and len(px) > 1 else None
        if str(order_type).upper() == "BUY":
            return bid
        return ask
    except Exception as e:
        logger.error("_get_market_close_price error for %s: %s", symbol, e)
        return None


class OrderCloser:
    def __init__(self) -> None:
        pass

    async def close_order(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        missing = [k for k in ("symbol", "order_type", "user_id", "user_type", "order_id") if k not in payload]
        if missing:
            return {"ok": False, "reason": "missing_fields", "fields": missing}

        symbol = str(payload["symbol"]).upper()
        user_id = str(payload["user_id"])
        user_type = str(payload["user_type"]).lower()
        order_id = str(payload["order_id"])  # canonical
        order_type = str(payload["order_type"]).upper()
        if order_type not in ("BUY", "SELL"):
            return {"ok": False, "reason": "invalid_order_type"}

        # Validate desired close status
        if str(payload.get("status") or "").upper() != "CLOSED" or str(payload.get("order_status") or "").upper() != "CLOSED":
            return {"ok": False, "reason": "invalid_close_status"}

        # Fetch user config (group + leverage + sending_orders)
        cfg = await fetch_user_config(user_type, user_id)
        group = cfg.get("group") or "Standard"
        sending_orders = (cfg.get("sending_orders") or "").strip().lower()

        close_reason = (str(payload.get("close_reason")) if payload.get("close_reason") else "").strip()
        trigger_lifecycle_id = payload.get("trigger_lifecycle_id")

        # Read existing order from user holdings
        hash_tag = f"{user_type}:{user_id}"
        order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
        try:
            order_hash = await redis_cluster.hgetall(order_key)
        except Exception as e:
            logger.error("close_order: failed to fetch order hash for %s: %s", order_key, e)
            order_hash = {}

        if not order_hash:
            # Best-effort fallback to canonical order_data (provider flow may rely on this)
            try:
                order_hash = await redis_cluster.hgetall(f"order_data:{order_id}") or {}
            except Exception:
                order_hash = {}

        # Quantity and entry price are required for PnL
        qty = _safe_float(order_hash.get("order_quantity")) or _safe_float(payload.get("order_quantity")) or 0.0
        entry_price = _safe_float(order_hash.get("order_price")) or _safe_float(payload.get("entry_price"))
        if qty <= 0:
            return {"ok": False, "reason": "missing_or_invalid_quantity"}
        if entry_price is None:
            return {"ok": False, "reason": "missing_entry_price"}

        # Determine execution flow
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

        # Resolve group fields (Redis-first for requested group; DB fallback via Node if missing)
        g = await fetch_group_data(symbol, group)
        if not g or g.get("contract_size") is None or g.get("profit") is None or g.get("type") is None:
            try:
                gfb = await get_group_config_with_fallback(group, symbol)
            except Exception:
                gfb = {}
            if gfb:
                # Merge missing fields
                if not g:
                    g = {}
                for k in ("contract_size", "profit", "type", "spread", "spread_pip", "commission_rate", "commission_type", "commission_value_type", "group_margin", "crypto_margin_factor"):
                    if g.get(k) is None and gfb.get(k) is not None:
                        g[k] = gfb.get(k)
        contract_size = _safe_float(g.get("contract_size"))
        profit_currency = g.get("profit") or None
        instrument_type = int(g.get("type") or 1)
        commission_rate = None
        commission_type = None
        commission_value_type = None
        try:
            rate_raw = g.get("commission_rate") or g.get("commission") or g.get("commision")
            commission_rate = _safe_float(rate_raw)
            ctype_raw = g.get("commission_type") or g.get("commision_type")
            commission_type = int(ctype_raw) if ctype_raw is not None else None
            vtype_raw = g.get("commission_value_type") or g.get("commision_value_type")
            commission_value_type = int(vtype_raw) if vtype_raw is not None else None
        except Exception:
            pass

        # Local flow may have local SL/TP trigger tracking; remove immediately. Provider flow skips this.
        removed_triggers = None

        if flow == "local":
            # Remove SL/TP triggers (if stored locally)
            try:
                removed_triggers = await remove_order_triggers(order_id)
            except Exception:
                removed_triggers = None
            # Determine close price from market: BUY->bid, SELL->ask
            close_price = await _get_market_close_price(symbol, order_type)
            if close_price is None:
                return {"ok": False, "reason": "missing_market_price"}

            # Half-spread adjustment for local close
            try:
                spread = _safe_float(g.get("spread"))
                spread_pip = _safe_float(g.get("spread_pip"))
                half_spread = float((spread or 0.0) * (spread_pip or 0.0) / 2.0)
            except Exception:
                half_spread = 0.0
            try:
                cp = float(close_price)
            except Exception:
                cp = 0.0
            if order_type == "BUY":
                close_price_adj = cp - float(half_spread)
            else:
                close_price_adj = cp + float(half_spread)

            # Commission exit
            commission_exit = compute_exit_commission(
                commission_rate=commission_rate,
                commission_type=commission_type,
                commission_value_type=commission_value_type,
                quantity=qty,
                close_price=float(close_price_adj),
                contract_size=contract_size,
            )
            # Commission entry if present in order hash
            commission_entry = _safe_float(order_hash.get("commission_entry")) or 0.0
            total_commission = float((commission_entry or 0.0) + (commission_exit or 0.0))

            # Profit in native currency
            if order_type == "BUY":
                pnl_native = (float(close_price_adj) - float(entry_price)) * float(qty) * float(contract_size or 0.0)
            else:
                pnl_native = (float(entry_price) - float(close_price_adj)) * float(qty) * float(contract_size or 0.0)

            # Convert to USD when needed
            prices_cache: Dict[str, Dict[str, float]] = {}
            profit_usd = pnl_native
            if profit_currency and str(profit_currency).upper() not in ("USD", "USDT"):
                conv = await convert_to_usd(pnl_native, str(profit_currency).upper(), prices_cache=prices_cache, strict=False)
                profit_usd = float(conv or 0.0)

            swap_val = _safe_float(order_hash.get("swap")) or 0.0
            net_profit = float(profit_usd) - float(total_commission) + float(swap_val)

            # Remove order and recompute margins
            result_cleanup = await self._cleanup_after_close(user_type, user_id, order_id, symbol)
            if not result_cleanup.get("ok"):
                return {"ok": False, "reason": f"cleanup_failed:{result_cleanup.get('reason')}"}

            response = {
                "ok": True,
                "flow": flow,
                "order_id": order_id,
                "symbol": symbol,
                "order_type": order_type,
                "close_price": float(close_price_adj),
                "commission_entry": float(commission_entry or 0.0),
                "commission_exit": float(commission_exit or 0.0),
                "total_commission": float(total_commission),
                "profit_usd": float(round(profit_usd, 2)),
                "swap": float(round(swap_val, 2)),
                "net_profit": float(round(net_profit, 2)),
                "used_margin_executed": result_cleanup.get("used_margin_executed"),
                "used_margin_all": result_cleanup.get("used_margin_all"),
                "order_status": "CLOSED",
                "status": "CLOSED",
            }

            close_message_value = close_reason or "Closed"

            extra_fields = {}
            if trigger_lifecycle_id:
                extra_fields["trigger_lifecycle_id"] = trigger_lifecycle_id

            close_msg_payload = build_close_confirmation_payload(
                order_id=order_id,
                user_id=user_id,
                user_type=user_type,
                symbol=symbol,
                order_type=order_type,
                result=response,
                close_message=close_message_value,
                flow=flow,
                close_origin="local",
                extra_fields=extra_fields or None,
            )
            try:
                await publish_close_confirmation(close_msg_payload)
            except Exception:
                # Errors already logged in helper; continue returning response
                pass
            return response

        # Provider flow

        # Link lifecycle IDs if present
        if payload.get("close_id"):
            close_id = str(payload.get("close_id"))
            
            # Existing Redis and lifecycle tracking
            try:
                await add_lifecycle_id(order_id, close_id, "close_id")
            except Exception as e:
                logger.warning("add_lifecycle_id close_id failed: %s", e)
            
            # Persist close_id into canonical order_data for downstream consumers (Node DB mapping fallback)
            try:
                await redis_cluster.hset(f"order_data:{order_id}", mapping={"close_id": close_id})
            except Exception:
                pass
            
            # 🆕 CRITICAL: Save close_id to database IMMEDIATELY before sending to provider
            # This ensures close_id is persisted even if provider confirmation fails
            try:
                await _save_close_id_to_database(order_id, close_id, user_type, user_id)
            except Exception as e:
                logger.error(
                    "[CLOSE:CLOSE_ID_DB_SAVE_ERROR] order_id=%s close_id=%s error=%s",
                    order_id, close_id, str(e)
                )
                # Continue with close even if DB save fails
                # The close_id will still be in Redis and can be recovered
        if payload.get("stoploss_cancel_id"):
            try:
                await add_lifecycle_id(order_id, str(payload.get("stoploss_cancel_id")), "stoploss_cancel_id")
            except Exception as e:
                logger.warning("add_lifecycle_id stoploss_cancel_id failed: %s", e)
        if payload.get("takeprofit_cancel_id"):
            try:
                await add_lifecycle_id(order_id, str(payload.get("takeprofit_cancel_id")), "takeprofit_cancel_id")
            except Exception as e:
                logger.warning("add_lifecycle_id takeprofit_cancel_id failed: %s", e)

        # Build base info for provider payloads
        contract_value = None
        try:
            cs = float(contract_size or 0.0)
            contract_value = cs * float(qty)
        except Exception:
            contract_value = None

        # Discover existing lifecycle ids for SL/TP to include in cancel payloads
        tp_id = None
        sl_id = None
        try:
            tp_id = (order_hash or {}).get("takeprofit_id")
            sl_id = (order_hash or {}).get("stoploss_id")
        except Exception:
            tp_id = None
            sl_id = None
        try:
            # Fallback to canonical storage
            od_lookup = await redis_cluster.hgetall(f"order_data:{order_id}") or {}
            tp_id = tp_id or od_lookup.get("takeprofit_id")
            sl_id = sl_id or od_lookup.get("stoploss_id")
        except Exception:
            pass

        # 1) Send cancels if needed and wait for confirmation
        cancel_steps: List[Tuple[str, Dict[str, Any]]] = []
        # Build cancel steps purely from payload-provided cancel IDs (no local trigger lookup)
        if payload.get("takeprofit_cancel_id"):
            cp_tp = {
                "order_id": order_id,
                "takeprofit_cancel_id": str(payload.get("takeprofit_cancel_id")),
                "order_type": order_type,
                "contract_value": contract_value,
                "symbol": symbol,
                "status": "TAKEPROFIT-CANCEL",
                "type": "order",
                "take_profit_cancel_id": str(payload.get("takeprofit_cancel_id"))
            }
            if tp_id:
                cp_tp["takeprofit_id"] = str(tp_id)
            cancel_steps.append(("TAKEPROFIT-CANCEL", cp_tp))
        if payload.get("stoploss_cancel_id"):
            cp_sl = {
                "order_id": order_id,
                "stoploss_cancel_id": str(payload.get("stoploss_cancel_id")),
                "order_type": order_type,
                "contract_value": contract_value,
                "symbol": symbol,
                "status": "STOPLOSS-CANCEL",
                "type": "order",
            }
            if sl_id:
                cp_sl["stoploss_id"] = str(sl_id)
            cancel_steps.append(("STOPLOSS-CANCEL", cp_sl))

        # Send cancel payloads sequentially and wait for ack per id
        for status_name, cp in cancel_steps:
            ok, via = await send_provider_order(cp)
            if not ok:
                return {"ok": False, "reason": f"provider_send_failed:{status_name}:{via}"}
            # Wait for ack on cancel id; abort if REJECTED; proceed only if CANCELLED
            cancel_id = cp.get("takeprofit_cancel_id") or cp.get("stoploss_cancel_id")
            if cancel_id:
                # Wait for acknowledgment on both cancel_id and original trigger_id
                # Production provider may return ack with original takeprofit_id/stoploss_id instead of cancel_id
                ack_ids = [str(cancel_id)]
                if cp.get("takeprofit_id"):
                    ack_ids.append(str(cp.get("takeprofit_id")))
                if cp.get("stoploss_id"):
                    ack_ids.append(str(cp.get("stoploss_id")))
                
                ord_stat = await self._wait_for_provider_ack_multi(ack_ids, ["CANCELLED", "REJECTED"], timeout_ms=5000)
                if ord_stat is None:
                    return {"ok": False, "reason": f"cancel_ack_timeout:{status_name}"}
                if ord_stat == "REJECTED":
                    return {"ok": False, "reason": f"cancel_request_rejected:{status_name}"}

        # 2) Send close request
        # Determine close price to send (best-effort market side price)
        close_price = payload.get("close_price")
        if close_price is None:
            close_price = await _get_market_close_price(symbol, order_type)
        try:
            close_price = float(close_price) if close_price is not None else None
        except Exception:
            close_price = None

        provider_close = {
            "order_id": order_id,
            "close_id": payload.get("close_id"),
            "symbol": symbol,
            "order_type": order_type,
            "close_price": close_price,
            "status": "CLOSED",
            "order_quantity": qty,
            "contract_value": contract_value,
            "type": "order",
        }
        
        # Debug logging for provider close message
        logger.info("[PROVIDER_CLOSE_DEBUG] order_id=%s close_id=%s payload_close_id=%s", 
                   order_id, provider_close.get("close_id"), payload.get("close_id"))
        # Mark the order as status=CLOSED in Redis so dispatcher can route EXECUTED -> CLOSE worker
        try:
            order_data_key = f"order_data:{order_id}"
            hash_tag = f"{user_type}:{user_id}"
            order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
            # Separate writes to avoid cross-slot pipeline
            try:
                await redis_cluster.hset(order_key, mapping={"status": "CLOSED"})
            except Exception:
                pass
            try:
                await redis_cluster.hset(order_data_key, mapping={"status": "CLOSED"})
            except Exception:
                pass
        except Exception:
            pass

        okc, via_c = await send_provider_order(provider_close)
        if not okc:
            return {"ok": False, "reason": f"provider_close_send_failed:{via_c}"}

        # If there were NO cancel steps, return immediately without waiting for provider ack
        if len(cancel_steps) == 0:
            return {
                "ok": True,
                "flow": flow,
                "order_id": order_id,
                "provider_close_sent": True,
                "status": "CLOSED",
                "note": "Close sent to provider; ack and finalization will be processed asynchronously",
            }

        # Otherwise (had cancels), wait for provider EXECUTED/REJECTED for close_id (preferred) or order_id
        close_any_ids: List[str] = []
        if payload.get("close_id"):
            close_any_ids.append(str(payload.get("close_id")))
        close_any_ids.append(order_id)
        ord_stat = await self._wait_for_provider_ack_multi(close_any_ids, ["EXECUTED", "REJECTED"], timeout_ms=8000)
        if ord_stat is None:
            return {"ok": False, "reason": "close_ack_timeout"}
        if ord_stat == "REJECTED":
            return {"ok": False, "reason": "close_request_rejected"}

        # Success: provider reported EXECUTED. Worker_close will finalize asynchronously.
        return {
            "ok": True,
            "flow": flow,
            "order_id": order_id,
            "provider_close_sent": True,
            "provider_close_executed": True,
            "status": "CLOSED",
            "note": "Close EXECUTED by provider; worker_close will finalize",
        }

    async def _wait_for_provider_ack(self, any_id: str, expected_status: str, timeout_ms: int = 5000) -> bool:
        deadline = time.time() + (timeout_ms / 1000.0)
        key = f"provider:ack:{any_id}"
        while time.time() < deadline:
            try:
                raw = await redis_cluster.get(key)
                if raw:
                    try:
                        data = orjson.loads(raw)
                    except Exception:
                        data = None
                    ord_status = str((data or {}).get("ord_status") or "").upper()
                    if ord_status == str(expected_status).upper():
                        return True
            except Exception:
                pass
            await self._sleep_ms(100)
        return False

    async def _wait_for_provider_ack_multi(self, any_ids: List[str], expect_statuses: List[str], timeout_ms: int = 8000) -> Optional[str]:
        """
        Wait for any ack among any_ids to have ord_status in expect_statuses. Returns the matched ord_status or None on timeout.
        """
        expect = {str(s).upper() for s in (expect_statuses or [])}
        deadline = time.time() + (timeout_ms / 1000.0)
        keys = [f"provider:ack:{aid}" for aid in any_ids if aid]
        while time.time() < deadline:
            for key in keys:
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
            await self._sleep_ms(100)
        return None

    async def _sleep_ms(self, ms: int):
        try:
            import asyncio
            await asyncio.sleep(ms / 1000.0)
        except Exception:
            time.sleep(ms / 1000.0)

    async def _cleanup_after_close(self, user_type: str, user_id: str, order_id: str, symbol: Optional[str]) -> Dict[str, Any]:
        # Use user-level lock to prevent race conditions during cleanup
        user_lock = await _get_user_lock(user_type, user_id)
        async with user_lock:
            try:
                hash_tag = f"{user_type}:{user_id}"
                order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
                order_data_key = f"order_data:{order_id}"
                index_key = f"user_orders_index:{{{hash_tag}}}"
                portfolio_key = f"user_portfolio:{{{hash_tag}}}"

                # Fetch all orders to recompute margins excluding closed
                orders = await fetch_user_orders(user_type, user_id)
                remaining = [od for od in orders if str(od.get("order_id")) != str(order_id)]

                executed_margin, total_margin, _ = await compute_user_total_margin(
                    user_type=user_type,
                    user_id=user_id,
                    orders=remaining,
                    prices_cache=None,
                    strict=False,
                    include_queued=True,
                )

                # Remove keys and update margins using same-slot pipeline for user-scoped keys
                # Add retry logic for Redis connection pool exhaustion with proper connection management
                max_retries = 3
                retry_delay = 0.01
                operation_id = generate_operation_id()
                
                for attempt in range(max_retries):
                    try:
                        connection_tracker.start_operation(operation_id, "cluster", f"close_cleanup_{order_id}")
                        log_connection_acquire("cluster", f"close_cleanup_{order_id}", operation_id)
                        
                        async with redis_cluster.pipeline() as p_user:
                            p_user.srem(index_key, order_id)
                            p_user.delete(order_key)
                            if executed_margin is not None:
                                p_user.hset(portfolio_key, mapping={
                                    "used_margin_executed": str(float(executed_margin)),
                                    "used_margin": str(float(executed_margin)),
                                })
                            if total_margin is not None:
                                p_user.hset(portfolio_key, mapping={
                                    "used_margin_all": str(float(total_margin)),
                                })
                            await p_user.execute()
                        
                        log_pipeline_operation("cluster", f"close_cleanup_{order_id}", 2 + (1 if executed_margin else 0) + (1 if total_margin else 0), operation_id)
                        log_connection_release("cluster", f"close_cleanup_{order_id}", operation_id)
                        connection_tracker.end_operation(operation_id, success=True)
                        break  # Success, exit retry loop
                        
                    except Exception as e:
                        log_connection_error("cluster", f"close_cleanup_{order_id}", str(e), operation_id, attempt + 1)
                        if attempt == max_retries - 1:
                            # Last attempt failed, re-raise
                            connection_tracker.end_operation(operation_id, success=False, error=str(e))
                            raise
                        logger.warning(
                            "[CLOSE:CLEANUP_RETRY] order_id=%s user=%s:%s attempt=%d error=%s",
                            order_id, user_type, user_id, attempt + 1, str(e)
                        )
                        # Wait briefly before retry (exponential backoff)
                        await asyncio.sleep(retry_delay)
                        retry_delay *= 2
                # Delete canonical in separate call to avoid cross-slot pipeline with connection tracking
                delete_operation_id = generate_operation_id()
                connection_tracker.start_operation(delete_operation_id, "cluster", f"delete_canonical_{order_id}")
                log_connection_acquire("cluster", f"delete_canonical_{order_id}", delete_operation_id)
                
                try:
                    await redis_cluster.delete(order_data_key)
                    log_connection_release("cluster", f"delete_canonical_{order_id}", delete_operation_id)
                    connection_tracker.end_operation(delete_operation_id, success=True)
                except Exception as e:
                    log_connection_error("cluster", f"delete_canonical_{order_id}", str(e), delete_operation_id)
                    connection_tracker.end_operation(delete_operation_id, success=False, error=str(e))

                # Symbol holders cleanup if no more orders for same symbol with connection tracking
                if symbol:
                    any_same_symbol = any(str(od.get("symbol", "")).upper() == str(symbol).upper() for od in remaining)
                    if not any_same_symbol:
                        symbol_operation_id = generate_operation_id()
                        connection_tracker.start_operation(symbol_operation_id, "cluster", f"symbol_cleanup_{symbol}_{user_type}_{user_id}")
                        log_connection_acquire("cluster", f"symbol_cleanup_{symbol}_{user_type}_{user_id}", symbol_operation_id)
                        
                        try:
                            await redis_cluster.srem(f"symbol_holders:{symbol}:{user_type}", f"{user_type}:{user_id}")
                            log_connection_release("cluster", f"symbol_cleanup_{symbol}_{user_type}_{user_id}", symbol_operation_id)
                            connection_tracker.end_operation(symbol_operation_id, success=True)
                        except Exception as e:
                            log_connection_error("cluster", f"symbol_cleanup_{symbol}_{user_type}_{user_id}", str(e), symbol_operation_id)
                            connection_tracker.end_operation(symbol_operation_id, success=False, error=str(e))

                return {
                    "ok": True,
                    "used_margin_executed": float(executed_margin or 0.0) if executed_margin is not None else None,
                    "used_margin_all": float(total_margin or 0.0) if total_margin is not None else None,
                }
            except Exception as e:
                logger.error(
                    "[CLOSE:CLEANUP_EXCEPTION] order_id=%s user=%s:%s error_type=%s error_msg=%s",
                    order_id, user_type, user_id, type(e).__name__, str(e)
                )
                # Log the full traceback to provider_errors.log
                error_logger.exception(
                    "[CLOSE:CLEANUP_EXCEPTION_TRACE] order_id=%s user=%s:%s",
                    order_id, user_type, user_id
                )
                return {"ok": False, "reason": "cleanup_exception"}

    async def finalize_close(self, *, user_type: str, user_id: str, order_id: str, close_price: Optional[float] = None,
                             fallback_symbol: Optional[str] = None,
                             fallback_order_type: Optional[str] = None,
                             fallback_entry_price: Optional[float] = None,
                             fallback_qty: Optional[float] = None) -> Dict[str, Any]:
        """
        Finalize a close after provider EXECUTED report. Computes commissions, net profit, removes keys, and recomputes margins.
        """
        # Fetch order context
        hash_tag = f"{user_type}:{user_id}"
        order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
        order_hash = await redis_cluster.hgetall(order_key)
        if not order_hash:
            # Fallback to canonical for metadata
            order_hash = await redis_cluster.hgetall(f"order_data:{order_id}") or {}

        # Resolve fields from Redis first; if missing, use provided fallbacks from dispatcher payload
        symbol = ((order_hash.get("symbol") or fallback_symbol) or "").upper()
        order_type = ((order_hash.get("order_type") or fallback_order_type) or "").upper()
        qty_val = _safe_float(order_hash.get("order_quantity"))
        if qty_val is None:
            qty_val = _safe_float(fallback_qty)
        qty = float(qty_val or 0.0)
        entry_price_val = _safe_float(order_hash.get("order_price"))
        if entry_price_val is None:
            entry_price_val = _safe_float(fallback_entry_price)
        entry_price = entry_price_val
        if qty <= 0 or entry_price is None or not symbol or not order_type:
            return {"ok": False, "reason": "missing_order_context"}
        if close_price is None:
            close_price = await _get_market_close_price(symbol, order_type)

        cfg = await fetch_user_config(user_type, user_id)
        group = cfg.get("group") or "Standard"
        g = await fetch_group_data(symbol, group)
        if not g or g.get("contract_size") is None or g.get("profit") is None:
            try:
                gfb = await get_group_config_with_fallback(group, symbol)
            except Exception:
                gfb = {}
            if gfb:
                if not g:
                    g = {}
                for k in ("contract_size", "profit", "spread", "spread_pip", "commission_rate", "commission_type", "commission_value_type", "group_margin", "crypto_margin_factor", "type"):
                    if g.get(k) is None and gfb.get(k) is not None:
                        g[k] = gfb.get(k)
        contract_size = _safe_float(g.get("contract_size"))
        profit_currency = g.get("profit") or None
        commission_rate = _safe_float(g.get("commission_rate") or g.get("commission") or g.get("commision"))
        ctype_raw = g.get("commission_type") or g.get("commision_type")
        vtype_raw = g.get("commission_value_type") or g.get("commision_value_type")
        commission_type = int(ctype_raw) if ctype_raw is not None else None
        commission_value_type = int(vtype_raw) if vtype_raw is not None else None

        # Apply half-spread adjustment for provider-confirmed close price
        try:
            spread = _safe_float(g.get("spread"))
            spread_pip = _safe_float(g.get("spread_pip"))
            half_spread = float((spread or 0.0) * (spread_pip or 0.0) / 2.0)
        except Exception:
            half_spread = 0.0
        try:
            cp = float(close_price or 0.0)
        except Exception:
            cp = 0.0
        if order_type == "BUY":
            close_price_adj = cp - float(half_spread)
        else:
            close_price_adj = cp + float(half_spread)

        commission_exit = compute_exit_commission(
            commission_rate=commission_rate,
            commission_type=commission_type,
            commission_value_type=commission_value_type,
            quantity=qty,
            close_price=float(close_price_adj),
            contract_size=contract_size,
        )
        commission_entry = _safe_float(order_hash.get("commission_entry")) or 0.0
        total_commission = float((commission_entry or 0.0) + (commission_exit or 0.0))

        if order_type == "BUY":
            pnl_native = (float(close_price_adj) - float(entry_price)) * float(qty) * float(contract_size or 0.0)
        else:
            pnl_native = (float(entry_price) - float(close_price_adj)) * float(qty) * float(contract_size or 0.0)

        profit_usd = pnl_native
        if profit_currency and str(profit_currency).upper() not in ("USD", "USDT"):
            conv = await convert_to_usd(pnl_native, str(profit_currency).upper(), prices_cache={}, strict=False)
            profit_usd = float(conv or 0.0)

        swap_val = _safe_float(order_hash.get("swap")) or 0.0
        net_profit = float(profit_usd) - float(total_commission) + float(swap_val)

        clean = await self._cleanup_after_close(user_type, user_id, order_id, symbol)
        if not clean.get("ok"):
            return {"ok": False, "reason": f"cleanup_failed:{clean.get('reason')}"}

        return {
            "ok": True,
            "flow": "provider",
            "order_id": order_id,
            "symbol": symbol,
            "order_type": order_type,
            "close_price": float(close_price_adj),
            "commission_entry": float(commission_entry or 0.0),
            "commission_exit": float(commission_exit or 0.0),
            "total_commission": float(total_commission),
            "profit_usd": float(round(profit_usd, 2)),
            "swap": float(round(swap_val, 2)),
            "net_profit": float(round(net_profit, 2)),
            "used_margin_executed": clean.get("used_margin_executed"),
            "used_margin_all": clean.get("used_margin_all"),
            "order_status": "CLOSED",
            "status": "CLOSED",
        }
