#!/usr/bin/env python3
"""
Unit tests (script-run) for app/services/orders/order_execution_service.py

Run: python tests/test_order_execution_service.py
"""
import asyncio
from typing import Any, Dict, Tuple

from app.services.orders import order_execution_service as oes


class _Recorder:
    def __init__(self):
        self.saved_idem: Dict[str, Dict[str, Any]] = {}

    async def save(self, key: str, result: Dict[str, Any], ttl_sec: int = 300):
        self.saved_idem[key] = result


async def _setup_common_mocks_local(rec: _Recorder):
    # Minimal mocks to drive local flow
    async def fetch_user_config(user_type: str, user_id: str) -> Dict[str, Any]:
        return {
            "wallet_balance": 10000,
            "leverage": 100,
            "group": "Standard",
            "status": 1,
            "sending_orders": "rock",
        }

    async def fetch_group_data(symbol: str, group: str) -> Dict[str, Any]:
        return {
            "contract_size": "1000",
            "profit": "USD",
            "type": "1",
        }

    async def fetch_user_portfolio(user_type: str, user_id: str) -> Dict[str, Any]:
        return {"free_margin": "999999"}

    async def fetch_user_orders(user_type: str, user_id: str):
        return []

    async def get_execution_price(group: str, symbol: str, order_type: str, strict: bool = True):
        return {"ok": True, "exec_price": 1.2, "raw_price": 1.2, "half_spread": 0.00005, "group": group}

    async def compute_single_order_margin(**kwargs) -> float:
        # (contract_size * qty * price)/leverage
        cs = float(kwargs["contract_size"]) if kwargs.get("contract_size") else 1000
        qty = float(kwargs["order_quantity"]) if kwargs.get("order_quantity") else 1
        px = float(kwargs["execution_price"]) if kwargs.get("execution_price") else 1.2
        lev = float(kwargs["leverage"]) if kwargs.get("leverage") else 100
        return (cs * qty * px) / lev

    async def compute_user_total_margin(**kwargs) -> Tuple[float, Dict[str, Any]]:
        # return same as single order margin for simplicity
        return 12.0, {"fatal": False}

    async def place_order_atomic_or_fallback(**kwargs) -> Tuple[bool, str]:
        return True, ""

    async def get_idempotency(key: str):
        return None

    async def set_idempotency_placeholder(key: str, ttl_sec: int = 60) -> bool:
        return True

    # Monkeypatch into module
    oes.fetch_user_config = fetch_user_config
    oes.fetch_group_data = fetch_group_data
    oes.fetch_user_portfolio = fetch_user_portfolio
    oes.fetch_user_orders = fetch_user_orders
    oes.get_execution_price = get_execution_price
    oes.compute_single_order_margin = compute_single_order_margin
    oes.compute_user_total_margin = compute_user_total_margin
    oes.place_order_atomic_or_fallback = place_order_atomic_or_fallback
    oes.get_idempotency = get_idempotency
    oes.set_idempotency_placeholder = set_idempotency_placeholder
    oes.save_idempotency_result = rec.save


async def _setup_common_mocks_provider(rec: _Recorder):
    # Similar to local but provider flow
    async def fetch_user_config(user_type: str, user_id: str) -> Dict[str, Any]:
        return {
            "wallet_balance": 10000,
            "leverage": 100,
            "group": "Standard",
            "status": 1,
            "sending_orders": "barclays",
        }

    async def fetch_group_data(symbol: str, group: str) -> Dict[str, Any]:
        return {
            "contract_size": "1000",
            "profit": "USD",
            "type": "1",
        }

    async def fetch_user_portfolio(user_type: str, user_id: str) -> Dict[str, Any]:
        return {"free_margin": "999999"}

    async def fetch_user_orders(user_type: str, user_id: str):
        return []

    async def compute_single_order_margin(**kwargs) -> float:
        return 10.0

    async def compute_user_total_margin(**kwargs) -> Tuple[float, Dict[str, Any]]:
        return 10.0, {"fatal": False}

    async def place_order_atomic_or_fallback(**kwargs) -> Tuple[bool, str]:
        return True, ""

    async def get_idempotency(key: str):
        return None

    async def set_idempotency_placeholder(key: str, ttl_sec: int = 60) -> bool:
        return True

    # Monkeypatch into module
    oes.fetch_user_config = fetch_user_config
    oes.fetch_group_data = fetch_group_data
    oes.fetch_user_portfolio = fetch_user_portfolio
    oes.fetch_user_orders = fetch_user_orders
    # provider flow does not call get_execution_price
    oes.compute_single_order_margin = compute_single_order_margin
    oes.compute_user_total_margin = compute_user_total_margin
    oes.place_order_atomic_or_fallback = place_order_atomic_or_fallback
    oes.get_idempotency = get_idempotency
    oes.set_idempotency_placeholder = set_idempotency_placeholder
    oes.save_idempotency_result = rec.save


async def test_local_flow_success():
    rec = _Recorder()
    await _setup_common_mocks_local(rec)
    executor = oes.OrderExecutor()
    payload = {
        "symbol": "EURUSD",
        "order_type": "BUY",
        "order_price": 1.2345,  # ignored in local flow
        "order_quantity": 1,
        "user_id": "u1",
        "user_type": "demo",
        "idempotency_key": "k1",
    }
    res = await executor.execute_instant_order(payload)
    assert res["ok"] is True
    assert res["flow"] == "local"
    assert res["order_status"] == "EXECUTED"
    assert abs(res["margin_usd"] - 12.0) < 1e-9
    # Idempotency should be saved without error
    idem_key = f"idempotency:demo:u1:k1"
    assert idem_key in rec.saved_idem


async def test_provider_flow_returns_payload_and_sanitizes_idem():
    rec = _Recorder()
    await _setup_common_mocks_provider(rec)
    executor = oes.OrderExecutor()
    payload = {
        "symbol": "EURUSD",
        "order_type": "SELL",
        "order_price": 1.2345,
        "order_quantity": 2,
        "user_id": "u2",
        "user_type": "live",
        "idempotency_key": "k2",
    }
    res = await executor.execute_instant_order(payload)
    assert res["ok"] is True
    assert res["flow"] == "provider"
    assert res["order_status"] == "QUEUED"
    assert "provider_send_payload" in res
    # Saved idempotency result must NOT contain provider_send_payload
    idem_key = f"idempotency:live:u2:k2"
    saved = rec.saved_idem.get(idem_key)
    assert saved is not None
    assert "provider_send_payload" not in saved


async def test_idempotent_replay_returns_previous():
    rec = _Recorder()
    # Provide get_idempotency to return a stored result
    prev_resp = {"ok": True, "flow": "local", "order_status": "EXECUTED", "order_id": "abc"}

    async def get_idempotency(key: str):
        return prev_resp

    async def set_idempotency_placeholder(key: str, ttl_sec: int = 60) -> bool:
        return False

    oes.get_idempotency = get_idempotency
    oes.set_idempotency_placeholder = set_idempotency_placeholder

    # Other mocks to satisfy code path, though should short-circuit
    async def fetch_user_config(user_type: str, user_id: str) -> Dict[str, Any]:
        return {"status": 1, "leverage": 100, "group": "Standard", "sending_orders": "rock"}

    oes.fetch_user_config = fetch_user_config

    executor = oes.OrderExecutor()
    payload = {
        "symbol": "EURUSD",
        "order_type": "BUY",
        "order_price": 1.2,
        "order_quantity": 1,
        "user_id": "u3",
        "user_type": "demo",
        "idempotency_key": "k3",
    }
    res = await executor.execute_instant_order(payload)
    assert res is prev_resp


async def run_tests():
    await test_local_flow_success()
    print("✅ local flow test passed")
    await test_provider_flow_returns_payload_and_sanitizes_idem()
    print("✅ provider flow test passed")
    await test_idempotent_replay_returns_previous()
    print("✅ idempotency replay test passed")


if __name__ == "__main__":
    asyncio.run(run_tests())
