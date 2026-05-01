import os
import asyncio
import struct
import time
from typing import Any, Dict, List

import msgpack


LEN_HDR = 4


def pack_frame(obj: Dict[str, Any]) -> bytes:
    payload = msgpack.packb(obj, use_bin_type=True)
    return struct.pack("!I", len(payload)) + payload


async def send_reports_over_uds(uds_path: str, reports: List[Dict[str, Any]], delay_ms: int = 50) -> None:
    reader, writer = await asyncio.open_unix_connection(uds_path)
    try:
        for r in reports:
            writer.write(pack_frame(r))
            await writer.drain()
            await asyncio.sleep(delay_ms / 1000)
    finally:
        writer.close()
        await writer.wait_closed()


async def send_reports_over_tcp(host: str, port: int, reports: List[Dict[str, Any]], delay_ms: int = 50) -> None:
    reader, writer = await asyncio.open_connection(host, port)
    try:
        for r in reports:
            writer.write(pack_frame(r))
            await writer.drain()
            await asyncio.sleep(delay_ms / 1000)
    finally:
        writer.close()
        await writer.wait_closed()


def build_test_reports() -> List[Dict[str, Any]]:
    # Important: this must match what listener.py expects to unpack.
    # listener.py accepts either:
    # - {"fields": {...}}
    # - {"message": {...}}
    # - a flat dict
    # We'll send a flat dict for simplicity.
    return [
        {
            "type": "execution_report",
            "order_id": "9126113253000",
            "orig_cl_ord_id": None,
            "ord_status": "CANCELLED",
            "ord_type": "2",
            "symbol": "XAGUSD",
            "avgpx": "0",
            "cumqty": "50.0",
            "account_number": None,
            "side": "BUY",
            "reason": "shutdown",
            "ts": 1776807790537,
            "idempotency": "c4e728968fd15361",
        },
        {
            "type": "execution_report",
            "order_id": "9126113253000",
            "ord_status": "ACK",
            "ord_type": "2",
            "symbol": "XAGUSD",
            "side": "BUY",
            "avgpx": "74.975",
            "cumqty": "50.0",
            "account_number": None,
            "ts": 1776808816592,
            "_recovery_new_id": "0878642099000",
            "mode": "recovery",
        },
        {
            "type": "execution_report",
            "order_id": "9126113253000",
            "orig_cl_ord_id": None,
            "ord_status": "PENDING",
            "ord_type": "2",
            "symbol": "XAGUSD",
            "avgpx": "74.975",
            "cumqty": "50.0",
            "account_number": None,
            "side": "BUY",
            "reason": "",
            "ts": 1776808816592,
            "idempotency": "cd2a798338acc283",
            "_recovery_new_id": "0878642099000",
            "mode": "recovery",
        },
    ]


async def main() -> None:
    transport = os.getenv("EXEC_TRANSPORT", "uds").strip().lower()
    delay_ms = int(os.getenv("EXEC_SEND_DELAY_MS", "50"))

    reports = build_test_reports()

    if transport == "tcp":
        host = os.getenv("EXEC_TCP_HOST", "127.0.0.1")
        port = int(os.getenv("EXEC_TCP_PORT", "9001"))
        await send_reports_over_tcp(host, port, reports, delay_ms=delay_ms)
        return

    uds_path = os.getenv("EXEC_UDS_PATH", "/run/fx_exec/exec.sock")
    await send_reports_over_uds(uds_path, reports, delay_ms=delay_ms)


if __name__ == "__main__":
    asyncio.run(main())
