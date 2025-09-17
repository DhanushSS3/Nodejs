import os
import asyncio
import logging
from typing import Optional

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.services.orders.sl_tp_repository import remove_stoploss_trigger, remove_takeprofit_trigger

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
CANCEL_QUEUE = os.getenv("ORDER_WORKER_CANCEL_QUEUE", "order_worker_cancel_queue")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")


class CancelWorker:
    def __init__(self) -> None:
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._ch: Optional[aio_pika.abc.AbstractChannel] = None
        self._q: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._ch = await self._conn.channel()
        await self._ch.set_qos(prefetch_count=256)
        self._q = await self._ch.declare_queue(CANCEL_QUEUE, durable=True)
        await self._ch.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._ch.default_exchange
        logger.info("CancelWorker connected. URL=%s Waiting on queue=%s", RABBITMQ_URL, CANCEL_QUEUE)

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
            logger.info("[CancelWorker] received message: order_id=%s ord_status=%s keys=%s", order_id, ord_status, list(payload.keys()))
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
                        logger.info("[CANCEL:skip:provider_idempotent] order_id=%s idem=%s", order_id, idem)
                        await self._ack(message)
                        return
            except Exception:
                pass

            # Inspect current engine/UI routing status to decide finalization path
            try:
                od = await redis_cluster.hgetall(f"order_data:{order_id}")
            except Exception:
                od = {}

            # If no canonical record found (dispatcher may have fallen back to lifecycle_id), try resolving now
            if not od:
                try:
                    lifecycle_id = str(er.get("order_id") or (er.get("raw") or {}).get("11") or "")
                    if lifecycle_id:
                        canon = await redis_cluster.get(f"global_order_lookup:{lifecycle_id}")
                        if canon and canon != order_id:
                            order_id = str(canon)
                            od = await redis_cluster.hgetall(f"order_data:{order_id}") or {}
                except Exception:
                    pass

            redis_status = str(od.get("status") or od.get("order_status") or "").upper()
            logger.info("[CancelWorker] order_id=%s redis_status=%s", order_id, redis_status)

            # Accept rules:
            # - For PENDING-CANCEL, accept ord_status in (CANCELLED/CANCELED/PENDING/MODIFY)
            # - Otherwise (SL/TP cancels), accept only CANCELLED/CANCELED
            if redis_status == "PENDING-CANCEL":
                if ord_status not in ("CANCELLED", "CANCELED", "PENDING", "MODIFY"):
                    await self._ack(message)
                    return
            else:
                if ord_status not in ("CANCELLED", "CANCELED"):
                    await self._ack(message)
                    return
            user_type = str(od.get("user_type") or payload.get("user_type") or "")
            user_id = str(od.get("user_id") or payload.get("user_id") or "")
            symbol = str(od.get("symbol") or payload.get("symbol") or "").upper()
            side = str(od.get("order_type") or payload.get("order_type") or payload.get("side") or "").upper()

            # Determine cancel kind robustly to avoid race with status write
            lifecycle_id = str(er.get("order_id") or (er.get("raw") or {}).get("11") or "")
            cancel_kind = None
            try:
                if od:
                    tp_cid = str(od.get("takeprofit_cancel_id") or "")
                    sl_cid = str(od.get("stoploss_cancel_id") or "")
                    pc_cid = str(od.get("cancel_id") or "")
                    if lifecycle_id and tp_cid and lifecycle_id == tp_cid:
                        cancel_kind = "TP"
                    elif lifecycle_id and sl_cid and lifecycle_id == sl_cid:
                        cancel_kind = "SL"
                    elif lifecycle_id and pc_cid and lifecycle_id == pc_cid:
                        cancel_kind = "PENDING"
            except Exception:
                pass
            if not cancel_kind:
                if redis_status == "STOPLOSS-CANCEL":
                    cancel_kind = "SL"
                elif redis_status == "TAKEPROFIT-CANCEL":
                    cancel_kind = "TP"
                elif redis_status == "PENDING-CANCEL":
                    cancel_kind = "PENDING"
                # Fallback per spec: if provider reports CANCELLED and order status is one of MODIFY/PENDING/CANCELLED,
                # treat this as a pending order cancel even without cancel_id match
                elif ord_status in ("CANCELLED", "CANCELED") and redis_status in ("MODIFY", "PENDING", "CANCELLED"):
                    cancel_kind = "PENDING"
            logger.info("[CancelWorker] order_id=%s resolved cancel_kind=%s", order_id, cancel_kind)

            if cancel_kind == "SL":
                # Provider idempotency handled earlier; proceed to finalize SL cancel
                # Remove only SL trigger and set OPEN
                try:
                    await remove_stoploss_trigger(order_id)
                except Exception:
                    pass
                try:
                    order_data_key = f"order_data:{order_id}"
                    order_key = f"user_holdings:{{{user_type}:{user_id}}}:{order_id}"
                    pipe = redis_cluster.pipeline()
                    pipe.hdel(order_data_key, "stop_loss")
                    pipe.hdel(order_key, "stop_loss")
                    if symbol and side:
                        pipe.hset(order_data_key, mapping={"status": "OPEN", "symbol": symbol, "order_type": side})
                    else:
                        pipe.hset(order_data_key, mapping={"status": "OPEN"})
                    pipe.hset(order_key, mapping={"status": "OPEN"})
                    await pipe.execute()
                except Exception:
                    pass
                # Publish DB update intent
                try:
                    db_msg = {
                        "type": "ORDER_STOPLOSS_CANCEL",
                        "order_id": order_id,
                        "user_id": user_id,
                        "user_type": user_type,
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB update for stoploss cancel finalize")
                await self._ack(message)
                return

            if cancel_kind == "TP":
                # Provider idempotency handled earlier; proceed to finalize TP cancel
                try:
                    await remove_takeprofit_trigger(order_id)
                except Exception:
                    pass
                try:
                    order_data_key = f"order_data:{order_id}"
                    order_key = f"user_holdings:{{{user_type}:{user_id}}}:{order_id}"
                    pipe = redis_cluster.pipeline()
                    pipe.hdel(order_data_key, "take_profit")
                    pipe.hdel(order_key, "take_profit")
                    if symbol and side:
                        pipe.hset(order_data_key, mapping={"status": "OPEN", "symbol": symbol, "order_type": side})
                    else:
                        pipe.hset(order_data_key, mapping={"status": "OPEN"})
                    pipe.hset(order_key, mapping={"status": "OPEN"})
                    await pipe.execute()
                except Exception:
                    pass
                try:
                    db_msg = {
                        "type": "ORDER_TAKEPROFIT_CANCEL",
                        "order_id": order_id,
                        "user_id": user_id,
                        "user_type": user_type,
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB update for takeprofit cancel finalize")
                await self._ack(message)
                return

            if cancel_kind == "PENDING":
                # Finalize pending order cancellation: remove monitoring + holdings + canonical
                symbol = str(od.get("symbol") or payload.get("symbol") or "").upper()
                order_type = str(od.get("order_type") or payload.get("order_type") or "").upper()
                try:
                    if symbol and order_type:
                        try:
                            await redis_cluster.zrem(f"pending_index:{{{symbol}}}:{order_type}", order_id)
                        except Exception:
                            pass
                        try:
                            await redis_cluster.delete(f"pending_orders:{order_id}")
                        except Exception:
                            pass
                except Exception:
                    logger.exception("Pending cancel: failed to remove monitoring keys for %s", order_id)
                try:
                    hash_tag = f"{user_type}:{user_id}"
                    index_key = f"user_orders_index:{{{hash_tag}}}"
                    order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
                    pipe = redis_cluster.pipeline()
                    pipe.srem(index_key, order_id)
                    pipe.delete(order_key)
                    pipe.delete(f"order_data:{order_id}")
                    await pipe.execute()
                except Exception:
                    logger.exception("Pending cancel: failed to remove holdings/canonical for %s", order_id)
                # Publish DB update intent for pending cancel
                try:
                    db_msg = {
                        "type": "ORDER_PENDING_CANCEL",
                        "order_id": order_id,
                        "user_id": user_id,
                        "user_type": user_type,
                        "order_status": "CANCELLED",
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB update for pending cancel finalize")
                await self._ack(message)
                return

            # If the current redis_status isn't a cancel state, we can't finalize
            logger.info("[CancelWorker] Unmapped cancel state for order_id=%s status=%s", order_id, redis_status)
            await self._ack(message)
        except Exception as e:
            logger.exception("CancelWorker handle error: %s", e)
            await self._nack(message, requeue=True)

    async def run(self):
        await self.connect()
        await self._q.consume(self.handle, no_ack=False)
        while True:
            await asyncio.sleep(3600)


async def main():
    w = CancelWorker()
    await w.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
