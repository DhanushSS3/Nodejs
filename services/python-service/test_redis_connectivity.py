#!/usr/bin/env python3
"""
Quick Redis connectivity test to verify Python can access the same data as Node.js
"""
import asyncio
import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), 'app'))

# Load .env file explicitly for testing
from dotenv import load_dotenv
env_paths = [".env", "../.env", "../../.env"]
for env_path in env_paths:
    if os.path.exists(env_path):
        load_dotenv(env_path)
        print(f"✅ Test loaded .env from: {os.path.abspath(env_path)}")
        break

from app.config.redis_config import redis_cluster

async def test_redis_connectivity():
    """Test Redis cluster connectivity and data access"""
    print("🔍 Testing Redis Cluster Connectivity...")
    
    # Check environment variables
    print(f"🔍 Environment Variables:")
    print(f"REDIS_HOSTS: {os.getenv('REDIS_HOSTS', 'NOT_SET')}")
    print(f"REDIS_HOST: {os.getenv('REDIS_HOST', 'NOT_SET')}")
    print(f"DATABASE_URL: {os.getenv('DATABASE_URL', 'NOT_SET')}")
    print(f"NODE_ENV: {os.getenv('NODE_ENV', 'NOT_SET')}")
    
    # Show which Redis config is actually being used
    redis_hosts_env = os.getenv("REDIS_HOSTS") or os.getenv("REDIS_HOST")
    if not redis_hosts_env:
        redis_hosts_env = "127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003"
    print(f"🔍 Actual Redis Config Used: {redis_hosts_env}")
    
    try:
        # Test cluster info
        cluster_info = await redis_cluster.cluster_info()
        print(f"✅ Cluster State: {cluster_info.get('cluster_state')}")
        
        # Test specific user key that should exist
        user_id = "6"
        user_type = "live"
        tagged_key = f"user:{{{user_type}:{user_id}}}:config"
        legacy_key = f"user:{user_type}:{user_id}:config"
        
        print(f"\n🔍 Testing User {user_type}:{user_id}")
        print(f"Tagged Key: {tagged_key}")
        print(f"Legacy Key: {legacy_key}")
        
        # Test tagged key
        tagged_data = await redis_cluster.hgetall(tagged_key)
        print(f"Tagged Key Data: {tagged_data}")
        
        # Test legacy key
        legacy_data = await redis_cluster.hgetall(legacy_key)
        print(f"Legacy Key Data: {legacy_data}")
        
        # Test key slot mapping
        try:
            key_slot = await redis_cluster.cluster_keyslot(tagged_key)
            print(f"Key Slot: {key_slot}")
        except Exception as e:
            print(f"❌ Key slot error: {e}")
        
        # Test cluster nodes
        try:
            nodes = await redis_cluster.cluster_nodes()
            print(f"Cluster Nodes: {nodes[:200]}...")
        except Exception as e:
            print(f"❌ Cluster nodes error: {e}")
            
        # Test if we can write and read
        test_key = f"test:{user_type}:{user_id}:connectivity"
        await redis_cluster.hset(test_key, mapping={"test": "value", "timestamp": str(asyncio.get_event_loop().time())})
        test_data = await redis_cluster.hgetall(test_key)
        print(f"Write/Read Test: {test_data}")
        await redis_cluster.delete(test_key)
        
        # Test the exact same function that's failing in production
        print(f"\n🔍 Testing fetch_user_config function...")
        try:
            from app.services.orders.order_repository import fetch_user_config
            config = await fetch_user_config(user_type, user_id)
            print(f"fetch_user_config result: {config}")
            print(f"Leverage from function: {config.get('leverage')}")
        except Exception as func_err:
            print(f"❌ fetch_user_config failed: {func_err}")
            import traceback
            traceback.print_exc()
        
    except Exception as e:
        print(f"❌ Redis connectivity test failed: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        await redis_cluster.aclose()

if __name__ == "__main__":
    asyncio.run(test_redis_connectivity())
