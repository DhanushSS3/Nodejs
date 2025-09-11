import time
import logging
from typing import Any, Dict, Optional, Tuple, List

from app.services.price_utils import get_execution_price
from app.services.portfolio.margin_calculator import compute_single_order_margin
from app.services.orders.commission_calculator import compute_entry_commission
from app.services.groups.group_config_helper import get_group_config_with_fallback
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
from app.services.orders.order_registry import (
    create_canonical_order,
    add_lifecycle_id,
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
        # Resolve required fields with Redis-first and DB fallback
        gfb = await get_group_config_with_fallback(group, symbol)
        # Prefer Redis group values; fallback to DB response
        # contract_size
        contract_size = None
        raw_cs = g.get("contract_size") if g.get("contract_size") is not None else gfb.get("contract_size")
        if raw_cs is not None:
            try:
                contract_size = float(raw_cs)
            except (TypeError, ValueError):
                contract_size = None
        # profit currency
        profit_currency = g.get("profit") or gfb.get("profit") or None
        # instrument type
        try:
            instrument_type = int(g.get("type") if g.get("type") is not None else (gfb.get("type") if gfb.get("type") is not None else 1))
        except (TypeError, ValueError):
            instrument_type = 1
        # crypto margin factor (DB may not have it; best-effort from Redis)
        try:
            crypto_margin_factor = float(g.get("crypto_margin_factor")) if g.get("crypto_margin_factor") is not None else None
        except (TypeError, ValueError):
            crypto_margin_factor = None

        # Commission config (normalized by group_config_helper)
        def _empty_to_none(x):
            if x is None:
                return None
            try:
                xs = x.decode() if isinstance(x, (bytes, bytearray)) else str(x)
                return None if xs.strip() == "" else x
            except Exception:
                return x
        def _f(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
        def _i(v):
            try:
                return int(v)
            except (TypeError, ValueError):
                return None
        # Read from Redis group hash first (g), else DB/normalized fallback (gfb)
        rate_raw = (
            g.get("commission_rate") if g.get("commission_rate") is not None else
            (g.get("commission") if g.get("commission") is not None else g.get("commision"))
        )
        if rate_raw is None:
            rate_raw = gfb.get("commission_rate") or gfb.get("commission") or gfb.get("commision")
        rate_raw = _empty_to_none(rate_raw)
        commission_rate = _f(rate_raw)

        ctype_raw = (
            g.get("commission_type") if g.get("commission_type") is not None else g.get("commision_type")
        )
        if ctype_raw is None:
            ctype_raw = gfb.get("commission_type") or gfb.get("commision_type")
        ctype_raw = _empty_to_none(ctype_raw)
        commission_type = _i(ctype_raw)

        vtype_raw = (
            g.get("commission_value_type") if g.get("commission_value_type") is not None else g.get("commision_value_type")
        )
        if vtype_raw is None:
            vtype_raw = gfb.get("commission_value_type") or gfb.get("commision_value_type")
        vtype_raw = _empty_to_none(vtype_raw)
        commission_value_type = _i(vtype_raw)
        group_margin_cfg = _f(g.get("group_margin") if g.get("group_margin") is not None else gfb.get("group_margin"))

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
        
        # Get current used_margin_all (includes queued orders)
        current_used_margin_all = 0.0
        try:
            if portfolio and portfolio.get("used_margin_all") is not None:
                current_used_margin_all = float(portfolio.get("used_margin_all"))
        except (TypeError, ValueError):
            current_used_margin_all = 0.0
        
        balance = float(cfg.get("wallet_balance") or 0.0)
        
        # Calculate free margin considering all orders (including queued)
        free_margin_with_queued = balance - current_used_margin_all
        
        if free_margin_with_queued < float(margin_usd):
            result = {
                "ok": False,
                "reason": "insufficient_margin",
                "required_margin": float(margin_usd),
                "available": float(free_margin_with_queued),
                "current_used_margin_all": float(current_used_margin_all),
                "balance": float(balance),
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
            "order_status": "QUEUED" if flow == "provider" else "OPEN",
            "execution_status": "QUEUED" if flow == "provider" else "EXECUTED",
        }
        orders_for_calc: List[Dict[str, Any]] = existing_orders + [new_order_for_calc]
        
        # Calculate both executed and total margins
        executed_margin, total_margin_with_queued, meta = await compute_user_total_margin(
            user_type=user_type,
            user_id=user_id,
            orders=orders_for_calc,
            prices_cache=None,
            strict=True,
            include_queued=True,
        )
        
        if total_margin_with_queued is None:
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
        # Commission entry for local execution (charged on entry for types [0,1])
        commission_entry = None
        if flow == "local":
            commission_entry = compute_entry_commission(
                commission_rate=commission_rate,
                commission_type=commission_type,
                commission_value_type=commission_value_type,
                quantity=order_qty,
                order_price=float(exec_price),
                contract_size=contract_size,
            )

        # (Removed temporary debug logging)

        order_fields: Dict[str, Any] = {
            "order_id": order_id,
            "symbol": symbol,
            "order_type": order_type,
            "order_status": displayed_status,
            "status": frontend_status or "OPEN",
            "order_price": exec_price,
            "order_quantity": order_qty,
            # For provider flow we reserve margin; for local immediate execution we set final margin
            **({"margin": float(margin_usd)} if flow == "local" else {}),
            **({"reserved_margin": float(margin_usd)} if flow == "provider" else {}),
            "contract_value": float(contract_value) if contract_value is not None else None,
            "execution": flow,
            "execution_status": execution_status,
            "created_at": now_ms,
            # Persist commission config snapshot for the order (immutable at open)
            **({"commission_rate": commission_rate} if commission_rate is not None else {}),
            **({"commission_type": commission_type} if commission_type is not None else {}),
            **({"commission_value_type": commission_value_type} if commission_value_type is not None else {}),
            **({"group_margin": group_margin_cfg} if group_margin_cfg is not None else {}),
            **({"commission_entry": commission_entry} if commission_entry is not None else {}),
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
                "status": "OPEN",
                "order_type": order_type,
                "order_quantity": order_qty,
                "order_price": exec_price,
                "contract_value": float(contract_value) if contract_value is not None else None,
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
            recomputed_user_used_margin_executed=float(executed_margin),
            recomputed_user_used_margin_all=float(total_margin_with_queued),
        )
        if not ok_place:
            result = {"ok": False, "reason": f"place_order_failed:{reason}"}
            if idem_key:
                await save_idempotency_result(idem_key, result)
            return result

        # 14) For provider flow, create/update canonical order hash and global lookups
        if flow == "provider":
            try:
                # Build canonical order record with required fields
                # Merge spread/spread_pip from fallback config when available
                spread_val = g.get("spread") or gfb.get("spread")
                spread_pip_val = g.get("spread_pip") or gfb.get("spread_pip")

                canonical: Dict[str, Any] = {
                    # Order IDs
                    "order_id": order_id,
                    # User info
                    "user_id": user_id,
                    "user_type": user_type,
                    "group": group,
                    "leverage": leverage,
                    # Instrument / group data (best-effort from fetched group hash)
                    "type": instrument_type,
                    "spread": spread_val if spread_val is not None else None,
                    "spread_pip": spread_pip_val if spread_pip_val is not None else None,
                    "contract_size": contract_size if contract_size is not None else None,
                    "profit": profit_currency,
                    # Commission config snapshot and group-level margin config
                    "commission_rate": commission_rate,
                    "commission_type": commission_type,
                    "commission_value_type": commission_value_type,
                    "group_margin": group_margin_cfg,
                    # Order metadata
                    "execution": flow,
                    "execution_status": execution_status,
                    "created_at": now_ms,
                    # Engine-level state vs UI-level state
                    "order_status": displayed_status,
                    "status": (frontend_status or "OPEN"),
                    # Additional pricing/margin fields useful for WS/UI
                    "symbol": symbol,
                    "order_type": order_type,
                    "order_price": exec_price,
                    "order_quantity": order_qty,
                    # For provider flow, do not store final margin yet; reserve it
                    **({"margin": float(margin_usd)} if flow == "local" else {}),
                    **({"reserved_margin": float(margin_usd)} if flow == "provider" else {}),
                    "contract_value": float(contract_value) if contract_value is not None else None,
                    # Commission entry only for local immediate execution
                    **({"commission_entry": commission_entry} if commission_entry is not None else {}),
                }

                # Merge any pricing metadata we already computed
                if pricing_meta.get("pricing"):
                    price_info = pricing_meta["pricing"]
                    canonical.update({
                        "raw_price": price_info.get("raw_price"),
                        "half_spread": price_info.get("half_spread"),
                    })

                # Include any lifecycle IDs provided in payload (if any already exist)
                lifecycle_fields = [
                    "close_id",
                    "modify_id",
                    "cancel_id",
                    "takeprofit_id",
                    "stoploss_id",
                    "takeprofit_cancel_id",
                    "stoploss_cancel_id",
                ]
                provided_extra_ids: Dict[str, str] = {}
                for f in lifecycle_fields:
                    if payload.get(f):
                        val = str(payload.get(f))
                        canonical[f] = val
                        provided_extra_ids[f] = val

                # Persist canonical record and self-lookup for order_id
                await create_canonical_order(canonical)

                # Create global lookups for any extra IDs already generated
                for field_name, the_id in provided_extra_ids.items():
                    try:
                        await add_lifecycle_id(order_id, the_id, field_name)
                    except Exception as id_err:
                        logger.warning("add_lifecycle_id failed for %s=%s on %s: %s", field_name, the_id, order_id, id_err)
            except Exception as reg_err:
                # Non-fatal; continue flow, but log for observability
                logger.error("canonical order registry update failed for %s: %s", order_id, reg_err)

        # 15) Success response
        resp = {
            "ok": True,
            "order_id": order_id,
            "order_status": displayed_status,
            "flow": flow,
            "exec_price": exec_price,
            "margin_usd": float(margin_usd),
            "used_margin_executed": float(executed_margin),
            "used_margin_all": float(total_margin_with_queued),
            "contract_value": float(contract_value) if contract_value is not None else None,
            **({"commission_entry": commission_entry} if commission_entry is not None else {}),
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

