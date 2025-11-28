import asyncio
import logging
import os
from typing import Any, Dict, Optional

import aio_pika
import orjson

logger = logging.getLogger(__name__)


class _RabbitMQClient:
    """Shared RabbitMQ publisher with automatic reconnection and queue caching."""

    def __init__(self) -> None:
        self._url = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
        self._connection: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._connection_lock = asyncio.Lock()
        self._declare_lock = asyncio.Lock()
        self._declared_queues: set[str] = set()

    async def _reset_connection(self) -> None:
        if self._connection and not self._connection.is_closed:
            try:
                await self._connection.close()
            except Exception:
                pass
        self._connection = None
        self._channel = None
        self._declared_queues.clear()

    async def _ensure_channel(self) -> None:
        if self._channel and not self._channel.is_closed:
            return

        async with self._connection_lock:
            if self._channel and not self._channel.is_closed:
                return

            await self._reset_connection()
            self._connection = await aio_pika.connect_robust(self._url)
            self._channel = await self._connection.channel()
            logger.info("RabbitMQ shared client connected")

    async def _declare_queue(self, queue_name: str) -> None:
        if queue_name in self._declared_queues:
            return

        async with self._declare_lock:
            if queue_name in self._declared_queues:
                return
            if not self._channel or self._channel.is_closed:
                await self._ensure_channel()
            await self._channel.declare_queue(queue_name, durable=True)
            self._declared_queues.add(queue_name)

    async def publish(self, queue_name: str, payload: bytes) -> None:
        last_error: Optional[Exception] = None

        for attempt in (1, 2):
            try:
                await self._ensure_channel()
                await self._declare_queue(queue_name)
                assert self._channel is not None
                message = aio_pika.Message(body=payload, delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                await self._channel.default_exchange.publish(message, routing_key=queue_name)
                return
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                logger.warning(
                    "RabbitMQ publish attempt %s failed for queue %s: %s",
                    attempt,
                    queue_name,
                    exc,
                )
                await self._reset_connection()

        raise RuntimeError(f"Failed to publish message to {queue_name}") from last_error

    async def publish_json(self, queue_name: str, payload: Dict[str, Any]) -> None:
        await self.publish(queue_name, orjson.dumps(payload))

    async def close(self) -> None:
        await self._reset_connection()


_shared_client = _RabbitMQClient()


async def publish_db_update(message: Dict[str, Any]) -> None:
    queue_name = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")
    await _shared_client.publish_json(queue_name, message)


async def publish_to_queue(queue_name: str, message: Dict[str, Any]) -> None:
    await _shared_client.publish_json(queue_name, message)


async def close_shared_rabbitmq_connection() -> None:
    await _shared_client.close()
