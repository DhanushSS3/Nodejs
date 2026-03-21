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


async def replace_provider_id(old_id: str, new_id: str) -> Dict[str, Any]:
    """
    Replace an old provider ID with a new provider ID (e.g., after a rollover or restart).
    Updates the global lookup and the specific lifecycle ID field in the canonical order.
    """
    if not old_id or not new_id:
        return {"ok": False, "reason": "Missing old_id or new_id"}

    try:
        # 1. Resolve canonical order ID from old_id
        canonical_order_id = await redis_cluster.get(f"global_order_lookup:{old_id}")
        
        if not canonical_order_id:
            # If not in lookup, check if old_id is the canonical order ID itself
            exists = await redis_cluster.exists(f"order_data:{old_id}")
            if exists:
                canonical_order_id = old_id
            else:
                return {"ok": False, "reason": f"Canonical order not found for old_id: {old_id}"}
        
        canonical_order_id = str(canonical_order_id)
        order_hash_key = f"order_data:{canonical_order_id}"
        
        # 2. Fetch the current order data to find where old_id is used
        order_data = await redis_cluster.hgetall(order_hash_key)
        if not order_data:
            return {"ok": False, "reason": f"Order data not found for canonical ID: {canonical_order_id}"}
            
        # 3. Identify which lifecycle field holds the old_id based on prefix
        old_id_str = str(old_id)
        if old_id_str.startswith("SL"):
            matched_field = "stoploss_id"
        elif old_id_str.startswith("TP"):
            matched_field = "takeprofit_id"
        else:
            # No prefix (purely numeric) means it's a pending order replacement
            matched_field = "provider_order_id"
            
        # Prepare pipeline for atomic updates
        pipe = redis_cluster.pipeline()
        
        # 4. Map the new_id to the canonical order ID
        pipe.set(f"global_order_lookup:{new_id}", canonical_order_id)
        
        # 5. Always securely map the new ID to the corresponding explicit field
        pipe.hset(order_hash_key, matched_field, new_id)
                
        # 6. Update associated_ids list safely
        try:
            raw_associated = order_data.get("associated_ids")
            import json
            ids_list = json.loads(raw_associated) if raw_associated else []
            if old_id in ids_list:
                ids_list.remove(old_id)
            if new_id not in ids_list:
                ids_list.append(new_id)
            pipe.hset(order_hash_key, "associated_ids", json.dumps(ids_list))
        except Exception as e:
            logger.warning(f"Failed to parse associated_ids for {canonical_order_id}: {e}")
            
        # We intentionally keep global_order_lookup:{old_id} around intact to not break delayed reports.

        await pipe.execute()
        return {
            "ok": True, 
            "canonical_order_id": canonical_order_id,
            "matched_field": matched_field,
            "note": "Replaced ID successfully"
        }
        
    except Exception as e:
        logger.error(f"replace_provider_id failed for old_id={old_id} new_id={new_id}: {e}")
        return {"ok": False, "reason": str(e)}
