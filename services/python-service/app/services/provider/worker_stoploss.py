import os
import asyncio
import logging
from typing import Optional

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.services.orders.order_repository import fetch_user_config, fetch_group_data

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
SL_QUEUE = os.getenv("ORDER_WORKER_STOPLOSS_QUEUE", "order_worker_stoploss_queue")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


class StopLossWorker:
    def __init__(self) -> None:
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._ch: Optional[aio_pika.abc.AbstractChannel] = None
        self._q: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._ch = await self._conn.channel()
        await self._ch.set_qos(prefetch_count=128)
        self._q = await self._ch.declare_queue(SL_QUEUE, durable=True)
        await self._ch.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._ch.default_exchange
        logger.info("StopLossWorker connected. Waiting on %s", SL_QUEUE)

    async def _ack(self, m: aio_pika.abc.AbstractIncomingMessage):
        try:
            await m.ack()
        except Exception:
            logger.exception("ack failed")

    async def _nack(self, m: aio_pika.abc.AbstractIncomingMessage, requeue: bool = True):
        try:
            await m.nack(requeue=requeue)
        except Exception:
            logger.exception("nack failed")

    async def handle(self, message: aio_pika.abc.AbstractIncomingMessage):
        try:
            payload = orjson.loads(message.body)
            er = payload.get("execution_report") or {}
            ord_status = str(er.get("ord_status") or (er.get("raw") or {}).get("39") or "").strip().upper()
            order_id = str(payload.get("order_id"))

            if ord_status not in ("PENDING", "0", "A"):
                await self._ack(message)
                return

            # Idempotency: only apply once per order_id
            try:
                if await redis_cluster.set(f"stoploss_confirmed:{order_id}", "1", ex=7 * 24 * 3600, nx=True) is None:
                    logger.info("[SL:skip:idempotent] order_id=%s", order_id)
                    await self._ack(message)
                    return
            except Exception:
                pass

            user_type = str(payload.get("user_type"))
            user_id = str(payload.get("user_id"))
            symbol = str(payload.get("symbol") or "").upper()
            side = str(payload.get("order_type") or payload.get("side") or "").upper()

            # Fallback from order_data if missing
            if not symbol or side not in ("BUY", "SELL"):
                od = await redis_cluster.hgetall(f"order_data:{order_id}")
                symbol = symbol or str(od.get("symbol") or "").upper()
                side = side if side in ("BUY", "SELL") else str(od.get("order_type") or "").upper()

            # Compute half_spread
            cfg = await fetch_user_config(user_type, user_id)
            group = cfg.get("group") or "Standard"
            g = await fetch_group_data(symbol, group)
            spread = _safe_float(g.get("spread")) or 0.0
            spread_pip = _safe_float(g.get("spread_pip")) or 0.0
            half_spread = float(spread * spread_pip / 2.0)

            avgpx = er.get("avgpx") or (er.get("raw") or {}).get("6")
            price = _safe_float(avgpx)
            if price is None:
                logger.warning("[SL:skip] missing avgpx for order_id=%s", order_id)
                await self._ack(message)
                return

            # Adjust back to user-facing price
            if side == "BUY":
                user_price = float(price - half_spread)
            else:
                user_price = float(price + half_spread)

            # Update canonical Redis (optional, for backfill/observability)
            try:
                await redis_cluster.hset(f"order_data:{order_id}", mapping={"stop_loss": str(user_price)})
            except Exception:
                pass

            # Publish DB update intent
            try:
                db_msg = {
                    "type": "ORDER_STOPLOSS_CONFIRMED",
                    "order_id": order_id,
                    "user_id": user_id,
                    "user_type": user_type,
                    "stop_loss": user_price,
                }
                msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
            except Exception:
                logger.exception("Failed to publish DB update for stoploss confirm")

            await self._ack(message)
        except Exception as e:
            logger.exception("StopLossWorker handle error: %s", e)
            await self._nack(message, requeue=True)

    async def run(self):
        await self.connect()
        await self._q.consume(self.handle, no_ack=False)
        while True:
            await asyncio.sleep(3600)


async def main():
    w = StopLossWorker()
    await w.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
