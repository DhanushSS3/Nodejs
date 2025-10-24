"""
Execution price logging utilities for debugging wrong execution price issues.
Creates dedicated log files for different types of execution price problems.
"""
import logging
import json
import time
from typing import Dict, Any, Optional
from pathlib import Path
import orjson
from .provider_logger import _create_rotating_logger

# Base logs directory for execution price logs
EXECUTION_PRICE_LOG_DIR = Path(__file__).parent.parent.parent.parent / "logs" / "execution_price"
EXECUTION_PRICE_LOG_DIR.mkdir(parents=True, exist_ok=True)

class ExecutionPriceLogger:
    """
    Dedicated logger for execution price debugging and monitoring
    Creates separate log files for different types of execution price issues
    """
    
    def __init__(self):
        # Create specialized loggers for different execution price issues
        self._setup_loggers()
    
    def _setup_loggers(self):
        """Setup specialized loggers for different execution price issues"""
        
        # 1. Stale Price Logger
        self.stale_price_logger = _create_rotating_logger(
            "execution_price.stale",
            f"../execution_price/execution_price_stale.log",
            max_bytes=50 * 1024 * 1024,  # 50MB
            backup_count=10
        )
        
        # 2. Price Inconsistency Logger
        self.price_inconsistency_logger = _create_rotating_logger(
            "execution_price.inconsistent", 
            f"../execution_price/execution_price_inconsistent.log",
            max_bytes=25 * 1024 * 1024,  # 25MB
            backup_count=8
        )
        
        # 3. Missing Price Data Logger
        self.missing_price_logger = _create_rotating_logger(
            "execution_price.missing",
            f"../execution_price/execution_price_missing.log",
            max_bytes=25 * 1024 * 1024,  # 25MB
            backup_count=8
        )
        
        # 4. Execution Price Calculation Logger
        self.calculation_logger = _create_rotating_logger(
            "execution_price.calculation",
            f"../execution_price/execution_price_calculation.log",
            max_bytes=100 * 1024 * 1024,  # 100MB
            backup_count=15
        )
        
        # 5. User-specific execution price issues (rock/demo users)
        self.user_issues_logger = _create_rotating_logger(
            "execution_price.user_issues",
            f"../execution_price/execution_price_user_issues.log",
            max_bytes=75 * 1024 * 1024,  # 75MB
            backup_count=12
        )
        
        # 6. WebSocket data issues
        self.websocket_issues_logger = _create_rotating_logger(
            "execution_price.websocket",
            f"../execution_price/execution_price_websocket.log",
            max_bytes=50 * 1024 * 1024,  # 50MB
            backup_count=10
        )
        
        # 7. Market data processing issues
        self.market_data_logger = _create_rotating_logger(
            "execution_price.market_data",
            f"../execution_price/execution_price_market_data.log",
            max_bytes=75 * 1024 * 1024,  # 75MB
            backup_count=12
        )
    
    def log_stale_price_issue(self, symbol: str, user_type: str, user_id: str, 
                             price_timestamp: int, current_timestamp: int, 
                             staleness_seconds: float, **kwargs):
        """Log stale price detection with detailed context"""
        log_data = {
            "issue_type": "STALE_PRICE",
            "symbol": symbol,
            "user_type": user_type,
            "user_id": user_id,
            "price_timestamp": price_timestamp,
            "current_timestamp": current_timestamp,
            "staleness_seconds": round(staleness_seconds, 3),
            "threshold_seconds": kwargs.get("threshold_seconds", 5.0),
            "severity": "HIGH" if staleness_seconds > 10 else "MEDIUM",
            **kwargs
        }
        
        self.stale_price_logger.error(f"STALE_PRICE_DETECTED: {orjson.dumps(log_data).decode()}")
        
        # Also log to user issues if user info available
        if user_type and user_id:
            self.user_issues_logger.warning(f"USER_STALE_PRICE: {orjson.dumps(log_data).decode()}")
    
    def log_price_inconsistency(self, symbol: str, bid: float, ask: float, 
                               user_type: str = None, user_id: str = None, **kwargs):
        """Log price inconsistency (ask < bid, etc.)"""
        spread = ask - bid if (bid is not None and ask is not None) else None
        log_data = {
            "issue_type": "PRICE_INCONSISTENCY",
            "symbol": symbol,
            "bid": bid,
            "ask": ask,
            "spread": round(spread, 6) if spread is not None else None,
            "user_type": user_type,
            "user_id": user_id,
            "timestamp": int(time.time() * 1000),
            "severity": "CRITICAL" if spread and spread < 0 else "HIGH",
            **kwargs
        }
        
        self.price_inconsistency_logger.error(f"PRICE_INCONSISTENCY: {orjson.dumps(log_data).decode()}")
        
        # Critical issue - also log to market data logger
        if spread and spread < 0:
            self.market_data_logger.critical(f"NEGATIVE_SPREAD: {orjson.dumps(log_data).decode()}")
    
    def log_missing_price_data(self, symbol: str, missing_fields: list, 
                              user_type: str = None, user_id: str = None, **kwargs):
        """Log missing price data (bid/ask/timestamp)"""
        log_data = {
            "issue_type": "MISSING_PRICE_DATA",
            "symbol": symbol,
            "missing_fields": missing_fields,
            "user_type": user_type,
            "user_id": user_id,
            "timestamp": int(time.time() * 1000),
            "severity": "HIGH" if "timestamp" in missing_fields else "MEDIUM",
            **kwargs
        }
        
        self.missing_price_logger.error(f"MISSING_PRICE_DATA: {orjson.dumps(log_data).decode()}")
    
    def log_execution_price_calculation(self, symbol: str, user_group: str, 
                                      order_type: str, raw_price: float, 
                                      half_spread: float, exec_price: float,
                                      user_type: str = None, user_id: str = None, 
                                      success: bool = True, **kwargs):
        """Log execution price calculation details"""
        log_data = {
            "issue_type": "EXECUTION_PRICE_CALCULATION",
            "symbol": symbol,
            "user_group": user_group,
            "order_type": order_type,
            "raw_price": round(raw_price, 6) if raw_price else None,
            "half_spread": round(half_spread, 6) if half_spread else None,
            "exec_price": round(exec_price, 6) if exec_price else None,
            "user_type": user_type,
            "user_id": user_id,
            "success": success,
            "timestamp": int(time.time() * 1000),
            **kwargs
        }
        
        if success:
            # Only log successful calculations for rock/demo users or when specifically requested
            if user_type in ["rock", "demo"] or kwargs.get("force_log", False):
                self.calculation_logger.info(f"EXEC_PRICE_SUCCESS: {orjson.dumps(log_data).decode()}")
        else:
            self.calculation_logger.error(f"EXEC_PRICE_FAILED: {orjson.dumps(log_data).decode()}")
            
            # Also log to user issues if user info available
            if user_type and user_id:
                self.user_issues_logger.error(f"USER_EXEC_PRICE_FAILED: {orjson.dumps(log_data).decode()}")
    
    def log_user_execution_issue(self, user_type: str, user_id: str, symbol: str,
                                order_type: str, issue_description: str, 
                                order_id: str = None, **kwargs):
        """Log user-specific execution price issues (especially for rock/demo users)"""
        log_data = {
            "issue_type": "USER_EXECUTION_ISSUE",
            "user_type": user_type,
            "user_id": user_id,
            "symbol": symbol,
            "order_type": order_type,
            "order_id": order_id,
            "issue_description": issue_description,
            "timestamp": int(time.time() * 1000),
            "severity": "CRITICAL" if user_type in ["rock", "demo"] else "HIGH",
            **kwargs
        }
        
        self.user_issues_logger.error(f"USER_EXECUTION_ISSUE: {orjson.dumps(log_data).decode()}")
        
        # For rock/demo users, also log to calculation logger for correlation
        if user_type in ["rock", "demo"]:
            self.calculation_logger.error(f"ROCK_DEMO_ISSUE: {orjson.dumps(log_data).decode()}")
    
    def log_websocket_data_issue(self, issue_type: str, message_size: int = None,
                                processing_time_ms: float = None, 
                                symbols_count: int = None, **kwargs):
        """Log WebSocket data processing issues"""
        log_data = {
            "issue_type": f"WEBSOCKET_{issue_type}",
            "message_size": message_size,
            "processing_time_ms": round(processing_time_ms, 2) if processing_time_ms else None,
            "symbols_count": symbols_count,
            "timestamp": int(time.time() * 1000),
            "severity": "HIGH" if processing_time_ms and processing_time_ms > 100 else "MEDIUM",
            **kwargs
        }
        
        self.websocket_issues_logger.warning(f"WEBSOCKET_ISSUE: {orjson.dumps(log_data).decode()}")
    
    def log_redis_operation_issue(self, operation: str, symbol: str = None,
                                 error: str = None, latency_ms: float = None, **kwargs):
        """Log Redis operation issues that might affect execution prices"""
        log_data = {
            "issue_type": "REDIS_OPERATION_ISSUE",
            "operation": operation,
            "symbol": symbol,
            "error": error,
            "latency_ms": round(latency_ms, 2) if latency_ms else None,
            "timestamp": int(time.time() * 1000),
            "severity": "HIGH" if latency_ms and latency_ms > 100 else "MEDIUM",
            **kwargs
        }
        
        self.calculation_logger.warning(f"REDIS_ISSUE: {orjson.dumps(log_data).decode()}")
    
    def log_market_data_processing(self, symbols_processed: int, processing_time_ms: float,
                                  batch_size: int, success: bool, **kwargs):
        """Log market data batch processing metrics"""
        log_data = {
            "issue_type": "MARKET_DATA_PROCESSING",
            "symbols_processed": symbols_processed,
            "processing_time_ms": round(processing_time_ms, 2),
            "batch_size": batch_size,
            "success": success,
            "avg_time_per_symbol": round(processing_time_ms / symbols_processed, 2) if symbols_processed > 0 else 0,
            "timestamp": int(time.time() * 1000),
            **kwargs
        }
        
        if success:
            if processing_time_ms > 500:  # Log slow processing
                self.market_data_logger.warning(f"SLOW_MARKET_PROCESSING: {orjson.dumps(log_data).decode()}")
            elif kwargs.get("force_log", False):
                self.market_data_logger.info(f"MARKET_PROCESSING: {orjson.dumps(log_data).decode()}")
        else:
            self.market_data_logger.error(f"MARKET_PROCESSING_FAILED: {orjson.dumps(log_data).decode()}")

# Global instance
execution_price_logger = ExecutionPriceLogger()

# Convenience functions for easy import and use
def log_stale_price(symbol: str, user_type: str, user_id: str, 
                   price_timestamp: int, current_timestamp: int, 
                   staleness_seconds: float, **kwargs):
    """Convenience function to log stale price issues"""
    execution_price_logger.log_stale_price_issue(
        symbol, user_type, user_id, price_timestamp, 
        current_timestamp, staleness_seconds, **kwargs
    )

def log_price_inconsistency(symbol: str, bid: float, ask: float, 
                           user_type: str = None, user_id: str = None, **kwargs):
    """Convenience function to log price inconsistencies"""
    execution_price_logger.log_price_inconsistency(
        symbol, bid, ask, user_type, user_id, **kwargs
    )

def log_missing_price_data(symbol: str, missing_fields: list, 
                          user_type: str = None, user_id: str = None, **kwargs):
    """Convenience function to log missing price data"""
    execution_price_logger.log_missing_price_data(
        symbol, missing_fields, user_type, user_id, **kwargs
    )

def log_execution_calculation(symbol: str, user_group: str, order_type: str, 
                             raw_price: float, half_spread: float, exec_price: float,
                             user_type: str = None, user_id: str = None, 
                             success: bool = True, **kwargs):
    """Convenience function to log execution price calculations"""
    execution_price_logger.log_execution_price_calculation(
        symbol, user_group, order_type, raw_price, half_spread, exec_price,
        user_type, user_id, success, **kwargs
    )

def log_user_issue(user_type: str, user_id: str, symbol: str, order_type: str, 
                   issue_description: str, order_id: str = None, **kwargs):
    """Convenience function to log user-specific issues"""
    execution_price_logger.log_user_execution_issue(
        user_type, user_id, symbol, order_type, issue_description, order_id, **kwargs
    )

def log_websocket_issue(issue_type: str, **kwargs):
    """Convenience function to log WebSocket issues"""
    execution_price_logger.log_websocket_data_issue(issue_type, **kwargs)

def log_redis_issue(operation: str, **kwargs):
    """Convenience function to log Redis issues"""
    execution_price_logger.log_redis_operation_issue(operation, **kwargs)

def log_market_processing(symbols_processed: int, processing_time_ms: float,
                         batch_size: int, success: bool, **kwargs):
    """Convenience function to log market data processing"""
    execution_price_logger.log_market_data_processing(
        symbols_processed, processing_time_ms, batch_size, success, **kwargs
    )
