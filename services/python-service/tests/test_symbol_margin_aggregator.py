#!/usr/bin/env python3
"""
Unit tests (script-run) for app/services/portfolio/symbol_margin_aggregator.py

Run: python tests/test_symbol_margin_aggregator.py
"""

from app.services.portfolio import symbol_margin_aggregator as agg


def run_tests():
    # Simple BUY/SELL single lot
    orders = [
        {"order_type": "BUY", "order_quantity": 1, "order_margin_usd": 10},
        {"order_type": "SELL", "order_quantity": 1, "order_margin_usd": 12},
    ]
    # net_qty = max(1,1)=1, per-lot margins=[10,12] -> 12
    m1 = agg.compute_symbol_margin(orders)
    assert abs(m1 - 12.0) < 1e-9, f"Expected 12.0, got {m1}"

    # Mixed quantities and per-lot margins
    orders2 = [
        {"order_type": "BUY", "order_quantity": 3, "order_margin_usd": 15},  # per lot = 5
        {"order_type": "SELL", "order_quantity": 2, "order_margin_usd": 18}, # per lot = 9
    ]
    # net_qty = max(3,2)=3; highest per-lot = 9 -> 27
    m2 = agg.compute_symbol_margin(orders2)
    assert abs(m2 - 27.0) < 1e-9, f"Expected 27.0, got {m2}"

    # Edge cases
    assert agg.compute_symbol_margin([]) == 0.0
    orders3 = [{"order_type": "BUY", "order_quantity": 0, "order_margin_usd": 10}]
    assert agg.compute_symbol_margin(orders3) == 0.0

    print("✅ test_symbol_margin_aggregator: all tests passed")


if __name__ == "__main__":
    run_tests()
