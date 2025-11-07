#!/usr/bin/env python3
"""
Quick diagnostic script to test WebSocket to Redis data flow
"""

import asyncio
import aiohttp
import json
import time

async def test_websocket_redis_flow():
    """Test the WebSocket to Redis data flow"""
    print("🔍 Testing WebSocket to Redis Data Flow")
    print("=" * 50)
    
    try:
        async with aiohttp.ClientSession() as session:
            # Test the new diagnostic endpoint
            print("📊 Running WebSocket-to-Redis diagnostics...")
            
            async with session.get("http://localhost:8000/api/debug/websocket-to-redis") as response:
                if response.status == 200:
                    data = await response.json()
                    
                    print(f"🕐 Timestamp: {data.get('timestamp')}")
                    print()
                    
                    # WebSocket Status
                    ws_status = data.get("websocket_status", {})
                    print("📡 WebSocket Status:")
                    print(f"   Running: {ws_status.get('is_running')}")
                    print(f"   Messages Processed: {ws_status.get('messages_processed')}")
                    print(f"   Successful Decodes: {ws_status.get('successful_decodes')}")
                    print(f"   Parse Errors: {ws_status.get('parse_errors')}")
                    print()
                    
                    # Redis Write Test
                    redis_test = data.get("redis_write_test", {})
                    print("🔴 Redis Write Test:")
                    print(f"   Write Success: {redis_test.get('write_success')}")
                    print(f"   Read Success: {redis_test.get('read_success')}")
                    print(f"   Data Integrity: {redis_test.get('data_integrity')}")
                    if "error" in redis_test:
                        print(f"   Error: {redis_test['error']}")
                    print()
                    
                    # Market Service Status
                    market_status = data.get("market_service_status", {})
                    print("💹 Market Service Status:")
                    print(f"   Service Available: {market_status.get('service_available')}")
                    print(f"   Redis Accessible: {market_status.get('redis_cluster_accessible')}")
                    print(f"   Write Test Success: {market_status.get('write_test_success')}")
                    if "error" in market_status:
                        print(f"   Error: {market_status['error']}")
                    print()
                    
                    # Data Flow Analysis
                    flow_analysis = data.get("data_flow_analysis", {})
                    print("🔄 Data Flow Analysis:")
                    print(f"   WebSocket Receiving: {flow_analysis.get('websocket_receiving')}")
                    print(f"   WebSocket Decoding: {flow_analysis.get('websocket_decoding')}")
                    print(f"   Redis Writable: {flow_analysis.get('redis_writable')}")
                    print(f"   Market Service Functional: {flow_analysis.get('market_service_functional')}")
                    print(f"   Data Flow Broken: {flow_analysis.get('data_flow_broken')}")
                    print()
                    
                    # Potential Issues
                    issues = data.get("potential_issues", [])
                    if issues:
                        print("🚨 Potential Issues:")
                        for i, issue in enumerate(issues, 1):
                            print(f"   {i}. {issue}")
                    else:
                        print("✅ No potential issues detected")
                    
                    print()
                    print("=" * 50)
                    
                    # Summary
                    if issues:
                        print("🚨 ISSUES DETECTED - Review the potential issues above")
                    else:
                        print("✅ DATA FLOW APPEARS HEALTHY")
                    
                else:
                    print(f"❌ HTTP Error: {response.status}")
                    text = await response.text()
                    print(f"Response: {text}")
    
    except Exception as e:
        print(f"❌ Test failed: {e}")

async def test_redis_connection_pool():
    """Test Redis connection pool status"""
    print("\n🔴 Testing Redis Connection Pool...")
    print("=" * 50)
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get("http://localhost:8000/api/debug/redis-cluster") as response:
                if response.status == 200:
                    data = await response.json()
                    
                    pool_info = data.get("connection_pool", {})
                    print("🏊 Connection Pool Status:")
                    print(f"   Type: {pool_info.get('type')}")
                    print(f"   Total Connections: {pool_info.get('total_connections', 0)}")
                    print(f"   Total In Use: {pool_info.get('total_in_use', 0)}")
                    print(f"   Total Available: {pool_info.get('total_available', 0)}")
                    print(f"   Utilization: {pool_info.get('utilization_percent', 0):.1f}%")
                    
                    errors = pool_info.get("connection_errors", [])
                    if errors:
                        print("🚨 Connection Errors:")
                        for error in errors:
                            print(f"   - {error.get('node')}: {error.get('error')}")
                    else:
                        print("✅ No connection errors")
                    
                    # Node-specific info
                    nodes_info = pool_info.get("nodes_info", {})
                    if nodes_info:
                        print("\n📊 Per-Node Connection Info:")
                        for node, info in nodes_info.items():
                            print(f"   {node}:")
                            print(f"     Created: {info.get('created_connections', 0)}")
                            print(f"     In Use: {info.get('in_use_connections', 0)}")
                            print(f"     Available: {info.get('available_connections', 0)}")
                            print(f"     Max: {info.get('max_connections', 'unknown')}")
                
                else:
                    print(f"❌ HTTP Error: {response.status}")
    
    except Exception as e:
        print(f"❌ Connection pool test failed: {e}")

async def main():
    """Main test function"""
    await test_websocket_redis_flow()
    await test_redis_connection_pool()

if __name__ == "__main__":
    asyncio.run(main())
