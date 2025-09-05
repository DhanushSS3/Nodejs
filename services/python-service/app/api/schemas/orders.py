from typing import Optional
from pydantic import BaseModel, Field, field_validator
from enum import Enum


class OrderType(str, Enum):
    BUY = "BUY"
    SELL = "SELL"


class UserType(str, Enum):
    LIVE = "live"
    DEMO = "demo"


class InstantOrderRequest(BaseModel):
    symbol: str = Field(..., description="Trading symbol, e.g., EURUSD")
    order_type: OrderType = Field(..., description="BUY or SELL")
    order_price: float = Field(..., gt=0, description="Requested price; provider flow uses this; local flow ignores")
    order_quantity: float = Field(..., gt=0, description="Order quantity (lots or units based on symbol config)")
    user_id: str = Field(..., description="User identifier")
    user_type: UserType = Field(..., description="User type: live or demo")
    idempotency_key: Optional[str] = Field(None, description="Client-provided idempotency key to avoid duplicates")
    order_id: Optional[str] = Field(None, description="Optional client-generated order id")
    status: Optional[str] = Field(None, description="Optional frontend status passthrough")
    order_status: Optional[str] = Field(
        None,
        description=(
            "Optional client-provided order status; server will set 'OPEN' for local execution and 'queued' for provider"
        ),
    )

    @field_validator("symbol")
    def symbol_upper(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("symbol cannot be empty")
        return v.upper()


class InstantOrderResponse(BaseModel):
    success: bool
    message: str
    data: dict
