#!/usr/bin/env python3
"""
Test Redis configuration compatibility
"""

import sys
import os
from pathlib import Path

# Add the services path to Python path
services_path = Path(__file__).parent / "services" / "python-service"
sys.path.insert(0, str(services_path))

def test_redis_config():
    """Test Redis configuration"""
    print("🔴 Testing Redis Configuration...")
    
    try:
        # Test import
        print("📦 Importing Redis modules...")
        from redis.asyncio.cluster import RedisCluster, ClusterNode
        import redis.asyncio as redis
        print("✅ Redis modules imported successfully")
        
        # Test configuration creation
        print("⚙️ Creating Redis configuration...")
        
        # Minimal test configuration
        startup_nodes = [ClusterNode("127.0.0.1", 7001)]
        
        test_configs = [
            # Test 1: Minimal config
            {
                "name": "Minimal Config",
                "config": {
                    "startup_nodes": startup_nodes,
                    "decode_responses": True,
                    "password": "admin@livefxhub@123",
                }
            },
            # Test 2: With timeouts
            {
                "name": "With Timeouts",
                "config": {
                    "startup_nodes": startup_nodes,
                    "decode_responses": True,
                    "password": "admin@livefxhub@123",
                    "socket_connect_timeout": 10,
                    "socket_timeout": 10,
                }
            },
            # Test 3: With max connections
            {
                "name": "With Max Connections",
                "config": {
                    "startup_nodes": startup_nodes,
                    "decode_responses": True,
                    "password": "admin@livefxhub@123",
                    "socket_connect_timeout": 10,
                    "socket_timeout": 10,
                    "max_connections": 50,
                }
            },
            # Test 4: With health check
            {
                "name": "With Health Check",
                "config": {
                    "startup_nodes": startup_nodes,
                    "decode_responses": True,
                    "password": "admin@livefxhub@123",
                    "socket_connect_timeout": 10,
                    "socket_timeout": 10,
                    "max_connections": 50,
                    "health_check_interval": 30,
                }
            }
        ]
        
        for test in test_configs:
            try:
                print(f"🧪 Testing {test['name']}...")
                cluster = RedisCluster(**test['config'])
                print(f"✅ {test['name']} - SUCCESS")
            except Exception as e:
                print(f"❌ {test['name']} - FAILED: {e}")
        
        # Test the actual config from our file
        print("🔧 Testing actual configuration...")
        try:
            from app.config.redis_config import RedisConfig
            config = RedisConfig()
            cluster = config.get_cluster()
            print("✅ Actual configuration - SUCCESS")
        except Exception as e:
            print(f"❌ Actual configuration - FAILED: {e}")
            return False
        
        return True
        
    except Exception as e:
        print(f"❌ Redis configuration test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = test_redis_config()
    if success:
        print("\n✅ Redis configuration is compatible!")
        print("🚀 You can now start the Python service")
    else:
        print("\n❌ Redis configuration has issues")
        print("🔧 Check the errors above and fix the configuration")
    
    sys.exit(0 if success else 1)
