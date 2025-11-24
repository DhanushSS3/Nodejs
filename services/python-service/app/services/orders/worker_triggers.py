import os
import asyncio
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, List, Optional

import aio_pika
import orjson
from redis.exceptions import ResponseError

from app.config.redis_config import redis_cluster
from app.config.redis_logging import (
    log_connection_acquire, log_connection_release, log_connection_error,
    log_pipeline_operation, connection_tracker, generate_operation_id
)
from app.services.orders.order_close_service import OrderCloser

logger = logging.getLogger(__name__)
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")

TICK_MS = int(os.getenv("TRIGGER_MONITOR_TICK_MS", "150"))
BATCH = int(os.getenv("TRIGGER_MONITOR_BATCH", "100"))


def _sl_key(symbol: str, side: str) -> str:
    return f"sl_index:{{{symbol}}}:{side}"


def _tp_key(symbol: str, side: str) -> str:
    return f"tp_index:{{{symbol}}}:{side}"


def _get_orders_calc_logger() -> logging.Logger:
    lg = logging.getLogger("orders.calculated")
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


class TriggerMonitor:
    def __init__(self) -> None:
        self._closer = OrderCloser()
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._ch: Optional[aio_pika.abc.AbstractChannel] = None
        self._ex = None

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._ch = await self._conn.channel()
        await self._ch.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._ch.default_exchange
        logger.info("TriggerMonitor connected to RabbitMQ")

    async def _publish_db_update(self, msg: dict):
        try:
            amsg = aio_pika.Message(body=orjson.dumps(msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
            await self._ex.publish(amsg, routing_key=DB_UPDATE_QUEUE)
        except Exception:
            logger.exception("Failed to publish DB update from TriggerMonitor")

    async def _fetch_market(self, symbol: str):
        operation_id = generate_operation_id()
        connection_tracker.start_operation(operation_id, "cluster", f"fetch_market_{symbol}")
        log_connection_acquire("cluster", f"fetch_market_{symbol}", operation_id)
        
        try:
            vals = await redis_cluster.hmget(f"market:{symbol}", ["bid", "ask"])  # [bid, ask]
            log_connection_release("cluster", f"fetch_market_{symbol}", operation_id)
            connection_tracker.end_operation(operation_id, success=True)
            
            bid = float(vals[0]) if vals and vals[0] is not None else None
            ask = float(vals[1]) if vals and vals[1] is not None else None
            return bid, ask
        except Exception as e:
            log_connection_error("cluster", f"fetch_market_{symbol}", str(e), operation_id)
            connection_tracker.end_operation(operation_id, success=False, error=str(e))
            return None, None

    async def _scan_and_trigger(self, symbol: str, side: str, bid: Optional[float], ask: Optional[float]):
        side = side.upper()
        if side not in ("BUY", "SELL"):
            return
        # Determine queries per rule with connection tracking
        try:
            if side == "BUY":
                # SL: trigger when bid <= compare -> zrangebyscore [bid, +inf)
                # TP: trigger when bid >= compare -> zrangebyscore (-inf, bid]
                if bid is not None:
                    # SL query with connection tracking
                    sl_operation_id = generate_operation_id()
                    connection_tracker.start_operation(sl_operation_id, "cluster", f"sl_scan_{symbol}_{side}")
                    log_connection_acquire("cluster", f"sl_scan_{symbol}_{side}", sl_operation_id)
                    
                    try:
                        sl_ids = await redis_cluster.zrangebyscore(_sl_key(symbol, side), min=bid, max="+inf", start=0, num=BATCH)
                        log_connection_release("cluster", f"sl_scan_{symbol}_{side}", sl_operation_id)
                        connection_tracker.end_operation(sl_operation_id, success=True)
                    except Exception as e:
                        log_connection_error("cluster", f"sl_scan_{symbol}_{side}", str(e), sl_operation_id)
                        connection_tracker.end_operation(sl_operation_id, success=False, error=str(e))
                        raise
                    
                    # TP query with connection tracking
                    tp_operation_id = generate_operation_id()
                    connection_tracker.start_operation(tp_operation_id, "cluster", f"tp_scan_{symbol}_{side}")
                    log_connection_acquire("cluster", f"tp_scan_{symbol}_{side}", tp_operation_id)
                    
                    try:
                        tp_ids = await redis_cluster.zrangebyscore(_tp_key(symbol, side), min="-inf", max=bid, start=0, num=BATCH)
                        log_connection_release("cluster", f"tp_scan_{symbol}_{side}", tp_operation_id)
                        connection_tracker.end_operation(tp_operation_id, success=True)
                    except Exception as e:
                        log_connection_error("cluster", f"tp_scan_{symbol}_{side}", str(e), tp_operation_id)
                        connection_tracker.end_operation(tp_operation_id, success=False, error=str(e))
                        raise
                else:
                    sl_ids, tp_ids = [], []
            else:
                # SELL
                # SL: trigger when ask >= compare -> zrangebyscore (-inf, ask]
                # TP: trigger when ask <= compare -> zrangebyscore [ask, +inf)
                if ask is not None:
                    # SL query with connection tracking
                    sl_operation_id = generate_operation_id()
                    connection_tracker.start_operation(sl_operation_id, "cluster", f"sl_scan_{symbol}_{side}")
                    log_connection_acquire("cluster", f"sl_scan_{symbol}_{side}", sl_operation_id)
                    
                    try:
                        sl_ids = await redis_cluster.zrangebyscore(_sl_key(symbol, side), min="-inf", max=ask, start=0, num=BATCH)
                        log_connection_release("cluster", f"sl_scan_{symbol}_{side}", sl_operation_id)
                        connection_tracker.end_operation(sl_operation_id, success=True)
                    except Exception as e:
                        log_connection_error("cluster", f"sl_scan_{symbol}_{side}", str(e), sl_operation_id)
                        connection_tracker.end_operation(sl_operation_id, success=False, error=str(e))
                        raise
                    
                    # TP query with connection tracking
                    tp_operation_id = generate_operation_id()
                    connection_tracker.start_operation(tp_operation_id, "cluster", f"tp_scan_{symbol}_{side}")
                    log_connection_acquire("cluster", f"tp_scan_{symbol}_{side}", tp_operation_id)
                    
                    try:
                        tp_ids = await redis_cluster.zrangebyscore(_tp_key(symbol, side), min=ask, max="+inf", start=0, num=BATCH)
                        log_connection_release("cluster", f"tp_scan_{symbol}_{side}", tp_operation_id)
                        connection_tracker.end_operation(tp_operation_id, success=True)
                    except Exception as e:
                        log_connection_error("cluster", f"tp_scan_{symbol}_{side}", str(e), tp_operation_id)
                        connection_tracker.end_operation(tp_operation_id, success=False, error=str(e))
                        raise
                else:
                    sl_ids, tp_ids = [], []
        except Exception as e:
            logger.warning("zrangebyscore failed for %s/%s: %s", symbol, side, e)
            sl_ids, tp_ids = [], []

        # Track trigger types for each order_id (preserve differentiation)
        trigger_info = {}  # order_id -> 'stoploss' or 'takeprofit'
        
        # Process SL triggers first (priority to SL)
        for order_id in (sl_ids or []):
            trigger_info[order_id] = 'stoploss'
        
        # Process TP triggers (won't override SL if same order_id)
        for order_id in (tp_ids or []):
            if order_id not in trigger_info:
                trigger_info[order_id] = 'takeprofit'
        
        if not trigger_info:
            return

        for order_id, trigger_type in trigger_info.items():
            # Guard against duplicates
            processing_key = f"close_processing:{order_id}"
            try:
                ok = await redis_cluster.set(processing_key, "1", ex=15, nx=True)
            except Exception:
                ok = True
            if not ok:
                continue

            # Load trigger doc
            trig = await redis_cluster.hgetall(f"order_triggers:{order_id}")
            if not trig:
                try:
                    await redis_cluster.delete(processing_key)
                except Exception:
                    pass
                continue

            try:
                user_type = str(trig.get("user_type"))
                user_id = str(trig.get("user_id"))
                otype = str(trig.get("order_type"))
                sym = str(trig.get("symbol"))
                
                # Retrieve lifecycle IDs from canonical order data
                trigger_lifecycle_id = None
                close_message = None
                try:
                    order_data = await redis_cluster.hgetall(f"order_data:{order_id}")
                    
                    # Debug: Log what's actually in order_data
                    logger.info("[TRIGGER:DEBUG_ORDER_DATA] order_id=%s keys=%s", order_id, list(order_data.keys()) if order_data else "None")
                    
                    if trigger_type == 'stoploss':
                        trigger_lifecycle_id = order_data.get("stoploss_id")
                        close_message = "Stoploss"
                        logger.info("[TRIGGER:DEBUG_SL] order_id=%s stoploss_id=%s", order_id, trigger_lifecycle_id)
                    elif trigger_type == 'takeprofit':
                        trigger_lifecycle_id = order_data.get("takeprofit_id") 
                        close_message = "Takeprofit"
                        logger.info("[TRIGGER:DEBUG_TP] order_id=%s takeprofit_id=%s", order_id, trigger_lifecycle_id)
                    
                    # If lifecycle ID not found in order_data, use trigger type directly
                    if not trigger_lifecycle_id:
                        logger.info("[TRIGGER:USING_TRIGGER_TYPE] order_id=%s trigger_type=%s - using trigger type for close_message", order_id, trigger_type)
                        
                        # Since we know the trigger type from our Redis query differentiation,
                        # we can set the correct close_message even without the lifecycle ID
                        if trigger_type == 'stoploss':
                            close_message = "Stoploss"
                            # Use a synthetic trigger ID for Node.js matching
                            trigger_lifecycle_id = f"trigger_stoploss_{order_id}"
                            logger.info("[TRIGGER:SYNTHETIC_SL] order_id=%s close_message=%s synthetic_id=%s", order_id, close_message, trigger_lifecycle_id)
                        elif trigger_type == 'takeprofit':
                            close_message = "Takeprofit"
                            # Use a synthetic trigger ID for Node.js matching
                            trigger_lifecycle_id = f"trigger_takeprofit_{order_id}"
                            logger.info("[TRIGGER:SYNTHETIC_TP] order_id=%s close_message=%s synthetic_id=%s", order_id, close_message, trigger_lifecycle_id)
                        else:
                            close_message = "Stoploss/Takeprofit"
                            trigger_lifecycle_id = f"trigger_unknown_{order_id}"
                        
                except Exception as e:
                    logger.warning("[TRIGGER:LIFECYCLE_ID_ERROR] order_id=%s error=%s", order_id, e)
                    close_message = "Stoploss/Takeprofit"
                payload = {
                    "symbol": sym,
                    "order_type": otype,
                    "user_id": user_id,
                    "user_type": user_type,
                    "order_id": order_id,
                    "status": "CLOSED",
                    "order_status": "CLOSED",
                    # Provide explicit reason so OrderCloser can propagate accurate close messages
                    "close_reason": close_message,
                    # Allow downstream systems to identify the exact trigger lifecycle id
                    "trigger_lifecycle_id": trigger_lifecycle_id,
                }
                result = await self._closer.close_order(payload)
                if not result.get("ok"):
                    logger.error("[TRIGGER:close_failed] order_id=%s reason=%s", order_id, result.get("reason"))
                    # allow retry later
                    try:
                        await redis_cluster.delete(processing_key)
                    except Exception:
                        pass
                    continue

                # Log and publish DB update like provider worker
                try:
                    calc = {
                        "type": "ORDER_CLOSE_CALC",
                        "order_id": order_id,
                        "user_type": user_type,
                        "user_id": user_id,
                        "symbol": sym,
                        "side": otype,
                        "close_price": result.get("close_price"),
                        "commission_entry": result.get("commission_entry"),
                        "commission_exit": result.get("commission_exit"),
                        "total_commission": result.get("total_commission"),
                        "profit_usd": result.get("profit_usd"),
                        "swap": result.get("swap"),
                        "net_profit": result.get("net_profit"),
                        "used_margin_executed": result.get("used_margin_executed"),
                        "used_margin_all": result.get("used_margin_all"),
                    }
                    _ORDERS_CALC_LOG.info(orjson.dumps(calc).decode())
                except Exception:
                    pass

                try:
                    db_msg = {
                        "type": "ORDER_CLOSE_CONFIRMED",
                        "order_id": order_id,
                        "user_id": user_id,
                        "user_type": user_type,
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
                        "close_message": close_message,  # "Stoploss" or "Takeprofit"
                        "trigger_lifecycle_id": trigger_lifecycle_id,  # SL123... or TP123...
                    }
                    
                    # Enhanced logging for debugging
                    logger.info(
                        "[TRIGGER:CLOSE_CONFIRMED] order_id=%s trigger_type=%s close_message=%s trigger_lifecycle_id=%s",
                        order_id, trigger_type, close_message, trigger_lifecycle_id
                    )
                    await self._publish_db_update(db_msg)
                except Exception:
                    pass
            finally:
                try:
                    await redis_cluster.delete(processing_key)
                except Exception:
                    pass

    async def run(self):
        await self.connect()
        while True:
            try:
                symbols: List[str] = await redis_cluster.smembers("trigger_active_symbols")
            except Exception:
                symbols = []
            for sym in symbols or []:
                bid, ask = await self._fetch_market(sym)
                # BUY then SELL for cache locality
                await self._scan_and_trigger(sym, "BUY", bid, ask)
                await self._scan_and_trigger(sym, "SELL", bid, ask)
            await asyncio.sleep(TICK_MS / 1000.0)


async def main():
    m = TriggerMonitor()
    await m.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
