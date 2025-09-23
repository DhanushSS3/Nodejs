import os
import asyncio
import logging
from typing import Optional
import time

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.services.orders.order_repository import fetch_user_config, fetch_group_data
from app.services.logging.provider_logger import (
    get_worker_takeprofit_logger,
    get_orders_calculated_logger,
    get_provider_errors_logger,
    log_provider_stats,
    log_order_processing,
    log_error_with_context
)

# Initialize dedicated loggers
logger = get_worker_takeprofit_logger()
calc_logger = get_orders_calculated_logger()
error_logger = get_provider_errors_logger()

# Keep basic logging for compatibility
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
TP_QUEUE = os.getenv("ORDER_WORKER_TAKEPROFIT_QUEUE", "order_worker_takeprofit_queue")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


class TakeProfitWorker:
    def __init__(self) -> None:
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._ch: Optional[aio_pika.abc.AbstractChannel] = None
        self._q: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None
        
        # Statistics tracking
        self._stats = {
            'start_time': time.time(),
            'messages_processed': 0,
            'takeprofit_confirmed': 0,
            'orders_failed': 0,
            'price_adjustments': 0,
            'redis_errors': 0,
            'db_publishes': 0,
            'last_message_time': None,
            'total_processing_time_ms': 0
        }

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._ch = await self._conn.channel()
        await self._ch.set_qos(prefetch_count=128)
        self._q = await self._ch.declare_queue(TP_QUEUE, durable=True)
        await self._ch.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._ch.default_exchange
        logger.info("[TAKEPROFIT:CONNECTED] Worker connected to %s", TP_QUEUE)

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
            user_type = str(payload.get("user_type"))
            user_id = str(payload.get("user_id"))
            symbol = str(payload.get("symbol") or "").upper()
            
            logger.info(
                "[TAKEPROFIT:RECEIVED] order_id=%s ord_status=%s user=%s:%s symbol=%s",
                order_id_dbg, ord_status, user_type, user_id, symbol
            )

            if ord_status not in ("PENDING", "0", "A"):
                logger.warning(
                    "[TAKEPROFIT:SKIP] order_id=%s ord_status=%s reason=not_pending", 
                    order_id_dbg, ord_status
                )
                await self._ack(message)
                return

            # Provider idempotency: skip duplicates based on token present in execution_report
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
                            "[TAKEPROFIT:SKIP] order_id=%s idem=%s reason=provider_idempotent", 
                            order_id_dbg, idem
                        )
                        await self._ack(message)
                        return
            except Exception:
                pass

            order_id = order_id_dbg
            side = str(payload.get("order_type") or payload.get("side") or "").upper()

            if not symbol or side not in ("BUY", "SELL"):
                try:
                    od = await redis_cluster.hgetall(f"order_data:{order_id}")
                    symbol = symbol or str(od.get("symbol") or "").upper()
                    side = side if side in ("BUY", "SELL") else str(od.get("order_type") or "").upper()
                    logger.debug(
                        "[TAKEPROFIT:FALLBACK] order_id=%s symbol=%s side=%s", 
                        order_id_dbg, symbol, side
                    )
                except Exception as e:
                    self._stats['redis_errors'] += 1
                    logger.warning(
                        "[TAKEPROFIT:FALLBACK_ERROR] order_id=%s error=%s", 
                        order_id_dbg, str(e)
                    )

            cfg = await fetch_user_config(user_type, user_id)
            group = cfg.get("group") or "Standard"
            g = await fetch_group_data(symbol, group)
            spread = _safe_float(g.get("spread")) or 0.0
            spread_pip = _safe_float(g.get("spread_pip")) or 0.0
            half_spread = float(spread * spread_pip / 2.0)

            avgpx = er.get("avgpx") or (er.get("raw") or {}).get("6")
            price = _safe_float(avgpx)
            if price is None:
                logger.warning(
                    "[TAKEPROFIT:SKIP] order_id=%s reason=missing_avgpx", 
                    order_id_dbg
                )
                await self._ack(message)
                return

            if side == "BUY":
                user_price = float(price - half_spread)
            else:
                user_price = float(price + half_spread)
            
            self._stats['price_adjustments'] += 1
            logger.debug(
                "[TAKEPROFIT:PRICE_ADJUST] order_id=%s side=%s provider_price=%s half_spread=%s user_price=%s",
                order_id_dbg, side, price, half_spread, user_price
            )

            try:
                await redis_cluster.hset(f"order_data:{order_id}", mapping={"take_profit": str(user_price)})
                logger.debug(
                    "[TAKEPROFIT:REDIS_UPDATED] order_id=%s canonical updated", 
                    order_id_dbg
                )
            except Exception as e:
                self._stats['redis_errors'] += 1
                logger.warning(
                    "[TAKEPROFIT:REDIS_ERROR] order_id=%s error=%s", 
                    order_id_dbg, str(e)
                )

            # Also reflect into user holdings for WS snapshots (do not change internal routing status)
            try:
                hash_tag = f"{user_type}:{user_id}"
                order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
                index_key = f"user_orders_index:{{{hash_tag}}}"
                pipe = redis_cluster.pipeline()
                # ensure index contains the order
                pipe.sadd(index_key, order_id)
                # write confirmed take_profit to holdings
                pipe.hset(order_key, mapping={"take_profit": str(user_price)})
                await pipe.execute()
                logger.debug(
                    "[TAKEPROFIT:USER_HOLDINGS_UPDATED] order_id=%s user=%s:%s", 
                    order_id_dbg, user_type, user_id
                )
            except Exception as e:
                self._stats['redis_errors'] += 1
                logger.warning(
                    "[TAKEPROFIT:USER_HOLDINGS_ERROR] order_id=%s error=%s", 
                    order_id_dbg, str(e)
                )

            try:
                self._stats['db_publishes'] += 1
                db_msg = {
                    "type": "ORDER_TAKEPROFIT_CONFIRMED",
                    "order_id": order_id,
                    "user_id": user_id,
                    "user_type": user_type,
                    "take_profit": user_price,
                }
                msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                logger.debug(
                    "[TAKEPROFIT:DB_PUBLISHED] order_id=%s queue=%s", 
                    order_id_dbg, DB_UPDATE_QUEUE
                )
            except Exception as e:
                error_logger.exception(
                    "[TAKEPROFIT:DB_PUBLISH_ERROR] order_id=%s error=%s", 
                    order_id_dbg, str(e)
                )

            # Log calculated order data
            try:
                calc = {
                    "type": "ORDER_TAKEPROFIT_CONFIRMED",
                    "order_id": order_id_dbg,
                    "user_type": user_type,
                    "user_id": user_id,
                    "symbol": symbol,
                    "side": side,
                    "provider_price": price,
                    "user_price": user_price,
                    "half_spread": half_spread,
                    "provider": {
                        "ord_status": ord_status,
                        "avgpx": avgpx,
                    },
                }
                calc_logger.info(orjson.dumps(calc).decode())
            except Exception:
                pass
            
            # Record successful processing
            processing_time = (time.time() - start_time) * 1000
            self._stats['takeprofit_confirmed'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            logger.info(
                "[TAKEPROFIT:SUCCESS] order_id=%s processing_time=%.2fms user_price=%s total_orders=%d",
                order_id_dbg, processing_time, user_price, self._stats['takeprofit_confirmed']
            )
            
            await self._ack(message)
        except Exception as e:
            processing_time = (time.time() - start_time) * 1000
            self._stats['orders_failed'] += 1
            self._stats['total_processing_time_ms'] += processing_time
            
            error_logger.exception(
                "[TAKEPROFIT:ERROR] order_id=%s processing_time=%.2fms error=%s",
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
                    (self._stats['takeprofit_confirmed'] / self._stats['messages_processed']) * 100
                    if self._stats['messages_processed'] > 0 else 0
                ),
                'avg_processing_time_ms': avg_processing_time
            }
            
            log_provider_stats('worker_takeprofit', stats)
            logger.info(
                "[TAKEPROFIT:STATS] processed=%d confirmed=%d failed=%d adjustments=%d uptime=%.1fh rate=%.2f/s avg_time=%.2fms",
                stats['messages_processed'],
                stats['takeprofit_confirmed'],
                stats['orders_failed'],
                stats['price_adjustments'],
                stats['uptime_hours'],
                stats['messages_per_second'],
                avg_processing_time
            )
        except Exception as e:
            logger.error("[TAKEPROFIT:STATS_ERROR] Failed to log stats: %s", e)

    async def run(self):
        logger.info("[TAKEPROFIT:STARTING] Worker initializing...")
        
        try:
            await self.connect()
            await self._q.consume(self.handle, no_ack=False)
            logger.info("[TAKEPROFIT:READY] Worker started consuming messages")
            
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
            error_logger.exception("[TAKEPROFIT:RUN_ERROR] Worker run error: %s", e)
            raise


async def main():
    w = TakeProfitWorker()
    try:
        logger.info("[TAKEPROFIT:MAIN] Starting takeprofit worker service...")
        await w.run()
    except KeyboardInterrupt:
        logger.info("[TAKEPROFIT:MAIN] Received keyboard interrupt, shutting down...")
    except Exception as e:
        error_logger.exception("[TAKEPROFIT:MAIN] Unhandled exception in main: %s", e)
    finally:
        # Log final stats
        try:
            await w._log_stats()
        except Exception:
            pass
        logger.info("[TAKEPROFIT:MAIN] Worker shutdown complete")


if __name__ == "__main__":
    try:
        logger.info("[TAKEPROFIT:APP] Starting takeprofit worker application...")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("[TAKEPROFIT:APP] Application interrupted by user")
    except Exception as e:
        error_logger.exception("[TAKEPROFIT:APP] Application failed: %s", e)
