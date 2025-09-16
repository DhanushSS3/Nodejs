import os
import asyncio
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.services.pending.provider_pending_monitor import register_provider_pending

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
PENDING_QUEUE = os.getenv("ORDER_WORKER_PENDING_QUEUE", "order_worker_pending_queue")
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


async def _update_redis_for_pending(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    For a provider PENDING acknowledgement:
      - Update canonical order_data:{order_id} and user_holdings:{user_type:user_id}:{order_id}
        with order_status=PENDING, execution_status=PENDING, and provider fields
      - Ensure the order is present in the user's index set
    """
    order_id = str(payload.get("order_id"))
    user_id = str(payload.get("user_id"))
    user_type = str(payload.get("user_type"))

    report: Dict[str, Any] = payload.get("execution_report") or {}
    ord_status = report.get("ord_status") or (report.get("raw") or {}).get("39")
    exec_id = report.get("exec_id") or (report.get("raw") or {}).get("17")
    avspx = report.get("avgpx") or (report.get("raw") or {}).get("6")
    ts = report.get("ts")

    order_data_key = f"order_data:{order_id}"
    hash_tag = f"{user_type}:{user_id}"
    order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
    index_key = f"user_orders_index:{{{hash_tag}}}"

    mapping_common = {
        "order_status": "PENDING",
        "execution_status": "PENDING",
        "provider_ord_status": ord_status if ord_status is not None else "",
        "provider_exec_id": exec_id if exec_id is not None else "",
        "provider_avspx": avspx if avspx is not None else "",
        "provider_ts": str(ts) if ts is not None else "",
    }

    pipe = redis_cluster.pipeline()
    pipe.hset(order_data_key, mapping=mapping_common)
    pipe.hset(order_key, mapping=mapping_common)
    pipe.sadd(index_key, order_id)
    await pipe.execute()

    return {
        "order_id": order_id,
        "user_id": user_id,
        "user_type": user_type,
        "order_key": order_key,
        "order_data_key": order_data_key,
    }


class PendingWorker:
    def __init__(self):
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._queue: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=64)
        self._queue = await self._channel.declare_queue(PENDING_QUEUE, durable=True)
        # ensure DB update queue exists
        await self._channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
        logger.info("PendingWorker connected. Waiting on %s", PENDING_QUEUE)

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
            order_id = str(payload.get("order_id"))
            user_type = str(payload.get("user_type"))
            user_id = str(payload.get("user_id"))

            if ord_status != "PENDING":
                logger.warning("[PENDING:skip] order_id=%s ord_status=%s not PENDING", order_id, ord_status)
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
                        logger.info("[PENDING:skip:provider_idempotent] order_id=%s idem=%s", order_id, idem)
                        await self._ack(message)
                        return
            except Exception:
                pass

            # Acquire per-user lock to avoid races with other workers
            lock_key = f"lock:user_margin:{user_type}:{user_id}"
            token = f"{os.getpid()}-{id(message)}"
            got_lock = await acquire_lock(lock_key, token, ttl_sec=8)
            if not got_lock:
                logger.warning("Could not acquire lock %s; NACK and requeue", lock_key)
                await self._nack(message, requeue=True)
                return

            try:
                # Step 1: mark order PENDING in Redis and persist provider fields
                ctx = await _update_redis_for_pending(payload)

                # Step 2: register for provider pending monitoring (starts cancel-on-insufficient-margin loop)
                try:
                    info = {
                        "order_id": order_id,
                        "symbol": str(payload.get("symbol") or "").upper(),
                        "order_type": str(payload.get("order_type") or "").upper(),
                        "order_quantity": payload.get("order_quantity"),
                        "user_id": user_id,
                        "user_type": user_type,
                        "group": str(payload.get("group") or "Standard"),
                    }
                    await register_provider_pending(info)
                except Exception:
                    logger.exception("[PENDING:register] failed for %s", order_id)

                # Step 3: publish DB update to flip SQL status to PENDING
                try:
                    db_msg = {
                        "type": "ORDER_PENDING_CONFIRMED",
                        "order_id": order_id,
                        "user_id": user_id,
                        "user_type": user_type,
                        "order_status": "PENDING",
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB update message for pending confirmation")

                # Step 4: log calculated/context info
                try:
                    calc = {
                        "type": "ORDER_PENDING_CONFIRMED",
                        "order_id": order_id,
                        "user_type": user_type,
                        "user_id": user_id,
                        "symbol": str(payload.get("symbol") or "").upper(),
                        "order_type": str(payload.get("order_type") or "").upper(),
                        "order_quantity": payload.get("order_quantity"),
                        "provider": {
                            "ord_status": ord_status,
                            "avgpx": er.get("avgpx") or (er.get("raw") or {}).get("6"),
                            "exec_id": er.get("exec_id") or (er.get("raw") or {}).get("17"),
                        },
                    }
                    _ORDERS_CALC_LOG.info(orjson.dumps(calc).decode())
                except Exception:
                    pass
            finally:
                await release_lock(lock_key, token)

            await self._ack(message)
        except Exception as e:
            logger.exception("PendingWorker handle error: %s", e)
            await self._nack(message, requeue=True)

    async def run(self):
        await self.connect()
        await self._queue.consume(self.handle, no_ack=False)
        while True:
            await asyncio.sleep(3600)


async def main():
    w = PendingWorker()
    await w.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
