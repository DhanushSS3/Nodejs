import os
import logging
from typing import Optional, Dict, Any, List, Tuple, Set

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
) -> Tuple[Optional[float], Dict[str, Any]]:
    """
    Orchestrate margin computation for a user's open orders.

    Returns (total_user_margin_usd, meta)
    meta includes:
      - per_order: {order_id: {'margin_usd': Optional[float], 'reason': Optional[str]}}
      - per_symbol: {symbol: symbol_margin}
      - skipped_orders_count: int
      - fatal: bool
    """
    meta: Dict[str, Any] = {
        "per_order": {},
        "per_symbol": {},
        "skipped_orders_count": 0,
        "fatal": False,
    }

    # Fetch orders if not provided
    user_orders = orders if orders is not None else await _fetch_user_orders(user_type, user_id)

    # Fast-path: no orders => zero margin
    if not user_orders:
        return 0.0, meta

    # Fetch user config (group + leverage)
    user_cfg = await _fetch_user_config(user_type, user_id)
    leverage = float(user_cfg.get("leverage") or 0.0)
    group = user_cfg.get("group") or "Standard"

    if strict and leverage <= 0:
        meta["fatal"] = True
        # Mark all orders as skipped due to leverage
        for od in user_orders:
            oid = od.get("order_id") or "unknown"
            meta["per_order"][oid] = {"margin_usd": None, "reason": "missing_or_invalid_leverage"}
        meta["skipped_orders_count"] = len(user_orders)
        return None, meta

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

    for od in user_orders:
        oid = od.get("order_id") or "unknown"
        sym = od.get("symbol")
        if not sym:
            meta["per_order"][oid] = {"margin_usd": None, "reason": "missing_symbol"}
            meta["skipped_orders_count"] += 1
            continue

        g = group_data.get(sym)
        if not g:
            meta["per_order"][oid] = {"margin_usd": None, "reason": "missing_group_data"}
            meta["skipped_orders_count"] += 1
            continue

        contract_size = _safe_float(g.get("contract_size"))
        profit_currency = g.get("profit")
        instrument_type = _safe_int(g.get("type"), default=1)
        crypto_margin_factor = _safe_float(g.get("crypto_margin_factor"))

        if strict and (contract_size is None or not profit_currency):
            reason = "missing_contract_size" if contract_size is None else "missing_profit_currency"
            meta["per_order"][oid] = {"margin_usd": None, "reason": reason}
            meta["skipped_orders_count"] += 1
            continue

        # Execution price: use ask for conservative margin regardless of side
        sym_price = prices_cache_local.get(sym)
        if not sym_price or _safe_float(sym_price.get("ask")) in (None, 0.0):
            meta["per_order"][oid] = {"margin_usd": None, "reason": "missing_price"}
            meta["skipped_orders_count"] += 1
            continue
        execution_price = float(sym_price["ask"])  # conservative

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
            meta["per_order"][oid] = {"margin_usd": None, "reason": "conversion_failed_or_invalid_inputs"}
            meta["skipped_orders_count"] += 1
            continue

        meta["per_order"][oid] = {"margin_usd": float(margin_usd), "reason": None}
        orders_by_symbol.setdefault(sym, []).append({
            "order_type": order_type,
            "order_quantity": qty,
            "order_margin_usd": float(margin_usd),
        })

    # Aggregate per-symbol hedged margins
    total_margin = 0.0
    for sym, od_list in orders_by_symbol.items():
        sym_margin = compute_symbol_margin(od_list)
        meta["per_symbol"][sym] = float(sym_margin)
        total_margin += float(sym_margin)

    return float(total_margin), meta


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
    key = f"user:{{{user_type}:{user_id}}}:config"
    try:
        data = await redis_cluster.hgetall(key)
    except Exception as e:
        logger.error(f"_fetch_user_config error for {user_type}:{user_id}: {e}")
        data = {}
    group = data.get("group") or "Standard"
    lev = _safe_float(data.get("leverage")) or 0.0
    return {"group": group, "leverage": lev}


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
            else:
                cs = None
                profit = None
                itype = 1
                cmf = None

            group_data[sym] = {
                'contract_size': cs,
                'profit': profit,
                'type': itype,
                'crypto_margin_factor': cmf,
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
