import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from redis.exceptions import ResponseError

from app.config.redis_config import redis_cluster

logger = logging.getLogger(__name__)

# Module-level cache for script text
_ORDER_PLACE_SCRIPT_TEXT: Optional[str] = None


async def _get_order_place_script_text() -> str:
    """Load and cache the Lua script text. Using EVAL avoids per-node script caching issues in cluster.
    """
    global _ORDER_PLACE_SCRIPT_TEXT
    if _ORDER_PLACE_SCRIPT_TEXT is not None:
        return _ORDER_PLACE_SCRIPT_TEXT
    try:
        from pathlib import Path
        script_path = Path(__file__).resolve().parents[2] / "lua" / "order_place.lua"
        with open(script_path, "r", encoding="utf-8") as f:
            _ORDER_PLACE_SCRIPT_TEXT = f.read()
        return _ORDER_PLACE_SCRIPT_TEXT
    except Exception as e:
        logger.error("Failed to read order_place.lua: %s", e)
        raise


async def get_idempotency(key: str) -> Optional[Dict[str, Any]]:
    try:
        raw = await redis_cluster.get(key)
        if not raw:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return {"raw": raw}
    except Exception as e:
        logger.error("get_idempotency error for key=%s: %s", key, e)
        return None


async def set_idempotency_placeholder(key: str, ttl_sec: int = 60) -> bool:
    """Set a short-lived placeholder to prevent duplicate processing.
    Returns True if successfully set (NX), False if already exists.
    """
    try:
        # SET key value NX EX ttl
        ok = await redis_cluster.set(key, json.dumps({"status": "processing"}), ex=ttl_sec, nx=True)
        return bool(ok)
    except Exception as e:
        logger.error("set_idempotency_placeholder error for key=%s: %s", key, e)
        return False


async def save_idempotency_result(key: str, result: Dict[str, Any], ttl_sec: int = 300) -> None:
    try:
        await redis_cluster.set(key, json.dumps(result), ex=ttl_sec)
    except Exception as e:
        logger.error("save_idempotency_result error for key=%s: %s", key, e)


async def fetch_user_config(user_type: str, user_id: str) -> Dict[str, Any]:
    key = f"user:{{{user_type}:{user_id}}}:config"
    try:
        data = await redis_cluster.hgetall(key)
        # Normalize types
        def _f(v):
            try:
                return float(v)
            except (TypeError, ValueError):
                return None
        cfg = {
            "wallet_balance": _f(data.get("wallet_balance")) if data else None,
            "leverage": _f(data.get("leverage")) if data else None,
            "group": (data.get("group") or "Standard") if data else "Standard",
            "status": int(data.get("status")) if data and data.get("status") is not None else 1,
            "sending_orders": data.get("sending_orders") if data else None,
        }
        return cfg
    except Exception as e:
        logger.error("fetch_user_config error for %s:%s: %s", user_type, user_id, e)
        return {"wallet_balance": None, "leverage": None, "group": "Standard", "status": 0, "sending_orders": None}


async def fetch_user_portfolio(user_type: str, user_id: str) -> Dict[str, Any]:
    key = f"user_portfolio:{{{user_type}:{user_id}}}"
    try:
        data = await redis_cluster.hgetall(key)
        return data or {}
    except Exception as e:
        logger.error("fetch_user_portfolio error for %s:%s: %s", user_type, user_id, e)
        return {}


async def fetch_group_data(symbol: str, group: str) -> Dict[str, Any]:
    """Fetch group data for symbol with fallback to Standard."""
    try:
        k_user = f"groups:{{{group}}}:{symbol}"
        k_std = f"groups:{{Standard}}:{symbol}"
        data = await redis_cluster.hgetall(k_user)
        if not data:
            data = await redis_cluster.hgetall(k_std)
        return data or {}
    except Exception as e:
        logger.error("fetch_group_data error for %s group=%s: %s", symbol, group, e)
        return {}


async def fetch_user_orders(user_type: str, user_id: str) -> List[Dict[str, Any]]:
    pattern = f"user_holdings:{{{user_type}:{user_id}}}:*"
    try:
        cursor = b"0"
        keys: List[str] = []
        while cursor:
            cursor, batch = await redis_cluster.scan(cursor=cursor, match=pattern, count=100)
            keys.extend(batch)
            if cursor == b"0" or cursor == 0:
                break
        if not keys:
            return []
        # Fetch orders concurrently
        from asyncio import gather
        results = await gather(*[redis_cluster.hgetall(k) for k in keys])
        orders: List[Dict[str, Any]] = []
        for i, k in enumerate(keys):
            try:
                key_str = k.decode() if isinstance(k, (bytes, bytearray)) else str(k)
            except Exception:
                key_str = str(k)
            order_id = key_str.rsplit(":", 1)[-1]
            od = results[i] or {}
            od["order_id"] = od.get("order_id") or order_id
            od["order_key"] = key_str
            orders.append(od)
        return orders
    except Exception as e:
        logger.error("fetch_user_orders error for %s:%s: %s", user_type, user_id, e)
        return []


async def place_order_atomic_or_fallback(
    *,
    user_type: str,
    user_id: str,
    order_id: str,
    symbol: str,
    order_fields: Dict[str, Any],
    single_order_margin_usd: Optional[float],
    recomputed_user_used_margin_usd: Optional[float],
) -> Tuple[bool, str]:
    """
    Try to place order atomically via Lua. If cluster raises CROSSSLOT, fallback to non-atomic path.

    Returns: (ok, reason) reason is empty when ok=True.
    """
    # Use hash tags for user-specific keys to ensure same Redis Cluster slot
    hash_tag = f"{user_type}:{user_id}"
    user_config_key = f"user:{{{hash_tag}}}:config"
    order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
    portfolio_key = f"user_portfolio:{{{hash_tag}}}"

    order_fields_json = json.dumps(order_fields, separators=(",", ":"))

    # Attempt Lua atomic path
    try:
        lua_src = await _get_order_place_script_text()
        # Pass only user-scoped keys to guarantee same slot and avoid CROSSSLOT
        keys = [user_config_key, order_key, portfolio_key]
        args = [
            user_type,
            str(user_id),
            order_id,
            symbol,
            order_fields_json,
            "" if single_order_margin_usd is None else str(float(single_order_margin_usd)),
            "" if recomputed_user_used_margin_usd is None else str(float(recomputed_user_used_margin_usd)),
        ]
        raw = await redis_cluster.eval(lua_src, len(keys), *keys, *args)
        # Script returns JSON string
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode()
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            data = {"ok": False, "reason": "invalid_script_response", "raw": raw}
        if data and data.get("ok"):
            # Perform non-user-scoped updates outside Lua to avoid cross-slot access
            try:
                symbol_holders_key = f"symbol_holders:{symbol}:{user_type}"
                await redis_cluster.sadd(symbol_holders_key, f"{user_type}:{user_id}")
            except Exception as e:
                logger.warning("symbol_holders SADD failed post-atomic: %s", e)
            return True, ""
        reason = (data or {}).get("reason", "script_failed")
        # If reason is inconsistent hash tags, fall back
        if reason in ("inconsistent_hash_tags", "missing_hash_tag"):
            logger.warning("Lua script hash tag issue; falling back to non-atomic path: %s", reason)
            return await _place_order_non_atomic(
                user_type=user_type,
                user_id=user_id,
                order_id=order_id,
                symbol=symbol,
                order_fields=order_fields,
                recomputed_user_used_margin_usd=recomputed_user_used_margin_usd,
            )
        return False, reason
    except ResponseError as re:
        msg = str(re)
        if "CROSSSLOT" in msg or "Keys in request don't hash to the same slot" in msg:
            logger.warning("Redis EVALSHA CROSSSLOT; falling back to non-atomic path: %s", msg)
            return await _place_order_non_atomic(
                user_type=user_type,
                user_id=user_id,
                order_id=order_id,
                symbol=symbol,
                order_fields=order_fields,
                recomputed_user_used_margin_usd=recomputed_user_used_margin_usd,
            )
        logger.error("EVALSHA ResponseError: %s", re)
        return False, "evalsha_error"
    except Exception as e:
        logger.error("place_order_atomic_or_fallback unexpected error: %s", e)
        return False, "exception"


async def _place_order_non_atomic(
    *,
    user_type: str,
    user_id: str,
    order_id: str,
    symbol: str,
    order_fields: Dict[str, Any],
    recomputed_user_used_margin_usd: Optional[float],
) -> Tuple[bool, str]:
    """Best-effort non-atomic placement when Lua cannot be used on cluster."""
    try:
        # Use same hash-tagged keys as atomic path
        hash_tag = f"{user_type}:{user_id}"
        order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
        portfolio_key = f"user_portfolio:{{{hash_tag}}}"
        symbol_holders_key = f"symbol_holders:{symbol}:{user_type}"
        # Ensure we do not overwrite an existing order
        exists = await redis_cluster.exists(order_key)
        if exists:
            return False, "order_exists"
        # HSET order
        # Flatten mapping to list
        mapping = {k: ("" if v is None else str(v)) for k, v in order_fields.items()}
        await redis_cluster.hset(order_key, mapping=mapping)
        # Add to symbol holders
        await redis_cluster.sadd(symbol_holders_key, f"{user_type}:{user_id}")
        # Update used margin if provided
        if recomputed_user_used_margin_usd is not None:
            await redis_cluster.hset(portfolio_key, mapping={"used_margin": str(float(recomputed_user_used_margin_usd))})
        return True, ""
    except Exception as e:
        logger.error("_place_order_non_atomic error: %s", e)
        return False, "non_atomic_error"
