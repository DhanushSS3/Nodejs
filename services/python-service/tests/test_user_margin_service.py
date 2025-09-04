#!/usr/bin/env python3
"""
Unit tests (script-run) for app/services/portfolio/user_margin_service.py

Run: python tests/test_user_margin_service.py
"""
import asyncio
from typing import Any, Dict, List, Tuple

from app.services.portfolio import user_margin_service as ums


class MockRedis:
    def __init__(self):
        # simple in-memory dict store
        self._h: Dict[str, Dict[str, Any]] = {}
        self._prices: Dict[str, Tuple[Any, Any]] = {}
        self._scan_keys: List[str] = []

    # Hash operations
    async def hgetall(self, key):
        return dict(self._h.get(key, {}))

    async def hmget(self, key, fields):
        if key in self._prices:
            bid, ask = self._prices[key]
            out = []
            for f in fields:
                if f == "bid":
                    out.append(bid)
                elif f == "ask":
                    out.append(ask)
                else:
                    out.append(None)
            return out
        # fallback to hash for single field if present
        row = self._h.get(key, {})
        return [row.get(f) for f in fields]

    # SCAN mock for user holdings
    async def scan(self, cursor: bytes, match: str, count: int = 100):
        # one-shot scan returning all keys that match
        keys = [k for k in self._scan_keys if k.startswith(match[:-1])]  # remove trailing '*'
        return (b"0", keys)


async def run_tests():
    # Build mock
    r = MockRedis()

    # User config (hash-tagged)
    r._h["user:{live:1001}:config"] = {"group": "Standard", "leverage": "100"}

    # Group data (Standard)
    r._h["groups:{Standard}:EURUSD"] = {
        "contract_size": "1000",
        "profit": "USD",
        "type": "1",
    }

    # Orders for user (hash-tagged)
    r._scan_keys = [
        "user_holdings:{live:1001}:o1",
        "user_holdings:{live:1001}:o2",
    ]
    r._h["user_holdings:{live:1001}:o1"] = {
        "symbol": "EURUSD",
        "order_quantity": "1",
        "order_type": "BUY",
    }
    r._h["user_holdings:{live:1001}:o2"] = {
        "symbol": "EURUSD",
        "order_quantity": "0.5",
        "order_type": "SELL",
    }

    # Prices
    r._prices["market:EURUSD"] = ("1.1999", "1.2")

    # Monkeypatch module-level redis client
    ums.redis_cluster = r

    total, meta = await ums.compute_user_total_margin("live", "1001", strict=True)
    # Expected per-lot margin: (1000*1*1.2)/100 = 12; net qty max(1,0.5)=1 -> 12
    assert abs(total - 12.0) < 1e-9, f"Expected 12.0, got {total}"
    assert meta.get("fatal") is False
    assert meta.get("skipped_orders_count", 0) == 0
    assert meta.get("per_symbol", {}).get("EURUSD") and abs(meta["per_symbol"]["EURUSD"] - 12.0) < 1e-9

    print("✅ test_user_margin_service: all tests passed")


if __name__ == "__main__":
    asyncio.run(run_tests())
