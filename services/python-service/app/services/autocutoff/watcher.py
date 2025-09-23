import asyncio
import logging
from typing import Optional

from app.config.redis_config import redis_cluster, redis_pubsub_client
from .notifier import EmailNotifier
from .liquidation import LiquidationEngine

logger = logging.getLogger(__name__)

ALERT_TTL_SEC = 10800  # 3 hours (3 * 60 * 60)


async def _get_margin_level(user_type: str, user_id: str) -> float:
    try:
        pf = await redis_cluster.hgetall(f"user_portfolio:{{{user_type}:{user_id}}}")
        if pf and pf.get("margin_level") is not None:
            return float(pf.get("margin_level"))
    except Exception:
        pass
    return 0.0


async def _get_user_email(user_type: str, user_id: str) -> Optional[str]:
    try:
        key = f"user:{{{user_type}:{user_id}}}:config"
        data = await redis_cluster.hgetall(key)
        em = (data or {}).get("email")
        if em:
            return str(em)
    except Exception:
        pass
    return None


async def _clear_flags(user_type: str, user_id: str):
    try:
        pipe = redis_cluster.pipeline()
        pipe.delete(f"autocutoff:liquidating:{user_type}:{user_id}")
        pipe.delete(f"autocutoff:alert_sent:{user_type}:{user_id}")
        await pipe.execute()
    except Exception:
        pass


async def _handle_user(user_type: str, user_id: str, notifier: EmailNotifier, liq: LiquidationEngine):
    ml = await _get_margin_level(user_type, user_id)
    if ml >= 100.0:
        await _clear_flags(user_type, user_id)
        return

    # Alert zone
    if 50.0 <= ml < 100.0:
        # rate-limit via Redis TTL flag with atomic check-and-set
        alert_key = f"autocutoff:alert_sent:{user_type}:{user_id}"
        try:
            # Use SET with NX (only if not exists) to prevent race conditions
            # TTL is 3 hours to limit alerts to once every 3 hours
            already_set = await redis_cluster.set(alert_key, "1", ex=ALERT_TTL_SEC, nx=True)
            if not already_set:
                # Alert already sent within TTL period
                return
        except Exception:
            # Fallback to simple check if SET NX fails
            try:
                already = await redis_cluster.get(alert_key)
                if already:
                    return
            except Exception:
                pass
        
        email = await _get_user_email(user_type, user_id)
        ok = await notifier.send_alert(user_type=user_type, user_id=user_id, email=email, margin_level=ml, threshold=100.0)
        if not ok:
            # If email failed, remove the TTL key so we can retry later
            try:
                await redis_cluster.delete(alert_key)
            except Exception:
                pass
        return

    # Liquidation zone
    if ml < 50.0:
        liq_key = f"autocutoff:liquidating:{user_type}:{user_id}"
        try:
            got = await redis_cluster.set(liq_key, "1", nx=True)
        except Exception:
            got = None
        if not got:
            # already running
            return
        try:
            await liq.run(user_type=user_type, user_id=user_id)
        finally:
            try:
                await redis_cluster.delete(liq_key)
            except Exception:
                pass


async def _watch_loop():
    notifier = EmailNotifier()
    liq = LiquidationEngine()

    # Subscribe to portfolio updates
    pubsub = redis_pubsub_client.pubsub()
    await pubsub.subscribe("portfolio_updates")
    logger.info("AutoCutoffWatcher subscribed to portfolio_updates")

    try:
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            data = str(message.get("data") or "")
            if ":" not in data:
                continue
            user_type, user_id = data.split(":", 1)
            user_type = user_type.strip().lower()
            user_id = user_id.strip()
            # Fire-and-forget per-user handler to avoid blocking the loop
            asyncio.create_task(_handle_user(user_type, user_id, notifier, liq))
    except asyncio.CancelledError:
        logger.info("AutoCutoffWatcher cancelled")
    except Exception as e:
        logger.exception("AutoCutoffWatcher error: %s", e)
    finally:
        try:
            await pubsub.unsubscribe("portfolio_updates")
            await pubsub.close()
        except Exception:
            pass


async def start_autocutoff_watcher():
    logger.info("Starting AutoCutoffWatcher...")
    asyncio.create_task(_watch_loop())
