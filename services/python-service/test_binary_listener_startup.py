"""
Test binary listener startup to see why it's not running
"""
import asyncio
import sys
import os
import traceback

# Add the app directory to the path
sys.path.append(os.path.join(os.path.dirname(__file__), 'app'))

from app.protobuf_market_listener import start_binary_market_listener, binary_market_listener

async def test_binary_listener_startup():
    """Test starting the binary listener and see what happens"""
    print("🚀 Testing Binary Listener Startup...")
    
    print(f"1. Initial listener state:")
    print(f"   Is running: {binary_market_listener.is_running}")
    print(f"   Stats: {binary_market_listener.stats}")
    
    print(f"\n2. Attempting to start binary listener...")
    
    try:
        # Try to start the listener with timeout
        await asyncio.wait_for(start_binary_market_listener(), timeout=10.0)
        print("   ✅ Listener started successfully")
        
    except asyncio.TimeoutError:
        print("   ⏰ Listener startup timed out (still connecting?)")
        
    except Exception as e:
        print(f"   ❌ Listener startup failed: {e}")
        traceback.print_exc()
    
    print(f"\n3. Post-startup listener state:")
    print(f"   Is running: {binary_market_listener.is_running}")
    print(f"   Stats: {binary_market_listener.stats}")
    
    if hasattr(binary_market_listener, 'websocket') and binary_market_listener.websocket:
        print(f"   WebSocket state: {binary_market_listener.websocket.state}")
        print(f"   WebSocket closed: {binary_market_listener.websocket.closed}")
    else:
        print("   No WebSocket connection")
    
    # Let it run for a bit to see if it processes messages
    print(f"\n4. Monitoring for 5 seconds...")
    initial_stats = binary_market_listener.stats.copy()
    
    await asyncio.sleep(5)
    
    final_stats = binary_market_listener.stats
    print(f"   Initial: {initial_stats}")
    print(f"   Final: {final_stats}")
    
    # Check for changes
    changes = {}
    for key in final_stats:
        if key in initial_stats and final_stats[key] != initial_stats[key]:
            changes[key] = f"{initial_stats[key]} → {final_stats[key]}"
    
    if changes:
        print(f"   📈 Activity detected: {changes}")
    else:
        print("   ❌ No activity - listener not processing messages")

async def test_manual_start():
    """Test starting the listener manually with detailed error handling"""
    print(f"\n🔧 Testing Manual Listener Start...")
    
    try:
        print("Creating new listener instance...")
        from app.protobuf_market_listener import BinaryMarketListener
        
        test_listener = BinaryMarketListener()
        print(f"✅ Created: {test_listener}")
        
        print("Calling start() method...")
        await test_listener.start()
        
        print("✅ Start method completed")
        print(f"Is running: {test_listener.is_running}")
        
    except Exception as e:
        print(f"❌ Manual start failed: {e}")
        traceback.print_exc()

async def main():
    """Run startup tests"""
    print("🚀 Binary Listener Startup Test")
    print("=" * 50)
    
    await test_binary_listener_startup()
    await test_manual_start()
    
    print("\n" + "=" * 50)
    print("🏁 Startup test complete")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹️ Test stopped by user")
    except Exception as e:
        print(f"❌ Test failed: {e}")
        traceback.print_exc()
