from fastapi import APIRouter, HTTPException, BackgroundTasks
from typing import Dict, Any
import logging

from ..services.orders.order_execution_service import OrderExecutor
from ..services.orders.order_close_service import OrderCloser
from ..services.orders.stoploss_service import StopLossService
from ..services.orders.takeprofit_service import TakeProfitService
from ..services.orders.service_provider_client import send_provider_order
from ..services.orders.order_repository import fetch_user_orders, save_idempotency_result
from ..services.portfolio.user_margin_service import compute_user_total_margin
from ..config.redis_config import redis_cluster
from ..services.orders.order_registry import add_lifecycle_id
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
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orders", tags=["Orders"])

_executor = OrderExecutor()
_closer = OrderCloser()
_sl_service = StopLossService()
_tp_service = TakeProfitService()


@router.post("/instant/execute", response_model=InstantOrderResponse)
async def instant_execute_order(payload: InstantOrderRequest, background_tasks: BackgroundTasks):
    """
    Unified endpoint for instant order execution.
    Supports local (demo/Rock) and provider (barclays) flows.
    """
    try:
        # Dump in JSON mode so Enum fields (order_type, user_type) are converted to their string values
        result = await _executor.execute_instant_order(payload.model_dump(mode="json"))
        if not result.get("ok"):
            # Map common reasons to HTTP codes if needed
            reason = result.get("reason", "execution_failed")
            # For validation errors, return 400
            if reason in ("missing_fields", "invalid_order_type", "invalid_numeric_fields", "invalid_order_quantity", "invalid_order_status"):
                raise HTTPException(status_code=400, detail=result)
            # For margin/user issues and unsupported flow, return 400
            if reason in ("user_not_verified", "invalid_leverage", "missing_group_data", "insufficient_margin", "unsupported_flow"):
                raise HTTPException(status_code=400, detail=result)
            # For idempotency in-progress, 409 could be used
            if reason in ("idempotency_in_progress",):
                raise HTTPException(status_code=409, detail=result)
            # Duplicate order_id attempts
            if reason == "place_order_failed:order_exists":
                raise HTTPException(status_code=409, detail=result)
            # Otherwise server error
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
                raise HTTPException(status_code=503, detail={
                    "ok": False,
                    "reason": reason,
                    "order_id": order_id,
                    "user_id": user_id,
                    "user_type": user_type,
                })

        return {
            "success": True,
            "message": "Order processed",
            "data": result,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"instant_execute_order error: {e}")
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
