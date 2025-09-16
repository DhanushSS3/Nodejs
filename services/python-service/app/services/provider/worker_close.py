import os
import asyncio
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional

import orjson
import aio_pika
import aiohttp

from app.config.redis_config import redis_cluster
from app.services.orders.order_close_service import OrderCloser

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
CLOSE_QUEUE = os.getenv("ORDER_WORKER_CLOSE_QUEUE", "order_worker_close_queue")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")

# Internal provider lookup (Node) for enriching lifecycle->canonical and order_data
INTERNAL_PROVIDER_URL = os.getenv("INTERNAL_PROVIDER_URL", "http://127.0.0.1:3000/api/internal/provider")
INTERNAL_PROVIDER_SECRET = os.getenv("INTERNAL_PROVIDER_SECRET", "")


# ------------- Concurrency: Lightweight Redis lock -------------
async def acquire_lock(lock_key: str, token: str, ttl_sec: int = 5) -> bool:
    try:
        ok = await redis_cluster.set(lock_key, token, ex=ttl_sec, nx=True)
        return bool(ok)
    except Exception as e:
        logger.error("acquire_lock error: %s", e)
        return False


async def release_lock(lock_key: str, token: str) -> None:
    try:
        # Safe release: only delete if value matches token
        lua = """
        if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('del', KEYS[1])
        else
            return 0
        end
        """
        try:
            await redis_cluster.eval(lua, 1, lock_key, token)
        except Exception:
            # Best effort
            pass
    except Exception as e:
        logger.error("release_lock error: %s", e)


# ------------- Dedicated calculated orders file logger -------------
def _get_orders_calc_logger() -> logging.Logger:
    lg = logging.getLogger("orders.calculated")
    # Avoid duplicate handlers
    for h in lg.handlers:
        if isinstance(h, RotatingFileHandler) and getattr(h, "_orders_calc", False):
            return lg
    try:
        base_dir = Path(__file__).resolve().parents[3]
    except Exception:
        base_dir = Path('.')
    log_dir = base_dir / 'logs'
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / 'orders_calculated.log'
    fh = RotatingFileHandler(str(log_file), maxBytes=10_000_000, backupCount=5, encoding='utf-8')
    fh.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    fh._orders_calc = True
    lg.addHandler(fh)
    lg.setLevel(logging.INFO)
    return lg


_ORDERS_CALC_LOG = _get_orders_calc_logger()


class CloseWorker:
    def __init__(self):
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._queue: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None
        self._db_queue: Optional[aio_pika.abc.AbstractQueue] = None
        self._closer = OrderCloser()

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=64)
        self._queue = await self._channel.declare_queue(CLOSE_QUEUE, durable=True)
        # ensure DB update queue exists
        self._db_queue = await self._channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
        logger.info("CloseWorker connected. Waiting on %s", CLOSE_QUEUE)

    async def _ack(self, message: aio_pika.abc.AbstractIncomingMessage):
        try:
            await message.ack()
        except Exception:
            logger.exception("ack failed")

    async def _nack(self, message: aio_pika.abc.AbstractIncomingMessage, requeue: bool = True):
        try:
            await message.nack(requeue=requeue)
        except Exception:
            logger.exception("nack failed")

    async def handle(self, message: aio_pika.abc.AbstractIncomingMessage):
        try:
            payload = orjson.loads(message.body)
            er = payload.get("execution_report") or {}
            ord_status = str(er.get("ord_status") or (er.get("raw") or {}).get("39") or "").strip().upper()
            order_id_dbg = str(payload.get("order_id"))
            side_dbg = str(payload.get("order_type") or payload.get("side") or "").upper()
            logger.info(
                "[CLOSE:received] order_id=%s ord_status=%s side=%s avgpx=%s",
                order_id_dbg, ord_status, side_dbg,
                er.get("avgpx") or (er.get("raw") or {}).get("6"),
            )

            # Only process close EXECUTED
            if ord_status not in ("EXECUTED", "2"):
                logger.warning(
                    "[CLOSE:skip] order_id=%s ord_status=%s not handled (only EXECUTED/2).",
                    order_id_dbg, ord_status,
                )
                await self._ack(message)
                return

            # Provider idempotency token-based dedupe
            try:
                idem = str(
                    er.get("idempotency")
                    or (er.get("raw") or {}).get("idempotency")
                    or er.get("ideampotency")
                    or (er.get("raw") or {}).get("ideampotency")
                    or ""
                ).strip()
                if idem:
                    if await redis_cluster.set(f"provider_idem:{idem}", "1", ex=7 * 24 * 3600, nx=True) is None:
                        logger.info("[CLOSE:skip:provider_idempotent] order_id=%s idem=%s", order_id_dbg, idem)
                        await self._ack(message)
                        return
            except Exception:
                pass

            # Per-order processing guard to avoid duplicate concurrent processing
            processing_key = f"close_processing:{payload.get('order_id')}"
            try:
                got_processing = await redis_cluster.set(processing_key, "1", ex=15, nx=True)
            except Exception:
                got_processing = True  # if Redis failed, proceed best-effort
            if not got_processing:
                logger.warning("[CLOSE:processing_exists] order_id=%s; ACK duplicate", order_id_dbg)
                await self._ack(message)
                return

            # Ensure we have enough context to finalize: backfill order_data and user info from Node if needed
            try:
                await self._ensure_order_context(payload, er)
            except Exception:
                # Best-effort; continue
                pass

            # Acquire per-user lock to avoid race on used_margin recompute (after enrichment)
            lock_key = f"lock:user_margin:{payload.get('user_type')}:{payload.get('user_id')}"
            token = f"{os.getpid()}-{id(message)}"
            got_lock = await acquire_lock(lock_key, token, ttl_sec=8)
            if not got_lock:
                logger.warning("Could not acquire lock %s; NACK and requeue", lock_key)
                try:
                    await redis_cluster.delete(processing_key)
                except Exception:
                    pass
                await self._nack(message, requeue=True)
                return

            try:
                # Finalize close using OrderCloser logic
                avgpx = er.get("avgpx") or (er.get("raw") or {}).get("6")
                try:
                    close_price = float(avgpx) if avgpx is not None else None
                except Exception:
                    close_price = None
                result = await self._closer.finalize_close(
                    user_type=str(payload.get("user_type")),
                    user_id=str(payload.get("user_id")),
                    order_id=str(payload.get("order_id")),
                    close_price=close_price,
                    fallback_symbol=str(payload.get("symbol") or ""),
                    fallback_order_type=str(payload.get("order_type") or ""),
                    fallback_entry_price=payload.get("order_price"),
                    fallback_qty=payload.get("order_quantity"),
                )
                if not result.get("ok"):
                    reason = str(result.get("reason"))
                    logger.error("[CLOSE:finalize_failed] order_id=%s reason=%s", order_id_dbg, reason)
                    # Bounded retries to avoid infinite loop on unrecoverable context
                    try:
                        rkey = f"close_finalize_retries:{payload.get('order_id')}"
                        cnt = await redis_cluster.incr(rkey)
                        # expire retry counter in 10 minutes to avoid leaks
                        await redis_cluster.expire(rkey, 600)
                    except Exception:
                        cnt = 1
                    if cnt <= 3 and reason.startswith("cleanup_failed:") is False:
                        try:
                            await redis_cluster.delete(processing_key)
                        except Exception:
                            pass
                        await self._nack(message, requeue=True)
                    else:
                        logger.warning("[CLOSE:dropping] order_id=%s after %s retries due to %s", order_id_dbg, cnt, reason)
                        await self._ack(message)
                    return

                # Log calculated close data
                try:
                    calc = {
                        "type": "ORDER_CLOSE_CALC",
                        "order_id": str(payload.get("order_id")),
                        "user_type": str(payload.get("user_type")),
                        "user_id": str(payload.get("user_id")),
                        "symbol": str(payload.get("symbol") or "").upper(),
                        "side": side_dbg,
                        "close_price": result.get("close_price"),
                        "commission_entry": result.get("commission_entry"),
                        "commission_exit": result.get("commission_exit"),
                        "total_commission": result.get("total_commission"),
                        "profit_usd": result.get("profit_usd"),
                        "swap": result.get("swap"),
                        "net_profit": result.get("net_profit"),
                        "used_margin_executed": result.get("used_margin_executed"),
                        "used_margin_all": result.get("used_margin_all"),
                        "provider": {
                            "ord_status": er.get("ord_status"),
                            "exec_id": er.get("exec_id"),
                            "avgpx": er.get("avgpx"),
                        },
                    }
                    _ORDERS_CALC_LOG.info(orjson.dumps(calc).decode())
                except Exception:
                    pass

                # Publish DB update intent
                try:
                    # Prefer provider's original lifecycle id (from ER raw payload) to infer close reason on Node
                    trigger_lifecycle_id = None
                    try:
                        trigger_lifecycle_id = (
                            (er.get("raw") or {}).get("order_id")
                            or er.get("exec_id")
                        )
                        if trigger_lifecycle_id is not None:
                            trigger_lifecycle_id = str(trigger_lifecycle_id)
                    except Exception:
                        trigger_lifecycle_id = None
                    db_msg = {
                        "type": "ORDER_CLOSE_CONFIRMED",
                        "order_id": str(payload.get("order_id")),
                        "user_id": str(payload.get("user_id")),
                        "user_type": str(payload.get("user_type")),
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
                        "trigger_lifecycle_id": trigger_lifecycle_id,
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB update message for close")
            finally:
                await release_lock(lock_key, token)
                try:
                    await redis_cluster.delete(processing_key)
                except Exception:
                    pass

            await self._ack(message)
        except Exception as e:
            logger.exception("CloseWorker handle error: %s", e)
            await self._nack(message, requeue=True)

    async def _ensure_order_context(self, payload: dict, er: dict) -> None:
        """
        Best-effort enrichment: resolve canonical order, user info and order_data fields by calling Node internal lookup
        and populate Redis order_data + global lookups. This helps finalize_close when Redis is missing context.
        """
        any_id = (
            str(payload.get("close_id") or "")
            or str(er.get("exec_id") or "")
            or str(payload.get("order_id") or "")
        )
        if not any_id:
            return
        data = await self._node_lookup_any_id(any_id)
        if not data:
            return
        order = data.get("order") or {}
        user = data.get("user") or {}
        gcfg = data.get("group_config") or {}
        can_id = str(order.get("order_id") or payload.get("order_id") or "")
        if not can_id:
            return
        # Backfill order_data canonical hash
        od_update = {}
        if order.get("symbol"):
            od_update["symbol"] = str(order.get("symbol")).upper()
        if order.get("order_type"):
            od_update["order_type"] = str(order.get("order_type")).upper()
        if order.get("order_price") is not None:
            od_update["order_price"] = str(order.get("order_price"))
        if order.get("order_quantity") is not None:
            od_update["order_quantity"] = str(order.get("order_quantity"))
        if user.get("group"):
            od_update["group"] = str(user.get("group"))
        # Group config enrichments
        for k_src, k_dst in (
            ("type", "type"),
            ("contract_size", "contract_size"),
            ("profit", "profit"),
            ("spread", "spread"),
            ("spread_pip", "spread_pip"),
            ("commission_rate", "commission_rate"),
            ("commission_type", "commission_type"),
            ("commission_value_type", "commission_value_type"),
            ("group_margin", "group_margin"),
            ("commision", "commission_rate"),
            ("commision_type", "commission_type"),
            ("commision_value_type", "commission_value_type"),
        ):
            if gcfg.get(k_src) is not None:
                od_update[k_dst] = str(gcfg.get(k_src))
        if od_update:
            try:
                await redis_cluster.hset(f"order_data:{can_id}", mapping=od_update)
            except Exception:
                pass
        # Ensure global lookups for lifecycle ids map to canonical id
        ids_to_map = [
            order.get("order_id"),
            order.get("close_id"),
            order.get("cancel_id"),
            order.get("modify_id"),
            order.get("takeprofit_id"),
            order.get("stoploss_id"),
            order.get("takeprofit_cancel_id"),
            order.get("stoploss_cancel_id"),
        ]
        try:
            pipe = redis_cluster.pipeline()
            for _id in ids_to_map:
                if _id:
                    pipe.set(f"global_order_lookup:{_id}", can_id)
            await pipe.execute()
        except Exception:
            pass
        # Enrich payload with user info if missing
        if not payload.get("user_id") and user.get("id") is not None:
            payload["user_id"] = str(user.get("id"))
        if not payload.get("user_type") and user.get("user_type"):
            payload["user_type"] = str(user.get("user_type")).lower()
        if not payload.get("symbol") and order.get("symbol"):
            payload["symbol"] = str(order.get("symbol")).upper()

    async def _node_lookup_any_id(self, any_id: str) -> Optional[dict]:
        timeout = aiohttp.ClientTimeout(total=3.0)
        headers = {"X-Internal-Auth": INTERNAL_PROVIDER_SECRET} if INTERNAL_PROVIDER_SECRET else {}
        url = f"{INTERNAL_PROVIDER_URL}/orders/lookup/{any_id}"
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, headers=headers) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
                    return data.get("data") or None
        except Exception:
            return None

    async def run(self):
        await self.connect()
        await self._queue.consume(self.handle, no_ack=False)
        while True:
            await asyncio.sleep(3600)


async def main():
    w = CloseWorker()
    await w.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
