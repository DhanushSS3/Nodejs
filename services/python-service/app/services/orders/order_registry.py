import json
import logging
import time
from typing import Any, Dict, Optional

from app.config.redis_config import redis_cluster

logger = logging.getLogger(__name__)


async def _to_str_mapping(d: Dict[str, Any]) -> Dict[str, str]:
    return {k: ("" if v is None else str(v)) for k, v in d.items()}


async def create_canonical_order(order_data: Dict[str, Any]) -> None:
    """
    Create/overwrite the canonical order hash and ensure self-lookup for order_id.
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


async def add_lifecycle_id(order_id: str, new_id: str, id_type: str) -> None:
    """
    Add a lifecycle-generated ID (e.g., close_id, stoploss_id, takeprofit_id)
    """
    if not order_id or not new_id or not id_type:
        raise ValueError("order_id, new_id, id_type are required")

    order_hash_key = f"order_data:{order_id}"
    lookup_key = f"global_order_lookup:{new_id}"

    try:
        pipe = redis_cluster.pipeline()
        pipe.setnx(lookup_key, order_id)
        pipe.hset(order_hash_key, id_type, new_id)
        
        # Update associated_ids list
        try:
            raw = await redis_cluster.hget(order_hash_key, "associated_ids")
            ids_list = json.loads(raw) if raw else []
            if new_id not in ids_list:
                ids_list.append(new_id)
                pipe.hset(order_hash_key, "associated_ids", json.dumps(ids_list))
        except Exception:
            pass
            
        await pipe.execute()
        logger.info("[REGISTRY:ADD_ID] Linked %s (%s) -> %s", new_id, id_type, order_id)
    except Exception as e:
        logger.error("add_lifecycle_id failed for %s -> %s: %s", new_id, order_id, e)


async def get_order_by_lifecycle_id(lifecycle_id: str) -> Optional[Dict[str, Any]]:
    """Resolve any ID to order data hash."""
    if not lifecycle_id:
        return None
    try:
        order_id = await redis_cluster.get(f"global_order_lookup:{lifecycle_id}")
        if not order_id:
            # Fallback: check if the ID is the canonical ID itself
            exists = await redis_cluster.exists(f"order_data:{lifecycle_id}")
            if exists:
                order_id = lifecycle_id
        
        if order_id:
            return await redis_cluster.hgetall(f"order_data:{order_id}")
    except Exception as e:
        logger.error("get_order_by_lifecycle_id error for %s: %s", lifecycle_id, e)
    return None


async def replace_provider_id(old_id: str, new_id: str) -> Dict[str, Any]:
    """
    Atomically replace/map a provider ID during recovery.
    """
    if not old_id or not new_id:
        return {"ok": False, "reason": "Missing old_id or new_id"}

    try:
        # Step 1: Resolve the canonical ID
        canonical_id = await redis_cluster.get(f"global_order_lookup:{old_id}")
        if not canonical_id:
            if await redis_cluster.exists(f"order_data:{old_id}"):
                canonical_id = old_id
        
        if not canonical_id:
            return {"ok": False, "reason": f"Canonical order not found for {old_id}"}
        
        canonical_id = str(canonical_id)
        order_hash_key = f"order_data:{canonical_id}"
        
        # Determine field
        field = "provider_order_id"
        if new_id.startswith("SL"): field = "stoploss_id"
        elif new_id.startswith("TP"): field = "takeprofit_id"
        elif new_id.startswith("CLS"): field = "close_id"
        
        # Step 2: Atomic Update
        pipe = redis_cluster.pipeline()
        pipe.hset(order_hash_key, field, new_id)
        pipe.set(f"global_order_lookup:{new_id}", canonical_id)
        
        # Update associated_ids list
        try:
            order_data = await redis_cluster.hgetall(order_hash_key)
            raw = order_data.get("associated_ids")
            ids_list = json.loads(raw) if raw else []
            if new_id not in ids_list:
                ids_list.append(new_id)
                pipe.hset(order_hash_key, "associated_ids", json.dumps(ids_list))
        except Exception:
            pass
            
        await pipe.execute()
        logger.info("[REGISTRY:REPLACE_ID] SUCCESS: %s -> %s (field=%s, canonical=%s)", old_id, new_id, field, canonical_id)
        
        return {
            "ok": True,
            "canonical_order_id": canonical_id,
            "field": field,
            "old_id": old_id,
            "new_id": new_id,
            "user_id": order_data.get("order_user_id"),
            "user_type": order_data.get("user_type")
        }
    except Exception as e:
        logger.error("replace_provider_id error: %s", e)
        return {"ok": False, "reason": str(e)}


def get_order_id_from_execution_report(report: Dict[str, Any]) -> Optional[str]:
    """Extract ID from report."""
    return report.get("order_id") or report.get("ClOrdID") or report.get("OrderID") or report.get("exec_id")


async def resolve_canonical_order_id(any_id: str) -> Optional[str]:
    """Resolve any ID to CID."""
    if not any_id: return None
    cid = await redis_cluster.get(f"global_order_lookup:{any_id}")
    if not cid and await redis_cluster.exists(f"order_data:{any_id}"):
        return any_id
    return str(cid) if cid else None


async def trigger_db_id_replacement(
    channel: Any, 
    old_id: str, 
    new_id: str, 
    canonical_id: str, 
    user_id: str = None, 
    user_type: str = None
):
    """Notify Node.js about ID replacement."""
    try:
        from app.services.provider.dispatcher import DB_UPDATE_QUEUE
        import orjson
        import aio_pika

        id_type = 'order_id'
        if new_id.startswith('SL'): id_type = 'stoploss_id'
        elif new_id.startswith('TP'): id_type = 'takeprofit_id'
        elif new_id.startswith('CLS'): id_type = 'close_id'

        payload = {
            "type": "ORDER_LIFECYCLE_ID_REPLACEMENT",
            "order_id": canonical_id,
            "old_lifecycle_id": old_id,
            "new_lifecycle_id": new_id,
            "id_type": id_type,
            "user_id": user_id,
            "user_type": user_type,
            "timestamp": time.time()
        }

        msg = aio_pika.Message(body=orjson.dumps(payload), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
        await channel.default_exchange.publish(msg, routing_key=DB_UPDATE_QUEUE)
        logger.info("[REGISTRY:DB_TRIGGER] Published for %s -> %s", old_id, new_id)
    except Exception as e:
        logger.error("[REGISTRY:DB_TRIGGER_ERROR] %s", e)
