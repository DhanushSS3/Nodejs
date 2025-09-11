import logging
from typing import Any, Dict, Optional

from app.config.redis_config import redis_cluster

logger = logging.getLogger(__name__)


def _sl_key(symbol: str, side: str) -> str:
    # Use hash tag {symbol} so all symbol-specific structures colocate on same slot
    return f"sl_index:{{{symbol}}}:{side}"


def _tp_key(symbol: str, side: str) -> str:
    return f"tp_index:{{{symbol}}}:{side}"


def _order_triggers_key(order_id: str) -> str:
    return f"order_triggers:{order_id}"


async def get_order_triggers(order_id: str) -> Dict[str, Any]:
    try:
        return await redis_cluster.hgetall(_order_triggers_key(order_id)) or {}
    except Exception as e:
        logger.error("get_order_triggers failed for %s: %s", order_id, e)
        return {}


async def remove_order_triggers(order_id: str) -> Dict[str, Any]:
    """
    Remove SL/TP monitoring state for an order.
    Returns the trigger doc that was removed (if any) for observability.
    """
    try:
        key = _order_triggers_key(order_id)
        doc = await redis_cluster.hgetall(key)
        if not doc:
            return {}
        symbol = str(doc.get("symbol") or "").upper()
        side = str(doc.get("order_type") or doc.get("side") or "").upper()
        pipe = redis_cluster.pipeline()
        if symbol and side in ("BUY", "SELL"):
            pipe.zrem(_sl_key(symbol, side), order_id)
            pipe.zrem(_tp_key(symbol, side), order_id)
        pipe.delete(key)
        await pipe.execute()
        return doc
    except Exception as e:
        logger.error("remove_order_triggers failed for %s: %s", order_id, e)
        return {}


async def upsert_order_triggers(*,
                                order_id: str,
                                symbol: str,
                                side: str,
                                user_type: str,
                                user_id: str,
                                stop_loss: Optional[float] = None,
                                take_profit: Optional[float] = None) -> bool:
    """
    Store triggers in Redis for monitoring. Member=order_id, score=trigger price.
    - Sorted sets per symbol+side for SL and TP: ensures O(logN) insert/remove and efficient range scans.
    - A hash order_triggers:{order_id} keeps metadata for fast deletions.
    """
    try:
        symbol = str(symbol).upper()
        side = str(side).upper()
        if side not in ("BUY", "SELL"):
            return False
        mapping = {
            "order_id": order_id,
            "symbol": symbol,
            "order_type": side,
            "user_type": user_type,
            "user_id": str(user_id),
        }
        if stop_loss is not None:
            mapping["stop_loss"] = str(float(stop_loss))
        if take_profit is not None:
            mapping["take_profit"] = str(float(take_profit))
        pipe = redis_cluster.pipeline()
        pipe.hset(_order_triggers_key(order_id), mapping=mapping)
        if stop_loss is not None:
            pipe.zadd(_sl_key(symbol, side), {order_id: float(stop_loss)})
        if take_profit is not None:
            pipe.zadd(_tp_key(symbol, side), {order_id: float(take_profit)})
        await pipe.execute()
        return True
    except Exception as e:
        logger.error("upsert_order_triggers failed for %s: %s", order_id, e)
        return False
