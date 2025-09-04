import asyncio
import logging
from typing import Dict, Any, Tuple

logger = logging.getLogger(__name__)


class ProviderSendError(Exception):
    pass


async def _try_send_uds(payload: Dict[str, Any]) -> Tuple[bool, str]:
    # Placeholder: Simulate UDS send and ACK
    await asyncio.sleep(0.01)
    # Simulate success for now
    return True, "uds"


async def _try_send_tcp(payload: Dict[str, Any]) -> Tuple[bool, str]:
    # Placeholder: Simulate TCP send and ACK
    await asyncio.sleep(0.01)
    # Simulate success for now
    return True, "tcp"


async def send_provider_order(payload: Dict[str, Any]) -> Tuple[bool, str]:
    """
    Try to send order via UDS, fallback to TCP.
    Returns (ok, sent_via)
    """
    try:
        ok, via = await _try_send_uds(payload)
        if ok:
            return True, via
        ok2, via2 = await _try_send_tcp(payload)
        if ok2:
            return True, via2
        return False, "none"
    except Exception as e:
        logger.error("send_provider_order error: %s", e)
        return False, "error"
