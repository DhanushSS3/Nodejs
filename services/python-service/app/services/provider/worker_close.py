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
from app.services.orders.order_close_service import OrderCloser
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
            'finalize_retries': 0
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
            side_dbg = str(payload.get("order_type") or payload.get("side") or "").upper()
            
            logger.info(
                "[CLOSE:RECEIVED] order_id=%s ord_status=%s side=%s avgpx=%s",
                order_id_dbg, ord_status, side_dbg,
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
                    db_msg = {
                        "type": "ORDER_CLOSE_CONFIRMED",
                        "order_id": str(payload.get("order_id")),
                        "user_id": str(payload.get("user_id")),
                        "user_type": str(payload.get("user_type")),
                        "order_status": "CLOSED",
                        "close_price": result.get("close_price"),
                        "net_profit": result.get("net_profit"),
                        "commission": result.get("total_commission"),
                        "commission_entry": result.get("commission_entry"),
                        "commission_exit": result.get("commission_exit"),
                        "profit_usd": result.get("profit_usd"),
                        "swap": result.get("swap"),
                        "used_margin_executed": result.get("used_margin_executed"),
                        "used_margin_all": result.get("used_margin_all"),
                        "trigger_lifecycle_id": trigger_lifecycle_id,
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                    
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
                "[CLOSE:SUCCESS] order_id=%s processing_time=%.2fms total_closed=%d profit=%s",
                order_id_dbg, processing_time, self._stats['orders_closed'],
                result.get('net_profit') if 'result' in locals() else None
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
                "[CLOSE:STATS] processed=%d closed=%d failed=%d uptime=%.1fh rate=%.2f/s avg_time=%.2fms",
                stats['messages_processed'],
                stats['orders_closed'],
                stats['orders_failed'],
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
