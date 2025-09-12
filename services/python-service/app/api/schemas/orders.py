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


class CloseOrderRequest(BaseModel):
    symbol: str = Field(..., description="Trading symbol, e.g., EURUSD")
    order_type: OrderType = Field(..., description="BUY or SELL")
    user_id: str = Field(..., description="User identifier")
    user_type: UserType = Field(..., description="User type: live or demo")
    order_id: str = Field(..., description="Canonical order id to close")
    status: str = Field("CLOSED", description="Frontend/UI status, must be CLOSED")
    order_status: str = Field("CLOSED", description="Engine order_status, must be CLOSED")
    close_id: str | None = Field(None, description="Lifecycle close id (provider flow requires this)")
    stoploss_cancel_id: str | None = Field(None, description="Lifecycle cancel id for stoploss (provider flow)")
    takeprofit_cancel_id: str | None = Field(None, description="Lifecycle cancel id for takeprofit (provider flow)")
    close_price: float | None = Field(None, description="Optional proposed close price; local flow will fetch from market")

    @field_validator("symbol")
    def symbol_upper(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("symbol cannot be empty")
        return v.upper()


class CloseOrderResponse(BaseModel):
    success: bool
    message: str
    data: dict


class FinalizeCloseRequest(BaseModel):
    user_id: str = Field(..., description="User identifier")
    user_type: UserType = Field(..., description="User type: live or demo")
    order_id: str = Field(..., description="Canonical order id to finalize close for")
    close_price: float | None = Field(None, description="Executed close price (avgpx) from execution report; if omitted, service will fetch from market")


class StopLossSetRequest(BaseModel):
    order_id: str = Field(..., description="Canonical order id")
    user_id: str = Field(..., description="User identifier")
    user_type: UserType = Field(..., description="User type: live or demo")
    symbol: str = Field(..., description="Trading symbol, e.g., EURUSD")
    order_type: OrderType = Field(..., description="BUY or SELL")
    stop_loss: float = Field(..., gt=0, description="Stop loss price from frontend (spread-included)")
    order_quantity: float | None = Field(None, description="Optional order quantity for provider payload")
    order_status: str | None = Field(None, description="Optional order_status passthrough (OPEN)")
    status: str | None = Field(None, description="Optional UI status passthrough")
    stoploss_id: str | None = Field(None, description="Lifecycle stoploss id (provider flow)")

    @field_validator("symbol")
    def symbol_upper_sl(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("symbol cannot be empty")
        return v.upper()


class StopLossSetResponse(BaseModel):
    success: bool
    message: str
    data: dict


class TakeProfitSetRequest(BaseModel):
    order_id: str = Field(..., description="Canonical order id")
    user_id: str = Field(..., description="User identifier")
    user_type: UserType = Field(..., description="User type: live or demo")
    symbol: str = Field(..., description="Trading symbol, e.g., EURUSD")
    order_type: OrderType = Field(..., description="BUY or SELL")
    take_profit: float = Field(..., gt=0, description="Take profit price from frontend (spread-included)")
    order_quantity: float | None = Field(None, description="Optional order quantity for provider payload")
    order_status: str | None = Field(None, description="Optional order_status passthrough (OPEN)")
    status: str | None = Field(None, description="Optional UI status passthrough")
    takeprofit_id: str | None = Field(None, description="Lifecycle takeprofit id (provider flow)")

    @field_validator("symbol")
    def symbol_upper_tp(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("symbol cannot be empty")
        return v.upper()


class TakeProfitSetResponse(BaseModel):
    success: bool
    message: str
    data: dict


class StopLossCancelRequest(BaseModel):
    order_id: str
    user_id: str
    user_type: UserType
    symbol: str
    order_type: OrderType
    order_status: str | None = Field('OPEN', description="Must be OPEN to cancel")
    status: str | None = Field('STOPLOSS-CANCEL', description="UI status passthrough")
    stoploss_id: str = Field(..., description="Original lifecycle stoploss id")
    stoploss_cancel_id: str | None = Field(None, description="Lifecycle cancel id (provider flow)")

    @field_validator("symbol")
    def symbol_upper_sl_cancel(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("symbol cannot be empty")
        return v.upper()


class TakeProfitCancelRequest(BaseModel):
    order_id: str
    user_id: str
    user_type: UserType
    symbol: str
    order_type: OrderType
    order_status: str | None = Field('OPEN', description="Must be OPEN to cancel")
    status: str | None = Field('TAKEPROFIT-CANCEL', description="UI status passthrough")
    takeprofit_id: str = Field(..., description="Original lifecycle takeprofit id")
    takeprofit_cancel_id: str | None = Field(None, description="Lifecycle cancel id (provider flow)")

    @field_validator("symbol")
    def symbol_upper_tp_cancel(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("symbol cannot be empty")
        return v.upper()
