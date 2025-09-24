import os
from fastapi import APIRouter, HTTPException, BackgroundTasks, Depends, Header, Request
from typing import Dict, Any
import logging
import time

from ..services.orders.order_execution_service import OrderExecutor
from ..services.orders.order_close_service import OrderCloser
from ..services.orders.stoploss_service import StopLossService
from ..services.orders.takeprofit_service import TakeProfitService
from ..services.orders.service_provider_client import send_provider_order
from ..services.orders.order_repository import fetch_user_orders, save_idempotency_result, fetch_group_data
from ..services.portfolio.user_margin_service import compute_user_total_margin
from ..config.redis_config import redis_cluster
from ..services.orders.order_registry import add_lifecycle_id
from ..services.logging.timing_logger import get_orders_timing_logger
from ..services.logging.error_logger import ErrorLogger
from .schemas.orders import (
    InstantOrderRequest,
    InstantOrderResponse,
    CloseOrderRequest,
    CloseOrderResponse,
    FinalizeCloseRequest,
    StopLossSetRequest,
    StopLossSetResponse,
    TakeProfitSetRequest,
    TakeProfitSetResponse,
    StopLossCancelRequest,
    TakeProfitCancelRequest,
)

logger = logging.getLogger(__name__)
timing_log = get_orders_timing_logger()

# Internal provider secret guard (header: X-Internal-Auth)
def _require_internal_auth(x_internal_auth: str = Header(None, alias="X-Internal-Auth")):
    # Fallback to default key 'livefxhub' if env variables are not set.
    secret = os.getenv("INTERNAL_PROVIDER_SECRET") or os.getenv("INTERNAL_API_SECRET") or "livefxhub"
    if not x_internal_auth or x_internal_auth != secret:
        raise HTTPException(status_code=401, detail={"success": False, "message": "Unauthorized (internal)"})

router = APIRouter(prefix="/orders", tags=["Orders"], dependencies=[Depends(_require_internal_auth)])

_executor = OrderExecutor()
_closer = OrderCloser()
_sl_service = StopLossService()
_tp_service = TakeProfitService()


@router.post("/instant/execute", response_model=InstantOrderResponse)
async def instant_execute_order(request: Request, payload: InstantOrderRequest, background_tasks: BackgroundTasks):
    """
    Unified endpoint for instant order execution.
    Supports local (demo/Rock) and provider (barclays) flows.
    """
    t0 = time.perf_counter()
    exec_done = None
    provider_send_done = None
    cleanup_done = None
    try:
        # Dump in JSON mode so Enum fields (order_type, user_type) are converted to their string values
        result = await _executor.execute_instant_order(payload.model_dump(mode="json"))
        exec_done = time.perf_counter()
        if not result.get("ok"):
            # Map common reasons to HTTP codes if needed
            reason = result.get("reason", "execution_failed")
            # For validation errors, return 400
            if reason in ("missing_fields", "invalid_order_type", "invalid_numeric_fields", "invalid_order_quantity", "invalid_order_status"):
                # timing log (error)
                try:
                    timing_log.info(__import__("orjson").dumps({
                        "component": "python_api",
                        "endpoint": "orders/instant/execute",
                        "status": "error",
                        "reason": reason,
                        "durations_ms": { "executor_ms": int(((exec_done or time.perf_counter()) - t0) * 1000) }
                    }).decode())
                except Exception:
                    pass
                raise HTTPException(status_code=400, detail=result)
            # For margin/user issues and unsupported flow, return 400
            if reason in ("user_not_verified", "invalid_leverage", "missing_group_data", "insufficient_margin", "unsupported_flow"):
                try:
                    timing_log.info(__import__("orjson").dumps({
                        "component": "python_api",
                        "endpoint": "orders/instant/execute",
                        "status": "error",
                        "reason": reason,
                        "durations_ms": { "executor_ms": int(((exec_done or time.perf_counter()) - t0) * 1000) }
                    }).decode())
                except Exception:
                    pass
                raise HTTPException(status_code=400, detail=result)
            # For idempotency in-progress, 409 could be used
            if reason in ("idempotency_in_progress",):
                try:
                    timing_log.info(__import__("orjson").dumps({
                        "component": "python_api",
                        "endpoint": "orders/instant/execute",
                        "status": "error",
                        "reason": reason,
                        "durations_ms": { "executor_ms": int(((exec_done or time.perf_counter()) - t0) * 1000) }
                    }).decode())
                except Exception:
                    pass
                raise HTTPException(status_code=409, detail=result)
            # Duplicate order_id attempts
            if reason == "place_order_failed:order_exists":
                try:
                    timing_log.info(__import__("orjson").dumps({
                        "component": "python_api",
                        "endpoint": "orders/instant/execute",
                        "status": "error",
                        "reason": reason,
                        "durations_ms": { "executor_ms": int(((exec_done or time.perf_counter()) - t0) * 1000) }
                    }).decode())
                except Exception:
                    pass
                raise HTTPException(status_code=409, detail=result)
            # Otherwise server error
            try:
                timing_log.info(__import__("orjson").dumps({
                    "component": "python_api",
                    "endpoint": "orders/instant/execute",
                    "status": "error",
                    "reason": reason,
                    "durations_ms": { "executor_ms": int(((exec_done or time.perf_counter()) - t0) * 1000) }
                }).decode())
            except Exception:
                pass
            raise HTTPException(status_code=500, detail=result)

        # If provider flow, send via persistent connection. If not connected within wait window, auto-reject.
        provider_payload = result.get("provider_send_payload")
        if provider_payload:
            order_id = str(provider_payload.get("order_id"))
            user_id = str(provider_payload.get("user_id"))
            user_type = str(provider_payload.get("user_type"))
            symbol = str(provider_payload.get("symbol") or "").upper()
            try:
                ok, via = await send_provider_order(provider_payload)
                provider_send_done = time.perf_counter()
            except Exception as e:
                logger.error(f"Persistent provider send exception for {order_id}: {e}")
                ok, via = False, "error"

            if not ok:
                # Auto-reject: delete Redis keys, recompute margins, cleanup symbol holders
                try:
                    hash_tag = f"{user_type}:{user_id}"
                    order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
                    order_data_key = f"order_data:{order_id}"
                    portfolio_key = f"user_portfolio:{{{hash_tag}}}"
                    index_key = f"user_orders_index:{{{hash_tag}}}"

                    # Remove from index and delete order keys
                    pipe = redis_cluster.pipeline()
                    pipe.srem(index_key, order_id)
                    pipe.delete(order_key)
                    pipe.delete(order_data_key)
                    await pipe.execute()

                    # Recompute margins without this order
                    orders = await fetch_user_orders(user_type, user_id)
                    filtered_orders = [od for od in orders if str(od.get("order_id")) != order_id]
                    executed_margin, total_margin, _ = await compute_user_total_margin(
                        user_type=user_type,
                        user_id=user_id,
                        orders=filtered_orders,
                        prices_cache=None,
                        strict=False,
                        include_queued=True,
                    )
                    margin_updates = {}
                    if executed_margin is not None:
                        margin_updates["used_margin_executed"] = str(float(executed_margin))
                        margin_updates["used_margin"] = str(float(executed_margin))  # legacy
                    if total_margin is not None:
                        margin_updates["used_margin_all"] = str(float(total_margin))
                    if margin_updates:
                        await redis_cluster.hset(portfolio_key, mapping=margin_updates)

                    # Symbol holders cleanup if no more orders for the same symbol
                    if symbol:
                        any_same_symbol = any(str(od.get("symbol", "")).upper() == symbol for od in filtered_orders)
                        if not any_same_symbol:
                            sym_set = f"symbol_holders:{symbol}:{user_type}"
                            await redis_cluster.srem(sym_set, hash_tag)
                except Exception as rej_err:
                    logger.error(f"Auto-reject cleanup failed for order {order_id}: {rej_err}")

                # Overwrite idempotency to failure to avoid stale success on replay
                try:
                    idem_key = provider_payload.get("idempotency_key")
                    if idem_key:
                        idem_redis_key = f"idempotency:{user_type}:{user_id}:{idem_key}"
                        await save_idempotency_result(idem_redis_key, {
                            "ok": False,
                            "reason": "provider_send_failed",
                            "order_id": order_id,
                            "user_id": user_id,
                            "user_type": user_type,
                        })
                except Exception as idem_err:
                    logger.warning(f"Failed to overwrite idempotency result for {order_id}: {idem_err}")

                # Return error so Node will update SQL status and close_message
                reason = (
                    "provider_unreachable" if via in ("unavailable", "none", "error")
                    else ("provider_send_timeout" if via == "timeout" else f"provider_via_{via}_failed")
                )
                cleanup_done = time.perf_counter()
                # timing log (provider failed path)
                try:
                    timing_log.info(__import__("orjson").dumps({
                        "component": "python_api",
                        "endpoint": "orders/instant/execute",
                        "status": "provider_send_failed",
                        "order_id": order_id,
                        "user_type": user_type,
                        "user_id": user_id,
                        "symbol": symbol,
                        "durations_ms": {
                            "executor_ms": int(((exec_done or time.perf_counter()) - t0) * 1000),
                            "provider_send_ms": int(((provider_send_done or time.perf_counter()) - (exec_done or t0)) * 1000) if provider_send_done and exec_done else None,
                            "cleanup_ms": int(((cleanup_done or time.perf_counter()) - (provider_send_done or exec_done or t0)) * 1000),
                        }
                    }).decode())
                except Exception:
                    pass
                raise HTTPException(status_code=503, detail={
                    "ok": False,
                    "reason": reason,
                    "order_id": order_id,
                    "user_id": user_id,
                    "user_type": user_type,
                })

        # Success timing log
        try:
            timing_log.info(__import__("orjson").dumps({
                "component": "python_api",
                "endpoint": "orders/instant/execute",
                "status": "success",
                "order_id": result.get("order_id"),
                "flow": result.get("flow"),
                "durations_ms": {
                    "executor_ms": int(((exec_done or time.perf_counter()) - t0) * 1000),
                    "provider_send_ms": int(((provider_send_done or time.perf_counter()) - (exec_done or t0)) * 1000) if provider_send_done and exec_done else None,
                }
            }).decode())
        except Exception:
            pass
        return {
            "success": True,
            "message": "Order processed",
            "data": result,
        }
    except HTTPException:
        raise
    except Exception as e:
        # Log detailed error information for debugging
        correlation_id = ErrorLogger.log_api_error(
            error=e,
            endpoint=f"{request.method} {request.url.path}",
            method=request.method,
            user_id=payload.user_id if hasattr(payload, 'user_id') else None,
            user_type=payload.user_type.value if hasattr(payload, 'user_type') else None,
            request_data=payload.model_dump(mode="json"),
            additional_context={
                "operation": "instant_order_execution",
                "execution_time_ms": int(((exec_done or time.perf_counter()) - t0) * 1000)
            }
        )
        
        try:
            timing_log.info(__import__("orjson").dumps({
                "component": "python_api",
                "endpoint": "orders/instant/execute",
                "status": "exception",
                "correlation_id": correlation_id,
                "durations_ms": { "executor_ms": int(((exec_done or time.perf_counter()) - t0) * 1000) }
            }).decode())
        except Exception:
            pass
        
        # Return generic error message (internal API, but still good practice)
        raise HTTPException(status_code=500, detail={
            "ok": False, 
            "reason": "service_error", 
            "message": "Service is temporarily unavailable. Please try again later.",
            "correlation_id": correlation_id
        })


@router.post("/pending/cancel")
async def pending_cancel_endpoint(payload: Dict[str, Any]):
    """
    Provider flow: cancel a pending order (fire-and-forget).
    Expected payload from Node:
      - order_id: canonical order id
      - cancel_id: lifecycle cancel id (registered via /orders/registry/lifecycle-id)
      - order_type: one of [BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP]
      - user_id, user_type (informational)
      - status: "CANCELLED" (engine intent)

    We forward to provider including cancel_id and fields required by provider.
    Redis/SQL modifications are performed only after provider confirmation by workers.
    """
    try:
        order_id = str(payload.get("order_id") or "").strip()
        cancel_id = str(payload.get("cancel_id") or "").strip()
        order_type = str(payload.get("order_type") or "").upper().strip()
        user_id = str(payload.get("user_id") or "").strip()
        user_type = str(payload.get("user_type") or "").lower().strip()
        status = str(payload.get("status") or "").upper().strip()

        if not order_id or not cancel_id or order_type not in ("BUY_LIMIT","SELL_LIMIT","BUY_STOP","SELL_STOP") or user_type not in ("live","demo"):
            raise HTTPException(status_code=400, detail={"ok": False, "reason": "invalid_fields"})

        # Optional: include symbol if present in canonical for provider context
        symbol = None
        try:
            od = await redis_cluster.hgetall(f"order_data:{order_id}")
            symbol = (od.get("symbol") if od else None) or None
        except Exception:
            symbol = None

        # Best-effort: ensure Redis status reflects engine intent PENDING-CANCEL for dispatcher routing
        try:
            current_status = str((od or {}).get("status") or "").upper().strip()
            if current_status not in ("PENDING-CANCEL",):
                if current_status in ("PENDING", "PENDING-QUEUED", "MODIFY", ""):
                    await redis_cluster.hset(f"order_data:{order_id}", "status", "PENDING-CANCEL")
                    if user_id and user_type:
                        try:
                            hkey = f"user_holdings:{{{user_type}:{user_id}}}:{order_id}"
                            await redis_cluster.hset(hkey, "status", "PENDING-CANCEL")
                        except Exception:
                            pass
        except Exception as e:
            logger.warning(f"pending_cancel: failed to mirror PENDING-CANCEL status for {order_id}: {e}")

        provider_payload = {
            # Keep canonical order id for mapping context
            "original_id": order_id,
            # Provide explicit cancel_id for provider lifecycle
            "cancel_id": cancel_id,
            "order_type": order_type,
            "status": status or "CANCELLED",
        }
        # print("Provider payload: ",provider_payload)
        if symbol:
            provider_payload["symbol"] = str(symbol).upper()

        try:
            ok, via = await send_provider_order(provider_payload)
        except Exception as e:
            logger.error(f"provider pending cancel send failed {order_id}: {e}")
            raise HTTPException(status_code=503, detail={"ok": False, "reason": "provider_send_failed", "error": str(e)})

        if not ok:
            raise HTTPException(status_code=503, detail={"ok": False, "reason": "provider_unreachable", "via": via})

        return {
            "success": True,
            "message": "Provider pending cancel dispatched",
            "data": {
                "order_id": order_id,
                "cancel_id": cancel_id,
                "via": via,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"pending_cancel_endpoint error: {e}")
        raise HTTPException(status_code=500, detail={"ok": False, "reason": "exception", "error": str(e)})


@router.post("/pending/place")
async def pending_place_endpoint(payload: Dict[str, Any]):
    """
    Provider flow: pending order placement.
    - Node sends: order_id, symbol, order_type (BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP), order_price, order_quantity, user_id, user_type
    - Python sends to provider: order_id, symbol, order_type, contract_value, order_price (user_price - half_spread)
    - Monitoring will start only after provider confirms ord_status=PENDING via dispatcher -> pending worker.
    """
    try:
        order_id = str(payload.get("order_id") or "").strip()
        symbol = str(payload.get("symbol") or "").upper().strip()
        order_type = str(payload.get("order_type") or "").upper().strip()
        user_id = str(payload.get("user_id") or "").strip()
        user_type = str(payload.get("user_type") or "").lower().strip()
        order_price_user = float(payload.get("order_price"))
        order_qty = float(payload.get("order_quantity"))
        if not order_id or not symbol or order_type not in ("BUY_LIMIT","SELL_LIMIT","BUY_STOP","SELL_STOP") or not user_id or user_type not in ("live","demo"):
            raise HTTPException(status_code=400, detail={"ok": False, "reason": "invalid_fields"})

        # Resolve group & group config (prefer canonical, fallback to DB/Redis group hash)
        group = None
        try:
            od = await redis_cluster.hgetall(f"order_data:{order_id}")
            if od:
                group = od.get("group") or None
        except Exception:
            group = None
        if not group:
            # Try user cache
            try:
                ucfg = await redis_cluster.hgetall(f"user:{{{user_type}:{user_id}}}:config")
                group = (ucfg.get("group") if ucfg else None) or "Standard"
            except Exception:
                group = "Standard"

        g = await fetch_group_data(symbol, group)
        # Compute half_spread
        try:
            spread = float(g.get("spread")) if g.get("spread") is not None else None
            spread_pip = float(g.get("spread_pip")) if g.get("spread_pip") is not None else None
        except (TypeError, ValueError):
            spread = None
            spread_pip = None
        if spread is None or spread_pip is None:
            raise HTTPException(status_code=400, detail={"ok": False, "reason": "missing_group_spread"})
        half_spread = (spread * spread_pip) / 2.0

        # Compute contract_size and contract_value
        try:
            contract_size = float(g.get("contract_size")) if g.get("contract_size") is not None else None
        except (TypeError, ValueError):
            contract_size = None
        if contract_size is None:
            raise HTTPException(status_code=400, detail={"ok": False, "reason": "missing_contract_size"})
        contract_value = float(contract_size) * float(order_qty)

        # Adjust provider price: user_price - half_spread
        provider_price = float(order_price_user) - float(half_spread)

        # Send to provider via persistent connection manager
        try:
            provider_payload = {
                "order_id": order_id,
                "symbol": symbol,
                "order_type": order_type,
                "order_price": provider_price,
                "contract_value": contract_value,
                "status": "PENDING",
            }
            ok, via = await send_provider_order(provider_payload)
            if not ok:
                raise HTTPException(status_code=503, detail={"ok": False, "reason": "provider_unreachable", "via": via})
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"provider pending send failed {order_id}: {e}")
            raise HTTPException(status_code=503, detail={"ok": False, "reason": "provider_send_failed", "error": str(e)})

        # Note: Do NOT start monitoring here. We start monitoring after provider confirms PENDING.

        return {
            "success": True,
            "message": "Provider pending placement dispatched",
            "data": {
                "order_id": order_id,
                "sent_price": provider_price,
                "contract_value": contract_value,
                "group": group,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"pending_place_endpoint error: {e}")
        raise HTTPException(status_code=500, detail={"ok": False, "reason": "exception", "error": str(e)})


@router.post("/pending/modify")
async def pending_modify_endpoint(payload: Dict[str, Any]):
    """
    Provider flow: modify an existing pending order's price.
    - Node sends: order_id, modify_id, symbol, order_type (BUY_LIMIT/SELL_LIMIT/BUY_STOP/SELL_STOP), order_price (user), order_quantity, user_id, user_type
    - Python computes provider_price = order_price_user - half_spread and forwards to provider with status=MODIFY.
    - Actual Redis/SQL updates are finalized by PendingWorker upon provider confirmation (ord_status=PENDING/MODIFY).
    """
    try:
        order_id = str(payload.get("order_id") or "").strip()
        modify_id = str(payload.get("modify_id") or "").strip()
        symbol = str(payload.get("symbol") or "").upper().strip()
        order_type = str(payload.get("order_type") or "").upper().strip()
        user_id = str(payload.get("user_id") or "").strip()
        user_type = str(payload.get("user_type") or "").lower().strip()
        order_price_user = float(payload.get("order_price")) if payload.get("order_price") is not None else None
        order_qty = float(payload.get("order_quantity")) if payload.get("order_quantity") is not None else None
        if not order_id or not modify_id or not symbol or order_type not in ("BUY_LIMIT","SELL_LIMIT","BUY_STOP","SELL_STOP") or not user_id or user_type not in ("live","demo"):
            raise HTTPException(status_code=400, detail={"ok": False, "reason": "invalid_fields"})
        if order_price_user is None or not (order_price_user > 0):
            raise HTTPException(status_code=400, detail={"ok": False, "reason": "invalid_order_price"})

        # Resolve group & group config (prefer canonical, fallback to user config)
        group = None
        od = None
        try:
            od = await redis_cluster.hgetall(f"order_data:{order_id}")
            if od:
                group = od.get("group") or None
        except Exception:
            group = None
        if not group:
            try:
                ucfg = await redis_cluster.hgetall(f"user:{{{user_type}:{user_id}}}:config")
                group = (ucfg.get("group") if ucfg else None) or "Standard"
            except Exception:
                group = "Standard"

        g = await fetch_group_data(symbol, group)
        # Compute half_spread
        try:
            spread = float(g.get("spread")) if g.get("spread") is not None else None
            spread_pip = float(g.get("spread_pip")) if g.get("spread_pip") is not None else None
        except (TypeError, ValueError):
            spread = None
            spread_pip = None
        if spread is None or spread_pip is None:
            raise HTTPException(status_code=400, detail={"ok": False, "reason": "missing_group_spread"})
        half_spread = (spread * spread_pip) / 2.0

        # Compute provider order price
        provider_price = float(order_price_user) - float(half_spread)

        # Optional contract_value for provider
        contract_value = None
        if order_qty is not None:
            try:
                contract_size = float(g.get("contract_size")) if g.get("contract_size") is not None else None
            except (TypeError, ValueError):
                contract_size = None
            if contract_size is not None:
                try:
                    contract_value = float(contract_size) * float(order_qty)
                except Exception:
                    contract_value = None

        # Best-effort: ensure Redis status reflects engine intent MODIFY for dispatcher routing
        try:
            cur = str((od or {}).get("status") or "").upper().strip()
            if cur not in ("MODIFY",):
                if cur in ("PENDING", "PENDING-QUEUED", ""):
                    await redis_cluster.hset(f"order_data:{order_id}", "status", "MODIFY")
                    if user_id and user_type:
                        try:
                            hkey = f"user_holdings:{{{user_type}:{user_id}}}:{order_id}"
                            await redis_cluster.hset(hkey, "status", "MODIFY")
                        except Exception:
                            pass
        except Exception as e:
            logger.warning(f"pending_modify: failed to mirror MODIFY status for {order_id}: {e}")

        # Compose provider payload
        provider_payload = {
            "original_id": order_id,
            "modify_id": modify_id,
            "symbol": symbol,
            "order_type": order_type,
            "order_price": provider_price,
            "status": "MODIFY",
        }
        if contract_value is not None:
            provider_payload["contract_value"] = contract_value

        try:
            ok, via = await send_provider_order(provider_payload)
            if not ok:
                raise HTTPException(status_code=503, detail={"ok": False, "reason": "provider_unreachable", "via": via})
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"provider pending modify send failed {order_id}: {e}")
            raise HTTPException(status_code=503, detail={"ok": False, "reason": "provider_send_failed", "error": str(e)})

        return {
            "success": True,
            "message": "Provider pending modify dispatched",
            "data": {
                "order_id": order_id,
                "modify_id": modify_id,
                "sent_price": provider_price,
                "group": group,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"pending_modify_endpoint error: {e}")
        raise HTTPException(status_code=500, detail={"ok": False, "reason": "exception", "error": str(e)})


@router.post("/stoploss/cancel")
async def stoploss_cancel_endpoint(payload: StopLossCancelRequest):
    """
    Cancel an existing stoploss trigger.
    Local flow: remove from Redis triggers and publish DB update intent.
    Provider flow: send cancel to provider, wait for CANCELLED ack, then update Redis and publish DB update.
    """
    try:
        result = await _sl_service.cancel_stoploss(payload.model_dump(mode="json"))
        if not result.get("ok"):
            reason = result.get("reason", "stoploss_cancel_failed")
            if reason in ("missing_fields", "invalid_order_type", "unsupported_flow"):
                raise HTTPException(status_code=400, detail=result)
            if reason.startswith("provider_send_failed") or reason.startswith("cancel_ack_timeout") or reason.startswith("cancel_request_rejected"):
                raise HTTPException(status_code=503, detail=result)
            raise HTTPException(status_code=500, detail=result)
        return {
            "success": True,
            "message": "Stoploss cancel processed",
            "data": result,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"stoploss_cancel_endpoint error: {e}")
        raise HTTPException(status_code=500, detail={"ok": False, "reason": "exception", "error": str(e)})


@router.post("/takeprofit/cancel")
async def takeprofit_cancel_endpoint(payload: TakeProfitCancelRequest):
    """
    Cancel an existing takeprofit trigger.
    Local flow: remove from Redis triggers and publish DB update intent.
    Provider flow: send cancel to provider, wait for CANCELLED ack, then update Redis and publish DB update.
    """
    try:
        result = await _tp_service.cancel_takeprofit(payload.model_dump(mode="json"))
        if not result.get("ok"):
            reason = result.get("reason", "takeprofit_cancel_failed")
            if reason in ("missing_fields", "invalid_order_type", "unsupported_flow"):
                raise HTTPException(status_code=400, detail=result)
            if reason.startswith("provider_send_failed") or reason.startswith("cancel_ack_timeout") or reason.startswith("cancel_request_rejected"):
                raise HTTPException(status_code=503, detail=result)
            raise HTTPException(status_code=500, detail=result)
        return {
            "success": True,
            "message": "Takeprofit cancel processed",
            "data": result,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"takeprofit_cancel_endpoint error: {e}")
        raise HTTPException(status_code=500, detail={"ok": False, "reason": "exception", "error": str(e)})


@router.post("/close", response_model=CloseOrderResponse)
async def close_order_endpoint(payload: CloseOrderRequest):
    """
    Close an existing order. Supports local (demo/Rock) and provider flows.
    For provider flow, cancels SL/TP first (if provided cancel ids), waits for CANCELLED acks, then sends close.
    """
    try:
        result = await _closer.close_order(payload.model_dump(mode="json"))
        if not result.get("ok"):
            reason = result.get("reason", "close_failed")
            # Validation errors
            if reason in ("missing_fields", "invalid_order_type", "invalid_close_status", "missing_or_invalid_quantity", "missing_entry_price"):
                raise HTTPException(status_code=400, detail=result)
            if reason.startswith("provider_send_failed") or reason.startswith("provider_close_send_failed") or reason.startswith("cancel_ack_timeout") or reason.startswith("cancel_request_rejected") or reason.startswith("close_request_rejected") or reason.startswith("close_ack_timeout"):
                raise HTTPException(status_code=503, detail=result)
            if reason.startswith("cleanup_failed"):
                raise HTTPException(status_code=500, detail=result)
            raise HTTPException(status_code=500, detail=result)

        return {
            "success": True,
            "message": "Close processed",
            "data": result,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"close_order_endpoint error: {e}")
        raise HTTPException(status_code=500, detail={"ok": False, "reason": "exception", "error": str(e)})


@router.post("/stoploss/add", response_model=StopLossSetResponse)
async def stoploss_add_endpoint(payload: StopLossSetRequest):
    """
    Set a stoploss for an existing order.
    Local flow: store in Redis triggers with half-spread adjusted score and publish DB update intent.
    Provider flow: adjust price before sending to provider and return immediately; confirmation handled asynchronously.
    """
    try:
        result = await _sl_service.add_stoploss(payload.model_dump(mode="json"))
        if not result.get("ok"):
            reason = result.get("reason", "stoploss_failed")
            if reason in ("missing_fields", "invalid_order_type", "invalid_stop_loss", "unsupported_flow"):
                raise HTTPException(status_code=400, detail=result)
            if reason.startswith("provider_send_failed"):
                raise HTTPException(status_code=503, detail=result)
            raise HTTPException(status_code=500, detail=result)

        return {
            "success": True,
            "message": "Stoploss processed",
            "data": result,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"stoploss_add_endpoint error: {e}")
        raise HTTPException(status_code=500, detail={"ok": False, "reason": "exception", "error": str(e)})


@router.post("/takeprofit/add", response_model=TakeProfitSetResponse)
async def takeprofit_add_endpoint(payload: TakeProfitSetRequest):
    """
    Set a takeprofit for an existing order.
    Local flow: store in Redis triggers with half-spread adjusted score and publish DB update intent.
    Provider flow: adjust price before sending to provider and return immediately; confirmation handled asynchronously.
    """
    try:
        result = await _tp_service.add_takeprofit(payload.model_dump(mode="json"))
        if not result.get("ok"):
            reason = result.get("reason", "takeprofit_failed")
            if reason in ("missing_fields", "invalid_order_type", "invalid_take_profit", "unsupported_flow"):
                raise HTTPException(status_code=400, detail=result)
            if reason.startswith("provider_send_failed"):
                raise HTTPException(status_code=503, detail=result)
            raise HTTPException(status_code=500, detail=result)

        return {
            "success": True,
            "message": "Takeprofit processed",
            "data": result,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"takeprofit_add_endpoint error: {e}")
        raise HTTPException(status_code=500, detail={"ok": False, "reason": "exception", "error": str(e)})


@router.post("/close/finalize", response_model=CloseOrderResponse)
async def finalize_close_endpoint(payload: FinalizeCloseRequest):
    """
    Finalize a close after provider EXECUTED report.
    Node should call this when it confirms ord_status=EXECUTED for the close request.
    """
    try:
        result = await _closer.finalize_close(
            user_type=str(payload.user_type.value if hasattr(payload.user_type, 'value') else payload.user_type),
            user_id=str(payload.user_id),
            order_id=str(payload.order_id),
            close_price=float(payload.close_price) if payload.close_price is not None else None,
        )
        if not result.get("ok"):
            raise HTTPException(status_code=500, detail=result)
        return {
            "success": True,
            "message": "Close finalized",
            "data": result,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"finalize_close_endpoint error: {e}")
        raise HTTPException(status_code=500, detail={"ok": False, "reason": "exception", "error": str(e)})


@router.post("/registry/lifecycle-id")
async def register_lifecycle_id(payload: Dict[str, Any]):
    """
    Register a lifecycle-generated ID and map it to the canonical order_id.
    Body:
      - order_id: str (canonical order id)
      - new_id: str (generated id)
      - id_type: one of [close_id, modify_id, cancel_id, takeprofit_id, stoploss_id, takeprofit_cancel_id, stoploss_cancel_id]
    """
    try:
        order_id = str(payload.get("order_id") or "").strip()
        new_id = str(payload.get("new_id") or "").strip()
        id_type = str(payload.get("id_type") or "").strip()

        allowed = {
            "close_id",
            "modify_id",
            "cancel_id",
            "takeprofit_id",
            "stoploss_id",
            "takeprofit_cancel_id",
            "stoploss_cancel_id",
        }
        if not order_id or not new_id or id_type not in allowed:
            raise HTTPException(status_code=400, detail={
                "ok": False,
                "reason": "invalid_fields",
                "allowed_id_types": sorted(list(allowed)),
            })

        await add_lifecycle_id(order_id, new_id, id_type)
        return {
            "success": True,
            "message": "Lifecycle ID registered",
            "data": {
                "order_id": order_id,
                "new_id": new_id,
                "id_type": id_type,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"register_lifecycle_id error: {e}")
        raise HTTPException(status_code=500, detail={"ok": False, "reason": "exception", "error": str(e)})
