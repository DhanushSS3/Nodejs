#!/usr/bin/env python3
"""
Unit tests (script-run) for app/api/orders_api.py endpoint function

Run: python tests/test_orders_api.py
"""
import asyncio
from typing import Any, Dict

from fastapi import BackgroundTasks, HTTPException

from app.api.orders_api import instant_execute_order, _executor
from app.api.schemas.orders import InstantOrderRequest


async def test_endpoint_local_success():
    # Patch executor to return a successful local flow response
    async def _stub_exec(payload: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ok": True,
            "order_id": "o123",
            "order_status": "EXECUTED",
            "flow": "local",
            "exec_price": 1.2,
            "margin_usd": 12.0,
            "used_margin_usd": 12.0,
        }

    _executor.execute_instant_order = _stub_exec  # type: ignore

    req = InstantOrderRequest(
        symbol="eurusd",
        order_type="BUY",
        order_price=1.2345,
        order_quantity=1,
        user_id="u1",
        user_type="demo",
        idempotency_key="k1",
    )
    bt = BackgroundTasks()
    resp = await instant_execute_order(req, bt)
    assert resp["success"] is True
    assert resp["data"]["ok"] is True
    assert resp["data"]["flow"] == "local"


async def test_endpoint_provider_queues_background():
    # Patch executor to return provider payload
    async def _stub_exec(payload: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ok": True,
            "order_id": "o200",
            "order_status": "QUEUED",
            "flow": "provider",
            "exec_price": 1.2345,
            "margin_usd": 10.0,
            "used_margin_usd": 10.0,
            "provider_send_payload": {
                "order_id": "o200",
                "user_id": "u2",
                "user_type": "live",
                "symbol": "EURUSD",
                "order_type": "SELL",
                "order_quantity": 1,
                "order_price": 1.2345,
                "idempotency_key": "k2",
                "ts": 1234567890,
            },
        }

    _executor.execute_instant_order = _stub_exec  # type: ignore

    req = InstantOrderRequest(
        symbol="eurusd",
        order_type="SELL",
        order_price=1.2345,
        order_quantity=1,
        user_id="u2",
        user_type="live",
        idempotency_key="k2",
    )
    bt = BackgroundTasks()
    resp = await instant_execute_order(req, bt)
    assert resp["success"] is True
    assert resp["data"]["flow"] == "provider"


async def test_endpoint_maps_validation_errors_to_400():
    # Patch executor to return a validation error
    async def _stub_exec(payload: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "reason": "invalid_order_type"}

    _executor.execute_instant_order = _stub_exec  # type: ignore

    req = InstantOrderRequest(
        symbol="eurusd",
        order_type="BUY",  # Will be ignored by stub
        order_price=1.2345,
        order_quantity=1,
        user_id="u3",
        user_type="demo",
    )
    bt = BackgroundTasks()
    try:
        await instant_execute_order(req, bt)
        assert False, "Expected HTTPException with 400"
    except HTTPException as e:
        assert e.status_code == 400


async def test_endpoint_maps_idempotency_conflict_to_409():
    async def _stub_exec(payload: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "reason": "idempotency_in_progress"}

    _executor.execute_instant_order = _stub_exec  # type: ignore

    req = InstantOrderRequest(
        symbol="eurusd",
        order_type="SELL",
        order_price=1.0,
        order_quantity=1,
        user_id="u4",
        user_type="live",
        idempotency_key="k4",
    )
    bt = BackgroundTasks()
    try:
        await instant_execute_order(req, bt)
        assert False, "Expected HTTPException with 409"
    except HTTPException as e:
        assert e.status_code == 409


async def run_tests():
    await test_endpoint_local_success()
    print("✅ orders_api local flow test passed")
    await test_endpoint_provider_queues_background()
    print("✅ orders_api provider flow test passed")
    await test_endpoint_maps_validation_errors_to_400()
    print("✅ orders_api validation mapping test passed")
    await test_endpoint_maps_idempotency_conflict_to_409()
    print("✅ orders_api idempotency mapping test passed")


if __name__ == "__main__":
    asyncio.run(run_tests())
