import time
import logging
from typing import Any, Dict, Optional, Tuple, List

from app.services.price_utils import get_execution_price
from app.services.portfolio.margin_calculator import compute_single_order_margin
from app.services.portfolio.user_margin_service import compute_user_total_margin
from app.services.orders.order_repository import (
    fetch_user_config,
    fetch_user_portfolio,
    fetch_group_data,
    fetch_user_orders,
    place_order_atomic_or_fallback,
    get_idempotency,
    set_idempotency_placeholder,
    save_idempotency_result,
)
"""
Order execution orchestration service.

This module decides execution flow (local vs provider), performs validation,
margin checks, and persists orders atomically where possible. For provider
flows, it returns an async payload for the API layer to dispatch to the
external provider after state is persisted, preventing duplicate sends on
idempotent replays.
"""

logger = logging.getLogger(__name__)


class BaseExecutionStrategy:
    def __init__(self, req: Dict[str, Any]):
        self.req = req

    async def determine_exec_price(self, group: str) -> Tuple[bool, Optional[float], Dict[str, Any]]:
        raise NotImplementedError

    async def after_send(self, provider_meta: Dict[str, Any]):
        # Optional hook for provider flow
        return


class LocalExecutionStrategy(BaseExecutionStrategy):
    async def determine_exec_price(self, group: str) -> Tuple[bool, Optional[float], Dict[str, Any]]:
        symbol = self.req["symbol"]
        order_type = self.req["order_type"]
        price_res = await get_execution_price(group, symbol, order_type, strict=True)
        if not price_res.get("ok"):
            return False, None, {"reason": price_res.get("reason", "pricing_failed")}
        return True, float(price_res["exec_price"]), {
            "pricing": price_res,
            "sent_via": "local",
        }


class ProviderExecutionStrategy(BaseExecutionStrategy):
    async def determine_exec_price(self, group: str) -> Tuple[bool, Optional[float], Dict[str, Any]]:
        # Use price from request for initial margin check
        try:
            return True, float(self.req["order_price"]), {"sent_via": None}
        except Exception:
            return False, None, {"reason": "invalid_order_price"}

    async def after_send(self, provider_meta: Dict[str, Any]):
        # No-op here; endpoint orchestrator (API layer) will handle async send
        return


class OrderExecutor:
    def __init__(self):
        pass

    async def execute_instant_order(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        # 1) Basic validation
        missing = [k for k in ("symbol", "order_type", "order_price", "order_quantity", "user_id", "user_type") if k not in payload]
        if missing:
            return {"ok": False, "reason": "missing_fields", "fields": missing}

        symbol = str(payload["symbol"]).upper()
        # Accept either Enum or raw string for order_type/user_type
        def _val(x):
            return getattr(x, "value", x)
        order_type = str(_val(payload["order_type"])).upper()
        if order_type not in ("BUY", "SELL"):
            return {"ok": False, "reason": "invalid_order_type"}
        try:
            order_price = float(payload["order_price"])  # used only for provider strategy
            order_qty = float(payload["order_quantity"]) if payload.get("order_quantity") is not None else None
        except Exception:
            return {"ok": False, "reason": "invalid_numeric_fields"}
        if order_qty is None or order_qty <= 0:
            return {"ok": False, "reason": "invalid_order_quantity"}

        user_id = str(payload["user_id"])  # keep as string for Redis keys
        user_type = str(_val(payload["user_type"])).lower()  # 'live' or 'demo'
        # Normalize back into payload for downstream consumers
        payload["symbol"] = symbol
        payload["order_type"] = order_type
        payload["user_type"] = user_type
        order_id = str(payload.get("order_id") or f"PY{int(time.time()*1000)}")
        idempotency_key = payload.get("idempotency_key")
        frontend_status = payload.get("status")  # passthrough
        incoming_order_status = payload.get("order_status") or "OPEN"
        if incoming_order_status != "OPEN":
            return {"ok": False, "reason": "invalid_order_status"}

        # 2) Fetch user config
        cfg = await fetch_user_config(user_type, user_id)
        if int(cfg.get("status") or 0) == 0:
            return {"ok": False, "reason": "user_not_verified"}
        leverage = float(cfg.get("leverage") or 0.0)
        if leverage <= 0:
            return {"ok": False, "reason": "invalid_leverage"}
        group = cfg.get("group") or "Standard"
        sending_orders = (cfg.get("sending_orders") or "").strip().lower()

        # 3) Determine strategy
        if (user_type == "demo") or (user_type == "live" and sending_orders == "rock"):
            strategy: BaseExecutionStrategy = LocalExecutionStrategy(payload)
            flow = "local"
        elif user_type == "live" and sending_orders == "barclays":
            strategy = ProviderExecutionStrategy(payload)
            flow = "provider"
        else:
            return {"ok": False, "reason": "unsupported_flow", "details": {"user_type": user_type, "sending_orders": sending_orders}}

        # 4) Idempotency
        idem_key = None
        if idempotency_key:
            idem_key = f"idempotency:{user_type}:{user_id}:{idempotency_key}"
            prev = await get_idempotency(idem_key)
            if prev:
                return prev
            placed = await set_idempotency_placeholder(idem_key, ttl_sec=60)
            if not placed:
                # Someone else placed it; return stored or generic response
                prev2 = await get_idempotency(idem_key)
                if prev2:
                    return prev2
                return {"ok": False, "reason": "idempotency_in_progress"}

        # 5) Fetch group data
        g = await fetch_group_data(symbol, group)
        try:
            contract_size = float(g.get("contract_size")) if g.get("contract_size") is not None else None
        except (TypeError, ValueError):
            contract_size = None
        profit_currency = (g.get("profit") or None)
        try:
            instrument_type = int(g.get("type")) if g.get("type") is not None else 1
        except (TypeError, ValueError):
            instrument_type = 1
        try:
            crypto_margin_factor = float(g.get("crypto_margin_factor")) if g.get("crypto_margin_factor") is not None else None
        except (TypeError, ValueError):
            crypto_margin_factor = None

        if contract_size is None or not profit_currency:
            result = {"ok": False, "reason": "missing_group_data"}
            if idem_key:
                await save_idempotency_result(idem_key, result)
            return result

        # 6) Determine execution price based on strategy
        ok_px, exec_price, pricing_meta = await strategy.determine_exec_price(group)
        if not ok_px or exec_price is None:
            result = {"ok": False, "reason": pricing_meta.get("reason", "pricing_failed")}
            if idem_key:
                await save_idempotency_result(idem_key, result)
            return result

        # 7) Compute single order margin in USD
        margin_usd = await compute_single_order_margin(
            contract_size=contract_size,
            order_quantity=order_qty,
            execution_price=float(exec_price),
            profit_currency=(str(profit_currency).upper() if profit_currency else None),
            symbol=symbol,
            leverage=leverage,
            instrument_type=instrument_type,
            prices_cache={},
            crypto_margin_factor=crypto_margin_factor,
            strict=True,
        )
        if margin_usd is None:
            result = {"ok": False, "reason": "margin_calculation_failed"}
            if idem_key:
                await save_idempotency_result(idem_key, result)
            return result

        # 8) Free margin / balance check
        portfolio = await fetch_user_portfolio(user_type, user_id)
        fm = None
        try:
            if portfolio and portfolio.get("free_margin") is not None:
                fm = float(portfolio.get("free_margin"))
        except (TypeError, ValueError):
            fm = None
        balance = cfg.get("wallet_balance")

        # Decide compare source
        compare_value = fm if (fm is not None) else (float(balance) if balance is not None else 0.0)
        if compare_value < float(margin_usd):
            result = {
                "ok": False,
                "reason": "insufficient_margin",
                "required_margin": float(margin_usd),
                "available": float(compare_value),
                "source": "free_margin" if fm is not None else "wallet_balance",
            }
            if idem_key:
                await save_idempotency_result(idem_key, result)
            return result

        # 9) Recompute overall used margin including new order
        existing_orders = await fetch_user_orders(user_type, user_id)
        new_order_for_calc = {
            "order_id": order_id,
            "symbol": symbol,
            "order_type": order_type,
            "order_quantity": order_qty,
        }
        orders_for_calc: List[Dict[str, Any]] = existing_orders + [new_order_for_calc]
        total_used_margin, meta = await compute_user_total_margin(
            user_type=user_type,
            user_id=user_id,
            orders=orders_for_calc,
            prices_cache=None,
            strict=True,
        )
        if total_used_margin is None:
            result = {"ok": False, "reason": "overall_margin_failed", "meta": meta}
            if idem_key:
                await save_idempotency_result(idem_key, result)
            return result

        # 10) Compute notional contract value (instrument-dependent; generic formula)
        try:
            contract_value = float(contract_size) * float(order_qty)
        except Exception:
            contract_value = None

        # 11) Prepare order fields for Redis
        now_ms = int(time.time() * 1000)
        execution_status = "EXECUTED" if flow == "local" else "QUEUED"
        displayed_status = "OPEN" if flow == "local" else "QUEUED"
        order_fields: Dict[str, Any] = {
            "order_id": order_id,
            "symbol": symbol,
            "order_type": order_type,
            "order_status": displayed_status,
            "status": frontend_status or "OPEN",
            "order_price": exec_price,
            "order_quantity": order_qty,
            "margin": float(margin_usd),
            "contract_value": float(contract_value) if contract_value is not None else None,
            "execution": flow,
            "execution_status": execution_status,
            "created_at": now_ms,
        }
        if pricing_meta.get("pricing"):
            price_info = pricing_meta["pricing"]
            order_fields.update({
                "raw_price": price_info.get("raw_price"),
                "half_spread": price_info.get("half_spread"),
                "group": price_info.get("group"),
            })

        # 12) Provider async send payload (API layer will dispatch in background)
        provider_send_payload = None
        if flow == "provider":
            provider_send_payload = {
                "order_id": order_id,
                "user_id": user_id,
                "user_type": user_type,
                "symbol": symbol,
                "order_type": order_type,
                "order_quantity": order_qty,
                "order_price": exec_price,
                "idempotency_key": idempotency_key,
                "ts": now_ms,
            }

        # 13) Place order in Redis (atomic Lua or fallback), update used_margin
        ok_place, reason = await place_order_atomic_or_fallback(
            user_type=user_type,
            user_id=user_id,
            order_id=order_id,
            symbol=symbol,
            order_fields=order_fields,
            single_order_margin_usd=float(margin_usd),
            recomputed_user_used_margin_usd=float(total_used_margin),
        )
        if not ok_place:
            result = {"ok": False, "reason": f"place_order_failed:{reason}"}
            if idem_key:
                await save_idempotency_result(idem_key, result)
            return result

        # 14) Success response
        resp = {
            "ok": True,
            "order_id": order_id,
            "order_status": displayed_status,
            "flow": flow,
            "exec_price": exec_price,
            "margin_usd": float(margin_usd),
            "used_margin_usd": float(total_used_margin),
            "contract_value": float(contract_value) if contract_value is not None else None,
        }
        if provider_send_payload:
            # Return payload to API layer for background dispatch
            resp["provider_send_payload"] = provider_send_payload

        # Sanitize result for idempotency storage to avoid re-triggering async send
        idem_resp = dict(resp)
        idem_resp.pop("provider_send_payload", None)
        if idem_key:
            await save_idempotency_result(idem_key, idem_resp)
        return resp

