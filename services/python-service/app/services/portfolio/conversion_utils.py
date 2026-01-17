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
    with_metadata: bool = False,
):
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
        float or None when strict and conversion not possible. If `with_metadata=True`,
        returns a tuple (result, metadata_dict).
    """
    try:
        if amount is None:
            return None if strict else 0.0
        if not from_currency:
            return None if strict else amount
        fc = str(from_currency).upper()
        metadata = {
            "from_currency": fc,
            "pair": None,
            "invert": False,
            "rate": None,
            "source": None
        }

        if fc in ("USD", "USDT"):
            result = float(amount)
            return (result, metadata.copy()) if with_metadata else result

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
                metadata.update({"pair": direct, "source": "cache_direct"})
        elif inverse in cache:
            ask = _safe_float(cache[inverse].get("ask"))
            if ask and ask > 0:
                rate = ask
                invert = True
                metadata.update({"pair": inverse, "source": "cache_inverse"})

        # 2) Fallback to Redis per-symbol hashes
        if rate == 0.0:
            # Try direct first
            data = await redis_cluster.hmget(f"market:{direct}", ["ask"])  # expect [ask]
            if data and data[0]:
                ask = _safe_float(data[0])
                if ask and ask > 0:
                    rate = ask
                    invert = False
                    metadata.update({"pair": direct, "source": "redis_direct"})
            if rate == 0.0:
                data2 = await redis_cluster.hmget(f"market:{inverse}", ["ask"])  # expect [ask]
                if data2 and data2[0]:
                    ask2 = _safe_float(data2[0])
                    if ask2 and ask2 > 0:
                        rate = ask2
                        invert = True
                        metadata.update({"pair": inverse, "source": "redis_inverse"})

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
                            metadata.update({"pair": direct, "source": "snapshot_direct"})
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
                                metadata.update({"pair": inverse, "source": "snapshot_inverse"})
                        except Exception:
                            pass
            except Exception as e:
                logger.warning(f"market:prices fallback failed for {fc}->USD: {e}")

        if rate == 0.0:
            if strict:
                logger.warning(f"Conversion rate not found for {fc}->USD (no {direct} or {inverse}); strict=True returning None")
                return (None, metadata.copy()) if with_metadata else None
            logger.warning(f"Conversion rate not found for {fc}->USD; returning amount unchanged (non-strict)")
            result = float(amount)
            return (result, metadata.copy()) if with_metadata else result

        if invert:
            result = float(amount) / rate
        else:
            result = float(amount) * rate

        metadata.update({
            "invert": invert,
            "rate": rate,
            "pair": metadata.get("pair") or (direct if not invert else inverse)
        })

        return (result, metadata.copy()) if with_metadata else result
    except Exception as e:
        logger.error(f"convert_to_usd error for {amount} {from_currency}: {e}")
        if strict:
            return (None, metadata.copy()) if with_metadata else None
        fallback = float(amount)
        return (fallback, metadata.copy()) if with_metadata else fallback


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None
