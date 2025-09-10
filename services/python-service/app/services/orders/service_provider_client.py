import os
import asyncio
import logging
import struct
import time
from typing import Dict, Any, Tuple, Optional

import msgpack

logger = logging.getLogger(__name__)

from app.services.orders.provider_connection import get_provider_connection_manager, _PROVIDER_RX_LOG

class ProviderSendError(Exception):
    pass


# Configuration (env overrides)
UDS_PATH = os.getenv("EXEC_UDS_PATH", "/run/fx_exec/exec.sock")
TCP_HOST = os.getenv("EXEC_TCP_HOST", "127.0.0.1")
TCP_PORT = int(os.getenv("EXEC_TCP_PORT", "9001"))
PROVIDER_SEND_MODE = os.getenv("PROVIDER_SEND_MODE", "persistent").strip().lower()  # 'persistent' | 'direct'
PROVIDER_SEND_WAIT_SEC = float(os.getenv("PROVIDER_SEND_WAIT_SEC", "2.0"))
CONNECT_TIMEOUT_SEC = float(os.getenv("EXEC_CONNECT_TIMEOUT", "2.0"))
# Optional small window to read an immediate ACK without blocking long
ACK_READ_TIMEOUT_SEC = float(os.getenv("EXEC_ACK_READ_TIMEOUT", "0.3"))

LEN_HDR = 4


def _pack_message(obj: Dict[str, Any]) -> bytes:
    payload = msgpack.packb(obj, use_bin_type=True)
    return struct.pack("!I", len(payload)) + payload


async def _read_optional_message(reader: asyncio.StreamReader, timeout: float) -> Optional[Dict[str, Any]]:
    try:
        hdr = await asyncio.wait_for(reader.readexactly(LEN_HDR), timeout=timeout)
        (length,) = struct.unpack("!I", hdr)
        data = await asyncio.wait_for(reader.readexactly(length), timeout=timeout)
        return msgpack.unpackb(data, raw=False)
    except (asyncio.TimeoutError, asyncio.IncompleteReadError):
        return None
    except Exception as e:
        logger.warning("optional ack read failed: %s", e)
        return None


async def _send_over_stream(reader: asyncio.StreamReader, writer: asyncio.StreamWriter, payload: Dict[str, Any], transport: str) -> None:
    # Ensure required fields
    if "type" not in payload:
        payload["type"] = "order"
    if "ts" not in payload:
        payload["ts"] = int(time.time() * 1000)

    writer.write(_pack_message(payload))
    await writer.drain()

    # Try to peek an immediate ack without blocking too long (optional)
    try:
        ack = await _read_optional_message(reader, ACK_READ_TIMEOUT_SEC)
        if ack is not None:
            logger.debug("provider immediate ack: %s", ack)
            try:
                _PROVIDER_RX_LOG.info(f"transport={transport} dir=in ack={ack!r}")
            except Exception:
                pass
    except Exception as e:
        # Non-fatal; just log
        logger.debug("optional ack read failed: %s", e)


async def _try_send_uds(payload: Dict[str, Any]) -> Tuple[bool, str]:
    if os.name != "posix":
        # UDS not supported on Windows
        return False, "uds"
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(UDS_PATH), timeout=CONNECT_TIMEOUT_SEC)
    except Exception as e:
        logger.warning("UDS connect failed (%s): %s", UDS_PATH, e)
        return False, "uds"

    try:
        await _send_over_stream(reader, writer, payload, transport="UDS")
        return True, "uds"
    except Exception as e:
        logger.error("UDS send failed: %s", e)
        return False, "uds"
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def _try_send_tcp(payload: Dict[str, Any]) -> Tuple[bool, str]:
    try:
        reader, writer = await asyncio.wait_for(asyncio.open_connection(TCP_HOST, TCP_PORT), timeout=CONNECT_TIMEOUT_SEC)
    except Exception as e:
        logger.error("TCP connect failed (%s:%s): %s", TCP_HOST, TCP_PORT, e)
        return False, "tcp"

    try:
        await _send_over_stream(reader, writer, payload, transport="TCP")
        return True, "tcp"
    except Exception as e:
        logger.error("TCP send failed: %s", e)
        return False, "tcp"
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def send_provider_order(payload: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Preferred: enqueue on persistent provider connection manager (single long-lived socket
    for both send and receive). Fallback: direct UDS/TCP short connection.
    Returns (ok, sent_via) where sent_via is one of 'persistent', 'uds', 'tcp', 'none', or 'error'.
    """
    # Default: persistent manager with automatic reconnect
    try:
        mgr = get_provider_connection_manager()
        # Ensure connection is up; if not, wait briefly and then fail fast
        if not mgr.is_connected():
            ok_conn = await mgr.wait_until_connected(PROVIDER_SEND_WAIT_SEC)
            if not ok_conn:
                return False, "unavailable"
        await mgr.send(payload)
        return True, "persistent"
    except Exception as e:
        logger.error("provider manager enqueue failed (persistent mode): %s", e)
        # In persistent mode, do NOT fallback to direct; report unavailable
        return False, "unavailable"


async def send_provider_order_direct_with_timeout(payload: Dict[str, Any], timeout_sec: float = 5.0) -> Tuple[bool, str]:
    """
    Attempt to send directly via UDS or TCP within a total timeout window.
    Skips the persistent connection manager to ensure we only report success
    when a direct send has been performed in this call.

    Returns (ok, via) where via is one of 'uds', 'tcp', 'none', 'timeout', or 'error'.
    """
    async def _do_send() -> Tuple[bool, str]:
        ok, via = await _try_send_uds(payload)
        if ok:
            return True, via
        ok2, via2 = await _try_send_tcp(payload)
        if ok2:
            return True, via2
        return False, "none"

    try:
        return await asyncio.wait_for(_do_send(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        return False, "timeout"
    except Exception as e:
        logger.error("send_provider_order_direct_with_timeout error: %s", e)
        return False, "error"
