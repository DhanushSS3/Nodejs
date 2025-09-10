"""
Admin Orders API - Superadmin endpoints for order management
"""

import logging
from typing import Optional
from fastapi import APIRouter, HTTPException, Depends, Header
from pydantic import BaseModel

from app.config.redis_config import redis_cluster
from app.services.orders.order_repository import fetch_user_orders
from app.services.portfolio.user_margin_service import compute_user_total_margin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin/orders", tags=["Admin Orders"])


class RejectQueuedOrderRequest(BaseModel):
    order_id: str
    user_type: str  # 'live' or 'demo'
    user_id: str
    reason: Optional[str] = "Manual rejection by admin"


class OrderStatusResponse(BaseModel):
    success: bool
    message: str
    data: Optional[dict] = None


async def verify_superadmin(authorization: str = Header(None)) -> bool:
    """
    Verify that the request is from a superadmin.
    In production, this should validate JWT and check for superadmin role.
    """
    # TODO: Implement proper JWT validation and role checking
    # For now, just check if authorization header exists
    if not authorization:
        raise HTTPException(status_code=401, detail="Authorization required")
    return True


@router.post("/reject-queued", response_model=OrderStatusResponse)
async def reject_queued_order(
    request: RejectQueuedOrderRequest,
    is_admin: bool = Depends(verify_superadmin)
):
    """
    Manually reject a queued order and release its reserved margin.
    Only accessible by superadmin.
    """
    try:
        # Construct keys
        hash_tag = f"{request.user_type}:{request.user_id}"
        order_key = f"user_holdings:{{{hash_tag}}}:{request.order_id}"
        order_data_key = f"order_data:{request.order_id}"
        portfolio_key = f"user_portfolio:{{{hash_tag}}}"
        index_key = f"user_orders_index:{{{hash_tag}}}"
        
        # Check if order exists and is queued
        order_data = await redis_cluster.hgetall(order_key)
        if not order_data:
            return OrderStatusResponse(
                success=False,
                message=f"Order {request.order_id} not found"
            )
        
        order_status = order_data.get("order_status", "").upper()
        execution_status = order_data.get("execution_status", "").upper()
        
        if order_status != "QUEUED" and execution_status != "QUEUED":
            return OrderStatusResponse(
                success=False,
                message=f"Order {request.order_id} is not in QUEUED status (current: {order_status}/{execution_status})"
            )
        
        # Delete order keys and remove from index
        # This reduces memory and removes order from active reads immediately
        pipe = redis_cluster.pipeline()
        # Remove from open orders index first so subsequent reads won't include it
        pipe.srem(index_key, request.order_id)
        # Delete user holding and canonical order data
        pipe.delete(order_key)
        pipe.delete(order_data_key)
        await pipe.execute()
        
        # Recompute user margins excluding this order
        orders = await fetch_user_orders(request.user_type, request.user_id)
        filtered_orders = [od for od in orders if str(od.get("order_id")) != str(request.order_id)]
        
        executed_margin, total_margin, _ = await compute_user_total_margin(
            user_type=request.user_type,
            user_id=request.user_id,
            orders=filtered_orders,
            prices_cache=None,
            strict=False,
            include_queued=True,
        )
        
        # Update portfolio margins
        margin_updates = {}
        if executed_margin is not None:
            margin_updates["used_margin_executed"] = str(float(executed_margin))
            margin_updates["used_margin"] = str(float(executed_margin))  # Legacy field
        if total_margin is not None:
            margin_updates["used_margin_all"] = str(float(total_margin))
        
        if margin_updates:
            await redis_cluster.hset(portfolio_key, mapping=margin_updates)
        
        # Remove from symbol holders set if no more holdings on this symbol
        symbol = order_data.get("symbol", "").upper()
        if symbol:
            any_same_symbol = any(
                str(od.get("symbol", "")).upper() == symbol 
                for od in filtered_orders
            )
            if not any_same_symbol:
                sym_set = f"symbol_holders:{symbol}:{request.user_type}"
                await redis_cluster.srem(sym_set, hash_tag)
        
        logger.info(
            "Superadmin rejected queued order: order_id=%s, user=%s:%s, reason=%s",
            request.order_id, request.user_type, request.user_id, request.reason
        )
        
        return OrderStatusResponse(
            success=True,
            message=f"Order {request.order_id} has been rejected and margin released",
            data={
                "order_id": request.order_id,
                "new_executed_margin": float(executed_margin) if executed_margin else 0.0,
                "new_total_margin": float(total_margin) if total_margin else 0.0,
                "symbol": symbol,
            }
        )
        
    except Exception as e:
        logger.error(f"Error rejecting queued order: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/queued/{user_type}/{user_id}", response_model=OrderStatusResponse)
async def get_queued_orders(
    user_type: str,
    user_id: str,
    is_admin: bool = Depends(verify_superadmin)
):
    """
    Get all queued orders for a specific user.
    Only accessible by superadmin.
    """
    try:
        # Fetch all user orders
        orders = await fetch_user_orders(user_type, user_id)
        
        # Filter for queued orders
        queued_orders = []
        for order in orders:
            order_status = order.get("order_status", "").upper()
            execution_status = order.get("execution_status", "").upper()
            
            if order_status == "QUEUED" or execution_status == "QUEUED":
                queued_orders.append({
                    "order_id": order.get("order_id"),
                    "symbol": order.get("symbol"),
                    "order_type": order.get("order_type"),
                    "order_quantity": order.get("order_quantity"),
                    "order_price": order.get("order_price"),
                    "reserved_margin": order.get("reserved_margin"),
                    "created_at": order.get("created_at"),
                    "order_status": order_status,
                    "execution_status": execution_status,
                })
        
        return OrderStatusResponse(
            success=True,
            message=f"Found {len(queued_orders)} queued orders",
            data={
                "user_type": user_type,
                "user_id": user_id,
                "queued_orders": queued_orders,
                "total_queued": len(queued_orders),
            }
        )
        
    except Exception as e:
        logger.error(f"Error fetching queued orders: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/margin-status/{user_type}/{user_id}", response_model=OrderStatusResponse)
async def get_margin_status(
    user_type: str,
    user_id: str,
    is_admin: bool = Depends(verify_superadmin)
):
    """
    Get detailed margin status for a user showing both executed and total margins.
    Only accessible by superadmin.
    """
    try:
        # Get portfolio data
        portfolio_key = f"user_portfolio:{{{user_type}:{user_id}}}"
        portfolio = await redis_cluster.hgetall(portfolio_key)
        
        # Get user config for balance
        config_key = f"user:{{{user_type}:{user_id}}}:config"
        config = await redis_cluster.hgetall(config_key)
        
        balance = float(config.get("wallet_balance", 0))
        used_margin_executed = float(portfolio.get("used_margin_executed", 0))
        used_margin_all = float(portfolio.get("used_margin_all", 0))
        
        # Calculate free margins
        free_margin_executed = balance - used_margin_executed
        free_margin_all = balance - used_margin_all
        
        # Get order counts
        orders = await fetch_user_orders(user_type, user_id)
        executed_count = 0
        queued_count = 0
        
        for order in orders:
            order_status = order.get("order_status", "").upper()
            execution_status = order.get("execution_status", "").upper()
            
            if order_status == "QUEUED" or execution_status == "QUEUED":
                queued_count += 1
            else:
                executed_count += 1
        
        return OrderStatusResponse(
            success=True,
            message="Margin status retrieved successfully",
            data={
                "user_type": user_type,
                "user_id": user_id,
                "balance": balance,
                "margins": {
                    "used_margin_executed": used_margin_executed,
                    "used_margin_all": used_margin_all,
                    "reserved_margin": used_margin_all - used_margin_executed,
                    "free_margin_executed": free_margin_executed,
                    "free_margin_all": free_margin_all,
                },
                "orders": {
                    "executed_count": executed_count,
                    "queued_count": queued_count,
                    "total_count": executed_count + queued_count,
                },
                "can_place_orders": free_margin_all > 0,
            }
        )
        
    except Exception as e:
        logger.error(f"Error fetching margin status: {e}")
        raise HTTPException(status_code=500, detail=str(e))
