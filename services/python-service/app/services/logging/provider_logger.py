"""
Provider logging utilities for separate worker log files.
Each worker gets its own dedicated log file with proper rotation.
"""
import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Dict, Any
import orjson


# Base logs directory - ensure it's inside the python-service directory
BASE_LOG_DIR = Path(__file__).parent.parent.parent.parent / "logs" / "provider"
BASE_LOG_DIR.mkdir(parents=True, exist_ok=True)

# Logger cache to avoid creating duplicate loggers
_LOGGER_CACHE: Dict[str, logging.Logger] = {}


def _create_rotating_logger(
    name: str,
    filename: str,
    max_bytes: int = 50 * 1024 * 1024,  # 50MB
    backup_count: int = 10,
    level: int = logging.INFO
) -> logging.Logger:
    """Create a rotating file logger with specified parameters."""
    
    if name in _LOGGER_CACHE:
        return _LOGGER_CACHE[name]
    
    logger = logging.getLogger(name)
    logger.setLevel(level)
    
    # Clear any existing handlers
    logger.handlers.clear()
    
    # Create file path
    log_file = BASE_LOG_DIR / filename
    
    # Create rotating file handler with Windows-safe rotation
    try:
        # Try to create a Windows-safe rotating handler
        from logging.handlers import TimedRotatingFileHandler
        import platform
        
        if platform.system() == 'Windows':
            # Use TimedRotatingFileHandler for Windows to avoid file locking issues
            handler = TimedRotatingFileHandler(
                filename=str(log_file),
                when='midnight',
                interval=1,
                backupCount=backup_count,
                encoding='utf-8'
            )
        else:
            # Use RotatingFileHandler for non-Windows systems
            handler = RotatingFileHandler(
                filename=str(log_file),
                maxBytes=max_bytes,
                backupCount=backup_count,
                encoding='utf-8'
            )
    except Exception:
        # Fallback to basic file handler if rotation fails
        handler = logging.FileHandler(
            filename=str(log_file),
            encoding='utf-8'
        )
    
    # Set formatter
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s',
        datefmt='%Y-%m-%d %H:%M:%S'
    )
    handler.setFormatter(formatter)
    
    logger.addHandler(handler)
    logger.propagate = False  # Don't propagate to root logger
    
    _LOGGER_CACHE[name] = logger
    return logger


# Individual worker loggers
def get_worker_open_logger() -> logging.Logger:
    """Get logger for open worker operations."""
    return _create_rotating_logger(
        "provider.worker.open",
        "worker_open.log",
        max_bytes=75 * 1024 * 1024,  # 75MB
        backup_count=12
    )


def get_worker_close_logger() -> logging.Logger:
    """Get logger for close worker operations."""
    return _create_rotating_logger(
        "provider.worker.close",
        "worker_close.log",
        max_bytes=75 * 1024 * 1024,  # 75MB
        backup_count=12
    )


def get_worker_pending_logger() -> logging.Logger:
    """Get logger for pending worker operations."""
    return _create_rotating_logger(
        "provider.worker.pending",
        "worker_pending.log",
        max_bytes=50 * 1024 * 1024,  # 50MB
        backup_count=10
    )


def get_worker_cancel_logger() -> logging.Logger:
    """Get logger for cancel worker operations."""
    return _create_rotating_logger(
        "provider.worker.cancel",
        "worker_cancel.log",
        max_bytes=50 * 1024 * 1024,  # 50MB
        backup_count=10
    )


def get_worker_reject_logger() -> logging.Logger:
    """Get logger for reject worker operations."""
    return _create_rotating_logger(
        "provider.worker.reject",
        "worker_reject.log",
        max_bytes=50 * 1024 * 1024,  # 50MB
        backup_count=10
    )


def get_worker_stoploss_logger() -> logging.Logger:
    """Get logger for stop loss worker operations."""
    return _create_rotating_logger(
        "provider.worker.stoploss",
        "worker_stoploss.log",
        max_bytes=50 * 1024 * 1024,  # 50MB
        backup_count=10
    )


def get_worker_takeprofit_logger() -> logging.Logger:
    """Get logger for take profit worker operations."""
    return _create_rotating_logger(
        "provider.worker.takeprofit",
        "worker_takeprofit.log",
        max_bytes=50 * 1024 * 1024,  # 50MB
        backup_count=10
    )


def get_dispatcher_logger() -> logging.Logger:
    """Get logger for dispatcher operations."""
    return _create_rotating_logger(
        "provider.dispatcher",
        "dispatcher.log",
        max_bytes=100 * 1024 * 1024,  # 100MB
        backup_count=15
    )


def get_orders_calculated_logger() -> logging.Logger:
    """Get logger for calculated orders data."""
    return _create_rotating_logger(
        "provider.orders.calculated",
        "orders_calculated.log",
        max_bytes=200 * 1024 * 1024,  # 200MB
        backup_count=20
    )


def get_provider_errors_logger() -> logging.Logger:
    """Get logger for provider errors across all workers."""
    return _create_rotating_logger(
        "provider.errors",
        "provider_errors.log",
        max_bytes=100 * 1024 * 1024,  # 100MB
        backup_count=15
    )


# Utility functions for standardized logging
def log_order_processing(logger: logging.Logger, order_id: str, user_id: str, symbol: str, 
                        order_type: str, status: str, processing_time_ms: float = None,
                        additional_data: Dict[str, Any] = None) -> None:
    """Log standardized order processing information."""
    log_data = {
        "order_id": order_id,
        "user_id": user_id,
        "symbol": symbol,
        "order_type": order_type,
        "status": status,
    }
    
    if processing_time_ms is not None:
        log_data["processing_time_ms"] = processing_time_ms
    
    if additional_data:
        log_data.update(additional_data)
    
    logger.info(f"ORDER_PROCESSING: {orjson.dumps(log_data).decode()}")


def log_worker_stats(logger: logging.Logger, worker_type: str, stats: Dict[str, Any]) -> None:
    """Log worker performance statistics."""
    log_data = {
        "worker_type": worker_type,
        "timestamp": stats.get("timestamp"),
        "stats": stats
    }
    logger.info(f"WORKER_STATS: {orjson.dumps(log_data).decode()}")


def log_provider_stats(worker_type: str, stats: Dict[str, Any]) -> None:
    """Log provider statistics to appropriate worker logger."""
    logger_map = {
        "worker_open": get_worker_open_logger(),
        "worker_close": get_worker_close_logger(),
        "worker_pending": get_worker_pending_logger(),
        "worker_cancel": get_worker_cancel_logger(),
        "worker_reject": get_worker_reject_logger(),
        "worker_stoploss": get_worker_stoploss_logger(),
        "worker_takeprofit": get_worker_takeprofit_logger(),
        "dispatcher": get_dispatcher_logger(),
    }
    
    logger = logger_map.get(worker_type)
    if logger:
        log_worker_stats(logger, worker_type, stats)


def log_error_with_context(logger: logging.Logger, error: Exception, context: Dict[str, Any] = None) -> None:
    """Log error with additional context information."""
    error_data = {
        "error_type": type(error).__name__,
        "error_message": str(error),
        "error_details": context or {}
    }
    logger.error(f"ERROR_CONTEXT: {orjson.dumps(error_data).decode()}", exc_info=True)


def log_success_with_metrics(logger: logging.Logger, operation: str, metrics: Dict[str, Any]) -> None:
    """Log successful operation with performance metrics."""
    success_data = {
        "operation": operation,
        "status": "success",
        "metrics": metrics
    }
    logger.info(f"SUCCESS_METRICS: {orjson.dumps(success_data).decode()}")


# Initialize all loggers on import to ensure directories exist
def initialize_all_loggers():
    """Initialize all provider loggers to ensure log files and directories exist."""
    loggers = [
        get_worker_open_logger(),
        get_worker_close_logger(),
        get_worker_pending_logger(),
        get_worker_cancel_logger(),
        get_worker_reject_logger(),
        get_worker_stoploss_logger(),
        get_worker_takeprofit_logger(),
        get_dispatcher_logger(),
        get_orders_calculated_logger(),
        get_provider_errors_logger(),
    ]
    
    # Log initialization message to each logger
    for logger in loggers:
        logger.info("Provider logger initialized successfully")


# Initialize on module import
initialize_all_loggers()
