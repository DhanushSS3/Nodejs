import logging
from typing import Optional, Dict, Any

from app.config.redis_config import redis_cluster

logger = logging.getLogger(__name__)


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


async def get_execution_price(
    user_group: Optional[str],
    symbol: str,
    order_type: str,
    strict: bool = True,
) -> Dict[str, Any]:
    """
    Compute execution price with group-specific spread adjustment.

    Data sources:
    - Group: groups:{group}:{symbol} -> fields: spread, spread_pip
    - Market: market:{symbol} -> fields: bid, ask

    order_type: BUY uses ask; SELL uses bid

    Returns a dict with keys:
      ok (bool)
      exec_price (float)
      raw_price (float)
      half_spread (float)
      group (str) - actual group used (fallback to Standard)
      reason (str) - only when ok=False
    """
    result: Dict[str, Any] = {
        "ok": False,
        "exec_price": 0.0,
        "raw_price": 0.0,
        "half_spread": 0.0,
        "group": None,
    }

    try:
        if not symbol:
            reason = "missing_symbol"
            logger.error(f"price_utils.get_execution_price: {reason}")
            result["reason"] = reason
            return result

        # Normalize inputs
        grp = (user_group or "").strip() or "Standard"
        otype = (order_type or "").strip().upper()
        if otype not in ("BUY", "SELL"):
            msg = f"invalid_order_type: {order_type} for {symbol} group={grp}"
            if strict:
                logger.error(f"price_utils.get_execution_price: {msg}")
                result["reason"] = "invalid_order_type"
                return result
            else:
                logger.warning(f"price_utils.get_execution_price (non-strict): {msg}; defaulting to BUY")
                otype = "BUY"

        # 1) Fetch group data with fallback to Standard
        group_key_user = f"groups:{{{grp}}}:{symbol}"
        group_key_std = f"groups:{{Standard}}:{symbol}"

        gdata = await redis_cluster.hgetall(group_key_user)
        used_group = grp
        if not gdata:
            gdata = await redis_cluster.hgetall(group_key_std)
            used_group = "Standard"
        result["group"] = used_group

        spread = _safe_float(gdata.get("spread") if gdata else None)
        spread_pip = _safe_float(gdata.get("spread_pip") if gdata else None)

        if spread is None or spread_pip is None:
            if strict:
                reason = "invalid_spread_data"
                logger.error(
                    f"price_utils.get_execution_price: {reason} for {symbol} order_type={otype} group={used_group}"
                )
                result["reason"] = reason
                return result
            else:
                logger.warning(
                    f"price_utils.get_execution_price (non-strict): missing/invalid spread data for {symbol} group={used_group}; half_spread=0"
                )
                half_spread = 0.0
        else:
            half_spread = (spread * spread_pip) / 2.0
        result["half_spread"] = float(half_spread)

        # 2) Fetch market prices
        px = await redis_cluster.hmget(f"market:{symbol}", ["bid", "ask"])  # [bid, ask]
        bid = _safe_float(px[0]) if px and len(px) > 0 else None
        ask = _safe_float(px[1]) if px and len(px) > 1 else None

        if otype == "BUY":
            raw_price = ask
        else:
            raw_price = bid

        if raw_price is None:
            if strict:
                reason = "missing_market_price"
                logger.error(
                    f"price_utils.get_execution_price: {reason} for {symbol} order_type={otype} group={used_group}"
                )
                result["reason"] = reason
                return result
            else:
                logger.warning(
                    f"price_utils.get_execution_price (non-strict): missing {('ask' if otype=='BUY' else 'bid')} for {symbol}; raw_price=0"
                )
                raw_price = 0.0

        result["raw_price"] = float(raw_price)

        # 3) Compute execution price with half-spread adjustment
        if otype == "BUY":
            exec_price = float(raw_price) + float(half_spread)
        else:
            exec_price = float(raw_price) - float(half_spread)

        result["exec_price"] = float(exec_price)
        result["ok"] = True
        return result

    except Exception as e:
        logger.error(
            f"price_utils.get_execution_price error for symbol={symbol} order_type={order_type} group={user_group}: {e}"
        )
        result["reason"] = "exception"
        return result
