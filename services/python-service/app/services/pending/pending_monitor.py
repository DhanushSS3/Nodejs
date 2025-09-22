import os
import asyncio
import logging
from typing import Dict, Any, List, Optional, Tuple

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.services.orders.order_repository import fetch_group_data, fetch_user_portfolio, fetch_user_config
from app.services.portfolio.margin_calculator import compute_single_order_margin

logger = logging.getLogger(__name__)

# RabbitMQ
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
OPEN_QUEUE = os.getenv("ORDER_WORKER_OPEN_QUEUE", "order_worker_open_queue")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")
TICK_MS = int(os.getenv("PENDING_MONITOR_TICK_MS", "150"))
BATCH = int(os.getenv("PENDING_MONITOR_BATCH", "100"))

# Pending sorted set key
def _zkey(symbol: str, order_type: str) -> str:
    return f"pending_index:{{{symbol}}}:{order_type}"

# Pending metadata hash key
def _hkey(order_id: str) -> str:
    return f"pending_orders:{order_id}"


def _side_from_type(order_type: str) -> str:
    t = (order_type or "").upper()
    if t.startswith("BUY"):
        return "BUY"
    if t.startswith("SELL"):
        return "SELL"
    return "BUY"


class PendingMonitor:
    def __init__(self) -> None:
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._ex = None
        self._started = False

    async def _ensure_amqp(self):
        if self._started and self._conn and not self._conn.is_closed:
            return
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.declare_queue(OPEN_QUEUE, durable=True)
        await self._channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
        self._started = True

    async def _publish(self, queue_name: str, body: Dict[str, Any]):
        await self._ensure_amqp()
        msg = aio_pika.Message(body=orjson.dumps(body), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
        await self._ex.publish(msg, routing_key=queue_name)

    async def _get_ask(self, symbol: str) -> Optional[float]:
        try:
            arr = await redis_cluster.hmget(f"market:{symbol}", ["bid", "ask"])  # reuse list API
            if arr and arr[1] is not None:
                return float(arr[1])
        except Exception as e:
            logger.warning("get_ask failed for %s: %s", symbol, e)
        return None

    async def _get_bid_ask(self, symbol: str) -> Tuple[Optional[float], Optional[float]]:
        try:
            arr = await redis_cluster.hmget(f"market:{symbol}", ["bid", "ask"])  # [bid, ask]
            bid = float(arr[0]) if arr and arr[0] is not None else None
            ask = float(arr[1]) if arr and arr[1] is not None else None
            return bid, ask
        except Exception as e:
            logger.warning("get_bid_ask failed for %s: %s", symbol, e)
            return None, None

    async def _compute_half_spread(self, group: str, symbol: str) -> Optional[float]:
        try:
            g = await fetch_group_data(symbol, group)
            if g:
                try:
                    spread = float(g.get("spread")) if g.get("spread") is not None else None
                    spread_pip = float(g.get("spread_pip")) if g.get("spread_pip") is not None else None
                except (TypeError, ValueError):
                    spread = None
                    spread_pip = None
                if spread is not None and spread_pip is not None:
                    return (spread * spread_pip) / 2.0
        except Exception as e:
            logger.warning("compute_half_spread failed %s:%s: %s", group, symbol, e)
        return None

    async def _validate_margin(self, user_type: str, user_id: str, group: str, symbol: str,
                               side: str, qty: float, ask: float) -> Tuple[bool, Optional[float]]:
        try:
            # Fetch config and group data
            cfg = await fetch_user_config(user_type, user_id)
            leverage = float(cfg.get("leverage") or 0.0)
            balance = float(cfg.get("wallet_balance") or 0.0)
            if leverage <= 0:
                return False, None
            g = await fetch_group_data(symbol, group)
            # Resolve fields
            try:
                contract_size = float(g.get("contract_size")) if g.get("contract_size") is not None else None
            except (TypeError, ValueError):
                contract_size = None
            profit_currency = g.get("profit") or None
            try:
                instrument_type = int(g.get("type")) if g.get("type") is not None else 1
            except (TypeError, ValueError):
                instrument_type = 1
            half_spread = await self._compute_half_spread(group, symbol)
            if contract_size is None or profit_currency is None or half_spread is None:
                return False, None
            # Pending logic: use ask as base for ALL types, user execution price = ask + half_spread
            exec_price_user = float(ask) + float(half_spread)
            single_margin = await compute_single_order_margin(
                contract_size=contract_size,
                order_quantity=float(qty),
                execution_price=float(exec_price_user),
                profit_currency=(str(profit_currency).upper() if profit_currency else None),
                symbol=symbol,
                leverage=float(leverage),
                instrument_type=int(instrument_type),
                prices_cache={},
                crypto_margin_factor=None,
                strict=True,
            )
            if single_margin is None:
                return False, None
            port = await fetch_user_portfolio(user_type, user_id)
            try:
                used_all = float(port.get("used_margin_all")) if port and port.get("used_margin_all") is not None else 0.0
            except (TypeError, ValueError):
                used_all = 0.0
            free = balance - used_all
            return (free >= float(single_margin)), float(single_margin)
        except Exception:
            logger.exception("validate_margin failed for %s:%s %s %s", user_type, user_id, symbol, side)
            return False, None

    async def _remove_pending(self, symbol: str, order_type: str, order_id: str):
        try:
            zk = _zkey(symbol, order_type)
            hk = _hkey(order_id)
            # Avoid cross-slot pipeline: perform operations sequentially
            await redis_cluster.zrem(zk, order_id)
            await redis_cluster.delete(hk)
        except Exception:
            logger.exception("remove_pending failed for %s %s %s", symbol, order_type, order_id)

    async def _reject_pending(self, order_id: str, user_type: str, user_id: str, reason: str):
        # Publish DB update to mark REJECTED
        try:
            await self._publish(DB_UPDATE_QUEUE, {
                "type": "ORDER_REJECTED",
                "order_id": str(order_id),
                "user_id": str(user_id),
                "user_type": str(user_type),
                "order_status": "REJECTED",
                "provider": {"ord_status": "REJECTED", "reason": reason},
            })
        except Exception:
            logger.exception("reject_pending publish failed for %s", order_id)

    async def _execute_pending(self, order_id: str, user_type: str, user_id: str, symbol: str,
                               order_type: str, order_qty: float, exec_px: float, group: str):
        # Send to OPEN worker as executed
        side = _side_from_type(order_type)
        try:
            payload = {
                "order_id": str(order_id),
                "user_id": str(user_id),
                "user_type": str(user_type),
                "symbol": str(symbol).upper(),
                "order_type": side,
                "order_quantity": float(order_qty),
                # Mark as pending-local execution so OpenWorker doesn't re-apply half_spread
                "pending_local": True,
                "execution_report": {
                    "ord_status": "EXECUTED",
                    # Use correct raw market side: BUY -> ask, SELL -> bid
                    "avgpx": float(exec_px),
                    "cumqty": float(order_qty),
                    "ts": int(asyncio.get_event_loop().time() * 1000),
                },
                "group": group,
            }
            await self._publish(OPEN_QUEUE, payload)
            
            # Immediately update DB to change order status from PENDING to OPEN
            # This prevents the 5-second delay in UI where order appears in both sections
            try:
                db_update_payload = {
                    "type": "ORDER_PENDING_TRIGGERED",
                    "order_id": str(order_id),
                    "user_id": str(user_id),
                    "user_type": str(user_type),
                    "order_status": "OPEN",
                    "order_type": side,
                    "order_price": str(exec_px),
                }
                await self._publish(DB_UPDATE_QUEUE, db_update_payload)
                logger.info(f"Sent immediate DB update for pending order trigger: {order_id}")
            except Exception as e:
                logger.exception("Failed to send immediate DB update for pending trigger %s: %s", order_id, e)
                
        except Exception:
            logger.exception("execute_pending publish failed for %s", order_id)

    async def process_symbol(self, symbol: str, limit_per_type: int = 200):
        symbol = str(symbol).upper()
        bid, ask = await self._get_bid_ask(symbol)
        if not (ask and ask > 0):
            return
        try:
            # ask-only comparison per new rules
            # BUY_STOP: ask >= compare -> scores <= ask
            try:
                ids_bs: List[str] = await redis_cluster.zrangebyscore(_zkey(symbol, "BUY_STOP"), "-inf", ask, start=0, num=limit_per_type)
            except Exception:
                ids_bs = await redis_cluster.zrangebyscore(_zkey(symbol, "BUY_STOP"), "-inf", ask)
            await self._handle_candidates(symbol, "BUY_STOP", ids_bs, bid, ask)

            # SELL_LIMIT: ask >= compare -> scores <= ask
            try:
                ids_slm: List[str] = await redis_cluster.zrangebyscore(_zkey(symbol, "SELL_LIMIT"), "-inf", ask, start=0, num=limit_per_type)
            except Exception:
                ids_slm = await redis_cluster.zrangebyscore(_zkey(symbol, "SELL_LIMIT"), "-inf", ask)
            await self._handle_candidates(symbol, "SELL_LIMIT", ids_slm, bid, ask)

            # BUY_LIMIT: ask <= compare -> scores >= ask
            try:
                ids_bl: List[str] = await redis_cluster.zrangebyscore(_zkey(symbol, "BUY_LIMIT"), ask, "+inf", start=0, num=limit_per_type)
            except Exception:
                ids_bl = await redis_cluster.zrangebyscore(_zkey(symbol, "BUY_LIMIT"), ask, "+inf")
            await self._handle_candidates(symbol, "BUY_LIMIT", ids_bl, bid, ask)

            # SELL_STOP: ask <= compare -> scores >= ask
            try:
                ids_ss: List[str] = await redis_cluster.zrangebyscore(_zkey(symbol, "SELL_STOP"), ask, "+inf", start=0, num=limit_per_type)
            except Exception:
                ids_ss = await redis_cluster.zrangebyscore(_zkey(symbol, "SELL_STOP"), ask, "+inf")
            await self._handle_candidates(symbol, "SELL_STOP", ids_ss, bid, ask)
        except Exception:
            logger.exception("process_symbol failed for %s", symbol)

    async def _has_any_pending(self, symbol: str) -> bool:
        """Return True if any pending orders exist for the symbol across four types."""
        try:
            types = ["BUY_LIMIT", "BUY_STOP", "SELL_LIMIT", "SELL_STOP"]
            counts = await asyncio.gather(*(redis_cluster.zcard(_zkey(symbol, t)) for t in types))
            total = sum(int(c or 0) for c in counts)
            return total > 0
        except Exception:
            return True  # conservative: assume pending exists on error

    async def _handle_candidates(self, symbol: str, order_type: str, order_ids: List[str], bid: Optional[float], ask: Optional[float]):
        if not order_ids:
            return
        for oid in order_ids:
            try:
                # Acquire per-order short lock to avoid race in multi-instance
                lock_key = f"lock:pending:{oid}"
                token = f"{os.getpid()}-{id(self)}"
                ok = await redis_cluster.set(lock_key, token, ex=5, nx=True)
                if not ok:
                    continue
                try:
                    meta = await redis_cluster.hgetall(_hkey(oid))
                    if not meta:
                        # Clean index entry and continue
                        await redis_cluster.zrem(_zkey(symbol, order_type), oid)
                        continue
                    user_type = str(meta.get("user_type"))
                    user_id = str(meta.get("user_id"))
                    order_qty = float(meta.get("order_quantity")) if meta.get("order_quantity") is not None else 0.0
                    group = str(meta.get("group") or "Standard")
                    side = _side_from_type(order_type)
                    # Check free margin using ask+half_spread pricing for all pending types
                    # Use ask as base for margin preview
                    mkt_px = ask or 0.0
                    ok_margin, needed = await self._validate_margin(user_type, user_id, group, symbol, side, order_qty, mkt_px)
                    if not ok_margin:
                        await self._remove_pending(symbol, order_type, oid)
                        await self._reject_pending(oid, user_type, user_id, reason="insufficient_margin_pretrigger")
                        continue
                    # Execute
                    # Pending execution price: ask + half_spread for ALL types
                    hs = await self._compute_half_spread(group, symbol)
                    try:
                        hs_val = float(hs) if hs is not None else 0.0
                    except Exception:
                        hs_val = 0.0
                    exec_px = (float(ask or 0.0) + hs_val)
                    await self._execute_pending(oid, user_type, user_id, symbol, order_type, order_qty, exec_px, group)
                    await self._remove_pending(symbol, order_type, oid)
                finally:
                    # Best-effort unlock
                    try:
                        lua = """
                        if redis.call('get', KEYS[1]) == ARGV[1] then
                            return redis.call('del', KEYS[1])
                        else
                            return 0
                        end
                        """
                        await redis_cluster.eval(lua, 1, lock_key, token)
                    except Exception:
                        pass
            except Exception:
                logger.exception("handle_candidate failed for %s", oid)


async def start_pending_monitor():
    monitor = PendingMonitor()

    async def _loop():
        SET_KEY = "pending_active_symbols"
        while True:
            try:
                symbols = await redis_cluster.smembers(SET_KEY)
                for sym in symbols or []:
                    if not sym:
                        continue
                    try:
                        await monitor.process_symbol(str(sym).upper(), limit_per_type=BATCH)
                    except Exception:
                        logger.exception("Pending monitor process_symbol failed for %s", sym)
            except Exception:
                logger.exception("Pending monitor loop set scan failed")
            await asyncio.sleep(TICK_MS / 1000.0)

    # Fire and forget loop (non-blocking)
    asyncio.create_task(_loop())
