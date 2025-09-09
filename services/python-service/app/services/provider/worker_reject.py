import os
import asyncio
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.services.orders.order_repository import fetch_user_orders
from app.services.portfolio.user_margin_service import compute_user_total_margin

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
REJECT_QUEUE = os.getenv("ORDER_WORKER_REJECT_QUEUE", "order_worker_reject_queue")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")


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
        # Safe release
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
            pass
    except Exception as e:
        logger.error("release_lock error: %s", e)


async def _update_redis_for_reject(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Mark order as REJECTED in both canonical and user holdings, persist provider details,
    and remove from the user's open orders index so it doesn't count toward used margin.
    """
    order_id = str(payload.get("order_id"))
    user_id = str(payload.get("user_id"))
    user_type = str(payload.get("user_type"))

    # Provider report fields
    report: Dict[str, Any] = payload.get("execution_report") or {}
    ord_status = report.get("ord_status") or (report.get("raw") or {}).get("39")
    exec_id = report.get("exec_id") or (report.get("raw") or {}).get("17")
    avspx = report.get("avgpx") or (report.get("raw") or {}).get("6")
    cumqty = report.get("cumqty") or (report.get("raw") or {}).get("14")
    # Prefer named 'reason' field; fallback to raw FIX tag 58 if present
    reason = report.get("reason") or (report.get("raw") or {}).get("58")
    ts = report.get("ts")

    # Keys
    order_data_key = f"order_data:{order_id}"
    hash_tag = f"{user_type}:{user_id}"
    order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
    index_key = f"user_orders_index:{{{hash_tag}}}"

    mapping_common = {
        "order_status": "REJECTED",
        "execution_status": "REJECTED",
        "provider_ord_status": ord_status if ord_status is not None else "",
        "provider_exec_id": exec_id if exec_id is not None else "",
        "provider_avspx": avspx if avspx is not None else "",
        "provider_cumqty": cumqty if cumqty is not None else "",
        "provider_reason": reason if reason is not None else "",
        "provider_ts": str(ts) if ts is not None else "",
    }

    pipe = redis_cluster.pipeline()
    pipe.hset(order_data_key, mapping=mapping_common)
    pipe.hset(order_key, mapping=mapping_common)
    # Remove from open orders index so it's not considered for used margin
    pipe.srem(index_key, order_id)
    await pipe.execute()

    return {
        "order_id": order_id,
        "user_id": user_id,
        "user_type": user_type,
        "order_key": order_key,
        "order_data_key": order_data_key,
    }


async def _recompute_used_margin_excluding(order_id: str, user_type: str, user_id: str) -> Optional[float]:
    try:
        orders = await fetch_user_orders(user_type, user_id)
        # Exclude this order from the list before recompute
        filtered = [od for od in orders if str(od.get("order_id")) != str(order_id)]
        total_used, _ = await compute_user_total_margin(
            user_type=user_type,
            user_id=user_id,
            orders=filtered,
            prices_cache=None,
            strict=True,
        )
        return float(total_used) if total_used is not None else None
    except Exception:
        logger.exception("_recompute_used_margin_excluding failed")
        return None


class RejectWorker:
    def __init__(self):
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._queue: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=64)
        self._queue = await self._channel.declare_queue(REJECT_QUEUE, durable=True)
        # ensure DB update queue exists
        await self._channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
        logger.info("RejectWorker connected. Waiting on %s", REJECT_QUEUE)

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
            order_id = str(payload.get("order_id"))
            user_type = str(payload.get("user_type"))
            user_id = str(payload.get("user_id"))

            # Check provider ord_status and ensure it's a rejection (8)
            er = (payload.get("execution_report") or {})
            # With new provider format, ord_status is a string like 'REJECTED'. Keep 8 for backward compat.
            ord_status = str(er.get("ord_status") or (er.get("raw") or {}).get("39") or "").strip()
            if ord_status not in ("REJECTED", "8"):
                logger.warning("[REJECT:skip] order_id=%s ord_status=%s not 8 (Rejected)", order_id, ord_status)
                await self._ack(message)
                return

            # Concurrency control per user
            lock_key = f"lock:user_margin:{user_type}:{user_id}"
            token = f"{os.getpid()}-{id(message)}"
            got_lock = await acquire_lock(lock_key, token, ttl_sec=8)
            if not got_lock:
                logger.warning("Could not acquire lock %s; NACK and requeue", lock_key)
                await self._nack(message, requeue=True)
                return

            try:
                # Step 1: mark order REJECTED and remove from index
                ctx = await _update_redis_for_reject(payload)
                logger.debug("[REJECT:update_redis_done] ctx=%s", ctx)

                # Step 2: recompute used margin excluding this order
                new_used = await _recompute_used_margin_excluding(order_id, user_type, user_id)
                if new_used is not None:
                    portfolio_key = f"user_portfolio:{{{user_type}:{user_id}}}"
                    await redis_cluster.hset(portfolio_key, mapping={"used_margin": str(float(new_used))})
                logger.info(
                    "[REJECT:updated] order_id=%s new_used_margin=%s",
                    order_id,
                    (str(float(new_used)) if new_used is not None else None),
                )

                # Step 3: if no other open orders for this symbol remain, remove from symbol_holders
                try:
                    symbol = str(payload.get("symbol") or "").upper()
                    if symbol:
                        # Check if user still has any other open orders for this symbol
                        orders = await fetch_user_orders(user_type, user_id)
                        any_same_symbol = False
                        for od in orders:
                            if str(od.get("symbol")).upper() == symbol and str(od.get("order_id")) != order_id:
                                any_same_symbol = True
                                break
                        if not any_same_symbol:
                            sym_set = f"symbol_holders:{symbol}:{user_type}"
                            await redis_cluster.srem(sym_set, f"{user_type}:{user_id}")
                except Exception:
                    logger.exception("[REJECT:symbol_holders] cleanup failed")

                # Log calculated reject data to dedicated file
                try:
                    calc = {
                        "type": "ORDER_REJECT_CALC",
                        "order_id": order_id,
                        "user_type": user_type,
                        "user_id": user_id,
                        "symbol": str(payload.get("symbol") or "").upper(),
                        "provider": {
                            "ord_status": "REJECTED",
                            "exec_id": er.get("exec_id") or (er.get("raw") or {}).get("17"),
                            "reason": er.get("reason") or (er.get("raw") or {}).get("58"),
                        },
                        "new_used_margin": (float(new_used) if new_used is not None else None),
                    }
                    _ORDERS_CALC_LOG.info(orjson.dumps(calc).decode())
                except Exception:
                    pass

                # Step 4: publish DB update intent for Node consumer
                try:
                    db_msg = {
                        "type": "ORDER_REJECTED",
                        "order_id": order_id,
                        "user_id": user_id,
                        "user_type": user_type,
                        "order_status": "REJECTED",
                        "provider": {
                            "exec_id": er.get("exec_id") or (er.get("raw") or {}).get("17"),
                            "reason": er.get("reason") or (er.get("raw") or {}).get("58"),
                            "ord_status": "REJECTED",
                        },
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB reject update message")
            finally:
                await release_lock(lock_key, token)

            await self._ack(message)
        except Exception as e:
            logger.exception("RejectWorker handle error: %s", e)
            await self._nack(message, requeue=True)

    async def run(self):
        await self.connect()
        await self._queue.consume(self.handle, no_ack=False)
        while True:
            await asyncio.sleep(3600)


async def main():
    w = RejectWorker()
    await w.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

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
