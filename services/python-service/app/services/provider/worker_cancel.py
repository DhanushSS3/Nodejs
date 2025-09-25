import os
import asyncio
import logging
from typing import Optional
import time

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.services.orders.sl_tp_repository import remove_stoploss_trigger, remove_takeprofit_trigger
from app.services.logging.provider_logger import (
    get_worker_cancel_logger,
    get_orders_calculated_logger,
    get_provider_errors_logger,
    log_provider_stats,
    log_order_processing,
    log_error_with_context
)

# Initialize dedicated loggers
logger = get_worker_cancel_logger()
calc_logger = get_orders_calculated_logger()
error_logger = get_provider_errors_logger()

# Keep basic logging for compatibility
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
CANCEL_QUEUE = os.getenv("ORDER_WORKER_CANCEL_QUEUE", "order_worker_cancel_queue")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")


class CancelWorker:
    def __init__(self) -> None:
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._ch: Optional[aio_pika.abc.AbstractChannel] = None
        self._q: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None
        
        # Statistics tracking
        self._stats = {
            'start_time': time.time(),
            'messages_processed': 0,
            'orders_cancelled': 0,
            'orders_failed': 0,
            'sl_cancels': 0,
            'tp_cancels': 0,
            'pending_cancels': 0,
            'redis_errors': 0,
            'db_publishes': 0,
            'last_message_time': None,
            'total_processing_time_ms': 0
        }

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._ch = await self._conn.channel()
        await self._ch.set_qos(prefetch_count=256)
        self._q = await self._ch.declare_queue(CANCEL_QUEUE, durable=True)
        await self._ch.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._ch.default_exchange
        logger.info("[CANCEL:CONNECTED] Worker connected to %s", CANCEL_QUEUE)

    async def _ack(self, m: aio_pika.abc.AbstractIncomingMessage):
        try:
            await m.ack()
        except Exception:
            logger.exception("ack failed")

    async def _nack(self, m: aio_pika.abc.AbstractIncomingMessage, requeue: bool = True):
        try:
            await m.nack(requeue=requeue)
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
            order_id = order_id_dbg  # Initialize order_id with the debug value
            
            logger.info(
                "[CANCEL:RECEIVED] order_id=%s ord_status=%s keys=%s", 
                order_id_dbg, ord_status, list(payload.keys())
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
                        logger.info(
                            "[CANCEL:SKIP] order_id=%s idem=%s reason=provider_idempotent", 
                            order_id_dbg, idem
                        )
                        await self._ack(message)
                        return
            except Exception:
                pass

            # Inspect current engine/UI routing status to decide finalization path
            try:
                od = await redis_cluster.hgetall(f"order_data:{order_id}")
            except Exception:
                od = {}

            # If no canonical record found (dispatcher may have fallen back to lifecycle_id), try resolving now
            if not od:
                try:
                    lifecycle_id = str(er.get("order_id") or (er.get("raw") or {}).get("11") or "")
                    if lifecycle_id:
                        canon = await redis_cluster.get(f"global_order_lookup:{lifecycle_id}")
                        if canon and canon != order_id:
                            order_id = str(canon)
                            od = await redis_cluster.hgetall(f"order_data:{order_id}") or {}
                except Exception:
                    pass

            redis_status = str(od.get("status") or od.get("order_status") or "").upper()
            logger.info("[CANCEL:REDIS_STATUS] order_id=%s redis_status=%s", order_id_dbg, redis_status)

            # Accept rules:
            # - For PENDING-CANCEL, accept ord_status in (CANCELLED/CANCELED/PENDING/MODIFY)
            # - Otherwise (SL/TP cancels), accept only CANCELLED/CANCELED
            if redis_status == "PENDING-CANCEL":
                if ord_status not in ("CANCELLED", "CANCELED", "PENDING", "MODIFY"):
                    await self._ack(message)
                    return
            else:
                if ord_status not in ("CANCELLED", "CANCELED"):
                    await self._ack(message)
                    return
            user_type = str(od.get("user_type") or payload.get("user_type") or "")
            user_id = str(od.get("user_id") or payload.get("user_id") or "")
            symbol = str(od.get("symbol") or payload.get("symbol") or "").upper()
            side = str(od.get("order_type") or payload.get("order_type") or payload.get("side") or "").upper()

            # Check if this is a modify-related cancel (no cancel_id in order_data)
            # These should be ignored as they're part of the modify flow
            has_cancel_id = bool(od.get("cancel_id") or od.get("stoploss_cancel_id") or od.get("takeprofit_cancel_id"))
            if ord_status in ("CANCELLED", "CANCELED") and not has_cancel_id:
                logger.info(
                    "[CANCEL:IGNORE_MODIFY] order_id=%s ord_status=%s reason=no_cancel_id_modify_flow", 
                    order_id_dbg, ord_status
                )
                await self._ack(message)
                return

            # Determine cancel kind robustly to avoid race with status write
            lifecycle_id = str(er.get("order_id") or (er.get("raw") or {}).get("11") or "")
            cancel_kind = None
            try:
                if od:
                    tp_cid = str(od.get("takeprofit_cancel_id") or "")
                    sl_cid = str(od.get("stoploss_cancel_id") or "")
                    pc_cid = str(od.get("cancel_id") or "")
                    if lifecycle_id and tp_cid and lifecycle_id == tp_cid:
                        cancel_kind = "TP"
                    elif lifecycle_id and sl_cid and lifecycle_id == sl_cid:
                        cancel_kind = "SL"
                    elif lifecycle_id and pc_cid and lifecycle_id == pc_cid:
                        cancel_kind = "PENDING"
            except Exception:
                pass
            if not cancel_kind:
                if redis_status == "STOPLOSS-CANCEL":
                    cancel_kind = "SL"
                elif redis_status == "TAKEPROFIT-CANCEL":
                    cancel_kind = "TP"
                elif redis_status == "PENDING-CANCEL":
                    cancel_kind = "PENDING"
                # Fallback per spec: if provider reports CANCELLED and order status is one of MODIFY/PENDING/CANCELLED,
                # treat this as a pending order cancel even without cancel_id match
                elif ord_status in ("CANCELLED", "CANCELED") and redis_status in ("MODIFY", "PENDING", "CANCELLED"):
                    cancel_kind = "PENDING"
                # Enhanced fallback: infer cancel type from lifecycle_id prefix when Redis status is empty
                elif not redis_status and lifecycle_id:
                    if lifecycle_id.startswith("SLC"):
                        cancel_kind = "SL"
                        logger.info("[CANCEL:INFERRED] order_id=%s inferred_type=SL from lifecycle_id=%s", order_id_dbg, lifecycle_id)
                    elif lifecycle_id.startswith("TPC"):
                        cancel_kind = "TP"
                        logger.info("[CANCEL:INFERRED] order_id=%s inferred_type=TP from lifecycle_id=%s", order_id_dbg, lifecycle_id)
                    elif lifecycle_id.startswith("PC"):
                        cancel_kind = "PENDING"
                        logger.info("[CANCEL:INFERRED] order_id=%s inferred_type=PENDING from lifecycle_id=%s", order_id_dbg, lifecycle_id)
                # Additional fallback: check if order has SL/TP fields in Redis
                elif not redis_status and od:
                    has_sl = bool(od.get("stop_loss") or od.get("stoploss_price"))
                    has_tp = bool(od.get("take_profit") or od.get("takeprofit_price"))
                    if has_sl and not has_tp:
                        cancel_kind = "SL"
                        logger.info("[CANCEL:INFERRED] order_id=%s inferred_type=SL from Redis SL fields", order_id_dbg)
                    elif has_tp and not has_sl:
                        cancel_kind = "TP"
                        logger.info("[CANCEL:INFERRED] order_id=%s inferred_type=TP from Redis TP fields", order_id_dbg)
            logger.info("[CANCEL:RESOLVED] order_id=%s cancel_kind=%s", order_id_dbg, cancel_kind)

            if cancel_kind == "SL":
                # Provider idempotency handled earlier; proceed to finalize SL cancel
                # Remove only SL trigger and set OPEN
                try:
                    await remove_stoploss_trigger(order_id)
                except Exception:
                    pass
                try:
                    order_data_key = f"order_data:{order_id}"
                    order_key = f"user_holdings:{{{user_type}:{user_id}}}:{order_id}"
                    pipe = redis_cluster.pipeline()
                    pipe.hdel(order_data_key, "stop_loss")
                    pipe.hdel(order_key, "stop_loss")
                    if symbol and side:
                        pipe.hset(order_data_key, mapping={"status": "OPEN", "symbol": symbol, "order_type": side})
                    else:
                        pipe.hset(order_data_key, mapping={"status": "OPEN"})
                    pipe.hset(order_key, mapping={"status": "OPEN"})
                    await pipe.execute()
                except Exception:
                    pass
                # Publish DB update intent
                try:
                    db_msg = {
                        "type": "ORDER_STOPLOSS_CANCEL",
                        "order_id": order_id,
                        "user_id": user_id,
                        "user_type": user_type,
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB update for stoploss cancel finalize")
                
                self._stats['sl_cancels'] += 1
                self._stats['db_publishes'] += 1
                
                # Record successful processing
                processing_time = (time.time() - start_time) * 1000
                self._stats['orders_cancelled'] += 1
                self._stats['total_processing_time_ms'] += processing_time
                
                logger.info(
                    "[CANCEL:SL_SUCCESS] order_id=%s processing_time=%.2fms",
                    order_id_dbg, processing_time
                )
                
                await self._ack(message)
                return

            if cancel_kind == "TP":
                # Provider idempotency handled earlier; proceed to finalize TP cancel
                try:
                    await remove_takeprofit_trigger(order_id)
                except Exception:
                    pass
                try:
                    order_data_key = f"order_data:{order_id}"
                    order_key = f"user_holdings:{{{user_type}:{user_id}}}:{order_id}"
                    pipe = redis_cluster.pipeline()
                    pipe.hdel(order_data_key, "take_profit")
                    pipe.hdel(order_key, "take_profit")
                    if symbol and side:
                        pipe.hset(order_data_key, mapping={"status": "OPEN", "symbol": symbol, "order_type": side})
                    else:
                        pipe.hset(order_data_key, mapping={"status": "OPEN"})
                    pipe.hset(order_key, mapping={"status": "OPEN"})
                    await pipe.execute()
                except Exception:
                    pass
                try:
                    db_msg = {
                        "type": "ORDER_TAKEPROFIT_CANCEL",
                        "order_id": order_id,
                        "user_id": user_id,
                        "user_type": user_type,
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB update for takeprofit cancel finalize")
                
                self._stats['tp_cancels'] += 1
                self._stats['db_publishes'] += 1
                
                # Record successful processing
                processing_time = (time.time() - start_time) * 1000
                self._stats['orders_cancelled'] += 1
                self._stats['total_processing_time_ms'] += processing_time
                
                logger.info(
                    "[CANCEL:TP_SUCCESS] order_id=%s processing_time=%.2fms",
                    order_id_dbg, processing_time
                )
                
                await self._ack(message)
                return

            if cancel_kind == "PENDING":
                # Finalize pending order cancellation: remove monitoring + holdings + canonical
                symbol = str(od.get("symbol") or payload.get("symbol") or "").upper()
                order_type = str(od.get("order_type") or payload.get("order_type") or "").upper()
                try:
                    if symbol and order_type:
                        try:
                            await redis_cluster.zrem(f"pending_index:{{{symbol}}}:{order_type}", order_id)
                        except Exception:
                            pass
                        try:
                            await redis_cluster.delete(f"pending_orders:{order_id}")
                        except Exception:
                            pass
                except Exception:
                    logger.exception("Pending cancel: failed to remove monitoring keys for %s", order_id)
                try:
                    hash_tag = f"{user_type}:{user_id}"
                    index_key = f"user_orders_index:{{{hash_tag}}}"
                    order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
                    pipe = redis_cluster.pipeline()
                    pipe.srem(index_key, order_id)
                    pipe.delete(order_key)
                    pipe.delete(f"order_data:{order_id}")
                    await pipe.execute()
                except Exception:
                    logger.exception("Pending cancel: failed to remove holdings/canonical for %s", order_id)
                # Publish DB update intent for pending cancel
                try:
                    db_msg = {
                        "type": "ORDER_PENDING_CANCEL",
                        "order_id": order_id,
                        "user_id": user_id,
                        "user_type": user_type,
                        "order_status": "CANCELLED",
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB update for pending cancel finalize")
                
                self._stats['pending_cancels'] += 1
                self._stats['db_publishes'] += 1
                
                # Record successful processing
                processing_time = (time.time() - start_time) * 1000
                self._stats['orders_cancelled'] += 1
                self._stats['total_processing_time_ms'] += processing_time
                
                logger.info(
                    "[CANCEL:PENDING_SUCCESS] order_id=%s processing_time=%.2fms",
                    order_id_dbg, processing_time
                )
                
                await self._ack(message)
                return

            # If the current redis_status isn't a cancel state, we can't finalize
            logger.warning(
                "[CANCEL:UNMAPPED] order_id=%s redis_status=%s reason=unknown_cancel_state", 
                order_id_dbg, redis_status
            )
            
            # Record successful processing
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_cancelled'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            logger.info(
                "[CANCEL:SUCCESS] order_id=%s processing_time=%.2fms total_orders=%d",
                order_id_dbg, processing_time, self._stats['orders_cancelled']
            )
            
            await self._ack(message)
        except Exception as e:
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_failed'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            error_logger.exception(
                "[CANCEL:ERROR] order_id=%s processing_time=%.2fms error=%s",
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
                    (self._stats['orders_cancelled'] / self._stats['messages_processed']) * 100
                    if self._stats['messages_processed'] > 0 else 0
                ),
                'avg_processing_time_ms': avg_processing_time
            }
            
            log_provider_stats('worker_cancel', stats)
            logger.info(
                "[CANCEL:STATS] processed=%d cancelled=%d sl=%d tp=%d pending=%d failed=%d uptime=%.1fh rate=%.2f/s avg_time=%.2fms",
                stats['messages_processed'],
                stats['orders_cancelled'],
                stats['sl_cancels'],
                stats['tp_cancels'],
                stats['pending_cancels'],
                stats['orders_failed'],
                stats['uptime_hours'],
                stats['messages_per_second'],
                avg_processing_time
            )
        except Exception as e:
            logger.error("[CANCEL:STATS_ERROR] Failed to log stats: %s", e)

    async def run(self):
        logger.info("[CANCEL:STARTING] Worker initializing...")
        
        try:
            await self.connect()
            await self._q.consume(self.handle, no_ack=False)
            logger.info("[CANCEL:READY] Worker started consuming messages")
            
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
            error_logger.exception("[CANCEL:RUN_ERROR] Worker run error: %s", e)
            raise


async def main():
    w = CancelWorker()
    try:
        logger.info("[CANCEL:MAIN] Starting cancel worker service...")
        await w.run()
    except KeyboardInterrupt:
        logger.info("[CANCEL:MAIN] Received keyboard interrupt, shutting down...")
    except Exception as e:
        error_logger.exception("[CANCEL:MAIN] Unhandled exception in main: %s", e)
    finally:
        # Log final stats
        try:
            await w._log_stats()
        except Exception:
            pass
        logger.info("[CANCEL:MAIN] Worker shutdown complete")


if __name__ == "__main__":
    try:
        logger.info("[CANCEL:APP] Starting cancel worker application...")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("[CANCEL:APP] Application interrupted by user")
    except Exception as e:
        error_logger.exception("[CANCEL:APP] Application failed: %s", e)
