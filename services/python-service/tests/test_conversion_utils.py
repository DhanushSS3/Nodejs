#!/usr/bin/env python3
"""
Unit tests (script-run) for app/services/portfolio/conversion_utils.py
- Validates direct and inverse cache conversions using ask price
- Validates Redis fallback via mocked redis_cluster.hmget
- Validates strict vs non-strict behavior for unknown pairs

Run: python tests/test_conversion_utils.py
"""
import asyncio

from app.services.portfolio import conversion_utils as conv_mod


class MockRedis:
    async def hmget(self, key, fields):
        # Simulate only JPYUSD existing in Redis with ask=0.009
        if key == "market:JPYUSD" and fields == ["ask"]:
            return ["0.009"]
        return [None]


async def run_tests():
    # Monkeypatch redis_cluster in module
    conv_mod.redis_cluster = MockRedis()

    # 1) Direct pair in cache: CADUSD ask=0.75
    prices_cache = {
        "CADUSD": {"ask": 0.75},
    }
    usd = await conv_mod.convert_to_usd(100, "CAD", prices_cache=prices_cache, strict=True)
    assert abs(usd - 75.0) < 1e-6, f"Expected 75.0, got {usd}"

    # 2) Inverse pair in cache: USDCAD ask=1.3333 (100 CAD -> 100/1.3333 USD)
    prices_cache2 = {
        "USDCAD": {"ask": 1.3333},
    }
    usd2 = await conv_mod.convert_to_usd(100, "CAD", prices_cache=prices_cache2, strict=True)
    assert abs(usd2 - 75.0) < 1e-2, f"Expected ~75.0, got {usd2}"

    # 3) Redis fallback: JPYUSD ask=0.009 => 1000 JPY -> 9 USD
    usd3 = await conv_mod.convert_to_usd(1000, "JPY", prices_cache={}, strict=True)
    assert abs(usd3 - 9.0) < 1e-6, f"Expected 9.0, got {usd3}"

    # 4) Non-strict unknown: return original amount
    usd4 = await conv_mod.convert_to_usd(50, "ABC", prices_cache={}, strict=False)
    assert abs(usd4 - 50.0) < 1e-6, f"Expected 50.0, got {usd4}"

    print("✅ test_conversion_utils: all tests passed")


if __name__ == "__main__":
    asyncio.run(run_tests())
