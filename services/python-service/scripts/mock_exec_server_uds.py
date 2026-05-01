import os
import asyncio
import struct
from typing import Any, Dict, List

import msgpack


LEN_HDR = 4


def pack_frame(obj: Dict[str, Any]) -> bytes:
    payload = msgpack.packb(obj, use_bin_type=True)
    return struct.pack("!I", len(payload)) + payload


def build_test_reports() -> List[Dict[str, Any]]:
    # Same payloads you provided. These will be msgpack encoded and framed.
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


async def handle_client(writer: asyncio.StreamWriter, reports: List[Dict[str, Any]], delay_ms: int) -> None:
    peer = writer.get_extra_info("peername")
    try:
        for msg in reports:
            writer.write(pack_frame(msg))
            await writer.drain()
            await asyncio.sleep(delay_ms / 1000)
    finally:
        try:
            writer.close()
            await writer.wait_closed()
        except Exception:
            pass


async def main() -> None:
    uds_path = os.getenv("MOCK_EXEC_UDS_PATH", "/tmp/mock_exec.sock")
    delay_ms = int(os.getenv("MOCK_EXEC_SEND_DELAY_MS", "50"))

    # Remove stale socket file if it exists
    try:
        if os.path.exists(uds_path):
            os.remove(uds_path)
    except Exception:
        pass

    reports = build_test_reports()

    async def _on_connect(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        await handle_client(writer, reports, delay_ms=delay_ms)

    server = await asyncio.start_unix_server(_on_connect, path=uds_path)

    # Ensure other processes can connect (optional)
    try:
        os.chmod(uds_path, 0o777)
    except Exception:
        pass

    try:
        print(f"Mock exec UDS server listening on: {uds_path}")
        async with server:
            await server.serve_forever()
    finally:
        try:
            server.close()
            await server.wait_closed()
        except Exception:
            pass
        try:
            if os.path.exists(uds_path):
                os.remove(uds_path)
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
