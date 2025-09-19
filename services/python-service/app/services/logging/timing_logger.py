import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

_logger: Optional[logging.Logger] = None


def get_orders_timing_logger() -> logging.Logger:
    global _logger
    if _logger is not None:
        return _logger
    lg = logging.getLogger("orders.timing")
    # Prevent duplicate handlers
    for h in lg.handlers:
        if isinstance(h, RotatingFileHandler) and getattr(h, "_orders_timing", False):
            _logger = lg
            return lg
    try:
        base_dir = Path(__file__).resolve().parents[3]
    except Exception:
        base_dir = Path('.')
    log_dir = base_dir / 'logs'
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / 'orders_timing.log'
    fh = RotatingFileHandler(str(log_file), maxBytes=20_000_000, backupCount=10, encoding='utf-8')
    fh.setFormatter(logging.Formatter('%(message)s'))
    fh._orders_timing = True  # marker
    lg.addHandler(fh)
    lg.setLevel(logging.INFO)
    _logger = lg
    return lg
