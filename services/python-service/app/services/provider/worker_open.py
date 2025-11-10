import os
import asyncio
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional
import time

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.config.redis_logging import (
    log_connection_acquire, log_connection_release, log_connection_error,
    log_pipeline_operation, connection_tracker, generate_operation_id
)
from app.services.portfolio.margin_calculator import compute_single_order_margin
from app.services.portfolio.user_margin_service import compute_user_total_margin
from app.services.orders.commission_calculator import compute_entry_commission
from app.services.orders.order_repository import fetch_group_data, fetch_user_orders, place_order_atomic
from app.services.groups.group_config_helper import get_group_config_with_fallback
from app.services.logging.provider_logger import (
    get_worker_open_logger,
    get_orders_calculated_logger,
    get_provider_errors_logger,
    log_provider_stats
)

# Initialize dedicated loggers
logger = get_worker_open_logger()
calc_logger = get_orders_calculated_logger()
error_logger = get_provider_errors_logger()

# Keep basic logging for compatibility
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
OPEN_QUEUE = os.getenv("ORDER_WORKER_OPEN_QUEUE", "order_worker_open_queue")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")


# ------------- Concurrency: Lightweight Redis lock -------------
async def acquire_lock(lock_key: str, token: str, ttl_sec: int = 5) -> bool:
    try:
        ok = await redis_cluster.set(lock_key, token, ex=ttl_sec, nx=True)
        return bool(ok)
    except Exception as e:
        logger.error("acquire_lock error: %s", e)
        return False


async def release_lock(lock_key: str, token: str) -> None:
    try:
        # Safe release: only delete if value matches token
        lua = """
        if redis.call('get', KEYS[1]) == ARGV[1] then
            return redis.call('del', KEYS[1])
        else
            return 0
        end
        """
        try:
            await redis_cluster.eval(lua, 1, lock_key, token)
        except Exception:
            # Best effort
            pass
    except Exception as e:
        logger.error("release_lock error: %s", e)

# Use centralized calculated orders logger
_ORDERS_CALC_LOG = calc_logger


def _normalize_side(side_or_type: Optional[str]) -> str:
    """Map order_type variants to canonical BUY/SELL where appropriate.
    BUY_LIMIT/BUY_STOP -> BUY; SELL_LIMIT/SELL_STOP -> SELL; B/S -> BUY/SELL.
    Otherwise return the uppercased input unchanged.
    """
    s = str(side_or_type or "").upper().strip()
    if s in ("B",):
        return "BUY"
    if s in ("S",):
        return "SELL"
    if s in ("BUY_LIMIT", "BUY_STOP", "B_LIMIT", "B_STOP"):
        return "BUY"
    if s in ("SELL_LIMIT", "SELL_STOP", "S_LIMIT", "S_STOP"):
        return "SELL"
    return s


async def _update_redis_for_open(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    For an OPEN acknowledgement:
      - Update canonical order_data:{order_id} with order_status OPEN and provider fields
      - Update user_holdings:{user_type:user_id}:{order_id} with order_status OPEN and provider fields
      - (Used margin was already reserved at placement; no change here.)
    """
    order_id = str(payload.get("order_id"))
    user_id = str(payload.get("user_id"))
    user_type = str(payload.get("user_type"))

    # Provider report fields
    report: Dict[str, Any] = payload.get("execution_report") or {}
    ord_status = report.get("ord_status")
    exec_id = report.get("exec_id") or (report.get("raw") or {}).get("17")
    avspx = report.get("avgpx") or (report.get("raw") or {}).get("6")
    cumqty = report.get("cumqty") or (report.get("raw") or {}).get("14")
    ts = report.get("ts")

    # Canonical
    order_data_key = f"order_data:{order_id}"

    # User holdings
    hash_tag = f"{user_type}:{user_id}"
    order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
    index_key = f"user_orders_index:{{{hash_tag}}}"

    # Normalize side from payload: map *_LIMIT/*_STOP to BUY/SELL
    raw_side = payload.get("order_type") or payload.get("side")
    side_val = _normalize_side(raw_side)
    mapping_common = {
        "order_status": "OPEN",
        "execution_status": "EXECUTED",  # provider acknowledged
        "order_type": side_val if side_val else None,
        "provider_ord_status": ord_status,
        "provider_exec_id": exec_id if exec_id is not None else "",
        "provider_avspx": avspx if avspx is not None else "",
        "provider_cumqty": cumqty if cumqty is not None else "",
        "provider_ts": str(ts) if ts is not None else "",
    }

    # Update both keys in a pipeline with retry logic and proper connection management
    max_retries = 3
    retry_delay = 0.01
    operation_id = generate_operation_id()
    
    for attempt in range(max_retries):
        try:
            connection_tracker.start_operation(operation_id, "cluster", f"open_redis_update_{order_id}")
            log_connection_acquire("cluster", f"open_redis_update_{order_id}", operation_id)
            
            async with redis_cluster.pipeline() as pipe:
                # Filter out None values to avoid writing 'order_type': None
                mapping_filtered = {k: v for k, v in mapping_common.items() if v is not None}
                pipe.hset(order_data_key, mapping=mapping_filtered)
                pipe.hset(order_key, mapping=mapping_filtered)
                # Ensure order is in the active index (idempotent safety)
                pipe.sadd(index_key, order_id)
                # Ensure symbol_holders has this user for this symbol (idempotent safety)
                try:
                    symbol = str(payload.get("symbol") or "").upper()
                    if symbol:
                        sym_set = f"symbol_holders:{symbol}:{user_type}"
                        pipe.sadd(sym_set, hash_tag)
                except Exception:
                    pass
                await pipe.execute()
            
            log_pipeline_operation("cluster", f"open_redis_update_{order_id}", 3 + (1 if symbol else 0), operation_id)
            log_connection_release("cluster", f"open_redis_update_{order_id}", operation_id)
            connection_tracker.end_operation(operation_id, success=True)
            break  # Success, exit retry loop
            
        except Exception as e:
            log_connection_error("cluster", f"open_redis_update_{order_id}", str(e), operation_id, attempt + 1)
            if attempt == max_retries - 1:
                # Last attempt failed, re-raise
                connection_tracker.end_operation(operation_id, success=False, error=str(e))
                raise
            logger.warning(
                "[OPEN:REDIS_UPDATE_RETRY] order_id=%s attempt=%d error=%s",
                order_id, attempt + 1, str(e)
            )
            # Wait briefly before retry (exponential backoff)
            await asyncio.sleep(retry_delay)
            retry_delay *= 2

    return {
        "order_id": order_id,
        "user_id": user_id,
        "user_type": user_type,
        "order_key": order_key,
        "order_data_key": order_data_key,
        "exec_price_hint": avspx,
        "cumqty_hint": cumqty,
    }


async def _recompute_margins(order_ctx: Dict[str, Any], payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Recompute single order margin and user total used margin.
    Returns dict with keys: single_margin_usd, used_margin_executed, used_margin_all, final_exec_price, final_order_qty
    """
    symbol = str(payload.get("symbol") or "").upper()
    leverage = float(payload.get("leverage") or 0.0)
    contract_size = payload.get("contract_size")
    profit_currency = payload.get("profit_currency")
    instrument_type = payload.get("type") or payload.get("instrument_type") or 1

    # Determine effective executed price and qty
    exec_price = order_ctx.get("exec_price_hint") or payload.get("order_price")
    try:
        final_price = float(exec_price) if exec_price is not None else float(payload.get("order_price"))
    except Exception:
        final_price = None

    # Resolve final executed quantity
    # Priority:
    #   1) payload.order_quantity (should be sourced from canonical order_data by dispatcher)
    #   2) canonical order_data:{order_id}.order_quantity (fallback fetch)
    #   3) provider cumqty hint (last resort)
    final_qty = None
    qty_source = None
    try:
        if payload.get("order_quantity") is not None:
            final_qty = float(payload.get("order_quantity"))
            qty_source = "payload"
        else:
            # Fallback: fetch from canonical with connection tracking
            try:
                order_id_lookup = str(payload.get("order_id"))
                qty_operation_id = generate_operation_id()
                connection_tracker.start_operation(qty_operation_id, "cluster", f"fetch_qty_{order_id_lookup}")
                log_connection_acquire("cluster", f"fetch_qty_{order_id_lookup}", qty_operation_id)
                
                try:
                    raw_qty = await redis_cluster.hget(f"order_data:{order_id_lookup}", "order_quantity")
                    log_connection_release("cluster", f"fetch_qty_{order_id_lookup}", qty_operation_id)
                    connection_tracker.end_operation(qty_operation_id, success=True)
                    
                    if raw_qty is not None:
                        final_qty = float(raw_qty)
                        qty_source = "canonical"
                except Exception as e:
                    log_connection_error("cluster", f"fetch_qty_{order_id_lookup}", str(e), qty_operation_id)
                    connection_tracker.end_operation(qty_operation_id, success=False, error=str(e))
                    raise
            except Exception:
                final_qty = None
        if final_qty is None and order_ctx.get("cumqty_hint") is not None:
            final_qty = float(order_ctx.get("cumqty_hint"))
            qty_source = "cumqty"
    except Exception:
        final_qty = None
        qty_source = None

    # Prefer spread info from payload/report; fallback to Redis group data
    group = str(payload.get("group") or "Standard")
    er = payload.get("execution_report") or {}
    spread_val = payload.get("spread") or er.get("spread")
    spread_pip_val = payload.get("spread_pip") or er.get("spread_pip")
    g = {}
    # Resolve missing fields using Redis for the requested group; if still missing, DB fallback via Node
    if spread_val is None or spread_pip_val is None or payload.get("contract_size") is None or profit_currency is None:
        # Attempt Redis first (requested group only)
        g = await fetch_group_data(symbol, group)
        if spread_val is None:
            spread_val = g.get("spread")
        if spread_pip_val is None:
            spread_pip_val = g.get("spread_pip")
        if profit_currency is None and g:
            profit_currency = g.get("profit")

        # If any required still missing, use DB fallback via Node internal API
        needs_db = (
            spread_val is None or spread_pip_val is None or (payload.get("contract_size") is None and (not g or g.get("contract_size") is None)) or profit_currency is None
        )
        if needs_db:
            gfb = await get_group_config_with_fallback(group, symbol)
            if gfb:
                if spread_val is None:
                    spread_val = gfb.get("spread")
                if spread_pip_val is None:
                    spread_pip_val = gfb.get("spread_pip")
                if profit_currency is None:
                    profit_currency = gfb.get("profit")
                # Merge contract_size and crypto margin fields into g so downstream consumers use them
                if not g:
                    g = {}
                if g.get("contract_size") is None and gfb.get("contract_size") is not None:
                    g["contract_size"] = gfb.get("contract_size")
                if g.get("crypto_margin_factor") is None and gfb.get("crypto_margin_factor") is not None:
                    g["crypto_margin_factor"] = gfb.get("crypto_margin_factor")
                if g.get("group_margin") is None and gfb.get("group_margin") is not None:
                    g["group_margin"] = gfb.get("group_margin")
    # Compute half_spread = (spread * spread_pip) / 2
    half_spread = None
    try:
        sv = float(spread_val) if spread_val is not None else None
        spv = float(spread_pip_val) if spread_pip_val is not None else None
        if sv is not None and spv is not None:
            half_spread = (sv * spv) / 2.0
    except (TypeError, ValueError):
        half_spread = None

    try:
        crypto_factor = float(g.get("crypto_margin_factor")) if g.get("crypto_margin_factor") is not None else None
    except (TypeError, ValueError):
        crypto_factor = None

    # Convert contract_size to float safely (fallback to group.contract_size if payload missing)
    try:
        cs_source = contract_size if contract_size is not None else (g.get("contract_size") if isinstance(g, dict) else None)
        cs_val = float(cs_source) if cs_source is not None else None
    except (TypeError, ValueError):
        cs_val = None

    # Apply half_spread adjustment to executed price.
    # - Provider PENDING->EXECUTED: always add half_spread for ALL types (BUY and SELL), regardless of side.
    # - Instant provider execution: side-based (+ for BUY, - for SELL).
    # - Local PENDING->EXECUTED (pending_local=True): skip (already adjusted upstream).
    side = _normalize_side(payload.get("order_type") or payload.get("side"))
    pending_local = bool(payload.get("pending_local"))
    pending_executed = bool(payload.get("pending_executed"))
    if final_price is not None and half_spread is not None and not pending_local:
        if pending_executed:
            # For provider pending orders, the provider price did not include the "ask + half_spread" normalization.
            # Normalize by adding half_spread for all order types.
            adjusted_price = final_price + half_spread
        else:
            if side == "BUY" or side == "B":
                adjusted_price = final_price + half_spread
            elif side == "SELL" or side == "S":
                adjusted_price = final_price - half_spread
            else:
                adjusted_price = final_price
        logger.debug(
            "[OPEN:price_adjust] symbol=%s side=%s base_exec_price=%s half_spread=%s final_exec_price=%s",
            symbol, side, final_price, half_spread, adjusted_price,
        )
        final_price = adjusted_price

    single_margin = None
    if cs_val is not None and final_qty and final_price and leverage > 0:
        single_margin = await compute_single_order_margin(
            contract_size=cs_val,
            order_quantity=final_qty,
            execution_price=float(final_price),
            profit_currency=(str(profit_currency).upper() if profit_currency else None),
            symbol=symbol,
            leverage=float(leverage),
            instrument_type=int(instrument_type or 1),
            prices_cache={},
            crypto_margin_factor=crypto_factor,
            strict=True,
        )

    # Recompute total used margin from all current open orders
    user_type = str(payload.get("user_type"))
    user_id = str(payload.get("user_id"))
    orders = await fetch_user_orders(user_type, user_id)
    # Overlay this order with executed price/qty so totals reflect provider fill
    try:
        current_id = str(payload.get("order_id"))
        updated = False
        for od in orders:
            if str(od.get("order_id")) == current_id:
                if final_price is not None:
                    od["order_price"] = float(final_price)
                if final_qty is not None:
                    od["order_quantity"] = float(final_qty)
                if symbol:
                    od["symbol"] = symbol
                if side:
                    od["order_type"] = side
                updated = True
                break
        if not updated:
            # If not present, append a minimal record
            orders.append({
                "order_id": current_id,
                "symbol": symbol,
                "order_type": side,
                "order_quantity": final_qty,
                "order_price": final_price,
            })
        logger.debug("[OPEN:overlay] orders_count=%s updated=%s", len(orders), updated)
    except Exception:
        logger.exception("[OPEN:overlay] failed to overlay executed order into orders list")

    executed_m, total_m, meta = await compute_user_total_margin(
        user_type=user_type,
        user_id=user_id,
        orders=orders,
        prices_cache=None,
        strict=True,
        include_queued=True,
    )
    return {
        "single_margin_usd": single_margin,
        "used_margin_executed": float(executed_m) if executed_m is not None else None,
        "used_margin_all": float(total_m) if total_m is not None else None,
        "final_exec_price": final_price,
        "final_order_qty": final_qty,
        "half_spread": half_spread,
        "side": side,
        "contract_size": cs_val,
    }


class OpenWorker:
    def __init__(self):
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._queue: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None
        self._db_queue: Optional[aio_pika.abc.AbstractQueue] = None
        
        # Statistics tracking
        self._stats = {
            'start_time': time.time(),
            'messages_processed': 0,
            'orders_opened': 0,
            'orders_failed': 0,
            'margin_calculations': 0,
            'commission_calculations': 0,
            'redis_errors': 0,
            'db_publishes': 0,
            'last_message_time': None,
            'total_processing_time_ms': 0
        }

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=64)
        self._queue = await self._channel.declare_queue(OPEN_QUEUE, durable=True)
        # ensure DB update queue exists
        self._db_queue = await self._channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
        logger.info("[OPEN:CONNECTED] Worker connected to %s", OPEN_QUEUE)

    async def _ack(self, message: aio_pika.abc.AbstractIncomingMessage):
        try:
            await message.ack()
        except Exception:
            logger.exception("ack failed")

    async def _nack(self, message: aio_pika.abc.AbstractIncomingMessage, requeue: bool = True):
        try:
            await message.nack(requeue=requeue)
        except Exception:
            logger.exception("nack failed")

    async def handle(self, message: aio_pika.abc.AbstractIncomingMessage):
        start_time = time.time()
        order_id_dbg = None
        
        try:
            self._stats['messages_processed'] += 1
            self._stats['last_message_time'] = start_time
            
            payload = orjson.loads(message.body)
            
            # Basic debug context
            er = (payload.get("execution_report") or {})
            ord_status = str(er.get("ord_status") or (er.get("raw") or {}).get("39") or "").strip()
            order_id_dbg = str(payload.get("order_id"))
            side_dbg = str(payload.get("order_type") or payload.get("side") or "").upper()
            
            logger.info(
                "[OPEN:RECEIVED] order_id=%s ord_status=%s side=%s avgpx=%s cumqty=%s",
                order_id_dbg,
                ord_status,
                side_dbg,
                er.get("avgpx") or (er.get("raw") or {}).get("6"),
                er.get("cumqty") or (er.get("raw") or {}).get("14"),
            )

            # Only process filled: accept new format 'EXECUTED' and legacy '2'.
            if str(ord_status).upper() not in ("2", "EXECUTED"):
                logger.warning(
                    "[OPEN:SKIP] order_id=%s ord_status=%s reason=not_executed", 
                    order_id_dbg, ord_status
                )
                await self._ack(message)
                return
            # Provider idempotency token-based dedupe
            try:
                idem = str(
                    er.get("idempotency")
                    or (er.get("raw") or {}).get("idempotency")
                    or er.get("ideampotency")
                    or (er.get("raw") or {}).get("ideampotency")
                    or ""
                ).strip()
                if idem:
                    if await redis_cluster.set(f"provider_idem:{idem}", "1", ex=7 * 24 * 3600, nx=True) is None:
                        logger.info("[OPEN:SKIP] order_id=%s idem=%s reason=provider_idempotent", order_id_dbg, idem)
                        await self._ack(message)
                        return
            except Exception:
                pass
            # Acquire per-user lock to avoid race on used_margin recompute
            lock_key = f"lock:user_margin:{payload.get('user_type')}:{payload.get('user_id')}"
            token = f"{os.getpid()}-{id(message)}"
            got_lock = await acquire_lock(lock_key, token, ttl_sec=8)
            if not got_lock:
                logger.warning("[OPEN:LOCK_FAILED] order_id=%s lock_key=%s", order_id_dbg, lock_key)
                await self._nack(message, requeue=True)
                return

            try:
                # Step 1: update provider OPEN markers
                ctx = await _update_redis_for_open(payload)
                logger.debug("[OPEN:REDIS_UPDATED] order_id=%s ctx_keys=%s", order_id_dbg, list(ctx.keys()))
                
                # Step 2: recompute margins
                margin_start = time.time()
                margins = await _recompute_margins(ctx, payload)
                margin_time = (time.time() - margin_start) * 1000
                self._stats['margin_calculations'] += 1
                
                logger.debug(
                    "[OPEN:MARGINS_COMPUTED] order_id=%s margin_time=%.2fms single_margin=%s", 
                    order_id_dbg, margin_time, margins.get('single_margin_usd')
                )

                # Step 3: persist recalculated fields (best-effort)
                upd_map = {}
                if margins.get("single_margin_usd") is not None:
                    upd_map["margin"] = str(float(margins["single_margin_usd"]))
                    # Clear reserved_margin upon execution confirmation
                    upd_map["reserved_margin"] = ""
                if margins.get("final_exec_price") is not None:
                    upd_map["order_price"] = str(float(margins["final_exec_price"]))
                if margins.get("final_order_qty") is not None:
                    upd_map["order_quantity"] = str(float(margins["final_order_qty"]))
                if margins.get("half_spread") is not None:
                    upd_map["half_spread"] = str(float(margins["half_spread"]))

                # Cross-check cumqty vs stored order_quantity and contract_value
                try:
                    stored_qty_raw = await redis_cluster.hget(ctx["order_key"], "order_quantity")
                    stored_qty = float(stored_qty_raw) if stored_qty_raw is not None else None
                except Exception:
                    stored_qty = None
                final_qty = margins.get("final_order_qty")
                if stored_qty is not None and final_qty is not None and abs(float(stored_qty) - float(final_qty)) > 1e-9:
                    logger.warning(
                        "[OPEN:mismatch] order_id=%s stored_qty=%s provider_cumqty=%s -> updating",
                        ctx.get("order_id"), stored_qty, final_qty,
                    )
                    upd_map["order_quantity"] = str(float(final_qty))

                # Contract value check
                try:
                    stored_cv_raw = await redis_cluster.hget(ctx["order_key"], "contract_value")
                    stored_cv = float(stored_cv_raw) if stored_cv_raw is not None else None
                except Exception:
                    stored_cv = None
                cs_val = margins.get("contract_size")
                expected_cv = None
                try:
                    if cs_val is not None and final_qty is not None:
                        expected_cv = float(cs_val) * float(final_qty)
                except Exception:
                    expected_cv = None
                if expected_cv is not None and (stored_cv is None or abs(float(stored_cv) - expected_cv) > 1e-9):
                    logger.warning(
                        "[OPEN:mismatch] order_id=%s stored_contract_value=%s expected=%s -> updating",
                        ctx.get("order_id"), stored_cv, expected_cv,
                    )
                    upd_map["contract_value"] = str(float(expected_cv))

                # Update portfolio used_margin with recomputed totals (always recalc post-confirmation)
                portfolio_key = f"user_portfolio:{{{payload.get('user_type')}:{payload.get('user_id')}}}"
                # Recalculate both margin fields
                from app.services.portfolio.user_margin_service import compute_user_total_margin
                orders = await fetch_user_orders(payload.get('user_type'), payload.get('user_id'))
                executed_margin, total_margin, _ = await compute_user_total_margin(
                    user_type=payload.get('user_type'),
                    user_id=str(payload.get('user_id')),
                    orders=orders,
                    prices_cache=None,
                    strict=False,
                    include_queued=True,
                )
                margin_updates = {
                    "used_margin_executed": str(float(executed_margin)) if executed_margin is not None else "0.0",
                    "used_margin_all": str(float(total_margin)) if total_margin is not None else "0.0",
                    "used_margin": str(float(executed_margin)) if executed_margin is not None else "0.0",  # Legacy field now points to executed only
                }
                
                # Add retry logic for Redis connection pool exhaustion
                max_retries = 3
                for attempt in range(max_retries):
                    try:
                        pipe = redis_cluster.pipeline()
                        if upd_map:
                            pipe.hset(ctx["order_key"], mapping=upd_map)
                            pipe.hset(ctx["order_data_key"], mapping=upd_map)
                        pipe.hset(portfolio_key, mapping=margin_updates)
                        await pipe.execute()
                        break  # Success, exit retry loop
                    except Exception as e:
                        if attempt == max_retries - 1:
                            # Last attempt failed, re-raise
                            raise
                        logger.warning(
                            "[OPEN:PIPELINE_RETRY] order_id=%s attempt=%d error=%s",
                            ctx.get("order_id"), attempt + 1, str(e)
                        )
                        # Wait briefly before retry (exponential backoff)
                        await asyncio.sleep(0.1 * (2 ** attempt))
                logger.info(
                    "[OPEN:UPDATED] order_id=%s price=%s qty=%s margin=%s used_margin_executed=%s used_margin_all=%s",
                    ctx.get("order_id"),
                    upd_map.get("order_price"),
                    upd_map.get("order_quantity"),
                    upd_map.get("margin"),
                    (str(float(margins["used_margin_executed"])) if margins.get("used_margin_executed") is not None else None),
                    (str(float(margins["used_margin_all"])) if margins.get("used_margin_all") is not None else None),
                )

                # Step 3b: compute and persist ENTRY commission for provider EXECUTED (open)
                commission_start = time.time()
                commission_entry = 0.0
                try:
                    self._stats['commission_calculations'] += 1
                    # Fetch commission snapshot from canonical order_data; fallback to group hash
                    rate_raw = await redis_cluster.hget(ctx["order_data_key"], "commission_rate")
                    if rate_raw is None:
                        rate_raw = await redis_cluster.hget(ctx["order_data_key"], "commission")
                    ctype_raw = await redis_cluster.hget(ctx["order_data_key"], "commission_type")
                    vtype_raw = await redis_cluster.hget(ctx["order_data_key"], "commission_value_type")
                    # Normalize empty strings to None so fallback can trigger
                    try:
                        def _empty_to_none(x):
                            if x is None:
                                return None
                            try:
                                xs = x.decode() if isinstance(x, (bytes, bytearray)) else str(x)
                                return None if xs.strip() == "" else x
                            except Exception:
                                return x
                        rate_raw = _empty_to_none(rate_raw)
                        ctype_raw = _empty_to_none(ctype_raw)
                        vtype_raw = _empty_to_none(vtype_raw)
                    except Exception:
                        pass
                    # Track sources for debugging AFTER normalization
                    rate_src = "order_data" if rate_raw is not None else None
                    ctype_src = "order_data" if ctype_raw is not None else None
                    vtype_src = "order_data" if vtype_raw is not None else None

                    # Fallback to group hash if missing
                    if rate_raw is None or ctype_raw is None or vtype_raw is None:
                        try:
                            group_val = str(payload.get("group") or "Standard")
                            symbol_val = str(payload.get("symbol") or "").upper()
                            gkey = f"groups:{{{group_val}}}:{symbol_val}" if symbol_val else None
                            ghash = await redis_cluster.hgetall(gkey) if gkey else {}
                        except Exception:
                            ghash = {}
                        if rate_raw is None:
                            rate_raw = ghash.get("commission_rate") or ghash.get("commission") or ghash.get("commision")
                            if rate_raw is not None and rate_src is None:
                                rate_src = "group"
                        if ctype_raw is None:
                            ctype_raw = ghash.get("commission_type") or ghash.get("commision_type")
                            if ctype_raw is not None and ctype_src is None:
                                ctype_src = "group"
                        if vtype_raw is None:
                            vtype_raw = ghash.get("commission_value_type") or ghash.get("commision_value_type")
                            if vtype_raw is not None and vtype_src is None:
                                vtype_src = "group"

                    def _to_float(x):
                        try:
                            return float(x)
                        except Exception:
                            return None

                    def _to_int(x):
                        try:
                            return int(x)
                        except Exception:
                            return None

                    rate = _to_float(rate_raw)
                    ctype = _to_int(ctype_raw)
                    vtype = _to_int(vtype_raw)
                    qty = _to_float(margins.get("final_order_qty"))
                    exec_px = _to_float(margins.get("final_exec_price") or (payload.get("execution_report") or {}).get("avgpx"))
                    cs_val = _to_float(margins.get("contract_size"))

                    if rate is not None and ctype is not None and vtype is not None and qty is not None and exec_px is not None:
                        commission_entry = compute_entry_commission(
                            commission_rate=rate,
                            commission_type=ctype,
                            commission_value_type=vtype,
                            quantity=qty,
                            order_price=exec_px,
                            contract_size=cs_val,
                        )
                        
                        commission_time = (time.time() - commission_start) * 1000
                        logger.debug(
                            "[OPEN:COMMISSION] order_id=%s commission=%.4f time=%.2fms rate=%s type=%s",
                            order_id_dbg, commission_entry, commission_time, rate, ctype
                        )

                    # Persist commission: user holdings gets 'commission' for UI; canonical gets 'commission_entry'
                    try:
                        pipe_c = redis_cluster.pipeline()
                        pipe_c.hset(ctx["order_key"], mapping={
                            "commission": str(float(commission_entry)),
                            "commission_entry": str(float(commission_entry)),
                        })
                        pipe_c.hset(ctx["order_data_key"], mapping={
                            "commission_entry": str(float(commission_entry)),
                        })
                        await pipe_c.execute()
                    except Exception:
                        pass
                except Exception as e:
                    error_logger.exception(
                        "[OPEN:COMMISSION_ERROR] order_id=%s error=%s", 
                        order_id_dbg, str(e)
                    )

                # Log calculated order data to dedicated file
                try:
                    calc = {
                        "type": "ORDER_OPEN_CALC",
                        "order_id": str(payload.get("order_id")),
                        "user_type": str(payload.get("user_type")),
                        "user_id": str(payload.get("user_id")),
                        "symbol": str(payload.get("symbol") or "").upper(),
                        "side": str(margins.get("side") or payload.get("order_type") or "").upper(),
                        "final_exec_price": margins.get("final_exec_price"),
                        "final_order_qty": margins.get("final_order_qty"),
                        "single_margin_usd": margins.get("single_margin_usd"),
                        "commission_entry": (commission_entry if 'commission_entry' in locals() else None),
                        "total_used_margin_usd": margins.get("total_used_margin_usd"),
                        "half_spread": margins.get("half_spread"),
                        "contract_size": margins.get("contract_size"),
                        "contract_value": (float(cs_val) * float(margins.get("final_order_qty")) if (cs_val is not None and margins.get("final_order_qty") is not None) else None),
                        "provider": {
                            "ord_status": (payload.get("execution_report") or {}).get("ord_status"),
                            "exec_id": (payload.get("execution_report") or {}).get("exec_id"),
                            "avgpx": (payload.get("execution_report") or {}).get("avgpx"),
                            "cumqty": (payload.get("execution_report") or {}).get("cumqty"),
                        },
                    }
                    _ORDERS_CALC_LOG.info(orjson.dumps(calc).decode())
                except Exception:
                    pass

                # Step 4: publish DB update intent for Node consumer (decoupled persistence)
                db_start = time.time()
                try:
                    self._stats['db_publishes'] += 1
                    # Derive executed side for DB from computed margins or payload (normalized)
                    side_for_db = _normalize_side(margins.get("side") or payload.get("order_type") or payload.get("side"))
                    db_msg = {
                        "type": "ORDER_OPEN_CONFIRMED",
                        "order_id": str(payload.get("order_id")),
                        "user_id": str(payload.get("user_id")),
                        "user_type": str(payload.get("user_type")),
                        "order_type": side_for_db,
                        "order_status": "OPEN",
                        "order_price": margins.get("final_exec_price") or payload.get("order_price"),
                        # Persist per-order executed margin in SQL via DB consumer
                        "margin": margins.get("single_margin_usd"),
                        # Contract value = contract_size * executed_qty
                        "contract_value": (float(cs_val) * float(margins.get("final_order_qty")) if (cs_val is not None and margins.get("final_order_qty") is not None) else None),
                        # Persist entry commission in SQL
                        "commission": commission_entry if 'commission_entry' in locals() else None,
                        # Backward compatibility: used_margin_usd mirrors executed margin
                        "used_margin_usd": margins.get("used_margin_executed"),
                        # New fields
                        "used_margin_executed": margins.get("used_margin_executed"),
                        "used_margin_all": margins.get("used_margin_all"),
                        "provider": {
                            "exec_id": (payload.get("execution_report") or {}).get("exec_id"),
                            "avgpx": (payload.get("execution_report") or {}).get("avgpx") or (payload.get("execution_report") or {}).get("raw", {}).get("6"),
                            "cumqty": (payload.get("execution_report") or {}).get("cumqty"),
                        },
                    }
                    # Additional debug log to orders_calculated.log to correlate DB publish
                    try:
                        dbg = {
                            "type": "ORDER_DB_UPDATE_PUBLISH",
                            "order_id": db_msg.get("order_id"),
                            "user_type": db_msg.get("user_type"),
                            "user_id": db_msg.get("user_id"),
                            "order_status": db_msg.get("order_status"),
                            "order_price": db_msg.get("order_price"),
                            "margin": db_msg.get("margin"),
                            "contract_value": db_msg.get("contract_value"),
                            "commission": db_msg.get("commission"),
                            "used_margin_usd": db_msg.get("used_margin_usd"),
                        }
                        _ORDERS_CALC_LOG.info(orjson.dumps(dbg).decode())
                    except Exception:
                        pass
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                    
                    db_time = (time.time() - db_start) * 1000
                    logger.debug(
                        "[OPEN:DB_PUBLISHED] order_id=%s db_time=%.2fms queue=%s",
                        order_id_dbg, db_time, DB_UPDATE_QUEUE
                    )
                    
                except Exception as e:
                    error_logger.exception(
                        "[OPEN:DB_PUBLISH_ERROR] order_id=%s error=%s", 
                        order_id_dbg, str(e)
                    )
            finally:
                await release_lock(lock_key, token)

            # Record successful processing
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_opened'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            logger.info(
                "[OPEN:SUCCESS] order_id=%s processing_time=%.2fms total_orders=%d",
                order_id_dbg, processing_time, self._stats['orders_opened']
            )
            
            await self._ack(message)
        except Exception as e:
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_failed'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            error_logger.exception(
                "[OPEN:ERROR] order_id=%s processing_time=%.2fms error=%s",
                order_id_dbg or "unknown", processing_time, str(e)
            )
            await self._nack(message, requeue=True)

    async def _log_stats(self):
        """Log worker statistics."""
        try:
            uptime = time.time() - self._stats['start_time']
            avg_processing_time = (
                self._stats['total_processing_time_ms'] / self._stats['messages_processed']
                if self._stats['messages_processed'] > 0 else 0
            )
            
            stats = {
                **self._stats,
                'uptime_seconds': uptime,
                'uptime_hours': uptime / 3600,
                'messages_per_second': self._stats['messages_processed'] / uptime if uptime > 0 else 0,
                'success_rate': (
                    (self._stats['orders_opened'] / self._stats['messages_processed']) * 100
                    if self._stats['messages_processed'] > 0 else 0
                ),
                'avg_processing_time_ms': avg_processing_time
            }
            
            log_provider_stats('worker_open', stats)
            logger.info(
                "[OPEN:STATS] processed=%d opened=%d failed=%d uptime=%.1fh rate=%.2f/s avg_time=%.2fms",
                stats['messages_processed'],
                stats['orders_opened'],
                stats['orders_failed'],
                stats['uptime_hours'],
                stats['messages_per_second'],
                avg_processing_time
            )
        except Exception as e:
            logger.error("[OPEN:STATS_ERROR] Failed to log stats: %s", e)

    async def run(self):
        logger.info("[OPEN:STARTING] Worker initializing...")
        
        try:
            await self.connect()
            await self._queue.consume(self.handle, no_ack=False)
            logger.info("[OPEN:READY] Worker started consuming messages")
            
            # Log stats periodically
            stats_interval = 0
            while True:
                await asyncio.sleep(300)  # 5 minutes
                stats_interval += 300
                
                # Log stats every 15 minutes
                if stats_interval >= 900:
                    await self._log_stats()
                    stats_interval = 0
        except Exception as e:
            error_logger.exception("[OPEN:RUN_ERROR] Worker run error: %s", e)
            raise


async def main():
    w = OpenWorker()
    try:
        logger.info("[OPEN:MAIN] Starting open worker service...")
        await w.run()
    except KeyboardInterrupt:
        logger.info("[OPEN:MAIN] Received keyboard interrupt, shutting down...")
    except Exception as e:
        error_logger.exception("[OPEN:MAIN] Unhandled exception in main: %s", e)
    finally:
        # Log final stats
        try:
            await w._log_stats()
        except Exception:
            pass
        logger.info("[OPEN:MAIN] Worker shutdown complete")


if __name__ == "__main__":
    try:
        logger.info("[OPEN:APP] Starting open worker application...")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("[OPEN:APP] Application interrupted by user")
    except Exception as e:
        error_logger.exception("[OPEN:APP] Application failed: %s", e)
