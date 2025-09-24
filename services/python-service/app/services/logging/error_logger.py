"""
Error logging utilities for Python service.
Provides centralized error logging with file rotation for debugging and monitoring.
"""
import logging
import os
import traceback
import uuid
from datetime import datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Dict, Any, Optional
import orjson


# Base logs directory
BASE_LOG_DIR = Path(__file__).parent.parent.parent.parent / "logs"
BASE_LOG_DIR.mkdir(parents=True, exist_ok=True)

# Logger cache to avoid creating duplicate loggers
_LOGGER_CACHE: Dict[str, logging.Logger] = {}


def _create_rotating_logger(
    name: str,
    filename: str,
    max_bytes: int = 100 * 1024 * 1024,  # 100MB
    backup_count: int = 15,
    level: int = logging.ERROR
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
    
    # Create rotating file handler
    handler = RotatingFileHandler(
        filename=str(log_file),
        maxBytes=max_bytes,
        backupCount=backup_count,
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


def get_error_logger() -> logging.Logger:
    """Get the main error logger for Python service."""
    return _create_rotating_logger(
        "python.service.errors",
        "python_errors.log",
        max_bytes=100 * 1024 * 1024,  # 100MB
        backup_count=15
    )


def get_api_error_logger() -> logging.Logger:
    """Get logger for API-specific errors."""
    return _create_rotating_logger(
        "python.service.api.errors",
        "python_api_errors.log",
        max_bytes=50 * 1024 * 1024,  # 50MB
        backup_count=10
    )


def get_service_error_logger() -> logging.Logger:
    """Get logger for service-layer errors."""
    return _create_rotating_logger(
        "python.service.service.errors",
        "python_service_errors.log",
        max_bytes=75 * 1024 * 1024,  # 75MB
        backup_count=12
    )


class ErrorLogger:
    """Centralized error logging utility for Python service."""
    
    @staticmethod
    def generate_correlation_id() -> str:
        """Generate a unique correlation ID for error tracking."""
        return f"py_err_{int(datetime.now().timestamp() * 1000)}_{str(uuid.uuid4())[:8]}"
    
    @staticmethod
    def log_error(
        error: Exception,
        context: Dict[str, Any] = None,
        logger_type: str = "general",
        correlation_id: str = None
    ) -> str:
        """
        Log error with detailed context information.
        
        Args:
            error: The exception object
            context: Additional context information
            logger_type: Type of logger to use ('general', 'api', 'service')
            correlation_id: Optional correlation ID for tracking
            
        Returns:
            str: The correlation ID for this error
        """
        if correlation_id is None:
            correlation_id = ErrorLogger.generate_correlation_id()
        
        # Select appropriate logger
        logger_map = {
            "general": get_error_logger(),
            "api": get_api_error_logger(),
            "service": get_service_error_logger()
        }
        logger = logger_map.get(logger_type, get_error_logger())
        
        # Prepare error data
        error_data = {
            "timestamp": datetime.now().isoformat(),
            "correlation_id": correlation_id,
            "error_type": type(error).__name__,
            "error_message": str(error),
            "stack_trace": traceback.format_exc(),
            "context": context or {}
        }
        
        # Log the error
        logger.error(f"ERROR_LOGGED: {orjson.dumps(error_data).decode()}")
        
        return correlation_id
    
    @staticmethod
    def log_api_error(
        error: Exception,
        endpoint: str = None,
        method: str = None,
        user_id: str = None,
        user_type: str = None,
        request_data: Dict[str, Any] = None,
        additional_context: Dict[str, Any] = None
    ) -> str:
        """
        Log API-specific error with request context.
        
        Args:
            error: The exception object
            endpoint: API endpoint where error occurred
            method: HTTP method
            user_id: User ID if available
            user_type: User type if available
            request_data: Request data that caused the error
            additional_context: Additional context information
            
        Returns:
            str: The correlation ID for this error
        """
        context = {
            "endpoint": endpoint or "unknown",
            "method": method or "unknown",
            "user_id": user_id or "anonymous",
            "user_type": user_type or "unknown",
            "request_data": ErrorLogger.sanitize_data(request_data or {}),
            "additional_context": additional_context or {}
        }
        
        return ErrorLogger.log_error(error, context, "api")
    
    @staticmethod
    def log_service_error(
        error: Exception,
        service_name: str = None,
        operation: str = None,
        user_id: str = None,
        additional_context: Dict[str, Any] = None
    ) -> str:
        """
        Log service-layer error with service context.
        
        Args:
            error: The exception object
            service_name: Name of the service
            operation: Operation being performed
            user_id: User ID if available
            additional_context: Additional context information
            
        Returns:
            str: The correlation ID for this error
        """
        context = {
            "service_name": service_name or "unknown",
            "operation": operation or "unknown",
            "user_id": user_id or "anonymous",
            "additional_context": additional_context or {}
        }
        
        return ErrorLogger.log_error(error, context, "service")
    
    @staticmethod
    def log_database_error(
        error: Exception,
        query: str = None,
        table: str = None,
        operation: str = None,
        user_id: str = None
    ) -> str:
        """
        Log database-specific error.
        
        Args:
            error: The exception object
            query: SQL query that failed (will be sanitized)
            table: Database table involved
            operation: Database operation (SELECT, INSERT, UPDATE, DELETE)
            user_id: User ID if available
            
        Returns:
            str: The correlation ID for this error
        """
        context = {
            "database_operation": operation or "unknown",
            "table": table or "unknown",
            "query": ErrorLogger.sanitize_query(query) if query else "unknown",
            "user_id": user_id or "anonymous"
        }
        
        return ErrorLogger.log_error(error, context, "service")
    
    @staticmethod
    def log_redis_error(
        error: Exception,
        operation: str = None,
        key: str = None,
        user_id: str = None,
        additional_context: Dict[str, Any] = None
    ) -> str:
        """
        Log Redis-specific error.
        
        Args:
            error: The exception object
            operation: Redis operation (GET, SET, HGET, etc.)
            key: Redis key involved
            user_id: User ID if available
            additional_context: Additional context information
            
        Returns:
            str: The correlation ID for this error
        """
        context = {
            "redis_operation": operation or "unknown",
            "redis_key": key or "unknown",
            "user_id": user_id or "anonymous",
            "additional_context": additional_context or {}
        }
        
        return ErrorLogger.log_error(error, context, "service")
    
    @staticmethod
    def log_external_service_error(
        error: Exception,
        service_name: str = None,
        endpoint: str = None,
        operation: str = None,
        response_data: Dict[str, Any] = None,
        additional_context: Dict[str, Any] = None
    ) -> str:
        """
        Log external service error (provider, market data, etc.).
        
        Args:
            error: The exception object
            service_name: Name of the external service
            endpoint: Service endpoint
            operation: Operation being performed
            response_data: Response data from service
            additional_context: Additional context information
            
        Returns:
            str: The correlation ID for this error
        """
        context = {
            "external_service": service_name or "unknown",
            "service_endpoint": endpoint or "unknown",
            "operation": operation or "unknown",
            "response_data": ErrorLogger.sanitize_data(response_data or {}),
            "additional_context": additional_context or {}
        }
        
        return ErrorLogger.log_error(error, context, "service")
    
    @staticmethod
    def sanitize_data(data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Sanitize data to remove sensitive information before logging.
        
        Args:
            data: Data dictionary to sanitize
            
        Returns:
            Dict[str, Any]: Sanitized data dictionary
        """
        if not isinstance(data, dict):
            return data
        
        sensitive_fields = {
            'password', 'confirm_password', 'old_password', 'new_password',
            'token', 'refresh_token', 'access_token', 'api_key', 'secret',
            'otp', 'pin', 'cvv', 'card_number', 'account_number',
            'bank_account_number', 'iban', 'swift', 'upi_id'
        }
        
        sanitized = {}
        for key, value in data.items():
            if isinstance(key, str) and key.lower() in sensitive_fields:
                sanitized[key] = '[REDACTED]'
            elif isinstance(value, dict):
                sanitized[key] = ErrorLogger.sanitize_data(value)
            elif isinstance(value, list):
                sanitized[key] = [
                    ErrorLogger.sanitize_data(item) if isinstance(item, dict) else item
                    for item in value
                ]
            else:
                sanitized[key] = value
        
        return sanitized
    
    @staticmethod
    def sanitize_query(query: str) -> str:
        """
        Sanitize SQL query to remove sensitive data.
        
        Args:
            query: SQL query string
            
        Returns:
            str: Sanitized query string
        """
        if not query:
            return query
        
        # Replace potential sensitive values with placeholders
        import re
        
        # Replace quoted strings that might contain sensitive data
        query = re.sub(r"'[^']*'", "'[REDACTED]'", query)
        query = re.sub(r'"[^"]*"', '"[REDACTED]"', query)
        
        # Replace numeric values that might be sensitive
        query = re.sub(r'\b\d{10,}\b', '[REDACTED_NUMBER]', query)
        
        return query


# Initialize loggers on import
def initialize_error_loggers():
    """Initialize all error loggers to ensure log files and directories exist."""
    loggers = [
        get_error_logger(),
        get_api_error_logger(),
        get_service_error_logger()
    ]
    
    # Log initialization message to each logger
    for logger in loggers:
        logger.info("Python error logger initialized successfully")


# Initialize on module import
initialize_error_loggers()
