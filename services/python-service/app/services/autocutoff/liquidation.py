import asyncio
import logging
from typing import Dict, List, Optional, Tuple

import orjson
import aio_pika
from app.config.redis_config import redis_cluster
from app.services.orders.order_repository import fetch_user_orders, fetch_group_data
from app.services.portfolio.conversion_utils import convert_to_usd
from app.services.orders.order_close_service import OrderCloser
from app.services.orders.id_generator import (
    generate_close_id,
    generate_stoploss_cancel_id,
    generate_takeprofit_cancel_id,
)

logger = logging.getLogger(__name__)


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


async def _get_market_bid_ask(symbol: str) -> Tuple[Optional[float], Optional[float]]:
    try:
        raw = await redis_cluster.hmget(f"market:{symbol}", ["bid", "ask"])  # [bid, ask]
        bid = _safe_float(raw[0]) if raw and len(raw) > 0 else None
        ask = _safe_float(raw[1]) if raw and len(raw) > 1 else None
        return bid, ask
    except Exception as e:
        logger.error("_get_market_bid_ask error for %s: %s", symbol, e)
        return None, None


async def _compute_order_loss_usd(order: Dict, group: Dict, prices: Dict[str, Dict[str, float]]) -> Optional[float]:
    symbol = str(order.get("symbol") or "").upper()
    side = str(order.get("order_type") or "").upper()
    qty = _safe_float(order.get("order_quantity")) or 0.0
    entry = _safe_float(order.get("order_price"))
    if not symbol or qty <= 0 or entry is None:
        return None

    # Contract size and profit currency from group
    try:
        contract_size = float(group.get("contract_size")) if group.get("contract_size") is not None else None
    except (TypeError, ValueError):
        contract_size = None
    profit_currency = group.get("profit") or None

    # Fetch market prices
    px = prices.get(symbol)
    if not px:
        bid, ask = await _get_market_bid_ask(symbol)
        if bid is None and ask is None:
            return None
    else:
        bid = _safe_float(px.get("bid"))
        ask = _safe_float(px.get("ask"))

    if side == "BUY":
        if bid is None:
            return None
        pnl_native = (float(bid) - float(entry)) * float(qty) * float(contract_size or 0.0)
    elif side == "SELL":
        if ask is None:
            return None
        pnl_native = (float(entry) - float(ask)) * float(qty) * float(contract_size or 0.0)
    else:
        return None

    # Convert to USD if needed for sorting across symbols
    pnl_usd = pnl_native
    if profit_currency and str(profit_currency).upper() not in ("USD", "USDT"):
        try:
            conv = await convert_to_usd(pnl_native, str(profit_currency).upper(), prices_cache=prices or {}, strict=False)
            pnl_usd = float(conv or 0.0)
        except Exception:
            pnl_usd = pnl_native

    # We need loss magnitude (positive number for losses)
    loss = -float(pnl_usd)
    return loss


class LiquidationEngine:
    def __init__(self) -> None:
        self._closer = OrderCloser()
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._ch: Optional[aio_pika.abc.AbstractChannel] = None
        self._ex = None

    async def _ensure_rabbitmq_connection(self):
        """Ensure RabbitMQ connection is established for DB updates"""
        if self._conn is None or self._conn.is_closed:
            try:
                import os
                rabbitmq_url = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
                db_update_queue = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")
                
                self._conn = await aio_pika.connect_robust(rabbitmq_url)
                self._ch = await self._conn.channel()
                await self._ch.declare_queue(db_update_queue, durable=True)
                self._ex = self._ch.default_exchange
                logger.info("LiquidationEngine connected to RabbitMQ for DB updates")
            except Exception as e:
                logger.error("Failed to connect to RabbitMQ: %s", e)
                self._conn = None
                self._ch = None
                self._ex = None

    async def _publish_db_update(self, msg: dict):
        """Publish DB update message to RabbitMQ"""
        try:
            await self._ensure_rabbitmq_connection()
            if self._ex is None:
                logger.warning("RabbitMQ not connected, skipping DB update")
                return
                
            import os
            db_update_queue = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")
            amsg = aio_pika.Message(body=orjson.dumps(msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
            await self._ex.publish(amsg, routing_key=db_update_queue)
            logger.info("[AUTOCUTOFF:DB_UPDATE] Published close confirmation for order_id=%s", msg.get("order_id"))
        except Exception as e:
            logger.error("Failed to publish DB update from LiquidationEngine: %s", e)

    async def close(self):
        """Close RabbitMQ connection"""
        try:
            if self._conn and not self._conn.is_closed:
                await self._conn.close()
                logger.info("LiquidationEngine RabbitMQ connection closed")
        except Exception as e:
            logger.error("Error closing RabbitMQ connection: %s", e)

    async def _get_margin_level(self, user_type: str, user_id: str) -> float:
        try:
            key = f"user_portfolio:{{{user_type}:{user_id}}}"
            pf = await redis_cluster.hgetall(key)
            if pf and pf.get("margin_level") is not None:
                margin_level = float(pf.get("margin_level"))
                used_margin = float(pf.get("used_margin", 0))
                
                # If used_margin is 0, margin_level should be infinite (safe)
                # Don't liquidate users with no margin usage
                if used_margin == 0:
                    logger.info("[AutoCutoff] User %s:%s has no used margin (%.2f), treating as safe margin level", user_type, user_id, used_margin)
                    return 999.0  # Return high margin level to prevent liquidation
                
                return margin_level
        except Exception as e:
            logger.warning("[AutoCutoff] Failed to get margin level for %s:%s: %s", user_type, user_id, e)
        return 0.0

    async def run(self, *, user_type: str, user_id: str, prices_cache: Optional[Dict[str, Dict[str, float]]] = None) -> None:
        """
        Close worst losing orders until margin_level >= 100 or no orders left.
        """
        prices_cache = prices_cache or {}

        # Fetch current orders
        orders = await fetch_user_orders(user_type, user_id)
        if not orders:
            logger.info("[AutoCutoff] no orders for %s:%s", user_type, user_id)
            return

        # Build per-symbol group cache to avoid repeated fetches
        # We will collect unique symbols and fetch their group data for the user's group via Redis lookup.
        try:
            ucfg = await redis_cluster.hgetall(f"user:{{{user_type}:{user_id}}}:config")
            group_name = (ucfg.get("group") if ucfg else None) or "Standard"
        except Exception:
            group_name = "Standard"

        # Pre-fetch prices for known symbols
        symbols = list({str(od.get("symbol") or "").upper() for od in orders if od.get("symbol")})
        if symbols:
            for sym in symbols:
                try:
                    raw = await redis_cluster.hgetall(f"market:{sym}")
                    if raw:
                        try:
                            prices_cache[sym] = {
                                "bid": float(raw.get("bid")) if raw.get("bid") is not None else None,
                                "ask": float(raw.get("ask")) if raw.get("ask") is not None else None,
                            }
                        except Exception:
                            prices_cache[sym] = {"bid": None, "ask": None}
                except Exception:
                    pass

        group_cache: Dict[str, Dict] = {}
        losses: List[Tuple[float, Dict]] = []
        for od in orders:
            sym = str(od.get("symbol") or "").upper()
            if not sym:
                continue
            if sym not in group_cache:
                group_cache[sym] = await fetch_group_data(sym, group_name)
            loss = await _compute_order_loss_usd(od, group_cache[sym], prices_cache)
            if loss is None:
                continue
            losses.append((loss, od))

        if not losses:
            logger.info("[AutoCutoff] no computable losses for %s:%s", user_type, user_id)
            return

        # Sort largest loss first
        losses.sort(key=lambda x: x[0], reverse=True)

        for loss_val, order in losses:
            try:
                # Double-check we still below threshold before closing
                ml = await self._get_margin_level(user_type, user_id)
                logger.info("[AutoCutoff] Pre-close margin check: margin_level=%.2f for %s:%s", ml, user_type, user_id)
                if ml >= 100.0:
                    logger.info("[AutoCutoff] margin_level %.2f restored for %s:%s; stop liquidation", ml, user_type, user_id)
                    break

                symbol = str(order.get("symbol") or "").upper()
                order_id = str(order.get("order_id"))
                side = str(order.get("order_type") or "").upper()
                payload = {
                    "symbol": symbol,
                    "order_type": side,
                    "user_id": str(user_id),
                    "user_type": str(user_type),
                    "order_id": order_id,
                    "status": "CLOSED",
                    "order_status": "CLOSED",
                    "close_message": "AUTOCUTOFF",  # Mark as autocutoff liquidation
                }

                # For provider flow, include close_id (we register mapping in OrderCloser)
                try:
                    ucfg = await redis_cluster.hgetall(f"user:{{{user_type}:{user_id}}}:config")
                    sending_orders = (ucfg.get("sending_orders") or "").strip().lower() if ucfg else ""
                except Exception:
                    sending_orders = ""
                if user_type == "live" and sending_orders == "barclays":
                    # Generate provider lifecycle IDs via Redis-backed counters (compatible with Node format)
                    payload["close_id"] = generate_close_id()

                    # Determine if TP/SL are active to send provider cancels first
                    def _is_active(v) -> bool:
                        try:
                            return float(v) > 0
                        except Exception:
                            return False

                    has_tp = _is_active(order.get("take_profit"))
                    has_sl = _is_active(order.get("stop_loss"))
                    # Fallback to user_holdings and canonical if missing on order dict
                    if not (has_tp and has_sl):
                        try:
                            tag = f"{user_type}:{user_id}"
                            hold = await redis_cluster.hgetall(f"user_holdings:{{{tag}}}:{order_id}")
                            if not has_tp:
                                has_tp = _is_active(hold.get("take_profit")) if hold else False
                            if not has_sl:
                                has_sl = _is_active(hold.get("stop_loss")) if hold else False
                        except Exception:
                            pass
                    if not (has_tp and has_sl):
                        try:
                            od = await redis_cluster.hgetall(f"order_data:{order_id}")
                            if not has_tp:
                                has_tp = _is_active(od.get("take_profit")) if od else False
                            if not has_sl:
                                has_sl = _is_active(od.get("stop_loss")) if od else False
                        except Exception:
                            pass

                    if has_tp:
                        payload["takeprofit_cancel_id"] = await generate_takeprofit_cancel_id()
                    if has_sl:
                        payload["stoploss_cancel_id"] = await generate_stoploss_cancel_id()

                # Dispatch close via existing closer service
                logger.info("[AutoCutoff] closing order %s loss=%.2f for %s:%s", order_id, loss_val, user_type, user_id)
                res = await self._closer.close_order(payload)
                if not res.get("ok"):
                    logger.warning("[AutoCutoff] close failed for %s:%s order_id=%s reason=%s", user_type, user_id, order_id, res.get("reason"))
                    # proceed to next order
                    continue

                # Send DB update ONLY for local execution (not provider flow)
                # Provider flow will be handled by provider workers after execution reports
                if not (user_type == "live" and sending_orders == "barclays"):
                    try:
                        db_msg = {
                            "type": "ORDER_CLOSE_CONFIRMED",
                            "order_id": order_id,
                            "user_id": str(user_id),
                            "user_type": str(user_type),
                            "order_status": "CLOSED",
                            "close_price": res.get("close_price"),
                            "net_profit": res.get("net_profit"),
                            "commission": res.get("total_commission"),
                            "commission_entry": res.get("commission_entry"),
                            "commission_exit": res.get("commission_exit"),
                            "profit_usd": res.get("profit_usd"),
                            "swap": res.get("swap"),
                            "used_margin_executed": res.get("used_margin_executed"),
                            "used_margin_all": res.get("used_margin_all"),
                            "close_message": "Autocutoff",  # Explicit autocutoff message
                            "trigger_lifecycle_id": f"autocutoff_{order_id}",  # Synthetic autocutoff trigger ID
                        }
                        await self._publish_db_update(db_msg)
                        logger.info("[AUTOCUTOFF:LOCAL_CLOSE_CONFIRMED] order_id=%s close_message=Autocutoff flow=local", order_id)
                    except Exception as e:
                        logger.warning("[AUTOCUTOFF:DB_UPDATE_FAILED] order_id=%s error=%s", order_id, e)
                else:
                    logger.info("[AUTOCUTOFF:PROVIDER_CLOSE] order_id=%s close_id=%s flow=provider - DB update will be handled by provider worker", 
                              order_id, payload.get("close_id"))

                # Wait briefly for portfolio recalculation to reflect changes
                await asyncio.sleep(0.3)
                ml2 = await self._get_margin_level(user_type, user_id)
                logger.info("[AutoCutoff] margin_level after close: %.2f for %s:%s", ml2, user_type, user_id)
                if ml2 >= 100.0:
                    break
            except Exception as e:
                logger.exception("[AutoCutoff] liquidation iteration error for %s:%s: %s", user_type, user_id, e)
                continue
