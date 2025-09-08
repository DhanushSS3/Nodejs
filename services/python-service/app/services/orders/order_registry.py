import json
import logging
from typing import Any, Dict, Optional

from app.config.redis_config import redis_cluster

logger = logging.getLogger(__name__)


async def _to_str_mapping(d: Dict[str, Any]) -> Dict[str, str]:
    return {k: ("" if v is None else str(v)) for k, v in d.items()}


async def create_canonical_order(order_data: Dict[str, Any]) -> None:
    """
    Create/overwrite the canonical order hash and ensure self-lookup for order_id.

    Keys used:
      - order_data:{order_id}  (HASH)
      - global_order_lookup:{order_id} -> {order_id} (STRING)
    """
    order_id = order_data.get("order_id")
    if not order_id:
        raise ValueError("order_id is required for canonical order creation")

    order_hash_key = f"order_data:{order_id}"
    lookup_key = f"global_order_lookup:{order_id}"

    try:
        mapping = await _to_str_mapping(order_data)
        pipe = redis_cluster.pipeline()
        pipe.hset(order_hash_key, mapping=mapping)
        pipe.setnx(lookup_key, order_id)
        await pipe.execute()
    except Exception as e:
        logger.error("create_canonical_order failed for %s: %s", order_id, e)
        # Do not raise to avoid breaking the main flow


async def add_lifecycle_id(order_id: str, new_id: str, id_type: str) -> None:
    """
    Add a lifecycle-generated ID (e.g., close_id, modify_id, takeprofit_id, stoploss_id, ...)
    - Ensure global lookup new_id -> order_id exists
    - Update order_data:{order_id} hash with the id_type field set to new_id
    - Optionally update associated_ids JSON array
    """
    if not order_id or not new_id or not id_type:
        raise ValueError("order_id, new_id, id_type are required")

    order_hash_key = f"order_data:{order_id}"
    lookup_key = f"global_order_lookup:{new_id}"

    try:
        # Create lookup and set the field on canonical hash
        pipe = redis_cluster.pipeline()
        pipe.setnx(lookup_key, order_id)
        pipe.hset(order_hash_key, id_type, new_id)
        await pipe.execute()

        # Update associated_ids array (best-effort)
        try:
            raw = await redis_cluster.hget(order_hash_key, "associated_ids")
            ids_list = json.loads(raw) if raw else []
            if new_id not in ids_list:
                ids_list.append(new_id)
                await redis_cluster.hset(order_hash_key, "associated_ids", json.dumps(ids_list))
        except Exception as inner:
            logger.warning("Failed to update associated_ids for %s: %s", order_id, inner)
    except Exception as e:
        logger.error("add_lifecycle_id failed order_id=%s new_id=%s type=%s: %s", order_id, new_id, id_type, e)


async def get_canonical_order_by_any_id(any_id: str) -> Optional[Dict[str, Any]]:
    """
    Resolve any lifecycle ID to the canonical order hash.
    - Checks global_order_lookup:{any_id} -> order_id
    - If not present, treats any_id as order_id directly (self-mapping case)
    - Returns order hash dict or None if not found
    """
    if not any_id:
        return None
    try:
        order_id = await redis_cluster.get(f"global_order_lookup:{any_id}")
        if not order_id:
            # Try self-mapping style
            order_id = any_id
        data = await redis_cluster.hgetall(f"order_data:{order_id}")
        return data or None
    except Exception as e:
        logger.error("get_canonical_order_by_any_id error for %s: %s", any_id, e)
        return None
