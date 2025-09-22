import os
import asyncio
import logging
from typing import Any, Dict, Optional
from pathlib import Path
from dotenv import load_dotenv

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

logger = logging.getLogger(__name__)
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


async def _compose_payload(report: Dict[str, Any], order_data: Dict[str, Any], canonical_order_id: str) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "order_id": canonical_order_id,
        "user_id": order_data.get("user_id"),
        "user_type": order_data.get("user_type"),
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
        
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=100)
        self._q_in = await self._channel.declare_queue(CONFIRMATION_QUEUE, durable=True)
        self._q_dlq = await self._channel.declare_queue(DLQ, durable=True)
        # Ensure worker queues exist (durable) even if no consumer yet
        await self._channel.declare_queue(OPEN_QUEUE, durable=True)
        await self._channel.declare_queue(CLOSE_QUEUE, durable=True)
        await self._channel.declare_queue(SL_QUEUE, durable=True)
        await self._channel.declare_queue(TP_QUEUE, durable=True)
        await self._channel.declare_queue(REJECT_QUEUE, durable=True)
        await self._channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        await self._channel.declare_queue(CANCEL_QUEUE, durable=True)
        await self._channel.declare_queue(PENDING_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
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
            msg = aio_pika.Message(body=orjson.dumps(body), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
            await self._ex.publish(msg, routing_key=queue_name)
        except Exception as e:
            logger.exception("Failed to publish message to queue %s: %s", queue_name, e)
            # Don't re-raise to avoid breaking the message processing flow

    async def handle(self, message: aio_pika.abc.AbstractIncomingMessage):
        try:
            async with message.process(requeue=False):
                report = orjson.loads(message.body)
                # Only process execution reports, ignore provider ACK messages
                rtype = str(report.get("type") or "").strip().lower()
                if rtype != "execution_report":
                    logger.info("Dispatcher ignoring non-execution report type=%s", rtype)
                    return
                
                lifecycle_id = report.get("order_id") or report.get("exec_id")
                if not lifecycle_id:
                    # try in raw dict
                    raw = report.get("raw") or {}
                    lifecycle_id = raw.get("11") or raw.get("17")

                if not lifecycle_id:
                    logger.warning("No lifecycle ID in report; sending to DLQ")
                    await self._publish(DLQ, {"reason": "missing_lifecycle_id", "report": report})
                    return

                # Handle Redis operations with error handling
                canonical_order_id = await _redis_get(f"global_order_lookup:{lifecycle_id}")
                # Fallback: treat lifecycle_id as canonical order_id (self-mapping case)
                if not canonical_order_id:
                    canonical_order_id = lifecycle_id

                order_data = await _redis_hgetall(f"order_data:{canonical_order_id}")
                if not order_data:
                    logger.warning("Canonical order_data missing for %s; DLQ", canonical_order_id)
                    await self._publish(DLQ, {"reason": "missing_order_data", "order_id": canonical_order_id, "report": report})
                    return

                payload = await _compose_payload(report, order_data, canonical_order_id)
                # Route based on Redis status (engine/UI state) and provider ord_status (string)
                # IMPORTANT: Use only the 'status' field per spec; do not fallback to 'order_status'.
                redis_status = str(order_data.get("status") or "").upper().strip()
                # Fallback: if status missing on order_data, try user_holdings status (still the 'status' field)
                if not redis_status:
                    try:
                        ut = str(order_data.get("user_type") or "")
                        uid = str(order_data.get("user_id") or "")
                        if ut and uid:
                            hkey = f"user_holdings:{{{ut}:{uid}}}:{canonical_order_id}"
                            hstat = await _redis_hget(hkey, "status")
                            if hstat:
                                redis_status = str(hstat).upper().strip()
                    except Exception as holdings_error:
                        logger.debug("Failed to get user holdings status for %s: %s", canonical_order_id, holdings_error)
                ord_status = str(report.get("ord_status") or "").upper().strip()
                target_queue = None
                # Pending cancel confirmations: route before generic CANCELLED branch
                if redis_status == "PENDING-CANCEL" and ord_status in ("CANCELLED", "CANCELED", "PENDING", "MODIFY"):
                    # Provider confirmed/acknowledged cancel request for pending order
                    target_queue = CANCEL_QUEUE
                # Handle CANCELLED (or CANCELED) confirmations for cancels
                elif ord_status in ("CANCELLED", "CANCELED"):
                    # SL/TP cancel confirmations
                    if redis_status in ("STOPLOSS-CANCEL", "TAKEPROFIT-CANCEL"):
                        target_queue = CANCEL_QUEUE
                    # Pending cancel confirmations may find status in MODIFY/PENDING/CANCELLED
                    elif redis_status in ("MODIFY", "PENDING", "CANCELLED"):
                        target_queue = CANCEL_QUEUE
                    else:
                        logger.info(
                            "Unmapped cancel confirmation; DLQ. redis_status=%s ord_status=%s order_id=%s",
                            redis_status, ord_status, canonical_order_id,
                        )
                        await self._publish(
                            DLQ,
                            {
                                "reason": "unmapped_cancel_state",
                                "redis_status": redis_status,
                                "ord_status": ord_status,
                                "order_id": canonical_order_id,
                                "report": report,
                            },
                        )
                        return
                elif redis_status == "OPEN" and ord_status == "EXECUTED":
                    target_queue = OPEN_QUEUE
                elif redis_status in ("PENDING", "PENDING-QUEUED", "MODIFY") and ord_status == "EXECUTED":
                    # Pending order executed at provider -> open the order
                    payload["pending_executed"] = True
                    target_queue = OPEN_QUEUE
                elif ord_status == "PENDING" and redis_status in ("PENDING", "PENDING-QUEUED", "MODIFY"):
                    # Provider confirmed pending placement
                    target_queue = PENDING_QUEUE
                elif ord_status == "MODIFY" and redis_status in ("PENDING", "PENDING-QUEUED", "MODIFY"):
                    # Provider acknowledged a pending modify request
                    target_queue = PENDING_QUEUE
                # (Handled above before generic CANCELLED branch)
                elif redis_status == "PENDING-CANCEL" and ord_status == "EXECUTED":
                    # Race: pending executed at provider before cancel took effect -> proceed to OPEN
                    payload["pending_executed"] = True
                    target_queue = OPEN_QUEUE
                elif redis_status == "OPEN" and ord_status == "REJECTED":
                    target_queue = REJECT_QUEUE
                elif redis_status in ("PENDING", "PENDING-QUEUED", "MODIFY") and ord_status == "REJECTED":
                    target_queue = REJECT_QUEUE
                elif redis_status == "CLOSED" and ord_status == "EXECUTED":
                    target_queue = CLOSE_QUEUE
                elif redis_status == "CLOSED" and ord_status == "REJECTED":
                    target_queue = REJECT_QUEUE
                elif redis_status == "STOPLOSS" and ord_status == "PENDING":
                    target_queue = SL_QUEUE
                elif redis_status == "TAKEPROFIT" and ord_status == "PENDING":
                    target_queue = TP_QUEUE
                # Close on provider EXECUTED for trigger-related statuses
                elif redis_status in ("STOPLOSS", "TAKEPROFIT", "STOPLOSS-CANCEL", "TAKEPROFIT-CANCEL") and ord_status == "EXECUTED":
                    target_queue = CLOSE_QUEUE
                else:
                    logger.info(
                        "Unmapped routing state; DLQ. redis_status=%s ord_status=%s order_id=%s",
                        redis_status, ord_status, canonical_order_id,
                    )
                    await self._publish(
                        DLQ,
                        {
                            "reason": "unmapped_routing_state",
                            "redis_status": redis_status,
                            "ord_status": ord_status,
                            "order_id": canonical_order_id,
                            "report": report,
                        },
                    )
                    return

                logger.info(
                    "Routing ER redis_status=%s ord_status=%s order_id=%s -> %s",
                    redis_status, ord_status, canonical_order_id, target_queue,
                )
                await self._publish(target_queue, payload)
        except Exception as e:
            logger.exception("Dispatcher handle error (channel/connection issue): %s", e)
            # Don't re-raise here to avoid unhandled exceptions during shutdown

    async def cleanup(self):
        """Clean up connections and resources"""
        try:
            # Cancel consumer if it exists
            if self._consumer_tag and self._q_in:
                try:
                    await self._q_in.cancel(self._consumer_tag)
                except Exception as e:
                    logger.debug("Failed to cancel consumer: %s", e)
            
            # Close channel
            if self._channel and not self._channel.is_closed:
                try:
                    await self._channel.close()
                except Exception as e:
                    logger.debug("Failed to close channel: %s", e)
            
            # Close connection
            if self._conn and not self._conn.is_closed:
                try:
                    await self._conn.close()
                except Exception as e:
                    logger.debug("Failed to close connection: %s", e)
                    
        except Exception as e:
            logger.exception("Error during cleanup: %s", e)
        finally:
            self._conn = None
            self._channel = None
            self._q_in = None
            self._q_dlq = None
            self._ex = None
            self._consumer_tag = None

    async def run(self):
        while True:
            try:
                # Clean up any existing connections first
                await self.cleanup()
                
                await self.connect()
                self._consumer_tag = await self._q_in.consume(self.handle, no_ack=False)
                logger.info("Dispatcher started consuming messages")
                
                # Keep the service running
                while True:
                    await asyncio.sleep(30)  # Check more frequently
                    # Check if connection is still alive
                    if not self._conn or self._conn.is_closed:
                        logger.warning("Connection lost, reconnecting...")
                        break
                    if not self._channel or self._channel.is_closed:
                        logger.warning("Channel lost, reconnecting...")
                        break
                        
            except Exception as e:
                logger.exception("Dispatcher run error: %s", e)
                logger.info("Retrying connection in 5 seconds...")
                await asyncio.sleep(5)


async def main():
    d = Dispatcher()
    try:
        await d.run()
    except KeyboardInterrupt:
        logger.info("Received keyboard interrupt, shutting down...")
    except Exception as e:
        logger.exception("Unhandled exception in main: %s", e)
    finally:
        await d.cleanup()
        logger.info("Dispatcher shutdown complete")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Application interrupted by user")
    except Exception as e:
        logger.exception("Application failed: %s", e)
