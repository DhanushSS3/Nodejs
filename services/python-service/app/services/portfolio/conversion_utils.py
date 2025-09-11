import os
import logging
import json
from typing import Optional, Dict
from app.config.redis_config import redis_cluster

logger = logging.getLogger(__name__)

STRICT_MODE = os.getenv("PORTFOLIO_STRICT_MODE", "true").strip().lower() in ("1", "true", "yes", "on")


async def convert_to_usd(
    amount: float,
    from_currency: str,
    prices_cache: Optional[Dict[str, Dict[str, float]]] = None,
    strict: bool = True,
) -> Optional[float]:
    """
    Convert a monetary amount from `from_currency` to USD using market prices.
    - Uses ask price for conservative conversion.
    - Tries prices_cache first, falls back to Redis market:{pair} lookups.

    Args:
        amount: numeric (in from_currency)
        from_currency: e.g., "CAD", "JPY", "USD"
        prices_cache: optional mapping { symbol: { 'bid': float, 'ask': float } }
        strict: if True and conversion not possible -> return None

    Returns:
        float or None when strict and conversion not possible
    """
    try:
        if amount is None:
            return None if strict else 0.0
        if not from_currency:
            return None if strict else amount
        fc = str(from_currency).upper()
        if fc in ("USD", "USDT"):
            return float(amount)

        cache = prices_cache or {}

        # Prefer direct pair: FROMUSD
        direct = f"{fc}USD"
        inverse = f"USD{fc}"

        rate = 0.0
        invert = False

        # 1) Check cache
        if direct in cache:
            ask = _safe_float(cache[direct].get("ask"))
            if ask and ask > 0:
                rate = ask
                invert = False
        elif inverse in cache:
            ask = _safe_float(cache[inverse].get("ask"))
            if ask and ask > 0:
                rate = ask
                invert = True

        # 2) Fallback to Redis per-symbol hashes
        if rate == 0.0:
            # Try direct first
            data = await redis_cluster.hmget(f"market:{direct}", ["ask"])  # expect [ask]
            if data and data[0]:
                ask = _safe_float(data[0])
                if ask and ask > 0:
                    rate = ask
                    invert = False
            if rate == 0.0:
                data2 = await redis_cluster.hmget(f"market:{inverse}", ["ask"])  # expect [ask]
                if data2 and data2[0]:
                    ask2 = _safe_float(data2[0])
                    if ask2 and ask2 > 0:
                        rate = ask2
                        invert = True

        # 3) Fallback to global snapshot hash market:prices (JSON values)
        if rate == 0.0:
            try:
                js = await redis_cluster.hget("market:prices", direct)
                if js:
                    try:
                        obj = json.loads(js)
                        ask = _safe_float((obj or {}).get("ask"))
                        if ask and ask > 0:
                            rate = ask
                            invert = False
                    except Exception:
                        pass
                if rate == 0.0:
                    js2 = await redis_cluster.hget("market:prices", inverse)
                    if js2:
                        try:
                            obj2 = json.loads(js2)
                            ask2 = _safe_float((obj2 or {}).get("ask"))
                            if ask2 and ask2 > 0:
                                rate = ask2
                                invert = True
                        except Exception:
                            pass
            except Exception as e:
                logger.warning(f"market:prices fallback failed for {fc}->USD: {e}")

        if rate == 0.0:
            if strict:
                logger.warning(f"Conversion rate not found for {fc}->USD (no {direct} or {inverse}); strict=True returning None")
                return None
            logger.warning(f"Conversion rate not found for {fc}->USD; returning amount unchanged (non-strict)")
            return float(amount)

        if invert:
            return float(amount) / rate
        return float(amount) * rate
    except Exception as e:
        logger.error(f"convert_to_usd error for {amount} {from_currency}: {e}")
        return None if strict else float(amount)


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None
