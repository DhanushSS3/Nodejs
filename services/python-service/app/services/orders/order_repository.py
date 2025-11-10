import json
import logging
from typing import Any, Dict, List, Optional, Tuple
import os
import time

import aiomysql
from redis.exceptions import ResponseError

from app.config.redis_config import redis_cluster
from app.config.redis_logging import (
    log_connection_acquire, log_connection_release, log_connection_error,
    log_pipeline_operation, connection_tracker, generate_operation_id
)
from app.services.logging.timing_logger import get_orders_timing_logger

logger = logging.getLogger(__name__)
_TIMING_LOG = get_orders_timing_logger()

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
    operation_id = generate_operation_id()
    connection_tracker.start_operation(operation_id, "cluster", f"get_idempotency_{key}")
    log_connection_acquire("cluster", f"get_idempotency_{key}", operation_id)
    
    try:
        raw = await redis_cluster.get(key)
        log_connection_release("cluster", f"get_idempotency_{key}", operation_id)
        connection_tracker.end_operation(operation_id, success=True)
        
        if not raw:
            return None
        try:
            return json.loads(raw)
        except Exception:
            return {"raw": raw}
    except Exception as e:
        log_connection_error("cluster", f"get_idempotency_{key}", str(e), operation_id)
        connection_tracker.end_operation(operation_id, success=False, error=str(e))
        logger.error("get_idempotency error for key=%s: %s", key, e)
        return None


async def set_idempotency_placeholder(key: str, ttl_sec: int = 60) -> bool:
    """Set a short-lived placeholder to prevent duplicate processing.
    Returns True if successfully set (NX), False if already exists.
    """
    operation_id = generate_operation_id()
    connection_tracker.start_operation(operation_id, "cluster", f"set_idempotency_placeholder_{key}")
    log_connection_acquire("cluster", f"set_idempotency_placeholder_{key}", operation_id)
    
    try:
        # SET key value NX EX ttl
        ok = await redis_cluster.set(key, json.dumps({"status": "processing"}), ex=ttl_sec, nx=True)
        log_connection_release("cluster", f"set_idempotency_placeholder_{key}", operation_id)
        connection_tracker.end_operation(operation_id, success=True)
        return bool(ok)
    except Exception as e:
        log_connection_error("cluster", f"set_idempotency_placeholder_{key}", str(e), operation_id)
        connection_tracker.end_operation(operation_id, success=False, error=str(e))
        logger.error("set_idempotency_placeholder error for key=%s: %s", key, e)
        return False


async def save_idempotency_result(key: str, result: Dict[str, Any], ttl_sec: int = 300) -> None:
    operation_id = generate_operation_id()
    connection_tracker.start_operation(operation_id, "cluster", f"save_idempotency_result_{key}")
    log_connection_acquire("cluster", f"save_idempotency_result_{key}", operation_id)
    
    try:
        await redis_cluster.set(key, json.dumps(result), ex=ttl_sec)
        log_connection_release("cluster", f"save_idempotency_result_{key}", operation_id)
        connection_tracker.end_operation(operation_id, success=True)
    except Exception as e:
        log_connection_error("cluster", f"save_idempotency_result_{key}", str(e), operation_id)
        connection_tracker.end_operation(operation_id, success=False, error=str(e))
        logger.error("save_idempotency_result error for key=%s: %s", key, e)


async def fetch_user_config(user_type: str, user_id: str) -> Dict[str, Any]:
    """Fetch user config from Redis with DB fallback."""
    tagged_key = f"user:{{{user_type}:{user_id}}}:config"
    legacy_key = f"user:{user_type}:{user_id}:config"
    
    # Debug logging for key construction (only for strategy providers during transition)
    # if user_type == "strategy_provider":
    #     logger.info("fetch_user_config: Fetching config for %s:%s, tagged_key=%s, legacy_key=%s", 
    #                 user_type, user_id, tagged_key, legacy_key)
    
    # Check Redis cluster health before attempting operations
    try:
        cluster_info = await redis_cluster.cluster_info()
        cluster_state = cluster_info.get('cluster_state', 'unknown')
        cluster_size = cluster_info.get('cluster_size', 0)
        # Ensure cluster_size is an integer
        try:
            cluster_size = int(cluster_size) if cluster_size is not None else 0
        except (ValueError, TypeError):
            cluster_size = 0
            
        # Only log Redis health issues, not every successful check
        if cluster_state != 'ok':
            _TIMING_LOG.info('{"component":"redis_health_warning","user_type":"%s","user_id":"%s","cluster_state":"%s","issue":"cluster_not_ok"}',
                            user_type, user_id, cluster_state)
    except Exception as health_err:
        _TIMING_LOG.info('{"component":"redis_health_error","user_type":"%s","user_id":"%s","error":"%s"}',
                        user_type, user_id, str(health_err))
    
    
    # Try tagged key first
    data = {}
    used_legacy = False
    try:
        data = await redis_cluster.hgetall(tagged_key)
        # if user_type == "strategy_provider":
            # logger.info("fetch_user_config: Tagged key result for %s:%s: %s", user_type, user_id, data)
        # Only log if no data found (potential issue)
        if not data:
            _TIMING_LOG.info('{"component":"redis_tagged_empty","user_type":"%s","user_id":"%s","tagged_key":"%s"}',
                            user_type, user_id, tagged_key)
    except Exception as e:
        logger.error("fetch_user_config tagged hgetall failed for %s:%s: %s", user_type, user_id, e)
        _TIMING_LOG.info('{"component":"redis_tagged_error","user_type":"%s","user_id":"%s","error":"%s"}',
                        user_type, user_id, str(e))
        data = {}
    # Fallback to legacy key if empty
    if not data:
        try:
            data = await redis_cluster.hgetall(legacy_key)
            if user_type == "strategy_provider":
                logger.info("fetch_user_config: Legacy key result for %s:%s: %s", user_type, user_id, data)
            if data:
                used_legacy = True
                # Only log legacy fallback when it actually happens (useful info)
                _TIMING_LOG.info('{"component":"redis_legacy_fallback","user_type":"%s","user_id":"%s","keys_count":%d}',
                                user_type, user_id, len(data))
        except Exception as e:
            logger.error("fetch_user_config legacy hgetall failed for %s:%s: %s", user_type, user_id, e)
            _TIMING_LOG.info('{"component":"redis_legacy_error","user_type":"%s","user_id":"%s","error":"%s"}',
                            user_type, user_id, str(e))
            data = {}

    # If still missing critical fields, fallback to DB
    # Enhanced validation: check for None, empty string, or invalid values
    def _is_invalid_string_field(value):
        return value is None or str(value).strip() == ""
    
    def _is_invalid_leverage(value):
        if value is None or str(value).strip() == "":
            return True
        try:
            leverage_val = float(value)
            return leverage_val <= 0
        except (TypeError, ValueError):
            return True
    
    needs_db = (
        (not data) or 
        _is_invalid_string_field(data.get("group")) or 
        _is_invalid_leverage(data.get("leverage")) or 
        _is_invalid_string_field(data.get("sending_orders"))
    )
    db_cfg: Dict[str, Any] = {}
    if needs_db:
        logger.warning("fetch_user_config triggering DB fallback for %s:%s - Redis data: %s", 
                      user_type, user_id, {k: v for k, v in (data or {}).items() if k in ["group", "leverage", "sending_orders"]})
        
        try:
            db_cfg = await _fetch_user_config_from_db(user_type, user_id)
            if db_cfg:
                logger.info("fetch_user_config DB fallback successful for %s:%s", user_type, user_id)
        except Exception as dbe:
            logger.error("fetch_user_config DB fallback failed for %s:%s: %s", user_type, user_id, dbe)
            db_cfg = {}

    # If we used legacy, backfill into tagged to stabilize future reads
    if used_legacy and data:
        try:
            await redis_cluster.hset(tagged_key, mapping=data)
        except Exception as be:
            logger.warning("fetch_user_config backfill to tagged failed for %s:%s: %s", user_type, user_id, be)

    # If DB returned values, backfill minimal fields into tagged key
    if db_cfg:
        try:
            mapping = {}
            if db_cfg.get("group") is not None:
                mapping["group"] = db_cfg["group"]
            if db_cfg.get("leverage") is not None:
                mapping["leverage"] = str(db_cfg["leverage"])
            if db_cfg.get("status") is not None:
                mapping["status"] = str(db_cfg["status"])
            if db_cfg.get("is_active") is not None:
                mapping["is_active"] = str(db_cfg["is_active"])
            if db_cfg.get("wallet_balance") is not None:
                mapping["wallet_balance"] = str(db_cfg["wallet_balance"])
            if db_cfg.get("sending_orders") is not None:
                mapping["sending_orders"] = str(db_cfg["sending_orders"])
            if mapping:
                await redis_cluster.hset(tagged_key, mapping=mapping)
        except Exception as be2:
            logger.warning("fetch_user_config DB-backfill to tagged failed for %s:%s: %s", user_type, user_id, be2)
        
        # Merge DB cfg into data for return (ALWAYS do this if we have DB data)
        # Prefer Redis values when present, else DB
        data_before_merge = dict(data) if data else {}
        data = {**db_cfg, **data}

    # Normalize types safely
    def _f(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    # Status parsing: prefer explicit status; fallback to is_active; default to 1
    status_val = 1
    if data:
        raw_status = data.get("status")
        if raw_status is not None:
            try:
                status_val = int(raw_status)
            except (TypeError, ValueError):
                status_val = 1
        else:
            raw_active = data.get("is_active")
            if raw_active is not None:
                try:
                    status_val = int(raw_active)
                except (TypeError, ValueError):
                    status_val = 1

    # Create final config using merged data
    # Note: data should contain merged Redis + DB data at this point
    cfg = {
        "wallet_balance": _f(data.get("wallet_balance")) if data else None,
        "leverage": _f(data.get("leverage")) if data else None,
        "group": data.get("group") or "Standard",
        "status": status_val,
        "sending_orders": data.get("sending_orders"),
    }
    
    # Only log timing for config creation, not detailed data
    # Removed excessive final_config logging to reduce log noise
    
    return cfg


async def fetch_user_portfolio(user_type: str, user_id: str) -> Dict[str, Any]:
    key = f"user_portfolio:{{{user_type}:{user_id}}}"
    try:
        data = await redis_cluster.hgetall(key)
        return data or {}
    except Exception as e:
        logger.error("fetch_user_portfolio error for %s:%s: %s", user_type, user_id, e)
        return {}


async def fetch_group_data(symbol: str, group: str) -> Dict[str, Any]:
    """Fetch group data for symbol for the requested group ONLY (no Standard fallback)."""
    try:
        k_user = f"groups:{{{group}}}:{symbol}"
        data = await redis_cluster.hgetall(k_user)
        return data or {}
    except Exception as e:
        logger.error("fetch_group_data error for %s group=%s: %s", symbol, group, e)
        return {}


async def fetch_user_orders(user_type: str, user_id: str) -> List[Dict[str, Any]]:
    """Fetch all open orders for a user.
    Prefer the index set user_orders_index:{user_type:user_id} to avoid cluster-wide SCAN.
    Fallback to SCAN with robust flattening when index is unavailable.
    """
    # Validate input parameters
    if not user_type or not user_id or user_type == "None" or user_id == "None":
        logger.error("fetch_user_orders: invalid parameters user_type=%s user_id=%s", user_type, user_id)
        return []
        
    try:
        # Ensure user_type and user_id are strings to prevent dict injection
        user_type_str = str(user_type) if user_type is not None else ""
        user_id_str = str(user_id) if user_id is not None else ""
        hash_tag = f"{user_type_str}:{user_id_str}"
        index_key = f"user_orders_index:{{{hash_tag}}}"
        order_ids = await redis_cluster.smembers(index_key)
        keys: List[str] = []
        
        # Handle unexpected return types from smembers
        if isinstance(order_ids, dict):
            logger.error("fetch_user_orders: smembers returned dict for %s:%s: %s, converting to list", user_type, user_id, order_ids)
            order_ids = list(order_ids.values() if order_ids else [])
        elif not isinstance(order_ids, (list, set, tuple)):
            logger.error("fetch_user_orders: smembers returned unexpected type for %s:%s: %s", user_type, user_id, type(order_ids))
            order_ids = []
            
        if order_ids:
            # Ensure all order IDs are strings (handle bytes, dicts, etc.)
            sanitized_order_ids = []
            for oid in order_ids:
                try:
                    if isinstance(oid, (bytes, bytearray)):
                        sanitized_order_ids.append(oid.decode('utf-8'))
                    elif isinstance(oid, dict):
                        # Skip invalid dict entries
                        logger.warning("fetch_user_orders: skipping dict order_id for %s:%s: %s", user_type, user_id, oid)
                        continue
                    else:
                        sanitized_order_ids.append(str(oid))
                except Exception as e:
                    logger.warning("fetch_user_orders: failed to sanitize order_id for %s:%s: %s (error: %s)", user_type, user_id, oid, e)
                    continue
            keys = [f"user_holdings:{{{hash_tag}}}:{oid}" for oid in sanitized_order_ids]
        else:
            # Fallback to SCAN (flatten any cluster-returned dict of lists)
            # Ensure hash_tag is a string for pattern construction
            safe_hash_tag = str(hash_tag) if hash_tag is not None else f"{user_type_str}:{user_id_str}"
            pattern = f"user_holdings:{{{safe_hash_tag}}}:*"
            cursor = b"0"
            raw_keys: List[Any] = []
            while cursor:
                try:
                    batch_result = await redis_cluster.scan(cursor=cursor, match=pattern, count=100)
                except Exception as e:
                    logger.error("fetch_user_orders: SCAN error for %s:%s pattern %s: %s", user_type, user_id, pattern, e)
                    logger.error("fetch_user_orders: SCAN cursor type was: %s, value: %s", type(cursor), cursor)
                    break
                # batch_result may be (cursor, list) or dict mapping node->(cursor, list)
                if isinstance(batch_result, tuple) and len(batch_result) == 2:
                    cursor, batch = batch_result
                    # Ensure cursor is bytes - handle all possible types
                    if isinstance(cursor, dict):
                        # If cursor is a dict, we can't continue SCAN properly, so stop
                        logger.warning("fetch_user_orders: SCAN cursor is dict for %s:%s, stopping scan: %s", user_type, user_id, cursor)
                        cursor = b"0"  # Stop scanning
                    elif isinstance(cursor, str):
                        cursor = cursor.encode('utf-8')
                    elif isinstance(cursor, int):
                        cursor = str(cursor).encode('utf-8')
                    elif isinstance(cursor, bytes):
                        pass  # Already bytes, keep as is
                    else:
                        # Unknown cursor type, convert to string then bytes
                        logger.warning("fetch_user_orders: Unknown cursor type %s for %s:%s: %s", type(cursor), user_type, user_id, cursor)
                        cursor = str(cursor).encode('utf-8')
                    if isinstance(batch, dict):
                        for _, v in batch.items():
                            # v may be (cur, list) or list
                            if isinstance(v, tuple) and len(v) == 2:
                                _, lst = v
                                raw_keys.extend(lst or [])
                            elif isinstance(v, (list, set, tuple)):
                                raw_keys.extend(list(v))
                    elif isinstance(batch, (list, set, tuple)):
                        raw_keys.extend(list(batch))
                    else:
                        # unknown structure; ignore
                        pass
                elif isinstance(batch_result, dict):
                    # Map of node -> (cursor, keys)
                    cursor = b"0"  # stop after one pass
                    for _, v in batch_result.items():
                        if isinstance(v, tuple) and len(v) == 2:
                            _, lst = v
                            raw_keys.extend(lst or [])
                else:
                    # Unknown structure; stop to avoid infinite loop
                    cursor = b"0"
                if cursor == b"0" or cursor == 0:
                    break
            if not raw_keys:
                return []
            # Sanitize keys to strings
            for k in raw_keys:
                try:
                    if isinstance(k, (bytes, bytearray)):
                        keys.append(k.decode())
                    else:
                        keys.append(str(k))
                except Exception:
                    keys.append(str(k))

        if not keys:
            return []
        # Fetch orders concurrently
        from asyncio import gather
        results = await gather(*[redis_cluster.hgetall(k) for k in keys])
        orders: List[Dict[str, Any]] = []
        for i, k in enumerate(keys):
            key_str = k
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
    recomputed_user_used_margin_executed: Optional[float],
    recomputed_user_used_margin_all: Optional[float],
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
            "" if recomputed_user_used_margin_executed is None else str(float(recomputed_user_used_margin_executed)),
            "" if recomputed_user_used_margin_all is None else str(float(recomputed_user_used_margin_all)),
        ]
        raw = await redis_cluster.eval(lua_src, len(keys), *keys, *args)
        # Script returns JSON string
        if isinstance(raw, (bytes, bytearray)):
            raw = raw.decode()
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            data = {"ok": False, "reason": "invalid_script_response", "raw": raw}
        # Log timing details from Lua if present
        try:
            if isinstance(data, dict) and data.get("timing_us"):
                _TIMING_LOG.info(__import__("orjson").dumps({
                    "component": "python_repo_lua",
                    "event": "order_place_eval",
                    "user_type": user_type,
                    "user_id": user_id,
                    "order_id": order_id,
                    "symbol": symbol,
                    "ok": bool(data.get("ok")),
                    "reason": data.get("reason"),
                    "timing_us": data.get("timing_us"),
                }).decode())
            else:
                # still log outcome without timing
                _TIMING_LOG.info(__import__("orjson").dumps({
                    "component": "python_repo_lua",
                    "event": "order_place_eval",
                    "user_type": user_type,
                    "user_id": user_id,
                    "order_id": order_id,
                    "symbol": symbol,
                    "ok": bool(data.get("ok")) if isinstance(data, dict) else False,
                    "reason": (data or {}).get("reason") if isinstance(data, dict) else "unknown",
                }).decode())
        except Exception:
            pass
        if data and data.get("ok"):
            # Perform non-user-scoped updates outside Lua to avoid cross-slot access
            try:
                symbol_holders_key = f"symbol_holders:{symbol}:{user_type}"
                await redis_cluster.sadd(symbol_holders_key, f"{user_type}:{user_id}")
                # Index the order id for efficient listing without SCAN
                index_key = f"user_orders_index:{{{hash_tag}}}"
                await redis_cluster.sadd(index_key, order_id)
            except Exception as e:
                logger.warning("symbol_holders SADD failed post-atomic: %s", e)
            return True, ""
        reason = (data or {}).get("reason", "script_failed")
        # Fallback: if user config tagged key missing, try to backfill from legacy key and retry once
        if reason == "user_not_found":
            try:
                legacy_key = f"user:{user_type}:{user_id}:config"
                legacy = await redis_cluster.hgetall(legacy_key)
                if legacy:
                    # Write legacy mapping into tagged key so Lua can find it in the same slot
                    try:
                        await redis_cluster.hset(user_config_key, mapping=legacy)
                        # Retry Lua once
                        raw2 = await redis_cluster.eval(lua_src, len(keys), *keys, *args)
                        if isinstance(raw2, (bytes, bytearray)):
                            raw2 = raw2.decode()
                        try:
                            data2 = json.loads(raw2) if isinstance(raw2, str) else raw2
                        except Exception:
                            data2 = {"ok": False, "reason": "invalid_script_response", "raw": raw2}
                        if data2 and data2.get("ok"):
                            try:
                                symbol_holders_key = f"symbol_holders:{symbol}:{user_type}"
                                await redis_cluster.sadd(symbol_holders_key, f"{user_type}:{user_id}")
                                index_key = f"user_orders_index:{{{hash_tag}}}"
                                await redis_cluster.sadd(index_key, order_id)
                            except Exception as e:
                                logger.warning("symbol_holders SADD failed post-atomic (retry): %s", e)
                            return True, ""
                        # else fall through with updated reason
                        reason = (data2 or {}).get("reason", reason)
                    except Exception as be:
                        logger.warning("Backfill to tagged user_config failed: %s", be)
                else:
                    logger.info("Legacy user config not found for %s:%s while backfilling tagged key", user_type, user_id)
            except Exception as e:
                logger.warning("Error during backfill from legacy user config: %s", e)
        # If reason is inconsistent hash tags, fall back
        if reason in ("inconsistent_hash_tags", "missing_hash_tag"):
            logger.warning("Lua script hash tag issue; falling back to non-atomic path: %s", reason)
            return await _place_order_non_atomic(
                user_type=user_type,
                user_id=user_id,
                order_id=order_id,
                symbol=symbol,
                order_fields=order_fields,
                recomputed_user_used_margin_executed=recomputed_user_used_margin_executed,
                recomputed_user_used_margin_all=recomputed_user_used_margin_all,
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
                recomputed_user_used_margin_executed=recomputed_user_used_margin_executed,
                recomputed_user_used_margin_all=recomputed_user_used_margin_all,
            )
        logger.error("EVALSHA ResponseError: %s", re)
        return False, "evalsha_error"
    except Exception as e:
        logger.error("place_order_atomic_or_fallback unexpected error: %s", e)
        return False, "exception"


# ----------------- Minimal MySQL fallback utilities for user config -----------------
_MYSQL_POOL: Optional[aiomysql.Pool] = None


async def _get_mysql_pool() -> Optional[aiomysql.Pool]:
    global _MYSQL_POOL
    if _MYSQL_POOL and not getattr(_MYSQL_POOL, 'closed', False):
        return _MYSQL_POOL

    host = os.getenv("MYSQL_HOST") or os.getenv("DB_HOST") or "89.117.188.103" or "127.0.0.1"
    port = int(os.getenv("MYSQL_PORT") or os.getenv("DB_PORT") or 3306) 
    user = os.getenv("MYSQL_USER") or os.getenv("DB_USER") or os.getenv("DB_USERNAME") or "u436589492_demo_excution" or "u436589492_forex"
    password = os.getenv("MYSQL_PASSWORD") or os.getenv("DB_PASSWORD") or os.getenv("DB_PASS") or "Lkj@asd@123" or "Setupdev@1998"
    db = os.getenv("MYSQL_DB") or os.getenv("DB_NAME") or "u436589492_demo_excution" or "u436589492_forex"

    if not user or not password or not db:
        logger.warning("MySQL credentials not set; skipping DB fallback for user config (order_repository)")
        return None

    try:
        _MYSQL_POOL = await aiomysql.create_pool(
            host=host,
            port=port,
            user=user,
            password=password,
            db=db,
            minsize=1,
            maxsize=5,
            autocommit=True,
            charset="utf8mb4",
        )
        return _MYSQL_POOL
    except Exception as e:
        logger.error("Failed to create MySQL pool (order_repository): %s", e)
        return None


async def _fetch_user_config_from_db(user_type: str, user_id: str) -> Dict[str, Any]:
    pool = await _get_mysql_pool()
    if not pool:
        return {}
    # Determine table based on user type
    user_type_lower = str(user_type).lower()
    if user_type_lower == "live":
        table = "live_users"
    elif user_type_lower == "demo":
        table = "demo_users"
    elif user_type_lower == "strategy_provider":
        table = "strategy_provider_accounts"
    elif user_type_lower == "copy_follower":
        table = "copy_follower_accounts"
    else:
        return {}  # Unsupported user type
    
    # Handle column differences between tables
    select_cols = "`group`, leverage, status, is_active, wallet_balance"
    if table in ["live_users", "strategy_provider_accounts", "copy_follower_accounts"]:
        select_cols += ", sending_orders"
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    f"SELECT {select_cols} FROM {table} WHERE id=%s LIMIT 1",
                    (int(user_id),),
                )
                row = await cur.fetchone()
                if not row:
                    return {}
                # Unpack with optional sending_orders
                if table in ["live_users", "strategy_provider_accounts", "copy_follower_accounts"]:
                    grp, lev, status, is_active, wallet_balance, sending_orders = row
                else:
                    grp, lev, status, is_active, wallet_balance = row
                    sending_orders = None
                cfg: Dict[str, Any] = {
                    "group": (grp or "Standard"),
                    "leverage": float(lev or 0),
                    "status": int(status) if status is not None else None,
                    "is_active": int(is_active) if is_active is not None else None,
                    "wallet_balance": float(wallet_balance or 0),
                    "sending_orders": (sending_orders or None),
                }
                return cfg
    except Exception as e:
        logger.error("DB fetch user config (order_repository) failed for %s:%s: %s", user_type, user_id, e)
        return {}


async def _place_order_non_atomic(
    *,
    user_type: str,
    user_id: str,
    order_id: str,
    symbol: str,
    order_fields: Dict[str, Any],
    recomputed_user_used_margin_executed: Optional[float],
    recomputed_user_used_margin_all: Optional[float],
) -> Tuple[bool, str]:
    """Best-effort non-atomic placement when Lua cannot be used on cluster."""
    t0 = time.perf_counter()
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
        # Index the order id
        index_key = f"user_orders_index:{{{hash_tag}}}"
        await redis_cluster.sadd(index_key, order_id)
        # Update both margin fields if provided
        margin_updates = {}
        if recomputed_user_used_margin_executed is not None:
            margin_updates["used_margin_executed"] = str(float(recomputed_user_used_margin_executed))
        if recomputed_user_used_margin_all is not None:
            margin_updates["used_margin_all"] = str(float(recomputed_user_used_margin_all))
        if margin_updates:
            await redis_cluster.hset(portfolio_key, mapping=margin_updates)
        # Log total duration for non-atomic path
        try:
            _TIMING_LOG.info(__import__("orjson").dumps({
                "component": "python_repo",
                "event": "order_place_non_atomic",
                "user_type": user_type,
                "user_id": user_id,
                "order_id": order_id,
                "symbol": symbol,
                "total_ms": int((time.perf_counter() - t0) * 1000),
            }).decode())
        except Exception:
            pass
        return True, ""
    except Exception as e:
        logger.error("_place_order_non_atomic error: %s", e)
        return False, "non_atomic_error"
