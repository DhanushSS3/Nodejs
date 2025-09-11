import os
import asyncio
import logging
from typing import Any, Dict, Optional

import orjson
import aio_pika

from app.config.redis_config import redis_cluster

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
CONFIRMATION_QUEUE = os.getenv("CONFIRMATION_QUEUE", "confirmation_queue")
DLQ = os.getenv("CONFIRMATION_DLQ", "confirmation_dlq")

# Worker queues
OPEN_QUEUE = os.getenv("ORDER_WORKER_OPEN_QUEUE", "order_worker_open_queue")
CLOSE_QUEUE = os.getenv("ORDER_WORKER_CLOSE_QUEUE", "order_worker_close_queue")
SL_QUEUE = os.getenv("ORDER_WORKER_STOPLOSS_QUEUE", "order_worker_stoploss_queue")
TP_QUEUE = os.getenv("ORDER_WORKER_TAKEPROFIT_QUEUE", "order_worker_takeprofit_queue")
REJECT_QUEUE = os.getenv("ORDER_WORKER_REJECT_QUEUE", "order_worker_reject_queue")


def _select_worker_queue(status: Optional[str]) -> Optional[str]:
    """Select target worker queue using canonical order status stored in order_data['status']."""
    if not status:
        return None
    s = str(status).upper()
    if s == "OPEN":
        return OPEN_QUEUE
    # Future routes (uncomment as workers are added)
    # if s == "CLOSE":
    #     return CLOSE_QUEUE
    # if s == "STOPLOSS":
    #     return SL_QUEUE
    # if s == "TAKEPROFIT":
    #     return TP_QUEUE
    return None


async def _compose_payload(report: Dict[str, Any], order_data: Dict[str, Any], canonical_order_id: str) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "order_id": canonical_order_id,
        "user_id": order_data.get("user_id"),
        "user_type": order_data.get("user_type"),
        "group": order_data.get("group"),
        "leverage": order_data.get("leverage"),
        "spread": order_data.get("spread"),
        "spread_pip": order_data.get("spread_pip"),
        "contract_size": order_data.get("contract_size"),
        "profit_currency": order_data.get("profit"),
        "symbol": order_data.get("symbol"),
        "order_type": order_data.get("order_type"),
        "order_price": order_data.get("order_price"),
        "order_quantity": order_data.get("order_quantity"),
        "execution_report": report,
    }
    return payload


class Dispatcher:
    def __init__(self):
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._q_in: Optional[aio_pika.abc.AbstractQueue] = None
        self._q_dlq: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=100)
        self._q_in = await self._channel.declare_queue(CONFIRMATION_QUEUE, durable=True)
        self._q_dlq = await self._channel.declare_queue(DLQ, durable=True)
        # Ensure worker queues exist (durable) even if no consumer yet
        await self._channel.declare_queue(OPEN_QUEUE, durable=True)
        await self._channel.declare_queue(CLOSE_QUEUE, durable=True)
        await self._channel.declare_queue(SL_QUEUE, durable=True)
        await self._channel.declare_queue(TP_QUEUE, durable=True)
        await self._channel.declare_queue(REJECT_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
        logger.info("Dispatcher connected. Listening on %s", CONFIRMATION_QUEUE)

    async def _publish(self, queue_name: str, body: Dict[str, Any]):
        msg = aio_pika.Message(body=orjson.dumps(body), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
        await self._ex.publish(msg, routing_key=queue_name)

    async def handle(self, message: aio_pika.abc.AbstractIncomingMessage):
        async with message.process(requeue=False):
            try:
                report = orjson.loads(message.body)
                lifecycle_id = report.get("order_id") or report.get("exec_id")
                if not lifecycle_id:
                    # try in raw dict
                    raw = report.get("raw") or {}
                    lifecycle_id = raw.get("11") or raw.get("17")

                if not lifecycle_id:
                    logger.warning("No lifecycle ID in report; sending to DLQ")
                    await self._publish(DLQ, {"reason": "missing_lifecycle_id", "report": report})
                    return

                canonical_order_id = await redis_cluster.get(f"global_order_lookup:{lifecycle_id}")
                # Fallback: treat lifecycle_id as canonical order_id (self-mapping case)
                if not canonical_order_id:
                    canonical_order_id = lifecycle_id

                order_data = await redis_cluster.hgetall(f"order_data:{canonical_order_id}")
                if not order_data:
                    logger.warning("Canonical order_data missing for %s; DLQ", canonical_order_id)
                    await self._publish(DLQ, {"reason": "missing_order_data", "order_id": canonical_order_id, "report": report})
                    return

                payload = await _compose_payload(report, order_data, canonical_order_id)
                # Route based on Redis status (engine/UI state) and provider ord_status (string)
                redis_status = str(order_data.get("status") or order_data.get("order_status") or "").upper()
                ord_status = str(report.get("ord_status") or "").upper().strip()
                target_queue = None
                if redis_status == "OPEN" and ord_status == "EXECUTED":
                    target_queue = OPEN_QUEUE
                elif redis_status == "OPEN" and ord_status == "REJECTED":
                    target_queue = REJECT_QUEUE
                elif redis_status == "CLOSED" and ord_status == "EXECUTED":
                    target_queue = CLOSE_QUEUE
                elif redis_status == "CLOSED" and ord_status == "REJECTED":
                    target_queue = REJECT_QUEUE
                else:
                    logger.info(
                        "Unmapped routing state; DLQ. redis_status=%s ord_status=%s order_id=%s",
                        redis_status, ord_status, canonical_order_id,
                    )
                    await self._publish(
                        DLQ,
                        {
                            "reason": "unmapped_routing_state",
                            "redis_status": redis_status,
                            "ord_status": ord_status,
                            "order_id": canonical_order_id,
                            "report": report,
                        },
                    )
                    return

                logger.info(
                    "Routing ER redis_status=%s ord_status=%s order_id=%s -> %s",
                    redis_status, ord_status, canonical_order_id, target_queue,
                )
                await self._publish(target_queue, payload)
            except Exception as e:
                logger.exception("Dispatcher handle error: %s", e)
                # Let message be NACKed due to exception context (but we used process(requeue=False))
                # We already avoid requeue by process context; ensure not to raise to avoid double logs
                return

    async def run(self):
        await self.connect()
        await self._q_in.consume(self.handle, no_ack=False)
        while True:
            await asyncio.sleep(3600)


async def main():
    d = Dispatcher()
    await d.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
