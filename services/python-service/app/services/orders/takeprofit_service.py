import logging
from typing import Any, Dict, Optional

from app.config.redis_config import redis_cluster
from app.services.orders.order_repository import fetch_user_config, fetch_group_data
from app.services.orders.sl_tp_repository import upsert_order_triggers
from app.services.orders.service_provider_client import send_provider_order
from app.services.orders.order_registry import add_lifecycle_id

logger = logging.getLogger(__name__)


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


async def _compute_half_spread(symbol: str, group: str) -> float:
    try:
        g = await fetch_group_data(symbol, group)
        spread = _safe_float(g.get("spread"))
        spread_pip = _safe_float(g.get("spread_pip"))
        if spread is None or spread_pip is None:
            return 0.0
        return float(spread * spread_pip / 2.0)
    except Exception as e:
        logger.warning("half_spread compute failed for %s/%s: %s", group, symbol, e)
        return 0.0


class TakeProfitService:
    async def add_takeprofit(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        missing = [k for k in ("order_id", "user_id", "user_type", "symbol", "order_type", "take_profit") if k not in payload]
        if missing:
            return {"ok": False, "reason": "missing_fields", "fields": missing}

        order_id = str(payload["order_id"])
        user_id = str(payload["user_id"])
        user_type = str(payload["user_type"]).lower()
        symbol = str(payload["symbol"]).upper()
        side = str(payload["order_type"]).upper()
        if side not in ("BUY", "SELL"):
            return {"ok": False, "reason": "invalid_order_type"}
        tp_raw = _safe_float(payload.get("take_profit"))
        if tp_raw is None or tp_raw <= 0:
            return {"ok": False, "reason": "invalid_take_profit"}

        # Determine flow
        cfg = await fetch_user_config(user_type, user_id)
        group = cfg.get("group") or "Standard"
        sending_orders = (cfg.get("sending_orders") or "").strip().lower()
        if (user_type == "demo") or (user_type == "live" and sending_orders == "rock"):
            flow = "local"
        elif user_type == "live" and sending_orders == "barclays":
            flow = "provider"
        else:
            return {"ok": False, "reason": "unsupported_flow", "details": {"user_type": user_type, "sending_orders": sending_orders}}

        half_spread = await _compute_half_spread(symbol, group)

        if flow == "local":
            # Adjust score for monitoring against market prices
            if side == "BUY":
                score_tp = float(tp_raw + half_spread)  # compare against BID
            else:
                score_tp = float(tp_raw - half_spread)  # compare against ASK

            ok = await upsert_order_triggers(
                order_id=order_id,
                symbol=symbol,
                side=side,
                user_type=user_type,
                user_id=user_id,
                stop_loss=None,
                take_profit=float(tp_raw),
                score_stop_loss=None,
                score_take_profit=score_tp,
            )
            if not ok:
                return {"ok": False, "reason": "upsert_triggers_failed"}

            # Persist for DB update backfill
            try:
                await redis_cluster.hset(f"order_data:{order_id}", mapping={
                    "symbol": symbol,
                    "order_type": side,
                    "user_type": user_type,
                    "user_id": user_id,
                    "take_profit": str(tp_raw),
                })
            except Exception:
                pass

            # Publish DB update intent
            try:
                db_msg = {
                    "type": "ORDER_TAKEPROFIT_SET",
                    "order_id": order_id,
                    "user_id": user_id,
                    "user_type": user_type,
                    "take_profit": float(tp_raw),
                }
                import aio_pika  # type: ignore
                RABBITMQ_URL = __import__('os').getenv("RABBITMQ_URL", "amqp://guest:guest@127.0.0.1/")
                ORDER_DB_UPDATE_QUEUE = __import__('os').getenv("ORDER_DB_UPDATE_QUEUE", "order_db_update_queue")
                conn = await aio_pika.connect_robust(RABBITMQ_URL)
                try:
                    ch = await conn.channel()
                    await ch.declare_queue(ORDER_DB_UPDATE_QUEUE, durable=True)
                    msg = aio_pika.Message(body=__import__('orjson').dumps(db_msg), delivery_mode=aio_pika.DeliveryMode.PERSISTENT)
                    await ch.default_exchange.publish(msg, routing_key=ORDER_DB_UPDATE_QUEUE)
                finally:
                    try:
                        await conn.close()
                    except Exception:
                        pass
            except Exception as e:
                logger.warning("Failed to publish DB update for takeprofit set: %s", e)

            return {
                "ok": True,
                "flow": flow,
                "order_id": order_id,
                "symbol": symbol,
                "order_type": side,
                "take_profit": float(tp_raw),
                "score_take_profit": float(score_tp),
            }

        # Provider flow
        # Adjust before sending per requirements
        if side == "BUY":
            provider_tp = float(tp_raw + half_spread)
        else:
            provider_tp = float(tp_raw - half_spread)

        # Persist lifecycle id mapping if provided
        if payload.get("takeprofit_id"):
            try:
                await add_lifecycle_id(order_id, str(payload.get("takeprofit_id")), "takeprofit_id")
            except Exception as e:
                logger.warning("add_lifecycle_id takeprofit_id failed: %s", e)

        # Mark status=TAKEPROFIT in Redis for routing
        try:
            order_data_key = f"order_data:{order_id}"
            hash_tag = f"{user_type}:{user_id}"
            order_key = f"user_holdings:{{{hash_tag}}}:{order_id}"
            pipe = redis_cluster.pipeline()
            pipe.hset(order_data_key, mapping={"status": "TAKEPROFIT", "symbol": symbol, "order_type": side})
            pipe.hset(order_key, mapping={"status": "TAKEPROFIT"})
            await pipe.execute()
        except Exception:
            pass

        # Compose provider payload as requested
        order_status_in = str(payload.get("order_status") or "OPEN")
        qty = _safe_float(payload.get("order_quantity"))
        entry_price = _safe_float(payload.get("order_price"))
        # Try to fetch missing fields from Redis canonical
        if qty is None or entry_price is None:
            try:
                od = await redis_cluster.hgetall(f"order_data:{order_id}")
                if qty is None:
                    qty = _safe_float(od.get("order_quantity"))
                if entry_price is None:
                    entry_price = _safe_float(od.get("order_price"))
                cv_existing = _safe_float(od.get("contract_value")) if od else None
            except Exception:
                cv_existing = None
        else:
            cv_existing = None
        # Compute contract_value if missing
        try:
            if cv_existing is not None:
                contract_value = float(cv_existing)
            else:
                gdata = await fetch_group_data(symbol, group)
                contract_size = _safe_float(gdata.get("contract_size")) or 1.0
                if qty is not None and entry_price is not None:
                    contract_value = float(contract_size * qty * entry_price)
                else:
                    contract_value = None
        except Exception:
            contract_value = None

        provider_payload = {
            "order_id": order_id,
            "symbol": symbol,
            "order_status": order_status_in,
            "status": "TAKEPROFIT",
            "order_type": side,
            "takeprofit": provider_tp,
            "type": "order",
        }
        if contract_value is not None:
            provider_payload["contract_value"] = contract_value
        if qty is not None:
            provider_payload["order_quantity"] = qty
        # Optional passthroughs
        if payload.get("takeprofit_id"):
            provider_payload["takeprofit_id"] = str(payload.get("takeprofit_id"))

        ok, via = await send_provider_order(provider_payload)
        if not ok:
            return {"ok": False, "reason": f"provider_send_failed:{via}"}

        return {
            "ok": True,
            "flow": flow,
            "order_id": order_id,
            "symbol": symbol,
            "order_type": side,
            "take_profit_sent": provider_tp,
            "note": "Takeprofit sent to provider; confirmation handled asynchronously",
        }
