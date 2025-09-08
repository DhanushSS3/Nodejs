import os
import asyncio
import struct
import time
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional

import msgpack
import orjson
import aio_pika

logger = logging.getLogger(__name__)

# Exec server connection config
UDS_PATH = os.getenv("EXEC_UDS_PATH", "/run/fx_exec/exec.sock")
TCP_HOST = os.getenv("EXEC_TCP_HOST", "127.0.0.1")
TCP_PORT = int(os.getenv("EXEC_TCP_PORT", "9001"))
CONNECT_TIMEOUT_SEC = float(os.getenv("EXEC_CONNECT_TIMEOUT", "3.0"))

# RabbitMQ
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
CONFIRMATION_QUEUE = os.getenv("CONFIRMATION_QUEUE", "confirmation_queue")

# Frame
LEN_HDR = 4


def _pack(obj: Dict[str, Any]) -> bytes:
    payload = msgpack.packb(obj, use_bin_type=True)
    return struct.pack("!I", len(payload)) + payload


def _unpack(data: bytes) -> Dict[str, Any]:
    return msgpack.unpackb(data, raw=False)


def _normalize_fields(msg: Dict[str, Any]) -> Dict[str, Any]:
    fields = msg.get("fields") if isinstance(msg, dict) else None
    base = fields if isinstance(fields, dict) and fields else (msg or {})
    norm: Dict[str, Any] = {}
    for k, v in base.items():
        ks = str(k) if not isinstance(k, str) else k
        norm[ks] = v
    return norm


def _build_report(msg: Dict[str, Any]) -> Dict[str, Any]:
    fields = _normalize_fields(msg)
    report = {
        "type": "execution_report",
        "order_id": fields.get("11"),
        "exec_id": fields.get("17"),
        "ord_status": fields.get("39"),
        "avgpx": fields.get("6"),
        "cumqty": fields.get("14"),
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
        self._lock = asyncio.Lock()

    async def connect(self):
        if self._conn and not self._conn.is_closed:
            return
        self._conn = await aio_pika.connect_robust(self.amqp_url)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=100)
        self._queue = await self._channel.declare_queue(self.queue_name, durable=True)

    async def publish(self, payload: Dict[str, Any]):
        async with self._lock:
            if not self._channel or self._channel.is_closed:
                await self.connect()
            body = orjson.dumps(payload)
            message = aio_pika.Message(body=body, delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
            await self._channel.default_exchange.publish(message, routing_key=self.queue_name)

    async def close(self):
        try:
            if self._conn and not self._conn.is_closed:
                await self._conn.close()
        except Exception:
            pass


class ProviderConnectionManager:
    """
    Maintains a persistent connection to provider.
    - Single connection used for both sending and receiving
    - Outbound messages come via an asyncio.Queue
    - Inbound frames parsed; 35=8 ERs are published to RabbitMQ confirmation queue
    """

    def __init__(self):
        self.reader: Optional[asyncio.StreamReader] = None
        self.writer: Optional[asyncio.StreamWriter] = None
        self.transport: Optional[str] = None
        self._send_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue(maxsize=1000)
        self._write_lock = asyncio.Lock()
        self._connected = asyncio.Event()
        self._stop = False
        self._publisher = RabbitPublisher(RABBITMQ_URL, CONFIRMATION_QUEUE)
        self._tasks: list[asyncio.Task] = []

    async def _connect(self) -> bool:
        if os.name == "posix":
            try:
                self.reader, self.writer = await asyncio.wait_for(asyncio.open_unix_connection(UDS_PATH), timeout=CONNECT_TIMEOUT_SEC)
                self.transport = "UDS"
                logger.info("Provider connected via UDS: %s", UDS_PATH)
                self._connected.set()
                return True
            except Exception as e:
                logger.warning("UDS connect failed: %s", e)
        try:
            self.reader, self.writer = await asyncio.wait_for(asyncio.open_connection(TCP_HOST, TCP_PORT), timeout=CONNECT_TIMEOUT_SEC)
            self.transport = "TCP"
            logger.info("Provider connected via TCP: %s:%s", TCP_HOST, TCP_PORT)
            self._connected.set()
            return True
        except Exception as e:
            logger.error("TCP connect failed: %s", e)
            return False

    async def _close(self):
        self._connected.clear()
        try:
            if self.writer:
                self.writer.close()
                await self.writer.wait_closed()
        except Exception:
            pass
        self.reader = None
        self.writer = None

    async def _read_loop(self):
        # Requires connected
        while not self._stop:
            try:
                hdr = await self.reader.readexactly(LEN_HDR)
                (length,) = struct.unpack("!I", hdr)
                data = await self.reader.readexactly(length)
                msg = _unpack(data)
                # Log every inbound frame (raw) to dedicated file
                try:
                    _PROVIDER_RX_LOG.info(orjson.dumps({
                        "transport": self.transport,
                        "direction": "in",
                        "message": msg,
                    }).decode())
                except Exception:
                    # Fallback to plain repr if JSON fails
                    _PROVIDER_RX_LOG.info(f"transport={self.transport} dir=in msg={msg!r}")
                # Publish execution reports: either already structured or raw FIX 35=8
                report = None
                try:
                    if isinstance(msg, dict) and str(msg.get("type")) == "execution_report":
                        report = msg
                    else:
                        fields = _normalize_fields(msg)
                        if str(fields.get("35")) == "8":  # FIX ExecutionReport
                            report = _build_report(msg)
                except Exception:
                    report = None
                if report is not None:
                    await self._publisher.publish(report)
                    try:
                        logger.debug(
                            "Published ER to %s: order_id=%s ord_status=%s",
                            CONFIRMATION_QUEUE,
                            report.get("order_id") or (report.get("raw") or {}).get("11"),
                            report.get("ord_status") or (report.get("raw") or {}).get("39"),
                        )
                    except Exception:
                        pass
            except asyncio.IncompleteReadError:
                logger.warning("Provider connection closed by server")
                break
            except Exception as e:
                logger.error("read_loop error: %s", e)
                break

    async def _send_loop(self):
        while not self._stop:
            payload = await self._send_queue.get()
            if payload is None:
                continue
            try:
                # Ensure minimal required fields
                if "type" not in payload:
                    payload["type"] = "order"
                if "ts" not in payload:
                    payload["ts"] = int(time.time() * 1000)
                # Compute contract_value if not given (best-effort)
                if payload.get("contract_value") is None:
                    try:
                        cs = float(payload.get("contract_size")) if payload.get("contract_size") is not None else None
                        oq = float(payload.get("order_quantity")) if payload.get("order_quantity") is not None else None
                        if cs is not None and oq is not None:
                            payload["contract_value"] = cs * oq
                    except Exception:
                        pass
                data = _pack(payload)
                async with self._write_lock:
                    await self._connected.wait()
                    self.writer.write(data)
                    await self.writer.drain()
            except Exception as e:
                logger.error("send_loop error: %s", e)
                # Requeue once on failure if disconnected
                try:
                    if not self._connected.is_set():
                        await asyncio.sleep(0.2)
                        await self._send_queue.put(payload)
                except Exception:
                    pass

    async def run(self):
        backoff = 1.0
        await self._publisher.connect()
        while not self._stop:
            ok = await self._connect()
            if not ok:
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)
                continue
            backoff = 1.0
            try:
                read_task = asyncio.create_task(self._read_loop(), name="provider_read")
                send_task = asyncio.create_task(self._send_loop(), name="provider_send")
                self._tasks = [read_task, send_task]
                done, pending = await asyncio.wait(self._tasks, return_when=asyncio.FIRST_EXCEPTION)
                for t in pending:
                    t.cancel()
                    try:
                        await t
                    except Exception:
                        pass
            finally:
                await self._close()
                logger.info("Reconnecting to provider...")

    async def stop(self):
        self._stop = True
        try:
            for t in self._tasks:
                t.cancel()
        except Exception:
            pass
        await self._close()
        await self._publisher.close()

    async def send(self, payload: Dict[str, Any]):
        """Queue an order payload to be sent on the persistent connection."""
        await self._send_queue.put(dict(payload))


# Singleton accessor
_manager: Optional[ProviderConnectionManager] = None


def get_provider_connection_manager() -> ProviderConnectionManager:
    global _manager
    if _manager is None:
        _manager = ProviderConnectionManager()
    return _manager


# ------------- Dedicated RX file logger -------------
def _get_provider_rx_logger() -> logging.Logger:
    lg = logging.getLogger("provider.rx")
    # Avoid adding duplicate handlers
    has_handler = False
    for h in lg.handlers:
        if isinstance(h, RotatingFileHandler) and getattr(h, "_provider_rx", False):
            has_handler = True
            break
    if not has_handler:
        try:
            base_dir = Path(__file__).resolve().parents[3]  # .../services/python-service
        except Exception:
            base_dir = Path('.')
        log_dir = base_dir / 'logs'
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / 'provider_rx.log'
        fh = RotatingFileHandler(str(log_file), maxBytes=10_000_000, backupCount=5, encoding='utf-8')
        fh.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
        fh._provider_rx = True  # marker
        lg.addHandler(fh)
        lg.setLevel(logging.INFO)
    return lg


_PROVIDER_RX_LOG = _get_provider_rx_logger()
