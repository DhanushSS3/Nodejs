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
from app.services.pending.provider_pending_monitor import register_provider_pending
from app.services.logging.provider_logger import (
    get_worker_pending_logger,
    get_orders_calculated_logger,
    get_provider_errors_logger,
    log_provider_stats,
    log_order_processing,
    log_error_with_context
)

# Initialize dedicated loggers
logger = get_worker_pending_logger()
calc_logger = get_orders_calculated_logger()
error_logger = get_provider_errors_logger()

# Keep basic logging for compatibility
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
PENDING_QUEUE = os.getenv("ORDER_WORKER_PENDING_QUEUE", "order_worker_pending_queue")
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


async def _update_redis_for_pending(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    For a provider PENDING acknowledgement:
      - Update canonical order_data:{order_id} and user_holdings:{user_type:user_id}:{order_id}
        with order_status=PENDING, execution_status=PENDING, and provider fields
      - Ensure the order is present in the user's index set
    """
    order_id = str(payload.get("order_id"))
    user_id = str(payload.get("user_id"))
    user_type = str(payload.get("user_type"))

    report: Dict[str, Any] = payload.get("execution_report") or {}
    ord_status = report.get("ord_status") or (report.get("raw") or {}).get("39")
    exec_id = report.get("exec_id") or (report.get("raw") or {}).get("17")
    avspx = report.get("avgpx") or (report.get("raw") or {}).get("6")
    ts = report.get("ts")

    order_data_key = f"order_data:{order_id}"
    hash_tag = f"{user_type}:{user_id}"
    order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
    index_key = f"user_orders_index:{{{hash_tag}}}"

    mapping_common = {
        "order_status": "PENDING",
        "execution_status": "PENDING",
        "provider_ord_status": ord_status if ord_status is not None else "",
        "provider_exec_id": exec_id if exec_id is not None else "",
        "provider_avspx": avspx if avspx is not None else "",
        "provider_ts": str(ts) if ts is not None else "",
    }

    pipe = redis_cluster.pipeline()
    pipe.hset(order_data_key, mapping=mapping_common)
    pipe.hset(order_key, mapping=mapping_common)
    pipe.sadd(index_key, order_id)
    await pipe.execute()

    # If a pending modify price was staged by Node, apply it now and clear the staging fields
    modified_price: Optional[str] = None
    try:
        pget = redis_cluster.pipeline()
        pget.hget(order_data_key, "pending_modify_price_user")
        pget.hget(order_key, "pending_modify_price_user")
        vals = await pget.execute()
        pm_od = vals[0] if isinstance(vals, (list, tuple)) and len(vals) > 0 else None
        pm_hold = vals[1] if isinstance(vals, (list, tuple)) and len(vals) > 1 else None
        pm = pm_od or pm_hold
        if pm is not None:
            modified_price = str(pm)
            pset = redis_cluster.pipeline()
            pset.hset(order_data_key, "order_price", modified_price)
            pset.hset(order_key, "order_price", modified_price)
            pset.hdel(order_data_key, "pending_modify_price_user")
            pset.hdel(order_key, "pending_modify_price_user")
            await pset.execute()
    except Exception:
        logger.exception("Failed to apply pending modify price for %s", order_id)

    return {
        "order_id": order_id,
        "user_id": user_id,
        "user_type": user_type,
        "order_key": order_key,
        "order_data_key": order_data_key,
        "modified_price": modified_price,
    }


class PendingWorker:
    def __init__(self):
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._queue: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None
        
        # Statistics tracking
        self._stats = {
            'start_time': time.time(),
            'messages_processed': 0,
            'orders_pending': 0,
            'orders_modified': 0,
            'orders_failed': 0,
            'provider_registrations': 0,
            'redis_errors': 0,
            'db_publishes': 0,
            'last_message_time': None,
            'total_processing_time_ms': 0
        }

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=64)
        self._queue = await self._channel.declare_queue(PENDING_QUEUE, durable=True)
        # ensure DB update queue exists
        await self._channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
        logger.info("[PENDING:CONNECTED] Worker connected to %s", PENDING_QUEUE)

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
            er = payload.get("execution_report") or {}
            ord_status = str(er.get("ord_status") or (er.get("raw") or {}).get("39") or "").strip().upper()
            order_id_dbg = str(payload.get("order_id"))
            user_type = str(payload.get("user_type"))
            user_id = str(payload.get("user_id"))
            symbol = str(payload.get("symbol") or "").upper()
            order_type = str(payload.get("order_type") or "").upper()
            
            logger.info(
                "[PENDING:RECEIVED] order_id=%s ord_status=%s user=%s:%s symbol=%s type=%s",
                order_id_dbg, ord_status, user_type, user_id, symbol, order_type
            )

            if ord_status not in ("PENDING", "MODIFY"):
                logger.warning(
                    "[PENDING:SKIP] order_id=%s ord_status=%s reason=not_pending_or_modify", 
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
                        logger.info(
                            "[PENDING:SKIP] order_id=%s idem=%s reason=provider_idempotent", 
                            order_id_dbg, idem
                        )
                        await self._ack(message)
                        return
            except Exception:
                pass

            # Acquire per-user lock to avoid races with other workers
            lock_key = f"lock:user_margin:{user_type}:{user_id}"
            token = f"{os.getpid()}-{id(message)}"
            got_lock = await acquire_lock(lock_key, token, ttl_sec=8)
            if not got_lock:
                logger.warning(
                    "[PENDING:LOCK_FAILED] order_id=%s lock_key=%s", 
                    order_id_dbg, lock_key
                )
                await self._nack(message, requeue=True)
                return

            try:
                # Step 1: mark order PENDING in Redis and persist provider fields
                ctx = await _update_redis_for_pending(payload)
                logger.debug(
                    "[PENDING:REDIS_UPDATED] order_id=%s modified_price=%s", 
                    order_id_dbg, ctx.get('modified_price')
                )

                # Step 2: register for provider pending monitoring (starts cancel-on-insufficient-margin loop)
                try:
                    self._stats['provider_registrations'] += 1
                    info = {
                        "order_id": order_id_dbg,
                        "symbol": symbol,
                        "order_type": order_type,
                        "order_quantity": payload.get("order_quantity"),
                        "user_id": user_id,
                        "user_type": user_type,
                        "group": str(payload.get("group") or "Standard"),
                    }
                    await register_provider_pending(info)
                    logger.debug(
                        "[PENDING:REGISTERED] order_id=%s for monitoring", 
                        order_id_dbg
                    )
                except Exception as e:
                    error_logger.exception(
                        "[PENDING:REGISTER_ERROR] order_id=%s error=%s", 
                        order_id_dbg, str(e)
                    )

                # Step 3: publish DB update to flip SQL status to PENDING
                try:
                    self._stats['db_publishes'] += 1
                    db_msg = {
                        "type": "ORDER_PENDING_CONFIRMED",
                        "order_id": order_id_dbg,
                        "user_id": user_id,
                        "user_type": user_type,
                        "order_status": "PENDING",
                    }
                    # Include updated order_price if a modify was applied
                    try:
                        mod_px = ctx.get("modified_price")
                        if mod_px is not None:
                            db_msg["order_price"] = str(mod_px)
                            self._stats['orders_modified'] += 1
                    except Exception:
                        pass
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                    logger.debug(
                        "[PENDING:DB_PUBLISHED] order_id=%s queue=%s", 
                        order_id_dbg, DB_UPDATE_QUEUE
                    )
                except Exception as e:
                    error_logger.exception(
                        "[PENDING:DB_PUBLISH_ERROR] order_id=%s error=%s", 
                        order_id_dbg, str(e)
                    )

                # Step 4: log calculated/context info
                try:
                    calc = {
                        "type": "ORDER_PENDING_CONFIRMED",
                        "order_id": order_id_dbg,
                        "user_type": user_type,
                        "user_id": user_id,
                        "symbol": symbol,
                        "order_type": order_type,
                        "order_quantity": payload.get("order_quantity"),
                        "modified_price": ctx.get("modified_price"),
                        "provider": {
                            "ord_status": ord_status,
                            "avgpx": er.get("avgpx") or (er.get("raw") or {}).get("6"),
                            "exec_id": er.get("exec_id") or (er.get("raw") or {}).get("17"),
                        },
                    }
                    _ORDERS_CALC_LOG.info(orjson.dumps(calc).decode())
                except Exception:
                    pass
            finally:
                await release_lock(lock_key, token)

            # Record successful processing
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_pending'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            logger.info(
                "[PENDING:SUCCESS] order_id=%s processing_time=%.2fms total_orders=%d",
                order_id_dbg, processing_time, self._stats['orders_pending']
            )
            
            await self._ack(message)
        except Exception as e:
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_failed'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            error_logger.exception(
                "[PENDING:ERROR] order_id=%s processing_time=%.2fms error=%s",
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
                    (self._stats['orders_pending'] / self._stats['messages_processed']) * 100
                    if self._stats['messages_processed'] > 0 else 0
                ),
                'avg_processing_time_ms': avg_processing_time
            }
            
            log_provider_stats('worker_pending', stats)
            logger.info(
                "[PENDING:STATS] processed=%d pending=%d modified=%d failed=%d uptime=%.1fh rate=%.2f/s avg_time=%.2fms",
                stats['messages_processed'],
                stats['orders_pending'],
                stats['orders_modified'],
                stats['orders_failed'],
                stats['uptime_hours'],
                stats['messages_per_second'],
                avg_processing_time
            )
        except Exception as e:
            logger.error("[PENDING:STATS_ERROR] Failed to log stats: %s", e)

    async def run(self):
        logger.info("[PENDING:STARTING] Worker initializing...")
        
        try:
            await self.connect()
            await self._queue.consume(self.handle, no_ack=False)
            logger.info("[PENDING:READY] Worker started consuming messages")
            
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
            error_logger.exception("[PENDING:RUN_ERROR] Worker run error: %s", e)
            raise


async def main():
    w = PendingWorker()
    try:
        logger.info("[PENDING:MAIN] Starting pending worker service...")
        await w.run()
    except KeyboardInterrupt:
        logger.info("[PENDING:MAIN] Received keyboard interrupt, shutting down...")
    except Exception as e:
        error_logger.exception("[PENDING:MAIN] Unhandled exception in main: %s", e)
    finally:
        # Log final stats
        try:
            await w._log_stats()
        except Exception:
            pass
        logger.info("[PENDING:MAIN] Worker shutdown complete")


if __name__ == "__main__":
    try:
        logger.info("[PENDING:APP] Starting pending worker application...")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("[PENDING:APP] Application interrupted by user")
    except Exception as e:
        error_logger.exception("[PENDING:APP] Application failed: %s", e)
