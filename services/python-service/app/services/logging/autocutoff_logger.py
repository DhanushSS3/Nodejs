"""Autocutoff-specific logging utilities with dedicated rotating files."""
from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Dict

BASE_LOG_DIR = (
    Path(__file__).parent.parent.parent.parent / "logs" / "autocutoff"
)
BASE_LOG_DIR.mkdir(parents=True, exist_ok=True)

_LOGGER_CACHE: Dict[str, logging.Logger] = {}


def _build_handler(filename: str, max_bytes: int = 50 * 1024 * 1024, backup_count: int = 10):
    log_file = BASE_LOG_DIR / filename
    handler = RotatingFileHandler(
        filename=str(log_file),
        maxBytes=max_bytes,
        backupCount=backup_count,
        encoding="utf-8",
    )
    formatter = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler.setFormatter(formatter)
    setattr(handler, "_autocutoff", True)
    return handler


def _get_logger(name: str, filename: str) -> logging.Logger:
    if name in _LOGGER_CACHE:
        return _LOGGER_CACHE[name]

    logger = logging.getLogger(name)
    logger.setLevel(logging.INFO)

    # Avoid duplicating handlers if already configured
    for handler in list(logger.handlers):
        if getattr(handler, "_autocutoff", False):
            _LOGGER_CACHE[name] = logger
            return logger

    handler = _build_handler(filename)
    logger.handlers.clear()
    logger.addHandler(handler)
    logger.propagate = False

    _LOGGER_CACHE[name] = logger
    logger.info("Autocutoff logger '%s' initialized", name)
    return logger


def get_autocutoff_core_logger() -> logging.Logger:
    """Logs overall watcher/liquidation lifecycle events."""
    return _get_logger("autocutoff.core", "autocutoff_core.log")


def get_autocutoff_order_logger() -> logging.Logger:
    """Logs per-order liquidation attempts and outcomes."""
    return _get_logger("autocutoff.order", "autocutoff_orders.log")


def get_autocutoff_error_logger() -> logging.Logger:
    """Logs fatal errors happening inside the autocutoff pipeline."""
    return _get_logger("autocutoff.error", "autocutoff_errors.log")
