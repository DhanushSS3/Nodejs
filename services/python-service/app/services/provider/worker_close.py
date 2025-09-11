import os
import asyncio
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.services.orders.order_close_service import OrderCloser

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
CLOSE_QUEUE = os.getenv("ORDER_WORKER_CLOSE_QUEUE", "order_worker_close_queue")
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

            # Acquire per-user lock to avoid race on used_margin recompute
            lock_key = f"lock:user_margin:{payload.get('user_type')}:{payload.get('user_id')}"
            token = f"{os.getpid()}-{id(message)}"
            got_lock = await acquire_lock(lock_key, token, ttl_sec=8)
            if not got_lock:
                logger.warning("Could not acquire lock %s; NACK and requeue", lock_key)
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
                )
                if not result.get("ok"):
                    logger.error("[CLOSE:finalize_failed] order_id=%s reason=%s", order_id_dbg, result.get("reason"))
                    await self._nack(message, requeue=True)
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
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB update message for close")
            finally:
                await release_lock(lock_key, token)

            await self._ack(message)
        except Exception as e:
            logger.exception("CloseWorker handle error: %s", e)
            await self._nack(message, requeue=True)

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
