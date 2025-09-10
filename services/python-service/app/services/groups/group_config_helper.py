import os
import logging
from typing import Any, Dict, Optional

import aiohttp

from app.config.redis_config import redis_cluster

logger = logging.getLogger(__name__)

INTERNAL_PROVIDER_URL = os.getenv("INTERNAL_PROVIDER_URL", "http://127.0.0.1:3000/api/internal/provider")


async def _fetch_from_redis(group: str, symbol: str) -> Dict[str, Any]:
    key = f"groups:{{{group}}}:{symbol.upper()}"
    try:
        data = await redis_cluster.hgetall(key)
        return data or {}
    except Exception as e:
        logger.warning("group redis fetch failed: %s", e)
        return {}


async def _fetch_from_db_via_node(group: str, symbol: str) -> Optional[Dict[str, Any]]:
    url = f"{INTERNAL_PROVIDER_URL}/groups/{group}/{symbol.upper()}"
    timeout = aiohttp.ClientTimeout(total=3.0)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as resp:
                if resp.status != 200:
                    return None
                js = await resp.json()
                return js.get("data") or None
    except Exception as e:
        logger.warning("group db fallback failed for %s %s: %s", group, symbol, e)
        return None


def _normalize_group_dict(src: Dict[str, Any]) -> Dict[str, Any]:
    if not src:
        return {}
    out: Dict[str, Any] = {}
    for k in ("type", "contract_size", "profit", "spread", "spread_pip"):
        if k in src and src[k] is not None:
            out[k] = src[k]
    return out


async def _cache_into_redis(group: str, symbol: str, g: Dict[str, Any]) -> None:
    if not g:
        return
    key = f"groups:{{{group}}}:{symbol.upper()}"
    try:
        await redis_cluster.hset(key, mapping={k: str(v) for k, v in g.items() if v is not None})
    except Exception as e:
        logger.warning("group redis cache failed: %s", e)


async def get_group_config_with_fallback(group: str, symbol: str) -> Dict[str, Any]:
    """
    Resolve group config for (group, symbol) with Redis-first strategy and DB fallback via Node.
    Caches successful DB responses back into Redis for future reads.
    Returns a dict possibly containing: type, contract_size, profit, spread, spread_pip
    """
    # 1) Try Redis (group, then Standard)
    data = await _fetch_from_redis(group, symbol)
    if not data:
        data = await _fetch_from_redis("Standard", symbol)

    # 2) If required fields missing, fallback to DB via Node for (group, symbol), then (Standard, symbol)
    required_missing = not data or (data.get("contract_size") is None or data.get("profit") is None or data.get("type") is None)
    if required_missing:
        db = await _fetch_from_db_via_node(group, symbol)
        if not db:
            db = await _fetch_from_db_via_node("Standard", symbol)
        if db:
            norm = _normalize_group_dict(db)
            await _cache_into_redis(db.get("name", group) or group, symbol, norm)
            # If Standard returned and original group missing, also cache under requested group for next time
            if (db.get("name") or "").strip() != str(group):
                await _cache_into_redis(group, symbol, norm)
            data = {**data, **norm}

    return data or {}
