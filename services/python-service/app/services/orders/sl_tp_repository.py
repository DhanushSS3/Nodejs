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
                                take_profit: Optional[float] = None,
                                score_stop_loss: Optional[float] = None,
                                score_take_profit: Optional[float] = None) -> bool:
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
            mapping["stop_loss"] = str(float(stop_loss))  # legacy
            if score_stop_loss is not None:
                mapping["stop_loss_user"] = str(float(stop_loss))
                mapping["stop_loss_compare"] = str(float(score_stop_loss))
        if take_profit is not None:
            mapping["take_profit"] = str(float(take_profit))  # legacy
            if score_take_profit is not None:
                mapping["take_profit_user"] = str(float(take_profit))
                mapping["take_profit_compare"] = str(float(score_take_profit))
        pipe = redis_cluster.pipeline()
        pipe.hset(_order_triggers_key(order_id), mapping=mapping)
        if stop_loss is not None:
            sl_score = float(score_stop_loss if score_stop_loss is not None else stop_loss)
            pipe.zadd(_sl_key(symbol, side), {order_id: sl_score})
        if take_profit is not None:
            tp_score = float(score_take_profit if score_take_profit is not None else take_profit)
            pipe.zadd(_tp_key(symbol, side), {order_id: tp_score})
        await pipe.execute()
        # Track active symbols for monitoring loop
        try:
            if stop_loss is not None or take_profit is not None:
                await redis_cluster.sadd("trigger_active_symbols", symbol)
        except Exception:
            pass
        return True
    except Exception as e:
        logger.error("upsert_order_triggers failed for %s: %s", order_id, e)
        return False


async def remove_stoploss_trigger(order_id: str) -> bool:
    """
    Remove only the stoploss parts of the trigger state for the given order.
    Does not remove the takeprofit trigger if present.
    """
    try:
        key = _order_triggers_key(order_id)
        doc = await redis_cluster.hgetall(key)
        if not doc:
            return True
        symbol = str(doc.get("symbol") or "").upper()
        side = str(doc.get("order_type") or doc.get("side") or "").upper()
        pipe = redis_cluster.pipeline()
        if symbol and side in ("BUY", "SELL"):
            pipe.zrem(_sl_key(symbol, side), order_id)
        # Remove only SL fields from hash
        try:
            pipe.hdel(key, "stop_loss", "stop_loss_user", "stop_loss_compare")
        except Exception:
            # Some Redis clients require multiple calls; fallback
            pipe.hdel(key, "stop_loss")
            pipe.hdel(key, "stop_loss_user")
            pipe.hdel(key, "stop_loss_compare")
        await pipe.execute()
        return True
    except Exception as e:
        logger.error("remove_stoploss_trigger failed for %s: %s", order_id, e)
        return False


async def remove_takeprofit_trigger(order_id: str) -> bool:
    """
    Remove only the takeprofit parts of the trigger state for the given order.
    Does not remove the stoploss trigger if present.
    """
    try:
        key = _order_triggers_key(order_id)
        doc = await redis_cluster.hgetall(key)
        if not doc:
            return True
        symbol = str(doc.get("symbol") or "").upper()
        side = str(doc.get("order_type") or doc.get("side") or "").upper()
        pipe = redis_cluster.pipeline()
        if symbol and side in ("BUY", "SELL"):
            pipe.zrem(_tp_key(symbol, side), order_id)
        # Remove only TP fields from hash
        try:
            pipe.hdel(key, "take_profit", "take_profit_user", "take_profit_compare")
        except Exception:
            pipe.hdel(key, "take_profit")
            pipe.hdel(key, "take_profit_user")
            pipe.hdel(key, "take_profit_compare")
        await pipe.execute()
        return True
    except Exception as e:
        logger.error("remove_takeprofit_trigger failed for %s: %s", order_id, e)
        return False
