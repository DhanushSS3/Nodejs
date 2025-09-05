from fastapi import APIRouter, HTTPException, BackgroundTasks
from typing import Dict, Any
import logging

from ..services.orders.order_execution_service import OrderExecutor
from ..services.orders.service_provider_client import send_provider_order
from .schemas.orders import InstantOrderRequest, InstantOrderResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orders", tags=["Orders"])

_executor = OrderExecutor()


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

        # If provider flow, schedule async send after successful persistence
        provider_payload = result.get("provider_send_payload")
        if provider_payload:
            try:
                background_tasks.add_task(send_provider_order, provider_payload)
            except Exception as e:
                logger.error(f"Failed to schedule provider send for order {provider_payload.get('order_id')}: {e}")

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
