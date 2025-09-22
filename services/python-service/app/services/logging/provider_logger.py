"""
Centralized logging configuration for provider services with file rotation.
Provides separate log files for dispatcher, workers, and calculated orders.
"""

import os
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Dict, Optional
import threading

# Thread-safe logger cache
_logger_cache: Dict[str, logging.Logger] = {}
_cache_lock = threading.Lock()

# Default log configuration
DEFAULT_LOG_CONFIG = {
    'max_bytes': 50 * 1024 * 1024,  # 50MB per file
    'backup_count': 10,  # Keep 10 backup files
    'format': '%(asctime)s [%(levelname)s] [%(name)s] %(message)s',
    'date_format': '%Y-%m-%d %H:%M:%S',
    'encoding': 'utf-8'
}

def get_log_directory() -> Path:
    """Get the logs directory, creating it if it doesn't exist."""
    try:
        # Get the base directory (services/python-service)
        base_dir = Path(__file__).resolve().parents[4]
    except Exception:
        base_dir = Path('.')
    
    log_dir = base_dir / 'logs' / 'provider'
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir

def create_rotating_logger(
    name: str,
    log_filename: str,
    level: str = None,
    max_bytes: int = None,
    backup_count: int = None,
    format_string: str = None
) -> logging.Logger:
    """
    Create a logger with rotating file handler.
    
    Args:
        name: Logger name (e.g., 'provider.dispatcher')
        log_filename: Log file name (e.g., 'dispatcher.log')
        level: Log level (defaults to LOG_LEVEL env var or INFO)
        max_bytes: Max file size before rotation (defaults to 50MB)
        backup_count: Number of backup files to keep (defaults to 10)
        format_string: Custom log format string
    
    Returns:
        Configured logger instance
    """
    with _cache_lock:
        # Return cached logger if it exists
        if name in _logger_cache:
            return _logger_cache[name]
        
        # Create new logger
        logger = logging.getLogger(name)
        
        # Avoid duplicate handlers
        if logger.handlers:
            _logger_cache[name] = logger
            return logger
        
        # Configuration with defaults
        log_level = level or os.getenv("LOG_LEVEL", "INFO")
        max_file_size = max_bytes or DEFAULT_LOG_CONFIG['max_bytes']
        backup_files = backup_count or DEFAULT_LOG_CONFIG['backup_count']
        log_format = format_string or DEFAULT_LOG_CONFIG['format']
        
        # Set logger level
        logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))
        
        # Create log directory and file path
        log_dir = get_log_directory()
        log_file = log_dir / log_filename
        
        # Create rotating file handler
        file_handler = RotatingFileHandler(
            str(log_file),
            maxBytes=max_file_size,
            backupCount=backup_files,
            encoding=DEFAULT_LOG_CONFIG['encoding']
        )
        
        # Set formatter
        formatter = logging.Formatter(
            log_format,
            datefmt=DEFAULT_LOG_CONFIG['date_format']
        )
        file_handler.setFormatter(formatter)
        
        # Add handler to logger
        logger.addHandler(file_handler)
        
        # Prevent propagation to root logger to avoid duplicate console output
        logger.propagate = False
        
        # Cache the logger
        _logger_cache[name] = logger
        
        # Log initial message
        logger.info(f"Logger '{name}' initialized - File: {log_file}, Max Size: {max_file_size/1024/1024:.1f}MB, Backups: {backup_files}")
        
        return logger

def get_dispatcher_logger() -> logging.Logger:
    """Get the dispatcher logger with dedicated log file."""
    return create_rotating_logger(
        name='provider.dispatcher',
        log_filename='dispatcher.log',
        max_bytes=100 * 1024 * 1024,  # 100MB for dispatcher (high volume)
        backup_count=15
    )

def get_worker_open_logger() -> logging.Logger:
    """Get the open worker logger with dedicated log file."""
    return create_rotating_logger(
        name='provider.worker.open',
        log_filename='worker_open.log',
        max_bytes=75 * 1024 * 1024,  # 75MB for open worker
        backup_count=12
    )

def get_worker_close_logger() -> logging.Logger:
    """Get the close worker logger with dedicated log file."""
    return create_rotating_logger(
        name='provider.worker.close',
        log_filename='worker_close.log',
        max_bytes=75 * 1024 * 1024,  # 75MB for close worker
        backup_count=12
    )

def get_worker_pending_logger() -> logging.Logger:
    """Get the pending worker logger with dedicated log file."""
    return create_rotating_logger(
        name='provider.worker.pending',
        log_filename='worker_pending.log',
        max_bytes=50 * 1024 * 1024,  # 50MB for pending worker
        backup_count=10
    )

def get_worker_cancel_logger() -> logging.Logger:
    """Get the cancel worker logger with dedicated log file."""
    return create_rotating_logger(
        name='provider.worker.cancel',
        log_filename='worker_cancel.log',
        max_bytes=50 * 1024 * 1024,  # 50MB for cancel worker
        backup_count=10
    )

def get_worker_reject_logger() -> logging.Logger:
    """Get the reject worker logger with dedicated log file."""
    return create_rotating_logger(
        name='provider.worker.reject',
        log_filename='worker_reject.log',
        max_bytes=50 * 1024 * 1024,  # 50MB for reject worker
        backup_count=10
    )

def get_orders_calculated_logger() -> logging.Logger:
    """Get the orders calculated logger with dedicated log file."""
    return create_rotating_logger(
        name='provider.orders.calculated',
        log_filename='orders_calculated.log',
        max_bytes=200 * 1024 * 1024,  # 200MB for calculated orders (JSON logs)
        backup_count=20,
        format_string='%(asctime)s %(message)s'  # Simplified format for JSON logs
    )

def get_provider_errors_logger() -> logging.Logger:
    """Get the provider errors logger for critical issues."""
    return create_rotating_logger(
        name='provider.errors',
        log_filename='provider_errors.log',
        max_bytes=100 * 1024 * 1024,  # 100MB for errors
        backup_count=15
    )

def log_provider_stats(component: str, stats: dict) -> None:
    """Log provider component statistics to dedicated stats logger."""
    stats_logger = create_rotating_logger(
        name='provider.stats',
        log_filename='provider_stats.log',
        max_bytes=50 * 1024 * 1024,
        backup_count=10,
        format_string='%(asctime)s [STATS] %(message)s'
    )
    
    import orjson
    stats_data = {
        'component': component,
        'timestamp': stats.get('timestamp'),
        **stats
    }
    stats_logger.info(orjson.dumps(stats_data).decode())

def cleanup_old_logs(days_to_keep: int = 30) -> None:
    """
    Clean up log files older than specified days.
    
    Args:
        days_to_keep: Number of days to keep log files (default: 30)
    """
    import time
    
    log_dir = get_log_directory()
    cutoff_time = time.time() - (days_to_keep * 24 * 3600)
    
    cleanup_logger = create_rotating_logger(
        name='provider.cleanup',
        log_filename='cleanup.log'
    )
    
    cleaned_count = 0
    try:
        for log_file in log_dir.glob('*.log*'):
            if log_file.stat().st_mtime < cutoff_time:
                try:
                    log_file.unlink()
                    cleaned_count += 1
                    cleanup_logger.info(f"Deleted old log file: {log_file.name}")
                except Exception as e:
                    cleanup_logger.error(f"Failed to delete {log_file.name}: {e}")
        
        cleanup_logger.info(f"Log cleanup completed. Removed {cleaned_count} old files.")
    except Exception as e:
        cleanup_logger.error(f"Log cleanup failed: {e}")

# Convenience function to get all loggers for health checks
def get_all_provider_loggers() -> Dict[str, logging.Logger]:
    """Get all provider loggers for health monitoring."""
    return {
        'dispatcher': get_dispatcher_logger(),
        'worker_open': get_worker_open_logger(),
        'worker_close': get_worker_close_logger(),
        'worker_pending': get_worker_pending_logger(),
        'worker_cancel': get_worker_cancel_logger(),
        'worker_reject': get_worker_reject_logger(),
        'orders_calculated': get_orders_calculated_logger(),
        'provider_errors': get_provider_errors_logger()
    }

# Auto-cleanup on module import (optional)
if os.getenv('AUTO_CLEANUP_LOGS', 'false').lower() == 'true':
    try:
        cleanup_old_logs(int(os.getenv('LOG_RETENTION_DAYS', '30')))
    except Exception:
        pass
