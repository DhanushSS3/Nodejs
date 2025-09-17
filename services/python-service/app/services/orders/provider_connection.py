# Provider Node internal lookup config will be declared after imports

import os
import asyncio
import struct
import time
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional

import msgpack
import aiohttp
import orjson
import aio_pika
from app.config.redis_config import redis_cluster

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

# After imports and logger setup: Node internal lookup config and helper
INTERNAL_PROVIDER_URL = os.getenv("INTERNAL_PROVIDER_URL", "http://127.0.0.1:3000/api/internal/provider")
INTERNAL_PROVIDER_SECRET = os.getenv("INTERNAL_PROVIDER_SECRET", "")


async def _node_lookup_any_id(any_id: str) -> Optional[Dict[str, Any]]:
    """
    Call Node internal lookup to resolve an order by any lifecycle ID and fetch
    user + group config. Live orders only.
    Returns payload dict or None on failure.
    """
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
    except Exception as e:
        try:
            logger.warning("Node provider lookup failed for %s: %s", any_id, e)
        except Exception:
            pass
        return None


def _pack(obj: Dict[str, Any]) -> bytes:
    payload = msgpack.packb(obj, use_bin_type=True)
    return struct.pack("!I", len(payload)) + payload


def _unpack(data: bytes) -> Dict[str, Any]:
    return msgpack.unpackb(data, raw=False)


def _normalize_fields(msg: Dict[str, Any]) -> Dict[str, Any]:
    """Return a shallow copy of the message with stringified keys.

    This is a generic helper that no longer performs any FIX tag mapping.
    The provider will send execution reports with named fields at the top level
    (e.g., order_id, ord_status, avgpx, cumqty, side, reason), possibly along
    with other auxiliary fields. We just normalize keys to strings for safety.
    """
    base = msg if isinstance(msg, dict) else {}
    norm: Dict[str, Any] = {}
    for k, v in base.items():
        ks = str(k) if not isinstance(k, str) else k
        norm[ks] = v
    return norm


def _build_report(msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Build an execution report from named fields provided by the provider.

    Expected fields (instant order report):
      - order_id: str | int
      - ord_status: EXECUTED | PENDING | REJECTED | CANCELLED
      - avgpx: float (executed price)
      - cumqty: float (contract_value / quantity as defined by provider)
      - side: BUY | SELL
      - reason: str (present on rejections/cancellations)

    Returns None if minimum required fields are missing.
    """
    fields = _normalize_fields(msg)
    order_id = fields.get("order_id")
    ord_status = fields.get("ord_status")
    if order_id is None or ord_status is None:
        return None
    # Only accept known execution report statuses. Drop ACK and other types.
    try:
        ord_status_norm = str(ord_status).upper().strip()
    except Exception:
        return None
    allowed_statuses = {"EXECUTED", "PENDING", "REJECTED", "CANCELLED", "CANCELED", "MODIFY"}
    if ord_status_norm not in allowed_statuses:
        return None
    report: Dict[str, Any] = {
        "type": "execution_report",
        "order_id": order_id,
        # exec_id is optional, keep if provider sends it
        "exec_id": fields.get("exec_id"),
        "ord_status": ord_status_norm,
        "avgpx": fields.get("avgpx"),
        "cumqty": fields.get("cumqty"),
        "side": fields.get("side"),
        "reason": fields.get("reason"),
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
    - Inbound frames parsed; execution reports are published to RabbitMQ confirmation queue
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
                # Publish execution reports: either already structured or named-field dicts
                report = None
                try:
                    if isinstance(msg, dict):
                        if str(msg.get("type")) == "execution_report":
                            # Already a proper report, pass through
                            report = msg
                        else:
                            # Build from named fields (no FIX tag mapping)
                            report = _build_report(msg)
                except Exception:
                    report = None
                if report is not None:
                    # Persist a short-lived ack in Redis for lifecycle-level awaits (cancel/close ids)
                    try:
                        ack_ids = set()
                        oid = report.get("order_id")
                        if oid:
                            ack_ids.add(str(oid))
                        exec_id = report.get("exec_id")
                        if exec_id:
                            ack_ids.add(str(exec_id))
                        if ack_ids:
                            pipe = redis_cluster.pipeline()
                            for _id in ack_ids:
                                try:
                                    pipe.setex(f"provider:ack:{_id}", 60, orjson.dumps(report))
                                except Exception:
                                    pass
                            await pipe.execute()
                    except Exception:
                        # best-effort only
                        pass
                    # Enrich with group/symbol spread data before publish; add DB fallback via Node
                    try:
                        lifecycle_id = report.get("order_id") or report.get("exec_id")
                        canonical_order_id = None
                        if lifecycle_id:
                            canonical_order_id = await redis_cluster.get(f"global_order_lookup:{lifecycle_id}")

                        group_val = report.get("group")
                        symbol_val = report.get("symbol")

                        # If no mapping or missing order_data fields, try Redis first then fallback to Node DB lookup
                        od: Dict[str, Any] = {}
                        if canonical_order_id:
                            od = await redis_cluster.hgetall(f"order_data:{canonical_order_id}") or {}

                        if (not canonical_order_id) or (not group_val or not symbol_val) and not od:
                            if lifecycle_id:
                                lookup = await _node_lookup_any_id(str(lifecycle_id))
                            else:
                                lookup = None
                            if lookup:
                                # Resolve canonical id and cache all lifecycle ids -> canonical mapping
                                can_id = str((lookup.get("order") or {}).get("order_id")) if lookup.get("order") else None
                                if can_id:
                                    canonical_order_id = can_id
                                    # Persist global lookups for all known lifecycle ids
                                    ids_to_map = [
                                        (lookup["order"].get("order_id"),),
                                        (lookup["order"].get("close_id"),),
                                        (lookup["order"].get("cancel_id"),),
                                        (lookup["order"].get("modify_id"),),
                                        (lookup["order"].get("takeprofit_id"),),
                                        (lookup["order"].get("stoploss_id"),),
                                        (lookup["order"].get("takeprofit_cancel_id"),),
                                        (lookup["order"].get("stoploss_cancel_id"),),
                                    ]
                                    pipe = redis_cluster.pipeline()
                                    for tup in ids_to_map:
                                        idv = tup[0]
                                        if idv:
                                            pipe.set(f"global_order_lookup:{idv}", can_id)
                                    await pipe.execute()

                                    # Backfill minimal order_data fields
                                    try:
                                        group_val = group_val or (lookup.get("user") or {}).get("group")
                                        symbol_val = symbol_val or (lookup.get("order") or {}).get("symbol")
                                        gcfg = lookup.get("group_config") or {}
                                        od_update = {}
                                        if group_val:
                                            od_update["group"] = str(group_val)
                                        if symbol_val:
                                            od_update["symbol"] = str(symbol_val).upper()
                                        if gcfg.get("type") is not None:
                                            od_update["type"] = str(gcfg.get("type"))
                                        if gcfg.get("contract_size") is not None:
                                            od_update["contract_size"] = str(gcfg.get("contract_size"))
                                        if gcfg.get("profit") is not None:
                                            od_update["profit"] = str(gcfg.get("profit"))
                                        if gcfg.get("spread") is not None:
                                            od_update["spread"] = str(gcfg.get("spread"))
                                        if gcfg.get("spread_pip") is not None:
                                            od_update["spread_pip"] = str(gcfg.get("spread_pip"))
                                        # Commission and group margin from groups config
                                        if gcfg.get("commision") is not None:
                                            od_update["commission_rate"] = str(gcfg.get("commision"))
                                        if gcfg.get("commision_type") is not None:
                                            od_update["commission_type"] = str(gcfg.get("commision_type"))
                                        if gcfg.get("commision_value_type") is not None:
                                            od_update["commission_value_type"] = str(gcfg.get("commision_value_type"))
                                        if gcfg.get("margin") is not None:
                                            od_update["group_margin"] = str(gcfg.get("margin"))
                                        if od_update:
                                            await redis_cluster.hset(f"order_data:{can_id}", mapping=od_update)
                                            od.update(od_update)
                                    except Exception:
                                        pass

                        # Attach group/symbol/spread if available; normalize report.order_id to canonical
                        if canonical_order_id:
                            report["order_id"] = str(canonical_order_id)
                        # Prefer report values, fallback to order_data
                        group_val = report.get("group") or od.get("group") or group_val
                        symbol_val = report.get("symbol") or od.get("symbol") or symbol_val
                        if group_val and symbol_val:
                            gkey = f"groups:{{{group_val}}}:{str(symbol_val).upper()}"
                            try:
                                ghash = await redis_cluster.hgetall(gkey)
                            except Exception:
                                ghash = {}
                            spread = ghash.get("spread") or od.get("spread")
                            spread_pip = ghash.get("spread_pip") or od.get("spread_pip")
                            report["group"] = str(group_val)
                            report["symbol"] = str(symbol_val).upper()
                            if spread is not None:
                                report["spread"] = spread
                            if spread_pip is not None:
                                report["spread_pip"] = spread_pip

                        # Attach group-level commission config snapshot for downstream workers (no computation here)
                        try:
                            if 'ghash' in locals():
                                if od.get("group_margin") is not None:
                                    report["group_margin"] = od.get("group_margin")
                                rate = (
                                    od.get("commission_rate")
                                    or ghash.get("commission_rate")
                                    or ghash.get("commission")
                                    or ghash.get("commision")
                                )
                                # Accept legacy misspelled keys as fallback
                                ctype = (
                                    od.get("commission_type")
                                    or od.get("commision_type")
                                    or ghash.get("commission_type")
                                    or ghash.get("commision_type")
                                )
                                vtype = (
                                    od.get("commission_value_type")
                                    or od.get("commision_value_type")
                                    or ghash.get("commission_value_type")
                                    or ghash.get("commision_value_type")
                                )
                                if rate is not None:
                                    report["commission_rate"] = rate
                                if ctype is not None:
                                    report["commission_type"] = ctype
                                if vtype is not None:
                                    report["commission_value_type"] = vtype
                        except Exception:
                            pass
                    except Exception:
                        # Enrichment is best-effort; proceed even if it fails
                        pass

                    await self._publisher.publish(report)
                    try:
                        logger.debug(
                            "Published ER to %s: order_id=%s ord_status=%s",
                            CONFIRMATION_QUEUE,
                            report.get("order_id"),
                            report.get("ord_status"),
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

    # ---- Connection helpers ----
    def is_connected(self) -> bool:
        """Return True if provider transport is currently connected."""
        return self._connected.is_set()

    async def wait_until_connected(self, timeout_sec: float) -> bool:
        """Wait up to timeout for connection. Returns True if connected, else False."""
        try:
            await asyncio.wait_for(self._connected.wait(), timeout=timeout_sec)
            return True
        except asyncio.TimeoutError:
            return False


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
