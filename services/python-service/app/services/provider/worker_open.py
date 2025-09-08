import os
import asyncio
import logging
from typing import Any, Dict, Optional

import orjson
import aio_pika

from app.config.redis_config import redis_cluster
from app.services.portfolio.margin_calculator import compute_single_order_margin
from app.services.portfolio.user_margin_service import compute_user_total_margin
from app.services.orders.order_repository import fetch_group_data, fetch_user_orders

logger = logging.getLogger(__name__)
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
    avspx = report.get("avspx") or (report.get("raw") or {}).get("6")
    cumqty = report.get("cumqty") or (report.get("raw") or {}).get("14")
    ts = report.get("ts")

    # Canonical
    order_data_key = f"order_data:{order_id}"

    # User holdings
    hash_tag = f"{user_type}:{user_id}"
    order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"

    mapping_common = {
        "order_status": "OPEN",
        "execution_status": "EXECUTED",  # provider acknowledged
        "provider_ord_status": ord_status,
        "provider_exec_id": exec_id if exec_id is not None else "",
        "provider_avspx": avspx if avspx is not None else "",
        "provider_cumqty": cumqty if cumqty is not None else "",
        "provider_ts": str(ts) if ts is not None else "",
    }

    # Update both keys in a pipeline
    pipe = redis_cluster.pipeline()
    pipe.hset(order_data_key, mapping=mapping_common)
    pipe.hset(order_key, mapping=mapping_common)
    await pipe.execute()

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
    Returns dict with keys: single_margin_usd, total_used_margin_usd, final_exec_price, final_order_qty
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

    qty = order_ctx.get("cumqty_hint") or payload.get("order_quantity")
    try:
        final_qty = float(qty) if qty is not None else None
    except Exception:
        final_qty = None

    # Fetch group data to enrich crypto factor if available
    group = str(payload.get("group") or "Standard")
    g = await fetch_group_data(symbol, group)
    try:
        crypto_factor = float(g.get("crypto_margin_factor")) if g.get("crypto_margin_factor") is not None else None
    except (TypeError, ValueError):
        crypto_factor = None

    # Convert contract_size to float safely
    try:
        cs_val = float(contract_size) if contract_size is not None else None
    except (TypeError, ValueError):
        cs_val = None

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
    total_used, meta = await compute_user_total_margin(
        user_type=user_type,
        user_id=user_id,
        orders=orders,
        prices_cache=None,
        strict=True,
    )
    return {
        "single_margin_usd": single_margin,
        "total_used_margin_usd": float(total_used) if total_used is not None else None,
        "final_exec_price": final_price,
        "final_order_qty": final_qty,
    }


class OpenWorker:
    def __init__(self):
        self._conn: Optional[aio_pika.RobustConnection] = None
        self._channel: Optional[aio_pika.abc.AbstractChannel] = None
        self._queue: Optional[aio_pika.abc.AbstractQueue] = None
        self._ex = None
        self._db_queue: Optional[aio_pika.abc.AbstractQueue] = None

    async def connect(self):
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=64)
        self._queue = await self._channel.declare_queue(OPEN_QUEUE, durable=True)
        # ensure DB update queue exists
        self._db_queue = await self._channel.declare_queue(DB_UPDATE_QUEUE, durable=True)
        self._ex = self._channel.default_exchange
        logger.info("OpenWorker connected. Waiting on %s", OPEN_QUEUE)

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
        try:
            payload = orjson.loads(message.body)
            # Acquire per-user lock to avoid race on used_margin recompute
            lock_key = f"lock:user_margin:{payload.get('user_type')}:{payload.get('user_id')}"
            token = f"{os.getpid()}-{id(message)}"
            got_lock = await acquire_lock(lock_key, token, ttl_sec=8)
            if not got_lock:
                logger.warning("Could not acquire lock %s; NACK and requeue", lock_key)
                await self._nack(message, requeue=True)
                return

            try:
                # Step 1: update provider OPEN markers
                ctx = await _update_redis_for_open(payload)
                # Step 2: recompute margins
                margins = await _recompute_margins(ctx, payload)

                # Step 3: persist recalculated fields (best-effort)
                upd_map = {}
                if margins.get("single_margin_usd") is not None:
                    upd_map["margin"] = str(float(margins["single_margin_usd"]))
                if margins.get("final_exec_price") is not None:
                    upd_map["order_price"] = str(float(margins["final_exec_price"]))
                if margins.get("final_order_qty") is not None:
                    upd_map["order_quantity"] = str(float(margins["final_order_qty"]))

                pipe = redis_cluster.pipeline()
                if upd_map:
                    pipe.hset(ctx["order_key"], mapping=upd_map)
                    pipe.hset(ctx["order_data_key"], mapping=upd_map)
                # Update portfolio used_margin with recomputed total, if available
                if margins.get("total_used_margin_usd") is not None:
                    portfolio_key = f"user_portfolio:{{{payload.get('user_type')}:{payload.get('user_id')}}}"
                    pipe.hset(portfolio_key, mapping={"used_margin": str(float(margins["total_used_margin_usd"]))})
                await pipe.execute()

                # Step 4: publish DB update intent for Node consumer (decoupled persistence)
                try:
                    db_msg = {
                        "type": "ORDER_OPEN_CONFIRMED",
                        "order_id": str(payload.get("order_id")),
                        "user_id": str(payload.get("user_id")),
                        "user_type": str(payload.get("user_type")),
                        "order_status": "OPEN",
                        "order_price": margins.get("final_exec_price") or payload.get("order_price"),
                        "margin": margins.get("single_margin_usd"),
                        "used_margin_usd": margins.get("total_used_margin_usd"),
                        "provider": {
                            "exec_id": (payload.get("execution_report") or {}).get("exec_id"),
                            "avspx": (payload.get("execution_report") or {}).get("avspx"),
                            "cumqty": (payload.get("execution_report") or {}).get("cumqty"),
                        },
                    }
                    msg = aio_pika.Message(body=orjson.dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await self._ex.publish(msg, routing_key=DB_UPDATE_QUEUE)
                except Exception:
                    logger.exception("Failed to publish DB update message")
            finally:
                await release_lock(lock_key, token)

            await self._ack(message)
        except Exception as e:
            logger.exception("OpenWorker handle error: %s", e)
            await self._nack(message, requeue=True)

    async def run(self):
        await self.connect()
        await self._queue.consume(self.handle, no_ack=False)
        while True:
            await asyncio.sleep(3600)


async def main():
    w = OpenWorker()
    await w.run()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
