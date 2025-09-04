#!/usr/bin/env python3
"""
Unit tests (script-run) for app/services/portfolio/margin_calculator.py

Run: python tests/test_margin_calculator.py
"""
import asyncio

from app.services.portfolio import margin_calculator as mc


async def run_tests():
    # compute_contract_value
    assert mc.compute_contract_value(100, 2) == 200
    assert mc.compute_contract_value(None, 2) == 0.0

    # Non-crypto, USD profit
    margin = await mc.compute_single_order_margin(
        contract_size=1000,
        order_quantity=1,
        execution_price=1.2,
        profit_currency="USD",
        symbol="EURUSD",
        leverage=100,
        instrument_type=1,
        prices_cache={},
        crypto_margin_factor=None,
        strict=True,
    )
    assert abs(margin - 12.0) < 1e-9, f"Expected 12.0, got {margin}"

    # Crypto, USD profit
    margin2 = await mc.compute_single_order_margin(
        contract_size=1000,
        order_quantity=1,
        execution_price=1.2,
        profit_currency="USD",
        symbol="BTCUSD",
        leverage=100,
        instrument_type=4,
        prices_cache={},
        crypto_margin_factor=0.5,
        strict=True,
    )
    assert abs(margin2 - 6.0) < 1e-9, f"Expected 6.0, got {margin2}"

    # Strict: invalid leverage
    margin3 = await mc.compute_single_order_margin(
        contract_size=1000,
        order_quantity=1,
        execution_price=1.2,
        profit_currency="USD",
        symbol="EURUSD",
        leverage=0,
        instrument_type=1,
        prices_cache={},
        crypto_margin_factor=None,
        strict=True,
    )
    assert margin3 is None, f"Expected None for invalid leverage, got {margin3}"

    # Non-strict: missing contract_size -> treated as 0 -> margin 0
    margin4 = await mc.compute_single_order_margin(
        contract_size=None,
        order_quantity=1,
        execution_price=1.2,
        profit_currency="USD",
        symbol="EURUSD",
        leverage=100,
        instrument_type=1,
        prices_cache={},
        crypto_margin_factor=None,
        strict=False,
    )
    assert abs(margin4 - 0.0) < 1e-9, f"Expected 0.0, got {margin4}"

    print("✅ test_margin_calculator: all tests passed")


if __name__ == "__main__":
    asyncio.run(run_tests())
