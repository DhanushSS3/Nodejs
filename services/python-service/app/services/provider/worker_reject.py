import os
import asyncio
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
import time

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.services.orders.order_repository import fetch_user_orders
from app.services.portfolio.user_margin_service import compute_user_total_margin
from app.services.logging.provider_logger import (
    get_worker_reject_logger,
    get_provider_errors_logger,
    log_order_processing,
    log_worker_stats
)

# Initialize dedicated loggers
logger = get_worker_reject_logger()
error_logger = get_provider_errors_logger()

# Keep basic logging for compatibility
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
REJECT_QUEUE = os.getenv("ORDER_WORKER_REJECT_QUEUE", "order_worker_reject_queue")
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
        # Safe release
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
            pass
    except Exception as e:
        logger.error("release_lock error: %s", e)


def _determine_rejection_type_by_lifecycle_id(provider_order_id: str) -> str:
    """
    Determine rejection type based on provider order_id (lifecycle ID) prefix.
    This is more reliable than Redis status as it directly maps to the operation type.
    
    ID Patterns:
    - MOD123... = Modify operation failed (PENDING_MODIFY)
    - SL123...  = Stop loss addition failed (STOPLOSS_ADD)  
    - TP123...  = Take profit addition failed (TAKEPROFIT_ADD)
    - SLC123... = Stop loss cancel failed (STOPLOSS_REMOVE)
    - TPC123... = Take profit cancel failed (TAKEPROFIT_REMOVE)
    - CNL123... = Pending cancel failed (PENDING_CANCEL)
    - CLS123... = Close order failed (ORDER_CLOSE)
    - 123...    = Order ID only = Instant order failed (ORDER_PLACEMENT)
    """
    if not provider_order_id:
        return 'ORDER_PLACEMENT'  # Default fallback
        
    pid = str(provider_order_id).upper().strip()
    
    # Check lifecycle ID prefixes
    if pid.startswith('MOD'):
        return 'PENDING_MODIFY'
    elif pid.startswith('SLC'):
        return 'STOPLOSS_REMOVE'
    elif pid.startswith('TPC'):
        return 'TAKEPROFIT_REMOVE'
    elif pid.startswith('SL'):
        return 'STOPLOSS_ADD'
    elif pid.startswith('TP'):
        return 'TAKEPROFIT_ADD'
    elif pid.startswith('CNL'):
        return 'PENDING_CANCEL'
    elif pid.startswith('CLS'):
        return 'ORDER_CLOSE'
    elif pid.isdigit():
        # Pure numeric ID = original order_id = placement failure
        return 'ORDER_PLACEMENT'
    else:
        # Unknown prefix, check if it looks like pending placement
        if any(char.isalpha() for char in pid):
            return 'PENDING_PLACEMENT'  # Has letters, likely pending
        return 'ORDER_PLACEMENT'  # Default fallback


def _determine_rejection_type(redis_status: str, provider_order_id: str = None) -> str:
    """
    Determine rejection type with dual approach:
    1. Primary: Use lifecycle ID prefix (more reliable)
    2. Fallback: Use Redis status (legacy compatibility)
    """
    # Primary method: Use lifecycle ID if available
    if provider_order_id:
        return _determine_rejection_type_by_lifecycle_id(provider_order_id)
    
    # Fallback method: Use Redis status
    status = str(redis_status or '').upper().strip()
    
    if status == 'OPEN':
        return 'ORDER_PLACEMENT'
    elif status == 'CLOSED':
        return 'ORDER_CLOSE'
    elif status == 'PENDING':
        return 'PENDING_PLACEMENT'
    elif status == 'MODIFY':
        return 'PENDING_MODIFY'
    elif status == 'CANCELLED':
        return 'PENDING_CANCEL'
    elif status == 'STOPLOSS':
        return 'STOPLOSS_ADD'
    elif status == 'STOPLOSS-CANCEL':
        return 'STOPLOSS_REMOVE'
    elif status == 'TAKEPROFIT':
        return 'TAKEPROFIT_ADD'
    elif status == 'TAKEPROFIT-CANCEL':
        return 'TAKEPROFIT_REMOVE'
    else:
        return 'ORDER_PLACEMENT'  # Default fallback


async def _handle_placement_rejection(payload: Dict[str, Any]) -> None:
    """
    Handle rejection of order placement (status=OPEN).
    Mark order as REJECTED and release reserved margin.
    """
    order_id = str(payload.get("order_id", ""))
    user_id_raw = payload.get("user_id")
    user_type_raw = payload.get("user_type")
    
    if user_id_raw is None or user_type_raw is None:
        logger.error("[REJECT:PLACEMENT] Missing user info: user_type=%s user_id=%s order_id=%s", 
                    user_type_raw, user_id_raw, order_id)
        return
        
    user_id = str(user_id_raw)
    user_type = str(user_type_raw)
        
    # Provider report fields
    report: Dict[str, Any] = payload.get("execution_report") or {}
    ord_status = report.get("ord_status") or (report.get("raw") or {}).get("39")
    exec_id = report.get("exec_id") or (report.get("raw") or {}).get("17")
    reason = report.get("reason") or (report.get("raw") or {}).get("58")
    ts = report.get("ts")

    # Keys
    order_data_key = f"order_data:{order_id}"
    hash_tag = f"{user_type}:{user_id}"
    order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
    index_key = f"user_orders_index:{{{hash_tag}}}"

    mapping_common = {
        "order_status": "REJECTED",
        "execution_status": "REJECTED",
        "provider_ord_status": ord_status if ord_status is not None else "",
        "provider_exec_id": exec_id if exec_id is not None else "",
        "provider_reason": reason if reason is not None else "",
        "provider_ts": str(ts) if ts is not None else "",
        "reserved_margin": "",
        "margin": "",
    }

    pipe = redis_cluster.pipeline()
    pipe.hset(order_data_key, mapping=mapping_common)
    pipe.hset(order_key, mapping=mapping_common)
    # Remove from open orders index so it's not considered for used margin
    pipe.srem(index_key, order_id)
    await pipe.execute()

    return {
        "order_id": order_id,
        "user_id": user_id,
        "user_type": user_type,
        "order_key": order_key,
        "order_data_key": order_data_key,
        "requires_margin_update": True
    }


async def _handle_non_placement_reject(payload: Dict[str, Any], rejection_type: str) -> Dict[str, Any]:
    """
    Handle rejection of non-placement operations (SL/TP, pending modify/cancel, etc.).
    These don't require margin updates or Redis order status changes.
    """
    order_id = str(payload.get("order_id", ""))
    user_id_raw = payload.get("user_id")
    user_type_raw = payload.get("user_type")
    
    if user_id_raw is None or user_type_raw is None:
        logger.error("[REJECT:NON_PLACEMENT] Missing user info: user_type=%s user_id=%s order_id=%s", 
                    user_type_raw, user_id_raw, order_id)
        return {
            "order_id": order_id,
            "user_id": "unknown",
            "user_type": "unknown", 
            "rejection_type": rejection_type,
            "requires_margin_update": False
        }
        
    user_id = str(user_id_raw)
    user_type = str(user_type_raw)

    logger.info(
        "[REJECT:NON_PLACEMENT] order_id=%s rejection_type=%s user=%s:%s - no Redis updates needed",
        order_id, rejection_type, user_type, user_id
    )

    return {
        "order_id": order_id,
        "user_id": user_id,
        "user_type": user_type,
        "rejection_type": rejection_type,
        "requires_margin_update": False
    }


async def _recompute_used_margin_excluding(order_id: str, user_type: str, user_id: str) -> Tuple[Optional[float], Optional[float]]:
    """Recompute both executed and total margins excluding the rejected order.
    Returns (executed_margin, total_margin)
    """
    try:
        orders = await fetch_user_orders(user_type, user_id)
        # Exclude this order from the list before recompute
        filtered = [od for od in orders if str(od.get("order_id")) != str(order_id)]
        executed_margin, total_margin, _ = await compute_user_total_margin(
            user_type=user_type,
            user_id=user_id,
            orders=filtered,
            prices_cache=None,
            strict=False,
            include_queued=True,
        )
        return (
            float(executed_margin) if executed_margin is not None else None,
            float(total_margin) if total_margin is not None else None
        )
    except Exception:
        logger.exception("_recompute_used_margin_excluding failed")
        return None, None


class RejectWorker:
    def __init__(self):
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._queue: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None
        
        # Statistics tracking
        self._stats = {
            'start_time': time.time(),
            'processed_count': 0,
            'success_count': 0,
            'failure_count': 0,
            'placement_rejects': 0,
            'non_placement_rejects': 0,
            'margin_updates': 0,
            'last_stats_log': time.time()
        }

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        # Reduce prefetch for idle efficiency (was 64)
        await self._channel.set_qos(prefetch_count=1)
        self._queue = await self._channel.declare_queue(REJECT_QUEUE, durable=True)
        # ensure DB update queue exists
        await self._channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
        logger.info("RejectWorker connected. Waiting on %s", REJECT_QUEUE)

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

    async def _log_stats_if_needed(self):
        """Log statistics every 100 orders or 5 minutes - optimized for idle."""
        now = time.time()
        
        # Only check stats if we've processed messages or significant time passed
        if self._stats['processed_count'] == 0 and (now - self._stats['start_time']) < 300:
            return  # Skip stats logging for first 5 minutes when idle
            
        should_log = (
            self._stats['processed_count'] % 100 == 0 or
            (now - self._stats['last_stats_log']) >= 300
        )
        
        if should_log:
            uptime = now - self._stats['start_time']
            success_rate = (self._stats['success_count'] / max(1, self._stats['processed_count'])) * 100
            processing_rate = self._stats['processed_count'] / max(1, uptime / 60)  # per minute
            
            stats_data = {
                'processed_count': self._stats['processed_count'],
                'success_count': self._stats['success_count'],
                'failure_count': self._stats['failure_count'],
                'placement_rejects': self._stats['placement_rejects'],
                'non_placement_rejects': self._stats['non_placement_rejects'],
                'margin_updates': self._stats['margin_updates'],
                'success_rate': success_rate,
                'processing_rate_per_min': processing_rate,
                'uptime_minutes': uptime / 60
            }
            
            log_worker_stats(logger, 'worker_reject', stats_data)
            self._stats['last_stats_log'] = now

    async def handle(self, message: aio_pika.abc.AbstractIncomingMessage):
        start_time = time.time()
        order_id = "unknown"
        
        try:
            self._stats['processed_count'] += 1
            
            payload = orjson.loads(message.body)
            order_id = str(payload.get("order_id", ""))
            
            # Safely extract user_type and user_id, handle None values
            user_type_raw = payload.get("user_type")
            user_id_raw = payload.get("user_id")
            
            if user_type_raw is None or user_id_raw is None:
                logger.error("[REJECT:MISSING_USER_INFO] order_id=%s user_type=%s user_id=%s - skipping", 
                           order_id, user_type_raw, user_id_raw)
                await self._ack(message)
                return
                
            user_type = str(user_type_raw)
            user_id = str(user_id_raw)
            symbol = str(payload.get("symbol", "")).upper()

            # Check provider ord_status and ensure it's a rejection
            er = (payload.get("execution_report") or {})
            ord_status = str(er.get("ord_status") or (er.get("raw") or {}).get("39") or "").strip()
            if ord_status not in ("REJECTED", "8"):
                logger.warning("[REJECT:SKIP] order_id=%s ord_status=%s not REJECTED", order_id, ord_status)
                await self._ack(message)
                return

            # Extract provider order ID for rejection type detection
            provider_order_id = (
                payload.get("provider_order_id") or 
                er.get("exec_id") or 
                (er.get("raw") or {}).get("17") or
                ""
            )

            # Get Redis status as fallback for rejection type determination
            redis_status = ""
            order_data = {}
            try:
                order_data = await redis_cluster.hgetall(f"order_data:{order_id}")
                redis_status = str(order_data.get("status", "")).upper().strip()
                if not redis_status:
                    # Fallback to user holdings
                    hash_tag = f"{user_type}:{user_id}"
                    holdings_data = await redis_cluster.hget(f"user_holdings:{{{hash_tag}}}:{order_id}", "status")
                    redis_status = str(holdings_data or "").upper().strip()
            except Exception as e:
                logger.warning("[REJECT:REDIS_ERROR] order_id=%s error=%s", order_id, e)
                redis_status = "OPEN"  # Default fallback

            # Determine rejection type using lifecycle ID (primary) and Redis status (fallback)
            rejection_type = _determine_rejection_type(redis_status, provider_order_id)
            
            # Enhanced logging to show detection method
            detection_method = "lifecycle_id" if provider_order_id else "redis_status"
            logger.info(
                "[REJECT:TYPE_DETECTION] order_id=%s provider_order_id=%s redis_status=%s rejection_type=%s method=%s",
                order_id, provider_order_id, redis_status, rejection_type, detection_method
            )
            
            log_order_processing(
                logger, order_id, user_id, symbol, 'REJECT', 'PROCESSING',
                processing_time_ms=(time.time() - start_time) * 1000,
                additional_data={
                    'rejection_type': rejection_type, 
                    'redis_status': redis_status,
                    'provider_order_id': provider_order_id,
                    'detection_method': detection_method
                }
            )

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
                        logger.info("[REJECT:SKIP:IDEMPOTENT] order_id=%s idem=%s", order_id, idem)
                        await self._ack(message)
                        return
            except Exception:
                pass

            # Concurrency control per user (only for placement rejections that need margin updates)
            lock_key = None
            token = None
            if rejection_type == 'ORDER_PLACEMENT':
                lock_key = f"lock:user_margin:{user_type}:{user_id}"
                token = f"{os.getpid()}-{id(message)}"
                got_lock = await acquire_lock(lock_key, token, ttl_sec=8)
                if not got_lock:
                    logger.warning("Could not acquire lock %s; NACK and requeue", lock_key)
                    await self._nack(message, requeue=True)
                    return

            try:
                # Handle different rejection types
                if rejection_type == 'ORDER_PLACEMENT':
                    # Order placement rejection - update Redis and release margin
                    ctx = await _handle_placement_rejection(payload)
                    self._stats['placement_rejects'] += 1
                    
                    # Recompute used margin excluding this order
                    new_executed, new_total = await _recompute_used_margin_excluding(order_id, user_type, user_id)
                    portfolio_key = f"user_portfolio:{{{user_type}:{user_id}}}"
                    margin_updates = {}
                    if new_executed is not None:
                        margin_updates["used_margin_executed"] = str(float(new_executed))
                        margin_updates["used_margin"] = str(float(new_executed))  # Legacy field
                    if new_total is not None:
                        margin_updates["used_margin_all"] = str(float(new_total))
                    if margin_updates:
                        await redis_cluster.hset(portfolio_key, mapping=margin_updates)
                        self._stats['margin_updates'] += 1
                    
                    logger.info(
                        "[REJECT:PLACEMENT_UPDATED] order_id=%s new_executed_margin=%s new_total_margin=%s",
                        order_id,
                        (str(float(new_executed)) if new_executed is not None else None),
                        (str(float(new_total)) if new_total is not None else None),
                    )
                    
                    # Clean up symbol holders if no other orders for this symbol
                    try:
                        if symbol:
                            orders = await fetch_user_orders(user_type, user_id)
                            any_same_symbol = False
                            for od in orders:
                                if str(od.get("symbol")).upper() == symbol and str(od.get("order_id")) != order_id:
                                    any_same_symbol = True
                                    break
                            if not any_same_symbol:
                                sym_set = f"symbol_holders:{symbol}:{user_type}"
                                await redis_cluster.srem(sym_set, f"{user_type}:{user_id}")
                                symbol_logger.info(
                                    "[REJECT:SYMBOL_HOLDERS_REMOVE] user=%s:%s symbol=%s key=%s reason=%s",
                                    user_type,
                                    user_id,
                                    symbol,
                                    sym_set,
                                    "placement_rejected_no_other_orders",
                                )
                            else:
                                symbol_logger.info(
                                    "[REJECT:SYMBOL_HOLDERS_SKIP] user=%s:%s symbol=%s reason=%s",
                                    user_type,
                                    user_id,
                                    symbol,
                                    "other_open_orders_present",
                                )
                    except Exception:
                        logger.exception("[REJECT:SYMBOL_HOLDERS] cleanup failed")
                        
                else:
                    # Non-placement rejection - just log, no Redis updates needed
                    ctx = await _handle_non_placement_reject(payload, rejection_type)
                    self._stats['non_placement_rejects'] += 1

                # Create rejection record for database
                rejection_record = {
                    "type": "ORDER_REJECTION_RECORD",
                    "canonical_order_id": order_id,
                    "provider_order_id": payload.get("provider_order_id") or er.get("exec_id") or (er.get("raw") or {}).get("17"),
                    "user_id": int(user_id),
                    "user_type": user_type,
                    "symbol": symbol,
                    "rejection_type": rejection_type,
                    "redis_status": redis_status,
                    "provider_ord_status": ord_status,
                    "reason": er.get("reason") or (er.get("raw") or {}).get("58"),
                    "provider_exec_id": er.get("exec_id") or (er.get("raw") or {}).get("17"),
                    "provider_raw_data": er,
                    "order_type": order_data.get("order_type"),
                    "order_price": float(order_data.get("order_price", 0)) if order_data.get("order_price") else None,
                    "order_quantity": float(order_data.get("order_quantity", 0)) if order_data.get("order_quantity") else None,
                    "margin_released": float(order_data.get("margin", 0)) if order_data.get("margin") else None,
                }

                # Publish rejection record and DB update messages
                try:
                    # Rejection record for Node.js to insert into order_rejections table
                    rejection_msg = aio_pika.Message(
                        body=orjson.dumps(rejection_record), 
                        delivery_mode=aio_pika.DeliveryMode.PERSISTENT
                    )
                    await self._ex.publish(rejection_msg, routing_key=DB_UPDATE_QUEUE)
                    
                    # Only send ORDER_REJECTED DB update for placement rejections
                    if rejection_type == 'ORDER_PLACEMENT':
                        db_msg = {
                            "type": "ORDER_REJECTED",
                            "order_id": order_id,
                            "user_id": user_id,
                            "user_type": user_type,
                            "order_status": "REJECTED",
                            "provider": {
                                "exec_id": er.get("exec_id") or (er.get("raw") or {}).get("17"),
                                "reason": er.get("reason") or (er.get("raw") or {}).get("58"),
                                "ord_status": "REJECTED",
                            },
                        }
                        db_update_msg = aio_pika.Message(
                            body=orjson.dumps(db_msg), 
                            delivery_mode=aio_pika.DeliveryMode.PERSISTENT
                        )
                        await self._ex.publish(db_update_msg, routing_key=DB_UPDATE_QUEUE)
                        
                except Exception:
                    logger.exception("Failed to publish rejection messages")

                # Log success
                processing_time = (time.time() - start_time) * 1000
                log_order_processing(
                    logger, order_id, user_id, symbol, 'REJECT', 'SUCCESS',
                    processing_time_ms=processing_time,
                    additional_data={'rejection_type': rejection_type, 'redis_status': redis_status}
                )
                
                self._stats['success_count'] += 1
                
            finally:
                if lock_key and token:
                    await release_lock(lock_key, token)

            await self._ack(message)
            await self._log_stats_if_needed()
            
        except Exception as e:
            processing_time = (time.time() - start_time) * 1000
            error_logger.exception(
                "[REJECT:ERROR] order_id=%s processing_time=%.2fms error=%s",
                order_id, processing_time, str(e)
            )
            self._stats['failure_count'] += 1
            await self._nack(message, requeue=True)

    async def run(self):
        await self.connect()
        await self._queue.consume(self.handle, no_ack=False)
        logger.info("[REJECT:READY] Enhanced reject worker started")
        
        # Use event-driven approach instead of continuous loop
        try:
            # Wait indefinitely for shutdown signal
            shutdown_event = asyncio.Event()
            
            # Register signal handlers for graceful shutdown
            import signal
            def signal_handler():
                logger.info("[REJECT:SHUTDOWN] Received shutdown signal")
                shutdown_event.set()
            
            for sig in (signal.SIGTERM, signal.SIGINT):
                signal.signal(sig, lambda s, f: signal_handler())
            
            # Wait for shutdown event (no CPU consumption)
            await shutdown_event.wait()
            
        except KeyboardInterrupt:
            logger.info("[REJECT:SHUTDOWN] Keyboard interrupt received")
        finally:
            # Cleanup connections
            if self._conn and not self._conn.is_closed:
                await self._conn.close()
            logger.info("[REJECT:SHUTDOWN] Worker stopped gracefully")


async def main():
    w = RejectWorker()
    await w.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass


# ------------- Dedicated calculated orders file logger -------------
def _get_orders_calc_logger() -> logging.Logger:
    lg = logging.getLogger("orders.calculated")
    # Avoid duplicate handlers
    for h in lg.handlers:
        if isinstance(h, RotatingFileHandler) and getattr(h, "_orders_calc", False):
            return lg
    try:
        base_dir = Path(__file__).resolve().parents[3]
    except Exception:
        base_dir = Path('.')
    log_dir = base_dir / 'logs'
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / 'orders_calculated.log'
    fh = RotatingFileHandler(str(log_file), maxBytes=10_000_000, backupCount=5, encoding='utf-8')
    fh.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
    fh._orders_calc = True
    lg.addHandler(fh)
    lg.setLevel(logging.INFO)
    return lg


_ORDERS_CALC_LOG = _get_orders_calc_logger()
