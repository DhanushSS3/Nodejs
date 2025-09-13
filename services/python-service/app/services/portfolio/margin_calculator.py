import os
import logging
from typing import Optional, Dict

from app.services.portfolio.conversion_utils import convert_to_usd
from app.services.groups.group_config_helper import get_group_config_with_fallback

logger = logging.getLogger(__name__)

STRICT_MODE = os.getenv("PORTFOLIO_STRICT_MODE", "true").strip().lower() in ("1", "true", "yes", "on")


def compute_contract_value(contract_size: float, order_quantity: float) -> float:
    """
    contract_value = contract_size * order_quantity
    """
    try:
        cs = float(contract_size)
        qty = float(order_quantity)
        return cs * qty
    except (TypeError, ValueError):
        return 0.0


async def compute_single_order_margin(
    contract_size: float,
    order_quantity: float,
    execution_price: float,
    profit_currency: Optional[str],
    symbol: str,
    leverage: float,
    instrument_type: int,
    prices_cache: Optional[Dict] = None,
    crypto_margin_factor: Optional[float] = None,
    strict: bool = True,
) -> Optional[float]:
    """
    Returns margin in USD (float) or None on strict failure.

    Formulas:
      - contract_value = contract_size * order_quantity
      - NON-CRYPTO (type in [1,2,3]):
          margin = (contract_value * execution_price) / leverage
      - CRYPTO (type == 4):
          margin = (contract_value * execution_price * (crypto_margin_factor or 1.0)) / leverage
      - After computing margin in profit currency, call convert_to_usd(margin, profit_currency, ...)
    """
    try:
        if leverage is None:
            leverage = 0.0
        if strict and (leverage <= 0):
            return None
        if strict and (contract_size is None):
            return None

        # Fallbacks in non-strict mode
        if (contract_size is None) and not strict:
            contract_size = 0.0
        if (profit_currency is None) and not strict:
            profit_currency = "USD"

        cv = compute_contract_value(contract_size or 0.0, order_quantity or 0.0)
        exec_price = float(execution_price or 0.0)

        if instrument_type == 4:  # CRYPTO
            factor = float(crypto_margin_factor) if crypto_margin_factor is not None else 1.0
            margin_native = (cv * exec_price * factor) / float(leverage or 1.0)
        else:
            margin_native = (cv * exec_price) / float(leverage or 1.0)

        # Convert to USD
        if profit_currency is None:
            return None if strict else margin_native

        margin_usd = await convert_to_usd(margin_native, profit_currency, prices_cache=prices_cache, strict=strict)
        return margin_usd
    except Exception as e:
        logger.error(f"compute_single_order_margin error for symbol={symbol}: {e}")
        return None if strict else 0.0


async def compute_single_order_margin_with_fallback(
    *,
    order_quantity: float,
    execution_price: float,
    symbol: str,
    group: str,
    leverage: float,
    instrument_type: Optional[int] = None,
    prices_cache: Optional[Dict] = None,
    crypto_margin_factor: Optional[float] = None,
    strict: bool = True,
) -> Optional[float]:
    """
    Wrapper that ensures required group fields exist by fetching Redis first,
    then falling back to DB via Node and caching into Redis.
    Calls compute_single_order_margin() with resolved fields.
    """
    try:
        cfg = await get_group_config_with_fallback(group, symbol)
        # Prefer provided instrument_type if set, else fallback
        inst_type = instrument_type if instrument_type is not None else (
            int(cfg.get("type")) if cfg.get("type") is not None else 1
        )
        cs_val = None
        if cfg.get("contract_size") is not None:
            try:
                cs_val = float(cfg.get("contract_size"))
            except (TypeError, ValueError):
                cs_val = None
        profit_ccy = cfg.get("profit")

        # Resolve crypto margin factor if not provided explicitly
        factor = crypto_margin_factor
        if factor is None:
            for k in ("crypto_margin_factor", "group_margin", "margin"):
                if cfg.get(k) is not None:
                    try:
                        factor = float(cfg.get(k))
                        break
                    except (TypeError, ValueError):
                        continue

        return await compute_single_order_margin(
            contract_size=cs_val,
            order_quantity=order_quantity,
            execution_price=execution_price,
            profit_currency=str(profit_ccy).upper() if profit_ccy else None,
            symbol=symbol,
            leverage=leverage,
            instrument_type=inst_type,
            prices_cache=prices_cache,
            crypto_margin_factor=factor,
            strict=strict,
        )
    except Exception as e:
        logger.error(f"compute_single_order_margin_with_fallback error for symbol={symbol}: {e}")
        return None if strict else 0.0
