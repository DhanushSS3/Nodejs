import os
import asyncio
import logging
from typing import Any, Dict, Optional
from pathlib import Path
from dotenv import load_dotenv
import time

import orjson
import aio_pika

# Load environment variables from root .env file
# Path: services/python-service/app/services/provider/dispatcher.py -> root
# __file__ = .../services/python-service/app/services/provider/dispatcher.py
# .parent = .../services/python-service/app/services/provider
# .parent.parent = .../services/python-service/app/services  
# .parent.parent.parent = .../services/python-service/app
# .parent.parent.parent.parent = .../services/python-service
# .parent.parent.parent.parent.parent = .../services
# We need one more .parent to get to root
root_dir = Path(__file__).parent.parent.parent.parent.parent.parent
env_path = root_dir / '.env'
load_dotenv(env_path)

from app.config.redis_config import redis_cluster, redis_pubsub_client
from app.services.logging.provider_logger import (
    get_dispatcher_logger,
    get_provider_errors_logger,
    log_provider_stats
)
from app.services.orders.order_registry import (
    get_order_by_lifecycle_id,
    replace_provider_id,
    get_order_id_from_execution_report,
    resolve_canonical_order_id,
    add_lifecycle_id,
    trigger_db_id_replacement,
)

# Initialize dedicated loggers
logger = get_dispatcher_logger()
error_logger = get_provider_errors_logger()

# Keep basic logging for compatibility
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))

# Debug: Log environment variable loading
logger.info("Environment loaded from: %s", env_path.resolve())
logger.info("Environment file exists: %s", env_path.exists())
logger.info("REDIS_PASSWORD set: %s", "Yes" if os.getenv("REDIS_PASSWORD") else "No")
logger.info("REDIS_HOSTS: %s", os.getenv("REDIS_HOSTS", "Not set"))

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
CONFIRMATION_QUEUE = os.getenv("CONFIRMATION_QUEUE", "confirmation_queue")
DLQ = os.getenv("CONFIRMATION_DLQ", "confirmation_dlq")
DB_UPDATE_QUEUE = os.getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")
CANCEL_QUEUE = os.getenv("ORDER_WORKER_CANCEL_QUEUE", "order_worker_cancel_queue")

# Worker queues
OPEN_QUEUE = os.getenv("ORDER_WORKER_OPEN_QUEUE", "order_worker_open_queue")
CLOSE_QUEUE = os.getenv("ORDER_WORKER_CLOSE_QUEUE", "order_worker_close_queue")
SL_QUEUE = os.getenv("ORDER_WORKER_STOPLOSS_QUEUE", "order_worker_stoploss_queue")
TP_QUEUE = os.getenv("ORDER_WORKER_TAKEPROFIT_QUEUE", "order_worker_takeprofit_queue")
REJECT_QUEUE = os.getenv("ORDER_WORKER_REJECT_QUEUE", "order_worker_reject_queue")
PENDING_QUEUE = os.getenv("ORDER_WORKER_PENDING_QUEUE", "order_worker_pending_queue")


async def _redis_get(key: str) -> Optional[str]:
    """Get value from Redis with fallback handling"""
    try:
        return await redis_cluster.get(key)
    except Exception as e:
        logger.info("Redis cluster get failed for key %s: %s", key, e)
        try:
            # Fallback to single Redis instance
            return await redis_pubsub_client.get(key)
        except Exception as fallback_error:
            logger.info("Redis fallback get failed for key %s: %s", key, fallback_error)
            return None


async def _redis_hgetall(key: str) -> Dict[str, Any]:
    """Get hash from Redis with fallback handling"""
    try:
        return await redis_cluster.hgetall(key)
    except Exception as e:
        logger.info("Redis cluster hgetall failed for key %s: %s", key, e)
        try:
            # Fallback to single Redis instance
            return await redis_pubsub_client.hgetall(key)
        except Exception as fallback_error:
            logger.info("Redis fallback hgetall failed for key %s: %s", key, fallback_error)
            return {}


async def _redis_hget(key: str, field: str) -> Optional[str]:
    """Get hash field from Redis with fallback handling"""
    try:
        return await redis_cluster.hget(key, field)
    except Exception as e:
        logger.info("Redis cluster hget failed for key %s field %s: %s", key, field, e)
        try:
            # Fallback to single Redis instance
            return await redis_pubsub_client.hget(key, field)
        except Exception as fallback_error:
            logger.info("Redis fallback hget failed for key %s field %s: %s", key, field, fallback_error)
            return None


def _select_worker_queue(status: Optional[str]) -> Optional[str]:
    """Select target worker queue using canonical order status stored in order_data['status']."""
    if not status:
        return None
    s = str(status).upper()
    if s == "OPEN":
        return OPEN_QUEUE
    # Future routes (uncomment as workers are added)
    # if s == "CLOSE":
    #     return CLOSE_QUEUE
    # if s == "STOPLOSS":
    #     return SL_QUEUE
    # if s == "TAKEPROFIT":
    #     return TP_QUEUE
    return None


async def _compose_payload(report: Dict[str, Any], order_data: Dict[str, Any], canonical_order_id: str, provider_order_id: Optional[str] = None) -> Dict[str, Any]:
    # Use the provider_order_id passed from dispatcher, or extract from report as fallback
    if not provider_order_id:
        provider_order_id = (
            report.get("provider_order_id") or
            report.get("order_id") or 
            report.get("exec_id") or 
            (report.get("raw") or {}).get("11") or 
            (report.get("raw") or {}).get("17")
        )
    
    payload: Dict[str, Any] = {
        "order_id": canonical_order_id,  # Keep canonical for existing workers
        "provider_order_id": provider_order_id,  # Add original provider order_id from execution report
        "user_id": order_data.get("user_id"),
        "user_type": order_data.get("user_type"),
        "account_number": order_data.get("account_number"),
        "group": order_data.get("group"),
        "leverage": order_data.get("leverage"),
        "spread": order_data.get("spread"),
        "spread_pip": order_data.get("spread_pip"),
        "contract_size": order_data.get("contract_size"),
        "profit_currency": order_data.get("profit"),
        "symbol": order_data.get("symbol"),
        "order_type": order_data.get("order_type"),
        "order_price": order_data.get("order_price"),
        "order_quantity": order_data.get("order_quantity"),
        "status": order_data.get("status") or order_data.get("order_status"),
        "execution_report": report,
    }
    return payload


class Dispatcher:
    def __init__(self):
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._q_in: Optional[aio_pika.abc.AbstractQueue] = None
        self._q_dlq: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None
        self._consumer_tag: Optional[str] = None
        
        # Statistics tracking
        self._stats: Dict[str, Any] = {
            'start_time': time.time(),
            'messages_processed': 0,
            'messages_routed': 0,
            'messages_dlq': 0,
            'routing_errors': 0,
            'redis_errors': 0,
            'last_message_time': 0.0
        }

    async def connect(self):
        # Test Redis connectivity
        redis_status = "unavailable"
        try:
            test_result = await _redis_get("test_connection")
            redis_status = "cluster" if test_result is not None or True else "cluster"
        except Exception:
            try:
                test_result = await redis_pubsub_client.ping()
                redis_status = "single" if test_result else "single"
            except Exception:
                redis_status = "unavailable"
        
        logger.info("Redis status: %s", redis_status)
        
        # Use local variables to avoid NoneType lint warnings
        conn = await aio_pika.connect_robust(RABBITMQ_URL)
        channel = await conn.channel()
        await channel.set_qos(prefetch_count=100)
        
        q_in = await channel.declare_queue(CONFIRMATION_QUEUE, durable=True)
        q_dlq = await channel.declare_queue(DLQ, durable=True)
        
        # Ensure worker queues exist (durable) even if no consumer yet
        await channel.declare_queue(OPEN_QUEUE, durable=True)
        await channel.declare_queue(CLOSE_QUEUE, durable=True)
        await channel.declare_queue(SL_QUEUE, durable=True)
        await channel.declare_queue(TP_QUEUE, durable=True)
        await channel.declare_queue(REJECT_QUEUE, durable=True)
        await channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        await channel.declare_queue(CANCEL_QUEUE, durable=True)
        await channel.declare_queue(PENDING_QUEUE, durable=True)
        
        # Assign to self attributes after full initialization
        self._conn = conn
        self._channel = channel
        self._q_in = q_in
        self._q_dlq = q_dlq
        self._ex = channel.default_exchange
        
        logger.info(
            "Dispatcher connected. URL=%s Redis=%s in=%s dlq=%s open=%s close=%s sl=%s tp=%s reject=%s cancel=%s pending=%s",
            RABBITMQ_URL,
            redis_status,
            CONFIRMATION_QUEUE,
            DLQ,
            OPEN_QUEUE,
            CLOSE_QUEUE,
            SL_QUEUE,
            TP_QUEUE,
            REJECT_QUEUE,
            CANCEL_QUEUE,
            PENDING_QUEUE,
        )

    async def _publish(self, queue_name: str, body: Dict[str, Any]):
        try:
            if not self._ex:
                logger.error("[DISPATCH:PUBLISH_ERROR] Queue exchange not initialized")
                return
                
            msg = aio_pika.Message(body=orjson.dumps(body), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
            await self._ex.publish(msg, routing_key=queue_name)
            
            # Log successful routing
            logger.debug(
                "[DISPATCH:ROUTED] order_id=%s queue=%s redis_status=%s ord_status=%s",
                body.get('order_id', 'unknown'),
                queue_name,
                body.get('execution_report', {}).get('redis_status', 'unknown'),
                body.get('execution_report', {}).get('ord_status', 'unknown')
            )
            self._stats['messages_routed'] += 1
            
        except Exception as e:
            error_logger.exception(
                "[DISPATCH:PUBLISH_FAILED] queue=%s order_id=%s error=%s",
                queue_name,
                body.get('order_id', 'unknown'),
                str(e)
            )
            self._stats['routing_errors'] += 1
            # Don't re-raise to avoid breaking the message processing flow

    async def handle(self, message: aio_pika.abc.AbstractIncomingMessage):
        start_time = time.time()
        order_id_debug = None
        
        try:
            async with message.process(requeue=False):
                self._stats['messages_processed'] += 1
                self._stats['last_message_time'] = start_time
                
                report = orjson.loads(message.body)
                
                # Extract order ID for logging
                raw = report.get("raw") or {}
                order_id_debug = (
                    report.get("order_id") or 
                    report.get("exec_id") or 
                    raw.get("11") or 
                    raw.get("17") or
                    "unknown"
                )
                
                # Debug: Log the raw execution report
                logger.debug(
                    "[DISPATCH:RAW_REPORT] order_id=%s report_keys=%s order_id_field=%s exec_id_field=%s",
                    order_id_debug, list(report.keys()), 
                    report.get("order_id"), report.get("exec_id")
                )
                
                # Only process execution reports
                rtype = str(report.get("type") or "").strip().lower()
                if rtype != "execution_report":
                    logger.debug(
                        "[DISPATCH:IGNORED] order_id=%s type=%s reason=non_execution_report",
                        order_id_debug, rtype
                    )
                    return
                
                # 1. SPECIAL CASE: Recovery mode ID replacement
                if report.get("mode") == "recovery":
                    recovery_old_id = str(report.get("order_id"))
                    recovery_new_id = str(report.get("_recovery_new_id"))
                    logger.info(
                        "[DISPATCH:RECOVERY] Processing recovery for old_id=%s new_id=%s",
                        recovery_old_id, recovery_new_id
                    )
                    
                    replace_result = await replace_provider_id(recovery_old_id, recovery_new_id)
                    
                    if not replace_result.get("ok"):
                        logger.warning(
                            "[DISPATCH:RECOVERY_FAILED] ID replacement failed for old_id=%s reason=%s",
                            recovery_old_id, replace_result.get("reason")
                        )
                    else:
                        logger.info(
                            "[DISPATCH:RECOVERY_SUCCESS] ID replacement successful for old_id=%s canonical_id=%s",
                            recovery_old_id, replace_result.get("canonical_order_id")
                        )
                        # Ensure the report and resolution logic use the canonical ID going forward
                        report["order_id"] = replace_result.get("canonical_order_id")
                        report["canonical_order_id"] = replace_result.get("canonical_order_id")

                # 2. RESOLVE CANONICAL ORDER ID
                # Start with candidates
                candidates = [
                    report.get("order_id"), 
                    report.get("exec_id"), 
                    raw.get("11"),  # ClOrdID
                    raw.get("17"),  # ExecID
                ]
                
                canonical_order_id = report.get("canonical_order_id")
                resolved_by_id = None
                
                if not canonical_order_id:
                    # Try to resolve from any candidate using global lookup
                    for cid in candidates:
                        if not cid:
                            continue
                        lookup_val = await _redis_get(f"global_order_lookup:{cid}")
                        if lookup_val:
                            canonical_order_id = lookup_val
                            resolved_by_id = cid
                            break
                    
                    # Special handling for close_id
                    if not canonical_order_id:
                        for cid in candidates:
                            if cid and str(cid).startswith("CLS"):
                                canonical_from_close = await _redis_get(f"close_id_lookup:{cid}")
                                if canonical_from_close:
                                    canonical_order_id = canonical_from_close
                                    resolved_by_id = cid
                                    break
                    
                    # Fallback: direct order_data existence check
                    if not canonical_order_id:
                        for cid in candidates:
                            if cid and await redis_cluster.exists(f"order_data:{cid}"):
                                canonical_order_id = cid
                                resolved_by_id = cid
                                break
                
                if not canonical_order_id:
                    logger.warning(
                        "[DISPATCH:DLQ] order_id=%s reason=unresolved_canonical_id candidates=%s",
                        order_id_debug, [c for c in candidates if c]
                    )
                    await self._publish(DLQ, {"reason": "unresolved_canonical_id", "candidates": candidates, "report": report})
                    self._stats['messages_dlq'] += 1
                    return
                
                provider_order_id = report.get("order_id") or resolved_by_id or order_id_debug
                
                # 3. AUTO-MAPPING: Register candidates to CID for future reports
                for cid in candidates:
                    if cid and cid != canonical_order_id:
                        try:
                            # Map generically as "provider_order_id" if it's purely numeric
                            id_type = "provider_order_id"
                            cid_str = str(cid)
                            if cid_str.startswith("SL"): id_type = "stoploss_id"
                            elif cid_str.startswith("TP"): id_type = "takeprofit_id"
                            elif cid_str.startswith("CLS"): id_type = "close_id"
                            
                            await add_lifecycle_id(str(canonical_order_id), cid_str, id_type)
                        except Exception as map_err:
                            logger.debug("Auto-mapping failed for %s: %s", cid, map_err)

                # 4. FETCH ORDER DATA
                order_data = await _redis_hgetall(f"order_data:{canonical_order_id}")
                if not order_data:
                    logger.warning(
                        "[DISPATCH:DLQ] order_id=%s canonical_id=%s reason=missing_order_data",
                        order_id_debug, canonical_order_id
                    )
                    await self._publish(DLQ, {"reason": "missing_order_data", "order_id": canonical_order_id, "report": report})
                    self._stats['messages_dlq'] += 1
                    return

                # 5. COMPOSE PAYLOAD AND ROUTE
                payload = await _compose_payload(report, order_data, canonical_order_id, provider_order_id)
                
                redis_status = str(order_data.get("status") or "").upper().strip()
                # Fallback to user_holdings for status if not in order_data
                if not redis_status:
                    try:
                        ut = str(order_data.get("user_type") or "")
                        uid = str(order_data.get("user_id") or "")
                        if ut and uid:
                            hkey = f"user_holdings:{{{ut}:{uid}}}:{canonical_order_id}"
                            hstat = await _redis_hget(hkey, "status")
                            if hstat:
                                redis_status = str(hstat).upper().strip()
                    except Exception:
                        pass
                
                ord_status = str(report.get("ord_status") or "").upper().strip()
                
                # Ignore ACK messages
                if ord_status == "ACK":
                    logger.debug("[DISPATCH:IGNORED] order_id=%s ord_status=ACK acknowledgment_only", canonical_order_id)
                    return
                
                target_queue = None
                
                # Logic for routing decisions
                if redis_status == "PENDING-CANCEL" and ord_status in ("CANCELLED", "CANCELED", "PENDING", "MODIFY"):
                    target_queue = CANCEL_QUEUE
                elif ord_status in ("CANCELLED", "CANCELED"):
                    is_modify_cancel = False
                    try:
                        modify_lookup = await redis_cluster.get(f"lifecycle_id_lookup:modify_id:{canonical_order_id}")
                        if modify_lookup:
                            is_modify_cancel = True
                    except Exception:
                        pass
                    
                    if is_modify_cancel:
                        target_queue = PENDING_QUEUE
                    elif redis_status in ("STOPLOSS-CANCEL", "TAKEPROFIT-CANCEL"):
                        target_queue = CANCEL_QUEUE
                    elif redis_status in ("MODIFY", "PENDING", "CANCELLED", "PENDING-QUEUED"):
                        target_queue = CANCEL_QUEUE
                    else:
                        logger.warning(
                            "[DISPATCH:DLQ] order_id=%s reason=unmapped_cancel_state redis_status=%s ord_status=%s",
                            canonical_order_id, redis_status, ord_status
                        )
                        await self._publish(DLQ, {"reason": "unmapped_cancel_state", "redis_status": redis_status, "ord_status": ord_status, "order_id": canonical_order_id, "report": report})
                        self._stats['messages_dlq'] += 1
                        return
                        
                elif ord_status == "REJECTED":
                    target_queue = REJECT_QUEUE
                elif ord_status == "EXECUTED":
                    target_queue = OPEN_QUEUE
                elif ord_status in ("OPEN", "PENDING", "MODIFY"):
                    target_queue = PENDING_QUEUE
                elif ord_status == "TRADE":
                    target_queue = CLOSE_QUEUE
                else:
                    logger.warning(
                        "[DISPATCH:DLQ] order_id=%s reason=unmapped_routing_state redis_status=%s ord_status=%s",
                        canonical_order_id, redis_status, ord_status
                    )
                    await self._publish(DLQ, {"reason": "unmapped_routing_state", "redis_status": redis_status, "ord_status": ord_status, "order_id": canonical_order_id, "report": report})
                    self._stats['messages_dlq'] += 1
                    return

                # Record success and publish
                processing_time = (time.time() - start_time) * 1000
                logger.info(
                    "[DISPATCH:SUCCESS] order_id=%s redis_status=%s ord_status=%s target_queue=%s processing_time=%.2fms",
                    canonical_order_id, redis_status, ord_status, target_queue, processing_time
                )
                
                payload["routing_metadata"] = {
                    "dispatcher_processing_time_ms": processing_time,
                    "routing_decision": {"redis_status": redis_status, "ord_status": ord_status, "target_queue": target_queue},
                    "timestamp": start_time
                }
                
                await self._publish(target_queue, payload)
        except Exception as e:
            processing_time = (time.time() - start_time) * 1000
            error_logger.exception(
                "[DISPATCH:ERROR] order_id=%s processing_time=%.2fms error=%s",
                order_id_debug or "unknown", processing_time, str(e)
            )
            self._stats['routing_errors'] += 1
            # Don't re-raise here to avoid unhandled exceptions during shutdown

    async def _log_stats(self):
        """Log dispatcher statistics."""
        try:
            uptime = time.time() - self._stats['start_time']
            stats = {
                **self._stats,
                'uptime_seconds': uptime,
                'uptime_hours': uptime / 3600,
                'messages_per_second': self._stats['messages_processed'] / uptime if uptime > 0 else 0,
                'routing_success_rate': (
                    (self._stats['messages_routed'] / self._stats['messages_processed']) * 100
                    if self._stats['messages_processed'] > 0 else 0
                ),
                'error_rate': (
                    (self._stats['routing_errors'] / self._stats['messages_processed']) * 100
                    if self._stats['messages_processed'] > 0 else 0
                )
            }
            
            log_provider_stats('dispatcher', stats)
            logger.info(
                "[DISPATCH:STATS] processed=%d routed=%d dlq=%d errors=%d uptime=%.1fh rate=%.2f/s",
                stats['messages_processed'],
                stats['messages_routed'],
                stats['messages_dlq'],
                stats['routing_errors'],
                stats['uptime_hours'],
                stats['messages_per_second']
            )
        except Exception as e:
            logger.error("[DISPATCH:STATS_ERROR] Failed to log stats: %s", e)

    async def cleanup(self):
        """Clean up connections and resources"""
        logger.info("[DISPATCH:CLEANUP] Starting cleanup...")
        
        try:
            # Log final stats before cleanup
            await self._log_stats()
            
            # Cancel consumer if it exists
            if self._consumer_tag and self._q_in:
                try:
                    await self._q_in.cancel(self._consumer_tag)
                    logger.debug("[DISPATCH:CLEANUP] Consumer cancelled")
                except Exception as e:
                    logger.debug("[DISPATCH:CLEANUP] Failed to cancel consumer: %s", e)
            
            # Close channel
            if self._channel and not self._channel.is_closed:
                try:
                    await self._channel.close()
                    logger.debug("[DISPATCH:CLEANUP] Channel closed")
                except Exception as e:
                    logger.debug("[DISPATCH:CLEANUP] Failed to close channel: %s", e)
            
            # Close connection
            if self._conn and not self._conn.is_closed:
                try:
                    await self._conn.close()
                    logger.debug("[DISPATCH:CLEANUP] Connection closed")
                except Exception as e:
                    logger.debug("[DISPATCH:CLEANUP] Failed to close connection: %s", e)
                    
        except Exception as e:
            error_logger.exception("[DISPATCH:CLEANUP] Error during cleanup: %s", e)
        finally:
            self._conn = None
            self._channel = None
            self._q_in = None
            self._q_dlq = None
            self._ex = None
            self._consumer_tag = None
            logger.info("[DISPATCH:CLEANUP] Cleanup completed")

    async def run(self):
        logger.info("[DISPATCH:STARTING] Dispatcher service initializing...")
        
        while True:
            try:
                # Clean up any existing connections first
                await self.cleanup()
                
                await self.connect()
                self._consumer_tag = await self._q_in.consume(self.handle, no_ack=False)
                logger.info("[DISPATCH:READY] Dispatcher started consuming messages")
                
                # Keep the service running and log stats periodically
                stats_interval = 0
                while True:
                    await asyncio.sleep(30)  # Check more frequently
                    stats_interval += 30
                    
                    # Log stats every 5 minutes
                    if stats_interval >= 300:
                        await self._log_stats()
                        stats_interval = 0
                    
                    # Check if connection is still alive
                    if not self._conn or self._conn.is_closed:
                        logger.warning("[DISPATCH:RECONNECT] Connection lost, reconnecting...")
                        break
                    if not self._channel or self._channel.is_closed:
                        logger.warning("[DISPATCH:RECONNECT] Channel lost, reconnecting...")
                        break
                        
            except Exception as e:
                error_logger.exception("[DISPATCH:RUN_ERROR] Dispatcher run error: %s", e)
                logger.info("[DISPATCH:RETRY] Retrying connection in 5 seconds...")
                await asyncio.sleep(5)


async def main():
    d = Dispatcher()
    try:
        logger.info("[DISPATCH:MAIN] Starting dispatcher service...")
        await d.run()
    except KeyboardInterrupt:
        logger.info("[DISPATCH:MAIN] Received keyboard interrupt, shutting down...")
    except Exception as e:
        error_logger.exception("[DISPATCH:MAIN] Unhandled exception in main: %s", e)
    finally:
        await d.cleanup()
        logger.info("[DISPATCH:MAIN] Dispatcher shutdown complete")


if __name__ == "__main__":
    try:
        logger.info("[DISPATCH:APP] Starting dispatcher application...")
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("[DISPATCH:APP] Application interrupted by user")
    except Exception as e:
        error_logger.exception("[DISPATCH:APP] Application failed: %s", e)
