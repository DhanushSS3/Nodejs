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
    Replace an old provider ID with a new provider ID during recovery.
    If the ID is the main order_id, we rename the Redis hash key to maintain consistency.
    """
    if not old_id or not new_id:
        return {"ok": False, "reason": "Missing old_id or new_id"}

    try:
        canonical_order_id = await redis_cluster.get(f"global_order_lookup:{old_id}")
        canonical_order_id = str(canonical_order_id) if canonical_order_id else None

        if not canonical_order_id:
            exists = await redis_cluster.exists(f"order_data:{old_id}")
            if exists:
                canonical_order_id = str(old_id)

        if not canonical_order_id:
            logger.warning(
                "[REGISTRY:REPLACE_NOT_FOUND] old_id=%s not in global_order_lookup and no direct order_data key exists",
                old_id
            )
            return {"ok": False, "reason": f"Canonical order not found for old_id: {old_id}"}

        old_hash_key = f"order_data:{canonical_order_id}"

        # Fetch full order hash so we can return user_id/user_type and update associated_ids
        order_data = await redis_cluster.hgetall(old_hash_key)
        if not order_data:
            return {"ok": False, "reason": f"order_data hash empty for canonical_id: {canonical_order_id}"}

        # Determine which field to replace based on ID prefix convention
        old_id_str = str(old_id)
        if old_id_str.startswith("SL"):
            matched_field = "stoploss_id"
        elif old_id_str.startswith("TP"):
            matched_field = "takeprofit_id"
        else:
            # Pure numeric → main order_id replacement (pending order recovery)
            matched_field = "order_id"

        is_main_order = (matched_field == "order_id")
        new_canonical_id = new_id if is_main_order else canonical_order_id
        new_hash_key = f"order_data:{new_canonical_id}"

        pipe = redis_cluster.pipeline()
        
        if is_main_order:
            # Rename canonical hash to new key
            pipe.rename(old_hash_key, new_hash_key)
            pipe.hset(new_hash_key, "order_id", new_id)
            pipe.set(f"global_order_lookup:{new_id}", new_id)
            
            # The holdings key must be renamed too if user details are present
            user_type = order_data.get("user_type") or order_data.get("order_user_type")
            user_id = order_data.get("user_id") or order_data.get("order_user_id")
            if user_type and user_id:
                old_holdings_key = f"user_holdings:{{{user_type}:{user_id}}}:{old_id}"
                new_holdings_key = f"user_holdings:{{{user_type}:{user_id}}}:{new_id}"
                index_key = f"user_orders_index:{{{user_type}:{user_id}}}"
                
                try:
                    exists = await redis_cluster.exists(old_holdings_key)
                    if exists:
                        pipe.rename(old_holdings_key, new_holdings_key)
                    pipe.srem(index_key, old_id)
                    pipe.sadd(index_key, new_id)
                except Exception as e:
                    logger.warning("[REGISTRY:HOLDINGS_WARN] error migrating holdings: %s", e)
        else:
            pipe.hset(old_hash_key, matched_field, new_id)
            pipe.set(f"global_order_lookup:{new_id}", canonical_order_id)

        # Keep associated_ids consistent (best-effort)
        try:
            import json as _json
            raw_associated = order_data.get("associated_ids")
            ids_list = _json.loads(raw_associated) if raw_associated else []
            if old_id in ids_list:
                ids_list.remove(old_id)
            if new_id not in ids_list:
                ids_list.append(new_id)
            pipe.hset(new_hash_key, "associated_ids", _json.dumps(ids_list))
        except Exception as assoc_err:
            logger.warning("[REGISTRY:REPLACE_ASSOC_WARN] canonical=%s err=%s", canonical_order_id, assoc_err)

        await pipe.execute()

        logger.info(
            "[REGISTRY:REPLACE_OK] old_id=%s new_id=%s field=%s canonical=%s action=%s",
            old_id, new_id, matched_field, canonical_order_id, 
            "key_renamed" if is_main_order else "field_updated"
        )
        return {
            "ok": True,
            "canonical_order_id": new_canonical_id,
            "current_sql_id": old_id if is_main_order else (order_data.get("order_id") or canonical_order_id),
            "matched_field": matched_field,
            "user_id": order_data.get("order_user_id") or order_data.get("user_id"),
            "user_type": order_data.get("order_user_type") or order_data.get("user_type"),
        }

    except Exception as e:
        logger.error("[REGISTRY:REPLACE_ERROR] old_id=%s new_id=%s err=%s", old_id, new_id, e)
        return {"ok": False, "reason": str(e)}
