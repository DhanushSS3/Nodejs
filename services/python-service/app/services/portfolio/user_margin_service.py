import os
import logging
from typing import Optional, Dict, Any, List, Tuple, Set
import aiomysql

import asyncio
from app.config.redis_config import redis_cluster
from app.services.portfolio.margin_calculator import compute_single_order_margin
from app.services.portfolio.symbol_margin_aggregator import compute_symbol_margin

logger = logging.getLogger(__name__)

STRICT_MODE = os.getenv("PORTFOLIO_STRICT_MODE", "true").strip().lower() in ("1", "true", "yes", "on")


async def compute_user_total_margin(
    user_type: str,
    user_id: str,
    orders: Optional[List[Dict[str, Any]]] = None,
    prices_cache: Optional[Dict[str, Dict[str, float]]] = None,
    strict: bool = True,
    include_queued: bool = True,
) -> Tuple[Optional[float], Optional[float], Dict[str, Any]]:
    """
    Orchestrate margin computation for a user's open orders.

    Args:
        include_queued: If True, includes queued orders in calculation

    Returns (executed_margin_usd, total_margin_usd, meta)
    - executed_margin_usd: Margin for executed orders only
    - total_margin_usd: Margin for all orders (executed + queued if include_queued=True)
    meta includes:
      - per_order: {order_id: {'margin_usd': Optional[float], 'reason': Optional[str], 'status': str}}
      - per_symbol: {symbol: symbol_margin}
      - per_symbol_executed: {symbol: symbol_margin for executed only}
      - skipped_orders_count: int
      - fatal: bool
      - queued_orders_count: int
      - executed_orders_count: int
    """
    meta: Dict[str, Any] = {
        "per_order": {},
        "per_symbol": {},
        "per_symbol_executed": {},
        "skipped_orders_count": 0,
        "fatal": False,
        "queued_orders_count": 0,
        "executed_orders_count": 0,
    }

    # Fetch orders if not provided
    user_orders = orders if orders is not None else await _fetch_user_orders(user_type, user_id)

    # Fast-path: no orders => zero margin
    if not user_orders:
        return 0.0, 0.0, meta

    # Fetch user config (group + leverage)
    user_cfg = await _fetch_user_config(user_type, user_id)
    leverage = float(user_cfg.get("leverage") or 0.0)
    group = user_cfg.get("group") or "Standard"

    if strict and leverage <= 0:
        meta["fatal"] = True
        # Mark all orders as skipped due to leverage
        for od in user_orders:
            oid = od.get("order_id") or "unknown"
            meta["per_order"][oid] = {"margin_usd": None, "reason": "missing_or_invalid_leverage", "status": "skipped"}
        meta["skipped_orders_count"] = len(user_orders)
        return None, None, meta

    # Build symbol set and fetch group data
    symbols: List[str] = sorted({str(od.get("symbol")) for od in user_orders if od.get("symbol")})
    group_data = await _fetch_group_data_batch(symbols, group)

    # Prepare prices cache
    prices_cache_local: Dict[str, Dict[str, float]] = dict(prices_cache or {})

    # Ensure trading symbol prices are present (ask used for execution price)
    to_fetch_symbols: Set[str] = set()
    for sym in symbols:
        if sym not in prices_cache_local:
            to_fetch_symbols.add(sym)

    # Collect profit currencies for conversion pairs
    profit_currencies: Set[str] = set()
    for sym in symbols:
        g = group_data.get(sym) or {}
        pc = g.get("profit")
        if pc and str(pc).upper() != "USD":
            profit_currencies.add(str(pc).upper())

    # Add both direct and inverse pairs for robustness
    for cur in profit_currencies:
        to_fetch_symbols.add(f"{cur}USD")
        to_fetch_symbols.add(f"USD{cur}")

    if to_fetch_symbols:
        fetched = await _fetch_prices_for_symbols(sorted(to_fetch_symbols))
        prices_cache_local.update(fetched)

    # Compute per-order margins
    orders_by_symbol: Dict[str, List[Dict[str, Any]]] = {}
    orders_by_symbol_executed: Dict[str, List[Dict[str, Any]]] = {}

    for od in user_orders:
        oid = od.get("order_id") or "unknown"
        sym = od.get("symbol")
        
        # Determine order status (QUEUED vs OPEN/EXECUTED)
        order_status = od.get("order_status", "").upper()
        execution_status = od.get("execution_status", "").upper()
        is_queued = order_status == "QUEUED" or execution_status == "QUEUED"
        
        if not sym:
            meta["per_order"][oid] = {"margin_usd": None, "reason": "missing_symbol", "status": "skipped"}
            meta["skipped_orders_count"] += 1
            continue

        # Skip queued orders if not including them
        if is_queued and not include_queued:
            meta["per_order"][oid] = {"margin_usd": None, "reason": "queued_excluded", "status": "queued"}
            meta["queued_orders_count"] += 1
            continue
        
        g = group_data.get(sym)
        if not g:
            meta["per_order"][oid] = {"margin_usd": None, "reason": "missing_group_data", "status": "skipped"}
            meta["skipped_orders_count"] += 1
            continue

        contract_size = _safe_float(g.get("contract_size"))
        profit_currency = g.get("profit")
        instrument_type = _safe_int(g.get("type"), default=1)
        # crypto_margin_factor comes from groups 'margin' field; ensure fallback mapping handled in _fetch_group_data_batch
        crypto_margin_factor = _safe_float(g.get("crypto_margin_factor"))

        if strict and (contract_size is None or not profit_currency):
            reason = "missing_contract_size" if contract_size is None else "missing_profit_currency"
            meta["per_order"][oid] = {"margin_usd": None, "reason": reason, "status": "skipped"}
            meta["skipped_orders_count"] += 1
            continue

        # Execution price:
        # - For CRYPTO (type==4): use order_price provided by the order as the buy price; if missing, fallback to market ask
        # - For NON-CRYPTO: use market ask for conservative margin regardless of side
        sym_price = prices_cache_local.get(sym)
        instrument_type = _safe_int(g.get("type"), default=1)
        execution_price = None
        if instrument_type == 4:
            op = _safe_float(od.get("order_price"))
            if op is not None and op > 0.0:
                execution_price = float(op)
            else:
                # Fallback to market ask if order_price not available
                if not sym_price or _safe_float(sym_price.get("ask")) in (None, 0.0):
                    meta["per_order"][oid] = {"margin_usd": None, "reason": "missing_price", "status": "skipped"}
                    meta["skipped_orders_count"] += 1
                    continue
                execution_price = float(sym_price["ask"])
        else:
            if not sym_price or _safe_float(sym_price.get("ask")) in (None, 0.0):
                meta["per_order"][oid] = {"margin_usd": None, "reason": "missing_price", "status": "skipped"}
                meta["skipped_orders_count"] += 1
                continue
            execution_price = float(sym_price["ask"])  # conservative for non-crypto

        qty = _safe_float(od.get("order_quantity")) or 0.0
        order_type = (od.get("order_type") or "").upper()

        margin_usd = await compute_single_order_margin(
            contract_size=contract_size or 0.0,
            order_quantity=qty,
            execution_price=execution_price,
            profit_currency=(str(profit_currency).upper() if profit_currency else None),
            symbol=sym,
            leverage=leverage,
            instrument_type=instrument_type,
            prices_cache=prices_cache_local,
            crypto_margin_factor=crypto_margin_factor,
            strict=strict,
        )

        if margin_usd is None:
            meta["per_order"][oid] = {"margin_usd": None, "reason": "conversion_failed_or_invalid_inputs", "status": "skipped"}
            meta["skipped_orders_count"] += 1
            continue

        # Track order status
        status = "queued" if is_queued else "executed"
        meta["per_order"][oid] = {"margin_usd": float(margin_usd), "reason": None, "status": status}
        
        # Add to appropriate collections
        order_entry = {
            "order_type": order_type,
            "order_quantity": qty,
            "order_margin_usd": float(margin_usd),
        }
        
        orders_by_symbol.setdefault(sym, []).append(order_entry)
        
        if not is_queued:
            orders_by_symbol_executed.setdefault(sym, []).append(order_entry)
            meta["executed_orders_count"] += 1
        else:
            meta["queued_orders_count"] += 1

    # Aggregate per-symbol hedged margins for all orders
    total_margin = 0.0
    for sym, od_list in orders_by_symbol.items():
        sym_margin = compute_symbol_margin(od_list)
        meta["per_symbol"][sym] = float(sym_margin)
        total_margin += float(sym_margin)
    
    # Aggregate per-symbol hedged margins for executed orders only
    executed_margin = 0.0
    for sym, od_list in orders_by_symbol_executed.items():
        sym_margin = compute_symbol_margin(od_list)
        meta["per_symbol_executed"][sym] = float(sym_margin)
        executed_margin += float(sym_margin)

    return float(executed_margin), float(total_margin), meta


# Internal helpers

async def _fetch_user_orders(user_type: str, user_id: str) -> List[Dict[str, Any]]:
    pattern = f"user_holdings:{{{user_type}:{user_id}}}:*"
    try:
        cursor = b'0'
        keys: List[str] = []
        while cursor:
            cursor, batch = await redis_cluster.scan(cursor=cursor, match=pattern, count=100)
            keys.extend(batch)
            if cursor == b'0' or cursor == 0:
                break
        if not keys:
            return []
        # Fetch orders concurrently
        results = await _mget_hashes(keys)
        orders: List[Dict[str, Any]] = []
        for i, k in enumerate(keys):
            try:
                key_str = k.decode() if isinstance(k, (bytes, bytearray)) else str(k)
            except Exception:
                key_str = str(k)
            order_id = key_str.rsplit(":", 1)[-1]
            od = results[i] or {}
            od['order_id'] = od.get('order_id') or order_id
            od['order_key'] = key_str
            orders.append(od)
        return orders
    except Exception as e:
        logger.error(f"_fetch_user_orders error for {user_type}:{user_id}: {e}")
        return []


async def _mget_hashes(keys: List[str]) -> List[Dict[str, Any]]:
    try:
        return await _gather_hgetall(keys)
    except Exception:
        # Fallback one by one
        results = []
        for k in keys:
            try:
                results.append(await redis_cluster.hgetall(k))
            except Exception:
                results.append({})
        return results


async def _gather_hgetall(keys: List[str]) -> List[Dict[str, Any]]:
    tasks = [redis_cluster.hgetall(k) for k in keys]
    return await _gather_all(tasks)


async def _gather_all(tasks: List) -> List:
    # Simple gather wrapper to keep code tidy
    from asyncio import gather
    return await gather(*tasks)


async def _fetch_user_config(user_type: str, user_id: str) -> Dict[str, Any]:
    tagged_key = f"user:{{{user_type}:{user_id}}}:config"
    legacy_key = f"user:{user_type}:{user_id}:config"
    data: Dict[str, Any] = {}

    # Try tagged first; on empty or failure, try legacy; small retry once.
    for attempt in range(2):
        # Attempt tagged read
        try:
            data = await redis_cluster.hgetall(tagged_key)
            if data:
                break
        except Exception as e:
            logger.warning(
                "_fetch_user_config tagged read failed for %s:%s (attempt %s): %s",
                user_type,
                user_id,
                attempt + 1,
                e,
            )

        # Attempt legacy read when tagged is missing or errored
        try:
            legacy = await redis_cluster.hgetall(legacy_key)
        except Exception as le:
            logger.error(
                "_fetch_user_config legacy read failed for %s:%s (attempt %s): %s",
                user_type,
                user_id,
                attempt + 1,
                le,
            )
            legacy = {}

        if legacy:
            data = legacy
            # Best-effort backfill into tagged key to stabilize future reads
            try:
                await redis_cluster.hset(tagged_key, mapping=legacy)
            except Exception as be:
                logger.warning(
                    "_fetch_user_config backfill to tagged failed for %s:%s: %s",
                    user_type,
                    user_id,
                    be,
                )
            break

        # If both tagged and legacy are missing, try DB fallback once (only on first loop)
        if attempt == 0 and not data:
            try:
                db_cfg = await _fetch_user_config_from_db(user_type, user_id)
                if db_cfg:
                    data = db_cfg
                    # Backfill tagged key for stability
                    try:
                        await redis_cluster.hset(tagged_key, mapping={
                            "group": db_cfg.get("group", "Standard"),
                            "leverage": str(db_cfg.get("leverage", 0)),
                            # optional fields if present
                            **({"status": str(db_cfg["status"]) } if db_cfg.get("status") is not None else {}),
                            **({"is_active": str(db_cfg["is_active"]) } if db_cfg.get("is_active") is not None else {}),
                        })
                    except Exception as be2:
                        logger.warning(
                            "_fetch_user_config DB-backfill to tagged failed for %s:%s: %s",
                            user_type,
                            user_id,
                            be2,
                        )
                    break
            except Exception as dbe:
                logger.error("_fetch_user_config DB fallback failed for %s:%s: %s", user_type, user_id, dbe)

        # Short delay before next attempt
        try:
            await asyncio.sleep(0.05)
        except Exception:
            pass

    group = data.get("group") or "Standard"
    lev = _safe_float(data.get("leverage")) or 0.0
    return {"group": group, "leverage": lev}


# ---------- Minimal MySQL fallback utilities (aiomysql) ----------
_MYSQL_POOL: Optional[aiomysql.Pool] = None


async def _get_mysql_pool() -> Optional[aiomysql.Pool]:
    global _MYSQL_POOL
    if _MYSQL_POOL and not getattr(_MYSQL_POOL, 'closed', False):
        return _MYSQL_POOL

    # Support multiple env var names for flexibility
    host = os.getenv("MYSQL_HOST") or os.getenv("DB_HOST") or "127.0.0.1"
    port = int(os.getenv("MYSQL_PORT") or os.getenv("DB_PORT") or 3306)
    user = os.getenv("MYSQL_USER") or os.getenv("DB_USER") or os.getenv("DB_USERNAME")
    password = os.getenv("MYSQL_PASSWORD") or os.getenv("DB_PASSWORD") or os.getenv("DB_PASS")
    db = os.getenv("MYSQL_DB") or os.getenv("DB_NAME")

    if not user or not password or not db:
        logger.warning("MySQL credentials not set; skipping DB fallback for user config")
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
        logger.error("Failed to create MySQL pool for user config fallback: %s", e)
        return None


async def _fetch_user_config_from_db(user_type: str, user_id: str) -> Dict[str, Any]:
    pool = await _get_mysql_pool()
    if not pool:
        return {}
    table = "live_users" if str(user_type).lower() == "live" else "demo_users"
    try:
        async with pool.acquire() as conn:
            async with conn.cursor() as cur:
                # Note: `group` is a reserved keyword; wrap with backticks
                await cur.execute(
                    f"SELECT `group`, leverage, status, is_active FROM {table} WHERE id=%s LIMIT 1",
                    (int(user_id),),
                )
                row = await cur.fetchone()
                if not row:
                    return {}
                grp, lev, status, is_active = row
                cfg: Dict[str, Any] = {
                    "group": grp or "Standard",
                    "leverage": float(lev or 0),
                    "status": int(status) if status is not None else None,
                    "is_active": int(is_active) if is_active is not None else None,
                }
                return cfg
    except Exception as e:
        logger.error("DB fetch user config failed for %s:%s: %s", user_type, user_id, e)
        return {}


async def _fetch_group_data_batch(symbols: List[str], group: str) -> Dict[str, Dict[str, Any]]:
    group_data: Dict[str, Dict[str, Any]] = {}
    try:
        # First attempt: user group
        grp_keys = [f"groups:{{{group}}}:{sym}" for sym in symbols]
        grp_results = await _gather_hgetall(grp_keys)

        # Fallback indices
        missing_idx = [i for i, data in enumerate(grp_results) if not data]
        std_map: Dict[int, Dict[str, Any]] = {}
        if missing_idx:
            std_keys = [f"groups:{{Standard}}:{symbols[i]}" for i in missing_idx]
            std_results = await _gather_hgetall(std_keys)
            for i, res in zip(missing_idx, std_results):
                std_map[i] = res

        for i, sym in enumerate(symbols):
            data = grp_results[i] if grp_results[i] else std_map.get(i, {})
            if data:
                # Parse fields
                try:
                    cs = float(data.get('contract_size')) if data.get('contract_size') is not None else None
                except (TypeError, ValueError):
                    cs = None
                profit = data.get('profit') or None
                try:
                    itype = int(data.get('type')) if data.get('type') is not None else 1
                except (TypeError, ValueError):
                    itype = 1
                try:
                    cmf = float(data.get('crypto_margin_factor')) if data.get('crypto_margin_factor') is not None else None
                except (TypeError, ValueError):
                    cmf = None
                try:
                    margin_val = float(data.get('margin')) if data.get('margin') is not None else None
                except (TypeError, ValueError):
                    margin_val = None
            else:
                cs = None
                profit = None
                itype = 1
                cmf = None
                margin_val = None

            group_data[sym] = {
                'contract_size': cs,
                'profit': profit,
                'type': itype,
                # Use explicit crypto_margin_factor if present; otherwise, fallback to groups 'margin' field
                'crypto_margin_factor': cmf if cmf is not None else margin_val,
                'group_margin': margin_val,
            }
        return group_data
    except Exception as e:
        logger.error(f"_fetch_group_data_batch error: {e}")
        return group_data


async def _fetch_prices_for_symbols(symbols: List[str]) -> Dict[str, Dict[str, float]]:
    prices: Dict[str, Dict[str, float]] = {}
    try:
        tasks = [redis_cluster.hmget(f"market:{sym}", ["bid", "ask"]) for sym in symbols]
        from asyncio import gather
        results = await gather(*tasks)
        for i, sym in enumerate(symbols):
            data = results[i]
            if data and (data[0] or data[1]):
                try:
                    bid = float(data[0]) if data[0] is not None else None
                except (TypeError, ValueError):
                    bid = None
                try:
                    ask = float(data[1]) if data[1] is not None else None
                except (TypeError, ValueError):
                    ask = None
                prices[sym] = {k: v for k, v in {"bid": bid, "ask": ask}.items() if v is not None}
        return prices
    except Exception as e:
        logger.error(f"_fetch_prices_for_symbols error: {e}")
        return prices


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def _safe_int(v, default: int = 0) -> int:
    try:
        if v is None:
            return default
        return int(v)
    except (TypeError, ValueError):
        return default
