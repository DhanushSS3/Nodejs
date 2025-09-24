#!/usr/bin/env python3
"""
Test script for Python error logging functionality
Run with: python test_python_error_logging.py
"""

import sys
import os
import asyncio
from datetime import datetime

# Add the Python service to the path
sys.path.append(os.path.join(os.path.dirname(__file__), 'services', 'python-service'))

try:
    from app.services.logging.error_logger import ErrorLogger
    print("✅ Successfully imported ErrorLogger")
except ImportError as e:
    print(f"❌ Failed to import ErrorLogger: {e}")
    sys.exit(1)


def test_basic_error_logging():
    """Test basic error logging functionality"""
    print("\n1️⃣ Testing basic error logging...")
    
    try:
        # Simulate an error
        raise ValueError("Test validation error for logging")
    except Exception as e:
        correlation_id = ErrorLogger.log_error(
            error=e,
            context={
                "operation": "test_operation",
                "user_id": "test_user_123",
                "additional_data": {"test": True}
            },
            logger_type="general"
        )
        print(f"✅ Error logged with correlation ID: {correlation_id}")


def test_api_error_logging():
    """Test API-specific error logging"""
    print("\n2️⃣ Testing API error logging...")
    
    try:
        # Simulate an API error
        raise ConnectionError("Database connection timeout")
    except Exception as e:
        correlation_id = ErrorLogger.log_api_error(
            error=e,
            endpoint="POST /api/orders/instant/execute",
            method="POST",
            user_id="user_456",
            user_type="live",
            request_data={
                "order_type": "BUY",
                "symbol": "EURUSD",
                "quantity": 1.0,
                "password": "secret123"  # This should be sanitized
            },
            additional_context={
                "operation": "instant_order_execution",
                "execution_time_ms": 1250
            }
        )
        print(f"✅ API error logged with correlation ID: {correlation_id}")


def test_service_error_logging():
    """Test service-layer error logging"""
    print("\n3️⃣ Testing service error logging...")
    
    try:
        # Simulate a service error
        raise RuntimeError("Redis cluster connection failed")
    except Exception as e:
        correlation_id = ErrorLogger.log_service_error(
            error=e,
            service_name="OrderExecutionService",
            operation="execute_instant_order",
            user_id="user_789",
            additional_context={
                "redis_cluster_nodes": 3,
                "retry_count": 2
            }
        )
        print(f"✅ Service error logged with correlation ID: {correlation_id}")


def test_database_error_logging():
    """Test database-specific error logging"""
    print("\n4️⃣ Testing database error logging...")
    
    try:
        # Simulate a database error
        raise Exception("Duplicate key constraint violation")
    except Exception as e:
        correlation_id = ErrorLogger.log_database_error(
            error=e,
            query="INSERT INTO live_users (email, password) VALUES ('test@example.com', 'hashed_password')",
            table="live_users",
            operation="INSERT",
            user_id="user_101"
        )
        print(f"✅ Database error logged with correlation ID: {correlation_id}")


def test_redis_error_logging():
    """Test Redis-specific error logging"""
    print("\n5️⃣ Testing Redis error logging...")
    
    try:
        # Simulate a Redis error
        raise ConnectionError("Redis connection timeout")
    except Exception as e:
        correlation_id = ErrorLogger.log_redis_error(
            error=e,
            operation="HGET",
            key="user:{live:123}:config",
            user_id="user_123",
            additional_context={
                "cluster_node": "127.0.0.1:7001",
                "timeout_seconds": 5
            }
        )
        print(f"✅ Redis error logged with correlation ID: {correlation_id}")


def test_external_service_error_logging():
    """Test external service error logging"""
    print("\n6️⃣ Testing external service error logging...")
    
    try:
        # Simulate an external service error
        raise TimeoutError("Provider service timeout")
    except Exception as e:
        correlation_id = ErrorLogger.log_external_service_error(
            error=e,
            service_name="BarclaysProvider",
            endpoint="POST /api/orders/place",
            operation="place_order",
            response_data={
                "status": "timeout",
                "message": "Request timed out after 30 seconds"
            },
            additional_context={
                "order_id": "ord_123456",
                "retry_attempt": 1
            }
        )
        print(f"✅ External service error logged with correlation ID: {correlation_id}")


def test_data_sanitization():
    """Test data sanitization functionality"""
    print("\n7️⃣ Testing data sanitization...")
    
    sensitive_data = {
        "email": "user@example.com",
        "password": "secret123",
        "api_key": "sk-1234567890",
        "card_number": "4111111111111111",
        "otp": "123456",
        "normal_field": "safe_data",
        "nested": {
            "password": "nested_secret",
            "safe_field": "safe_value"
        }
    }
    
    sanitized = ErrorLogger.sanitize_data(sensitive_data)
    
    print("Original data:", sensitive_data)
    print("Sanitized data:", sanitized)
    
    # Verify sanitization worked
    assert sanitized["password"] == "[REDACTED]"
    assert sanitized["api_key"] == "[REDACTED]"
    assert sanitized["card_number"] == "[REDACTED]"
    assert sanitized["otp"] == "[REDACTED]"
    assert sanitized["normal_field"] == "safe_data"
    assert sanitized["nested"]["password"] == "[REDACTED]"
    assert sanitized["nested"]["safe_field"] == "safe_value"
    
    print("✅ Data sanitization working correctly")


def test_query_sanitization():
    """Test SQL query sanitization"""
    print("\n8️⃣ Testing SQL query sanitization...")
    
    queries = [
        "SELECT * FROM users WHERE email = 'user@example.com' AND password = 'secret123'",
        'UPDATE users SET balance = 1000.50 WHERE id = "12345"',
        "INSERT INTO orders (user_id, amount) VALUES (123456789012, 500.00)"
    ]
    
    for query in queries:
        sanitized = ErrorLogger.sanitize_query(query)
        print(f"Original:  {query}")
        print(f"Sanitized: {sanitized}")
        print()
    
    print("✅ SQL query sanitization working")


def test_correlation_id_generation():
    """Test correlation ID generation"""
    print("\n9️⃣ Testing correlation ID generation...")
    
    # Generate multiple correlation IDs
    ids = [ErrorLogger.generate_correlation_id() for _ in range(5)]
    
    print("Generated correlation IDs:")
    for i, correlation_id in enumerate(ids, 1):
        print(f"  {i}. {correlation_id}")
    
    # Verify they're unique
    assert len(set(ids)) == len(ids), "Correlation IDs should be unique"
    
    # Verify format
    for correlation_id in ids:
        assert correlation_id.startswith("py_err_"), "Should start with py_err_"
        assert len(correlation_id.split("_")) >= 3, "Should have timestamp and random parts"
    
    print("✅ Correlation ID generation working correctly")


def main():
    """Run all tests"""
    print("🧪 Testing Python Error Logging System")
    print("=" * 50)
    
    try:
        test_basic_error_logging()
        test_api_error_logging()
        test_service_error_logging()
        test_database_error_logging()
        test_redis_error_logging()
        test_external_service_error_logging()
        test_data_sanitization()
        test_query_sanitization()
        test_correlation_id_generation()
        
        print("\n🎉 All tests completed successfully!")
        print("📁 Log files should be created in: services/python-service/logs/")
        print("   - python_errors.log (general errors)")
        print("   - python_api_errors.log (API errors)")
        print("   - python_service_errors.log (service errors)")
        
    except Exception as e:
        print(f"\n❌ Test failed with error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
