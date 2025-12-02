"""Redis order audit logger for Python services.
Captures key creation/removal events into a rotating file so we can
trace order-related Redis mutations alongside the Node.js audit log.
"""
from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict
import json

_logger: logging.Logger | None = None

def _build_logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger

    base_dir = Path(__file__).resolve().parents[3]
    logs_dir = base_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_file = logs_dir / "redis-orders.log"

    logger = logging.getLogger("redis_order_audit")
    logger.setLevel(logging.INFO)
    logger.propagate = False

    handler = RotatingFileHandler(
        log_file,
        maxBytes=10 * 1024 * 1024,
        backupCount=10,
        encoding="utf-8"
    )
    formatter = logging.Formatter('%(asctime)s %(message)s')
    handler.setFormatter(formatter)
    logger.addHandler(handler)

    _logger = logger
    return logger

def log_redis_order_event(event: str, context: Dict[str, Any] | None = None) -> None:
    """Write a structured order audit entry."""
    logger = _build_logger()
    payload = {
        "event": event,
        **(context or {})
    }
    try:
        logger.info(json.dumps(payload, default=str))
    except Exception:
        # Best-effort logging; avoid raising in worker paths
        logger.exception("Failed to serialize redis audit payload", exc_info=True)
