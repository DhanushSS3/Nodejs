import os
import asyncio
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional
import time

import orjson
import aio_pika
import aiohttp

from app.config.redis_config import redis_cluster
from app.config.redis_logging import (
    log_connection_acquire, log_connection_release, log_connection_error,
    log_pipeline_operation, connection_tracker, generate_operation_id
)
from app.services.orders.order_close_service import (
    OrderCloser,
    build_close_confirmation_payload,
    publish_close_confirmation,
)
from app.services.orders.order_repository import fetch_user_config
from app.services.orders.provider_connection import get_provider_connection_manager
from app.services.orders.id_generator import generate_stoploss_cancel_id, generate_takeprofit_cancel_id
from app.services.orders.order_registry import add_lifecycle_id
from app.services.logging.provider_logger import (
    get_worker_close_logger,
    get_orders_calculated_logger,
    get_provider_errors_logger,
    log_provider_stats
)

# Initialize dedicated loggers
logger = get_worker_close_logger()
calc_logger = get_orders_calculated_logger()
error_logger = get_provider_errors_logger()

# Keep basic logging for compatibility
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
CLOSE_QUEUE = os.getenv("ORDER_WORKER_CLOSE_QUEUE", "order_worker_close_queue")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")

# Internal provider lookup (Node) for enriching lifecycle->canonical and order_data
INTERNAL_PROVIDER_URL = os.getenv("INTERNAL_PROVIDER_URL", "http://127.0.0.1:3000/api/internal/provider")
INTERNAL_PROVIDER_SECRET = os.getenv("INTERNAL_PROVIDER_SECRET", "")


# ------------- Concurrency: Lightweight Redis lock -------------
async def acquire_lock(lock_key: str, token: str, ttl_sec: int = 5) -> bool:
    operation_id = generate_operation_id()
    connection_tracker.start_operation(operation_id, "cluster", f"acquire_lock_{lock_key}")
    log_connection_acquire("cluster", f"acquire_lock_{lock_key}", operation_id)
    
    try:
        ok = await redis_cluster.set(lock_key, token, ex=ttl_sec, nx=True)
        log_connection_release("cluster", f"acquire_lock_{lock_key}", operation_id)
        connection_tracker.end_operation(operation_id, success=True)
        return bool(ok)
    except Exception as e:
        log_connection_error("cluster", f"acquire_lock_{lock_key}", str(e), operation_id)
        connection_tracker.end_operation(operation_id, success=False, error=str(e))
        logger.error("acquire_lock error: %s", e)
        return False


async def release_lock(lock_key: str, token: str) -> None:
    operation_id = generate_operation_id()
    connection_tracker.start_operation(operation_id, "cluster", f"release_lock_{lock_key}")
    log_connection_acquire("cluster", f"release_lock_{lock_key}", operation_id)
    
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
            log_connection_release("cluster", f"release_lock_{lock_key}", operation_id)
            connection_tracker.end_operation(operation_id, success=True)
        except Exception as e:
            log_connection_error("cluster", f"release_lock_{lock_key}", str(e), operation_id)
            connection_tracker.end_operation(operation_id, success=False, error=str(e))
    except Exception as e:
        log_connection_error("cluster", f"release_lock_{lock_key}", str(e), operation_id)
        connection_tracker.end_operation(operation_id, success=False, error=str(e))
        logger.error("release_lock error: %s", e)


# Use centralized calculated orders logger
_ORDERS_CALC_LOG = calc_logger


class CloseWorker:
    def __init__(self):
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._queue: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None
        self._db_queue: Optional[aio_pika.abc.AbstractQueue] = None
        self._closer = OrderCloser()
        
        # Statistics tracking
        self._stats = {
            'start_time': time.time(),
            'messages_processed': 0,
            'orders_closed': 0,
            'orders_failed': 0,
            'close_calculations': 0,
            'context_enrichments': 0,
            'redis_errors': 0,
            'db_publishes': 0,
            'last_message_time': None,
            'total_processing_time_ms': 0,
            'finalize_retries': 0,
            'sl_cancel_requests': 0,
            'tp_cancel_requests': 0,
            'order_type_identifications': 0
        }

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=64)
        self._queue = await self._channel.declare_queue(CLOSE_QUEUE, durable=True)
        # ensure DB update queue exists
        self._db_queue = await self._channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
        logger.info("[CLOSE:CONNECTED] Worker connected to %s", CLOSE_QUEUE)

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

    async def _identify_order_type_and_get_canonical(self, received_order_id: str) -> tuple[str, str]:
        """
        Identify if received order_id is a stoploss_id, takeprofit_id, or close_id.
        Returns: (order_type, canonical_order_id)
        order_type: 'stoploss', 'takeprofit', 'close', or 'unknown'
        """
        try:
            # First check global lookup to get canonical order_id with connection tracking
            lookup_operation_id = generate_operation_id()
            connection_tracker.start_operation(lookup_operation_id, "cluster", f"global_lookup_{received_order_id}")
            log_connection_acquire("cluster", f"global_lookup_{received_order_id}", lookup_operation_id)
            
            try:
                canonical_order_id = await redis_cluster.get(f"global_order_lookup:{received_order_id}")
                log_connection_release("cluster", f"global_lookup_{received_order_id}", lookup_operation_id)
                connection_tracker.end_operation(lookup_operation_id, success=True)
            except Exception as e:
                log_connection_error("cluster", f"global_lookup_{received_order_id}", str(e), lookup_operation_id)
                connection_tracker.end_operation(lookup_operation_id, success=False, error=str(e))
                raise
                
            if not canonical_order_id:
                return ("unknown", received_order_id)
            
            canonical_order_id = str(canonical_order_id)
            
            # Get order data to check which ID type this is with connection tracking
            data_operation_id = generate_operation_id()
            connection_tracker.start_operation(data_operation_id, "cluster", f"order_data_{canonical_order_id}")
            log_connection_acquire("cluster", f"order_data_{canonical_order_id}", data_operation_id)
            
            try:
                order_data = await redis_cluster.hgetall(f"order_data:{canonical_order_id}")
                log_connection_release("cluster", f"order_data_{canonical_order_id}", data_operation_id)
                connection_tracker.end_operation(data_operation_id, success=True)
            except Exception as e:
                log_connection_error("cluster", f"order_data_{canonical_order_id}", str(e), data_operation_id)
                connection_tracker.end_operation(data_operation_id, success=False, error=str(e))
                raise
                
            if not order_data:
                return ("unknown", canonical_order_id)
            
            # Check if received_order_id matches any of the lifecycle IDs
            if order_data.get("stoploss_id") == received_order_id:
                return ("stoploss", canonical_order_id)
            elif order_data.get("takeprofit_id") == received_order_id:
                return ("takeprofit", canonical_order_id)
            elif order_data.get("close_id") == received_order_id:
                return ("close", canonical_order_id)
            elif canonical_order_id == received_order_id:
                return ("close", canonical_order_id)  # Direct canonical order close
            else:
                return ("unknown", canonical_order_id)
                
        except Exception as e:
            logger.warning(
                "[CLOSE:ORDER_TYPE_ID_ERROR] order_id=%s error=%s", 
                received_order_id, str(e)
            )
            return ("unknown", received_order_id)

    async def _send_cancel_request_priority(self, order_type: str, canonical_order_id: str, 
                                           user_type: str, user_id: str, symbol: str, side: str):
        """
        Send stoploss or takeprofit cancel request with proper cancel ID generation.
        This is sent as PRIORITY before processing the close.
        order_type: 'stoploss' or 'takeprofit'
        """
        try:
            # Get order data to find the target ID to cancel
            order_data = await redis_cluster.hgetall(f"order_data:{canonical_order_id}")
            if not order_data:
                logger.warning(
                    "[CLOSE:CANCEL_PRIORITY_NO_DATA] order_id=%s type=%s", 
                    canonical_order_id, order_type
                )
                return

            target_id = None
            cancel_type = None
            if order_type == "stoploss":
                # Stoploss executed, cancel takeprofit
                target_id = order_data.get("takeprofit_id")
                cancel_type = "takeprofit"
                if not target_id:
                    logger.debug(
                        "[CLOSE:CANCEL_PRIORITY_NO_TP] order_id=%s no_takeprofit_to_cancel", 
                        canonical_order_id
                    )
                    return
                self._stats['tp_cancel_requests'] += 1
            elif order_type == "takeprofit":
                # Takeprofit executed, cancel stoploss
                target_id = order_data.get("stoploss_id")
                cancel_type = "stoploss"
                if not target_id:
                    logger.debug(
                        "[CLOSE:CANCEL_PRIORITY_NO_SL] order_id=%s no_stoploss_to_cancel", 
                        canonical_order_id
                    )
                    return
                self._stats['sl_cancel_requests'] += 1

            if not target_id:
                return

            # Check user config to determine flow
            cfg = await fetch_user_config(user_type, user_id)
            sending_orders = (cfg.get("sending_orders") or "").strip().lower()
            
            # Only send to provider for provider flow
            if (user_type in ["live", "strategy_provider", "copy_follower"] and sending_orders == "barclays") or \
               (user_type in ["strategy_provider", "copy_follower"] and not sending_orders):
                # Generate proper cancel ID like manual cancel endpoints
                if cancel_type == "takeprofit":
                    cancel_id = generate_takeprofit_cancel_id()
                    # Register lifecycle mapping
                    try:
                        await add_lifecycle_id(canonical_order_id, cancel_id, "takeprofit_cancel_id")
                    except Exception as e:
                        logger.warning(
                            "[CLOSE:CANCEL_PRIORITY_LIFECYCLE_FAILED] order_id=%s cancel_id=%s error=%s",
                            canonical_order_id, cancel_id, str(e)
                        )
                    
                    # Build cancel payload exactly like manual takeprofit cancel
                    cancel_payload = {
                        "order_id": canonical_order_id,
                        "symbol": symbol,
                        "order_type": side,
                        "status": "TAKEPROFIT-CANCEL",
                        "takeprofit_id": target_id,
                        "takeprofit_cancel_id": cancel_id,
                        "type": "order",
                    }
                    logger.info(
                        "[CLOSE:CANCEL_PRIORITY_TP] order_id=%s takeprofit_id=%s cancel_id=%s payload=%s", 
                        canonical_order_id, target_id, cancel_id, orjson.dumps(cancel_payload).decode()
                    )
                else:  # stoploss
                    cancel_id = generate_stoploss_cancel_id()
                    # Register lifecycle mapping
                    try:
                        await add_lifecycle_id(canonical_order_id, cancel_id, "stoploss_cancel_id")
                    except Exception as e:
                        logger.warning(
                            "[CLOSE:CANCEL_PRIORITY_LIFECYCLE_FAILED] order_id=%s cancel_id=%s error=%s",
                            canonical_order_id, cancel_id, str(e)
                        )
                    
                    # Build cancel payload exactly like manual stoploss cancel
                    cancel_payload = {
                        "order_id": canonical_order_id,
                        "symbol": symbol,
                        "order_type": side,
                        "status": "STOPLOSS-CANCEL",
                        "stoploss_id": target_id,
                        "stoploss_cancel_id": cancel_id,
                        "type": "order",
                    }
                    logger.info(
                        "[CLOSE:CANCEL_PRIORITY_SL] order_id=%s stoploss_id=%s cancel_id=%s payload=%s", 
                        canonical_order_id, target_id, cancel_id, orjson.dumps(cancel_payload).decode()
                    )

                # Send IMMEDIATELY as priority (blocking call, not fire-and-forget)
                await self._send_provider_cancel_sync(cancel_payload, canonical_order_id, cancel_type, cancel_id)
            else:
                logger.debug(
                    "[CLOSE:CANCEL_PRIORITY_SKIP] order_id=%s type=%s flow=local", 
                    canonical_order_id, order_type
                )

        except Exception as e:
            logger.error(
                "[CLOSE:CANCEL_PRIORITY_ERROR] order_id=%s type=%s error=%s", 
                canonical_order_id, order_type, str(e)
            )

    async def _send_provider_cancel_sync(self, cancel_payload: dict, canonical_order_id: str, cancel_type: str, cancel_id: str):
        """
        Send cancel request to provider synchronously (priority, blocking).
        Follows the same pattern as other services: try send_provider_order first, then direct fallback.
        """
        try:
            # Log the payload being sent to provider
            logger.info(
                "[CLOSE:CANCEL_PRIORITY_SENDING] order_id=%s cancel_type=%s cancel_id=%s payload_to_provider=%s", 
                canonical_order_id, cancel_type, cancel_id, orjson.dumps(cancel_payload).decode()
            )
            
            # Follow the same pattern as other services: try send_provider_order first
            from app.services.orders.service_provider_client import send_provider_order, send_provider_order_direct_with_timeout
            
            # CRITICAL: Force direct send for cancel requests since persistent connection is unreliable
            # The persistent connection manager is not properly sending cancel requests
            logger.warning(
                "[CLOSE:CANCEL_PRIORITY_FORCE_DIRECT] order_id=%s cancel_type=%s forcing_direct_send_due_to_persistent_issues", 
                canonical_order_id, cancel_type
            )
            
            # Fallback to direct send with UDS→TCP fallback (same as other services)
            ok2, via2 = await send_provider_order_direct_with_timeout(cancel_payload, timeout_sec=5.0)
            
            if ok2:
                logger.info(
                    "[CLOSE:CANCEL_PRIORITY_SENT] order_id=%s cancel_type=%s cancel_id=%s via=direct_%s payload=%s", 
                    canonical_order_id, cancel_type, cancel_id, via2, orjson.dumps(cancel_payload).decode()
                )
                # Confirm that direct send logs to provider_tx.log
                logger.info(
                    "[CLOSE:CANCEL_PRIORITY_TX_LOG_CONFIRMED] order_id=%s cancel_type=%s logged_to_provider_tx_via=%s", 
                    canonical_order_id, cancel_type, via2
                )
            else:
                logger.error(
                    "[CLOSE:CANCEL_PRIORITY_FAILED] order_id=%s cancel_type=%s cancel_id=%s via=%s payload=%s", 
                    canonical_order_id, cancel_type, cancel_id, via2, orjson.dumps(cancel_payload).decode()
                )
                logger.error(
                    "[CLOSE:CANCEL_PRIORITY_NO_TX_LOG] order_id=%s cancel_type=%s not_logged_to_provider_tx_reason=%s", 
                    canonical_order_id, cancel_type, via2
                )
                
        except Exception as e:
            logger.error(
                "[CLOSE:CANCEL_PRIORITY_EXCEPTION] order_id=%s cancel_type=%s cancel_id=%s error=%s payload=%s", 
                canonical_order_id, cancel_type, cancel_id, str(e), orjson.dumps(cancel_payload).decode() if 'cancel_payload' in locals() else 'unknown'
            )

    async def handle(self, message: aio_pika.abc.AbstractIncomingMessage):
        start_time = time.time()
        order_id_dbg = None
        
        try:
            self._stats['messages_processed'] += 1
            self._stats['last_message_time'] = start_time
            
            payload = orjson.loads(message.body)
            er = payload.get("execution_report") or {}
            ord_status = str(er.get("ord_status") or (er.get("raw") or {}).get("39") or "").strip().upper()
            
            # Use provider_order_id for identification, fallback to order_id for backward compatibility
            provider_order_id = str(payload.get("provider_order_id") or payload.get("order_id"))
            canonical_order_id = str(payload.get("order_id"))
            order_id_dbg = provider_order_id  # Use provider order_id for logging
            side_dbg = str(payload.get("order_type") or payload.get("side") or "").upper()
            
            logger.info(
                "[CLOSE:RECEIVED] provider_id=%s canonical_id=%s ord_status=%s side=%s avgpx=%s",
                provider_order_id, canonical_order_id, ord_status, side_dbg,
                er.get("avgpx") or (er.get("raw") or {}).get("6"),
            )

            # Only process close EXECUTED
            if ord_status not in ("EXECUTED", "2"):
                logger.warning(
                    "[CLOSE:SKIP] order_id=%s ord_status=%s reason=not_executed",
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
                        logger.info("[CLOSE:SKIP] order_id=%s idem=%s reason=provider_idempotent", order_id_dbg, idem)
                        await self._ack(message)
                        return
            except Exception:
                pass

            # Identify order type and handle SL/TP cancellation logic
            self._stats['order_type_identifications'] += 1
            order_type, identified_canonical_id = await self._identify_order_type_and_get_canonical(provider_order_id)
            
            # Use the canonical_order_id from payload (dispatcher already resolved it)
            # But verify it matches our identification for logging
            if identified_canonical_id != canonical_order_id:
                logger.warning(
                    "[CLOSE:ORDER_TYPE_MISMATCH] provider_id=%s dispatcher_canonical=%s identified_canonical=%s",
                    provider_order_id, canonical_order_id, identified_canonical_id
                )
            
            logger.info(
                "[CLOSE:ORDER_TYPE] provider_id=%s canonical_id=%s type=%s",
                provider_order_id, canonical_order_id, order_type
            )
            
            # PRIORITY: If this is a stoploss or takeprofit execution, send cancel for the counterpart FIRST
            if order_type in ("stoploss", "takeprofit"):
                logger.info(
                    "[CLOSE:SL_TP_DETECTED] provider_id=%s canonical_id=%s order_type=%s will_send_priority_cancel_request=true",
                    provider_order_id, canonical_order_id, order_type
                )
                # Get basic order info for cancel request
                try:
                    user_type = str(payload.get("user_type") or "").lower()
                    user_id = str(payload.get("user_id") or "")
                    symbol = str(payload.get("symbol") or "").upper()
                    side = str(payload.get("order_type") or payload.get("side") or "").upper()
                    
                    # If missing from payload, try to get from order data
                    if not all([user_type, user_id, symbol, side]):
                        order_data = await redis_cluster.hgetall(f"order_data:{canonical_order_id}")
                        user_type = user_type or str(order_data.get("user_type") or "").lower()
                        user_id = user_id or str(order_data.get("user_id") or "")
                        symbol = symbol or str(order_data.get("symbol") or "").upper()
                        side = side or str(order_data.get("order_type") or "").upper()
                    
                    if all([user_type, user_id, symbol, side]):
                        # Send cancel request for the counterpart as PRIORITY (blocking)
                        await self._send_cancel_request_priority(
                            order_type, canonical_order_id, user_type, user_id, symbol, side
                        )
                    else:
                        logger.warning(
                            "[CLOSE:CANCEL_PRIORITY_MISSING_INFO] order_id=%s type=%s user_type=%s user_id=%s symbol=%s side=%s",
                            canonical_order_id, order_type, user_type, user_id, symbol, side
                        )
                except Exception as e:
                    logger.error(
                        "[CLOSE:CANCEL_PRIORITY_SETUP_ERROR] order_id=%s type=%s error=%s",
                        canonical_order_id, order_type, str(e)
                    )
            else:
                # Not an SL/TP order, no cancel request needed
                logger.debug(
                    "[CLOSE:NO_CANCEL_NEEDED] provider_id=%s canonical_id=%s order_type=%s reason=not_sl_tp",
                    provider_order_id, canonical_order_id, order_type
                )

            # Keep using canonical_order_id for the rest of processing (already in payload)
            # Update debug variable to canonical for consistency with existing logic
            order_id_dbg = canonical_order_id

            # Per-order processing guard to avoid duplicate concurrent processing
            processing_key = f"close_processing:{payload.get('order_id')}"
            try:
                got_processing = await redis_cluster.set(processing_key, "1", ex=15, nx=True)
            except Exception:
                got_processing = True  # if Redis failed, proceed best-effort
            if not got_processing:
                logger.warning("[CLOSE:SKIP] order_id=%s reason=already_processing", order_id_dbg)
                await self._ack(message)
                return

            # Ensure we have enough context to finalize: backfill order_data and user info from Node if needed
            context_start = time.time()
            try:
                await self._ensure_order_context(payload, er)
                context_time = (time.time() - context_start) * 1000
                self._stats['context_enrichments'] += 1
                logger.debug(
                    "[CLOSE:CONTEXT_ENRICHED] order_id=%s context_time=%.2fms",
                    order_id_dbg, context_time
                )
            except Exception as e:
                logger.debug(
                    "[CLOSE:CONTEXT_FAILED] order_id=%s error=%s",
                    order_id_dbg, str(e)
                )
                # Best-effort; continue
                pass

            # Acquire per-user lock to avoid race on used_margin recompute (after enrichment)
            lock_key = f"lock:user_margin:{payload.get('user_type')}:{payload.get('user_id')}"
            token = f"{os.getpid()}-{id(message)}"
            got_lock = await acquire_lock(lock_key, token, ttl_sec=8)
            if not got_lock:
                logger.warning("[CLOSE:LOCK_FAILED] order_id=%s lock_key=%s", order_id_dbg, lock_key)
                try:
                    await redis_cluster.delete(processing_key)
                except Exception:
                    pass
                await self._nack(message, requeue=True)
                return

            try:
                # Finalize close using OrderCloser logic
                close_start = time.time()
                avgpx = er.get("avgpx") or (er.get("raw") or {}).get("6")
                try:
                    close_price = float(avgpx) if avgpx is not None else None
                except Exception:
                    close_price = None
                    
                self._stats['close_calculations'] += 1
                result = await self._closer.finalize_close(
                    user_type=str(payload.get("user_type")),
                    user_id=str(payload.get("user_id")),
                    order_id=str(payload.get("order_id")),
                    close_price=close_price,
                    fallback_symbol=str(payload.get("symbol") or ""),
                    fallback_order_type=str(payload.get("order_type") or ""),
                    fallback_entry_price=payload.get("order_price"),
                    fallback_qty=payload.get("order_quantity"),
                )
                
                close_time = (time.time() - close_start) * 1000
                logger.debug(
                    "[CLOSE:FINALIZED] order_id=%s close_time=%.2fms close_price=%s profit=%s",
                    order_id_dbg, close_time, close_price, result.get('net_profit')
                )
                if not result.get("ok"):
                    reason = str(result.get("reason"))
                    error_logger.error(
                        "[CLOSE:FINALIZE_FAILED] order_id=%s reason=%s", 
                        order_id_dbg, reason
                    )
                    
                    # Bounded retries to avoid infinite loop on unrecoverable context
                    try:
                        rkey = f"close_finalize_retries:{payload.get('order_id')}"
                        cnt = await redis_cluster.incr(rkey)
                        # expire retry counter in 10 minutes to avoid leaks
                        await redis_cluster.expire(rkey, 600)
                        self._stats['finalize_retries'] += 1
                    except Exception:
                        cnt = 1
                        
                    if cnt <= 3 and reason.startswith("cleanup_failed:") is False:
                        logger.warning(
                            "[CLOSE:RETRY] order_id=%s attempt=%d reason=%s",
                            order_id_dbg, cnt, reason
                        )
                        try:
                            await redis_cluster.delete(processing_key)
                        except Exception:
                            pass
                        await self._nack(message, requeue=True)
                    else:
                        logger.warning(
                            "[CLOSE:DROPPED] order_id=%s retries=%d reason=%s", 
                            order_id_dbg, cnt, reason
                        )
                        await self._ack(message)
                    return


                # Log calculated close data
                try:
                    calc = {
                        "type": "ORDER_CLOSE_CALC",
                        "order_id": str(payload.get("order_id")),
                        "user_type": str(payload.get("user_type")),
                        "user_id": str(payload.get("user_id")),
                        "symbol": str(payload.get("symbol") or "").upper(),
                        "side": side_dbg,
                        "close_price": result.get("close_price"),
                        "commission_entry": result.get("commission_entry"),
                        "commission_exit": result.get("commission_exit"),
                        "total_commission": result.get("total_commission"),
                        "profit_usd": result.get("profit_usd"),
                        "swap": result.get("swap"),
                        "net_profit": result.get("net_profit"),
                        "used_margin_executed": result.get("used_margin_executed"),
                        "used_margin_all": result.get("used_margin_all"),
                        "provider": {
                            "ord_status": er.get("ord_status"),
                            "exec_id": er.get("exec_id"),
                            "avgpx": er.get("avgpx"),
                        },
                    }
                    _ORDERS_CALC_LOG.info(orjson.dumps(calc).decode())
                except Exception:
                    pass

                # Publish DB update intent
                db_start = time.time()
                try:
                    self._stats['db_publishes'] += 1
                    # Prefer provider's original lifecycle id (from ER raw payload) to infer close reason on Node
                    trigger_lifecycle_id = None
                    try:
                        trigger_lifecycle_id = (
                            (er.get("raw") or {}).get("order_id")
                            or er.get("exec_id")
                        )
                        if trigger_lifecycle_id is not None:
                            trigger_lifecycle_id = str(trigger_lifecycle_id)
                    except Exception:
                        trigger_lifecycle_id = None
                    
                    # Enhanced close message attribution using context
                    if order_type == "stoploss":
                        close_message = "Stoploss-Triggered"
                    elif order_type == "takeprofit":
                        close_message = "Takeprofit-Triggered"
                    else:  # order_type == "close" or "unknown"
                        # Check for close context to determine proper close message
                        close_context = None
                        try:
                            from app.services.orders.close_context_service import CloseContextService
                            close_context = await CloseContextService.get_close_context(order_id_dbg)
                        except Exception as e:
                            logger.warning("[CLOSE:CONTEXT_GET_FAILED] order_id=%s error=%s", order_id_dbg, str(e))
                        
                        if close_context and close_context.get("context"):
                            context = close_context.get("context")
                            if context == "AUTOCUTOFF":
                                close_message = "Auto-cutoff"
                            elif context == "ADMIN_CLOSED":
                                close_message = "Admin-Closed"
                            elif context == "USER_CLOSED":
                                close_message = "Closed"
                            else:
                                close_message = "Closed"  # Fallback
                            
                            # Clear context after use
                            try:
                                await CloseContextService.clear_close_context(order_id_dbg)
                            except Exception as e:
                                logger.warning("[CLOSE:CONTEXT_CLEAR_FAILED] order_id=%s error=%s", order_id_dbg, str(e))
                        else:
                            close_message = "Closed"  # Default fallback
                    
                    
                    db_msg = build_close_confirmation_payload(
                        order_id=str(payload.get("order_id")),
                        user_id=str(payload.get("user_id")),
                        user_type=str(payload.get("user_type")),
                        symbol=str(payload.get("symbol") or "").upper() or None,
                        order_type=str(payload.get("order_type") or "").upper() or None,
                        result=result,
                        close_message=close_message,
                        flow="provider",
                        close_origin="provider",
                        extra_fields={
                            "trigger_lifecycle_id": trigger_lifecycle_id,
                        },
                    )

                    await publish_close_confirmation(db_msg, channel=self._channel, exchange=self._ex)
                    
                    db_time = (time.time() - db_start) * 1000
                    logger.debug(
                        "[CLOSE:DB_PUBLISHED] order_id=%s db_time=%.2fms queue=%s",
                        order_id_dbg, db_time, DB_UPDATE_QUEUE
                    )
                    
                except Exception as e:
                    error_logger.exception(
                        "[CLOSE:DB_PUBLISH_ERROR] order_id=%s error=%s", 
                        order_id_dbg, str(e)
                    )
                
                # 🆕 Clean up close_pending lock after publishing confirmation
                # This ensures lock is removed even if DB consumer fails
                try:
                    close_pending_key = f"order_close_pending:{payload.get('order_id')}"
                    await redis_cluster.delete(close_pending_key)
                    logger.info(
                        "[CLOSE:PENDING_LOCK_CLEANUP] order_id=%s close_pending_key=%s",
                        order_id_dbg, close_pending_key
                    )
                except Exception as cleanup_err:
                    logger.warning(
                        "[CLOSE:PENDING_LOCK_CLEANUP_FAILED] order_id=%s error=%s",
                        order_id_dbg, str(cleanup_err)
                    )
                    # Non-fatal - lock will expire after TTL
            finally:
                await release_lock(lock_key, token)
                try:
                    await redis_cluster.delete(processing_key)
                except Exception:
                    pass

            # Record successful processing
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_closed'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            logger.info(
                "[CLOSE:SUCCESS] order_id=%s processing_time=%.2fms total_closed=%d profit=%s close_message=%s",
                order_id_dbg, processing_time, self._stats['orders_closed'],
                result.get('net_profit') if 'result' in locals() else None,
                close_message if 'close_message' in locals() else 'Closed'
            )
            
            await self._ack(message)
        except Exception as e:
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_failed'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            error_logger.exception(
                "[CLOSE:ERROR] order_id=%s processing_time=%.2fms error=%s",
                order_id_dbg or "unknown", processing_time, str(e)
            )
            await self._nack(message, requeue=True)

    async def _ensure_order_context(self, payload: dict, er: dict) -> None:
        """
        Best-effort enrichment: resolve canonical order, user info and order_data fields by calling Node internal lookup
        and populate Redis order_data + global lookups. This helps finalize_close when Redis is missing context.
        """
        any_id = (
            str(payload.get("close_id") or "")
            or str(er.get("exec_id") or "")
            or str(payload.get("order_id") or "")
        )
        if not any_id:
            return
        data = await self._node_lookup_any_id(any_id)
        if not data:
            return
        order = data.get("order") or {}
        user = data.get("user") or {}
        gcfg = data.get("group_config") or {}
        can_id = str(order.get("order_id") or payload.get("order_id") or "")
        if not can_id:
            return
        # Backfill order_data canonical hash
        od_update = {}
        if order.get("symbol"):
            od_update["symbol"] = str(order.get("symbol")).upper()
        if order.get("order_type"):
            od_update["order_type"] = str(order.get("order_type")).upper()
        if order.get("order_price") is not None:
            od_update["order_price"] = str(order.get("order_price"))
        if order.get("order_quantity") is not None:
            od_update["order_quantity"] = str(order.get("order_quantity"))
        if user.get("group"):
            od_update["group"] = str(user.get("group"))
        # Group config enrichments
        for k_src, k_dst in (
            ("type", "type"),
            ("contract_size", "contract_size"),
            ("profit", "profit"),
            ("spread", "spread"),
            ("spread_pip", "spread_pip"),
            ("commission_rate", "commission_rate"),
            ("commission_type", "commission_type"),
            ("commission_value_type", "commission_value_type"),
            ("group_margin", "group_margin"),
            ("commision", "commission_rate"),
            ("commision_type", "commission_type"),
            ("commision_value_type", "commission_value_type"),
        ):
            if gcfg.get(k_src) is not None:
                od_update[k_dst] = str(gcfg.get(k_src))
        if od_update:
            try:
                await redis_cluster.hset(f"order_data:{can_id}", mapping=od_update)
            except Exception:
                pass
        # Ensure global lookups for lifecycle ids map to canonical id
        ids_to_map = [
            order.get("order_id"),
            order.get("close_id"),
            order.get("cancel_id"),
            order.get("modify_id"),
            order.get("takeprofit_id"),
            order.get("stoploss_id"),
            order.get("takeprofit_cancel_id"),
            order.get("stoploss_cancel_id"),
        ]
        # Add retry logic for Redis connection pool exhaustion
        max_retries = 3
        for attempt in range(max_retries):
            try:
                pipe = redis_cluster.pipeline()
                for _id in ids_to_map:
                    if _id:
                        pipe.set(f"global_order_lookup:{_id}", can_id)
                await pipe.execute()
                break  # Success, exit retry loop
            except Exception as e:
                if attempt == max_retries - 1:
                    # Last attempt failed, log and continue (non-critical operation)
                    logger.warning(
                        "[CLOSE:LOOKUP_MAPPING_FAILED] order_id=%s error=%s",
                        payload.get("order_id"), str(e)
                    )
                    break
                logger.warning(
                    "[CLOSE:LOOKUP_MAPPING_RETRY] order_id=%s attempt=%d error=%s",
                    payload.get("order_id"), attempt + 1, str(e)
                )
                # Wait briefly before retry (exponential backoff)
                await asyncio.sleep(0.1 * (2 ** attempt))
        # Enrich payload with user info if missing
        if not payload.get("user_id") and user.get("id") is not None:
            payload["user_id"] = str(user.get("id"))
        if not payload.get("user_type") and user.get("user_type"):
            payload["user_type"] = str(user.get("user_type")).lower()
        if not payload.get("symbol") and order.get("symbol"):
            payload["symbol"] = str(order.get("symbol")).upper()

    async def _node_lookup_any_id(self, any_id: str) -> Optional[dict]:
        timeout = aiohttp.ClientTimeout(total=3.0)
        headers = {"X-Internal-Auth": INTERNAL_PROVIDER_SECRET} if INTERNAL_PROVIDER_SECRET else {}
        url = f"{INTERNAL_PROVIDER_URL}/orders/lookup/{any_id}"
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url, headers=headers) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
                    return data.get("data") or None
        except Exception:
            return None

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
                    (self._stats['orders_closed'] / self._stats['messages_processed']) * 100
                    if self._stats['messages_processed'] > 0 else 0
                ),
                'avg_processing_time_ms': avg_processing_time
            }
            
            log_provider_stats('worker_close', stats)
            logger.info(
                "[CLOSE:STATS] processed=%d closed=%d failed=%d sl_cancels=%d tp_cancels=%d type_ids=%d uptime=%.1fh rate=%.2f/s avg_time=%.2fms",
                stats['messages_processed'],
                stats['orders_closed'],
                stats['orders_failed'],
                stats['sl_cancel_requests'],
                stats['tp_cancel_requests'],
                stats['order_type_identifications'],
                stats['uptime_hours'],
                stats['messages_per_second'],
                avg_processing_time
            )
        except Exception as e:
            logger.error("[CLOSE:STATS_ERROR] Failed to log stats: %s", e)

    async def run(self):
        logger.info("[CLOSE:STARTING] Worker initializing...")
        
        try:
            await self.connect()
            await self._queue.consume(self.handle, no_ack=False)
            logger.info("[CLOSE:READY] Worker started consuming messages")
            
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
            error_logger.exception("[CLOSE:RUN_ERROR] Worker run error: %s", e)
            raise


async def main():
    w = CloseWorker()
    try:
        logger.info("[CLOSE:MAIN] Starting close worker service...")
        await w.run()
    except KeyboardInterrupt:
        logger.info("[CLOSE:MAIN] Received keyboard interrupt, shutting down...")
    except Exception as e:
        error_logger.exception("[CLOSE:MAIN] Unhandled exception in main: %s", e)
    finally:
        # Log final stats
        try:
            await w._log_stats()
        except Exception:
            pass
        logger.info("[CLOSE:MAIN] Worker shutdown complete")


if __name__ == "__main__":
    try:
        logger.info("[CLOSE:APP] Starting close worker application...")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("[CLOSE:APP] Application interrupted by user")
    except Exception as e:
        error_logger.exception("[CLOSE:APP] Application failed: %s", e)
