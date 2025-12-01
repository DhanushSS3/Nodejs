import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path


_LOGGER_NAME = "orders.symbol_holders"
_LOG_FILE = Path(__file__).resolve().parents[3] / "logs" / "symbol_holders.log"
_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

_symbol_logger: logging.Logger | None = None


def get_symbol_holders_logger() -> logging.Logger:
    global _symbol_logger
    if _symbol_logger:
        return _symbol_logger

    logger = logging.getLogger(_LOGGER_NAME)
    logger.setLevel(logging.INFO)

    # Avoid duplicate handlers when re-imported
    if not any(isinstance(h, RotatingFileHandler) and getattr(h, "_symbol_holders", False) for h in logger.handlers):
        handler = RotatingFileHandler(
            filename=str(_LOG_FILE),
            maxBytes=10 * 1024 * 1024,
            backupCount=5,
            encoding="utf-8",
        )
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        handler._symbol_holders = True  # type: ignore[attr-defined]
        logger.addHandler(handler)
        logger.propagate = False

    _symbol_logger = logger
    return logger
