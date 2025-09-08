import os
import asyncio
import struct
import time
import logging
from typing import Any, Dict, Optional

import msgpack
import orjson
import aio_pika

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

# Exec server connection
UDS_PATH = os.getenv("EXEC_UDS_PATH", "/run/fx_exec/exec.sock")
TCP_HOST = os.getenv("EXEC_TCP_HOST", "127.0.0.1")
TCP_PORT = int(os.getenv("EXEC_TCP_PORT", "9001"))
CONNECT_TIMEOUT_SEC = float(os.getenv("EXEC_CONNECT_TIMEOUT", "3.0"))

# RabbitMQ
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
CONFIRMATION_QUEUE = os.getenv("CONFIRMATION_QUEUE", "confirmation_queue")

LEN_HDR = 4


def _pack(obj: Dict[str, Any]) -> bytes:
    payload = msgpack.packb(obj, use_bin_type=True)
    return struct.pack("!I", len(payload)) + payload


def _unpack(data: bytes) -> Dict[str, Any]:
    return msgpack.unpackb(data, raw=False)


async def _read_frame(reader: asyncio.StreamReader) -> Optional[Dict[str, Any]]:
    try:
        hdr = await reader.readexactly(LEN_HDR)
        (length,) = struct.unpack("!I", hdr)
        payload = await reader.readexactly(length)
        return _unpack(payload)
    except asyncio.IncompleteReadError:
        logger.warning("connection closed by server")
        return None
    except Exception as e:
        logger.error("read_frame error: %s", e)
        return None


def _normalize_fields(msg: Dict[str, Any]) -> Dict[str, Any]:
    """
    Accept either { 'fields': {...} } or flat dict where keys are fix-like tags.
    Ensure keys are strings for safe .get("11") access.
    """
    fields = msg.get("fields") if isinstance(msg, dict) else None
    if isinstance(fields, dict) and fields:
        base = fields
    else:
        base = msg or {}
    norm: Dict[str, Any] = {}
    for k, v in base.items():
        try:
            ks = str(k)
        except Exception:
            ks = k
        norm[ks] = v
    return norm


def _build_report(msg: Dict[str, Any]) -> Dict[str, Any]:
    fields = _normalize_fields(msg)
    report = {
        "type": "execution_report",
        "order_id": fields.get("11"),      # ClOrdID or similar
        "exec_id": fields.get("17"),       # ExecID or similar
        "ord_status": fields.get("39"),    # OrdStatus
        "avspx": fields.get("6"),          # AvgPx
        "cumqty": fields.get("14"),        # CumQty
        "ts": int(time.time() * 1000),
        "raw": fields,
    }
    return report


class RabbitPublisher:
    def __init__(self, amqp_url: str, queue_name: str):
        self.amqp_url = amqp_url
        self.queue_name = queue_name
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._queue: Optional[aio_pika.abc.AbstractQueue] = None

    async def connect(self):
        self._conn = await aio_pika.connect_robust(self.amqp_url)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=100)
        self._queue = await self._channel.declare_queue(self.queue_name, durable=True)
        logger.info("RabbitMQ connected, queue declared: %s", self.queue_name)

    async def publish(self, payload: Dict[str, Any]):
        if not self._channel:
            await self.connect()
        body = orjson.dumps(payload)
        message = aio_pika.Message(body=body, delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
        await self._channel.default_exchange.publish(message, routing_key=self.queue_name)


class ExecListener:
    def __init__(self, publisher: RabbitPublisher):
        self.publisher = publisher
        self.reader: Optional[asyncio.StreamReader] = None
        self.writer: Optional[asyncio.StreamWriter] = None
        self.transport: Optional[str] = None
        self.stop_flag = False

    async def connect(self) -> bool:
        # Try UDS first (posix)
        if os.name == "posix":
            try:
                self.reader, self.writer = await asyncio.wait_for(asyncio.open_unix_connection(UDS_PATH), timeout=CONNECT_TIMEOUT_SEC)
                self.transport = "UDS"
                logger.info("Connected to exec server via UDS: %s", UDS_PATH)
                return True
            except Exception as e:
                logger.warning("UDS connect failed: %s", e)
        # Fallback TCP
        try:
            self.reader, self.writer = await asyncio.wait_for(asyncio.open_connection(TCP_HOST, TCP_PORT), timeout=CONNECT_TIMEOUT_SEC)
            self.transport = "TCP"
            logger.info("Connected to exec server via TCP: %s:%s", TCP_HOST, TCP_PORT)
            return True
        except Exception as e:
            logger.error("TCP connect failed: %s", e)
            return False

    async def listen_forever(self):
        backoff = 1.0
        while not self.stop_flag:
            ok = await self.connect()
            if not ok:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
                continue

            # Reset backoff on success
            backoff = 1.0

            try:
                while not self.stop_flag:
                    msg = await _read_frame(self.reader)
                    if msg is None:
                        break
                    report = _build_report(msg)
                    await self.publisher.publish(report)
            except Exception as e:
                logger.error("listen loop error: %s", e)
            finally:
                try:
                    if self.writer:
                        self.writer.close()
                        await self.writer.wait_closed()
                except Exception:
                    pass
                logger.info("Disconnected from exec server; reconnecting...")


async def main():
    publisher = RabbitPublisher(RABBITMQ_URL, CONFIRMATION_QUEUE)
    await publisher.connect()
    listener = ExecListener(publisher)
    await listener.listen_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
