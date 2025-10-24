"""
Test if the binary listener is actually running and processing messages
"""
import asyncio
import sys
import os
import time

# Add the app directory to the path
sys.path.append(os.path.join(os.path.dirname(__file__), 'app'))

from app.protobuf_market_listener import binary_market_listener

async def check_listener_status():
    """Check if binary listener is running and processing messages"""
    print("🔍 Checking Binary Listener Status...")
    
    if binary_market_listener is None:
        print("❌ Binary market listener is None - not initialized")
        return
    
    print(f"✅ Binary listener object exists: {type(binary_market_listener)}")
    
    # Check if it has stats
    if hasattr(binary_market_listener, 'stats'):
        stats = binary_market_listener.stats
        print(f"📊 Listener Stats:")
        for key, value in stats.items():
            print(f"  {key}: {value}")
    else:
        print("❌ No stats attribute found")
    
    # Check if it's running
    if hasattr(binary_market_listener, 'is_running'):
        print(f"🏃 Is running: {binary_market_listener.is_running}")
    
    # Check WebSocket connection status
    if hasattr(binary_market_listener, 'websocket') and binary_market_listener.websocket:
        print(f"🔌 WebSocket connected: {not binary_market_listener.websocket.closed}")
    else:
        print("❌ No WebSocket connection found")

async def test_manual_protobuf_parsing():
    """Test the protobuf parsing with known good data"""
    print("\n🧪 Testing manual protobuf parsing...")
    
    if binary_market_listener is None:
        print("❌ Cannot test - listener not available")
        return
    
    # Use the hex data we know works from our tests
    test_hex = "78 9c e3 e2 cd 4d 2c ca 4e 2d 89 2f 2d 48 49 2c 49 15 92 e3 92 e1 62 73 77 0a 08 76 f5 16 12 e2 74 ab 51 4f db cb a1 e9 20 e8 d9 30 2b 6a 1b 9b a6 03 00 40 c7 0d 3d"
    test_bytes = bytes.fromhex(test_hex.replace(' ', ''))
    
    print(f"Testing with {len(test_bytes)} bytes of known good data...")
    
    try:
        # Call the parsing method directly
        result = await binary_market_listener._parse_binary_message(test_bytes)
        
        if result:
            print(f"✅ Parsing successful: {result}")
        else:
            print("❌ Parsing returned None")
            
    except Exception as e:
        print(f"❌ Parsing failed: {e}")
        import traceback
        traceback.print_exc()

async def monitor_listener_activity():
    """Monitor listener activity for a short period"""
    print("\n👁️ Monitoring listener activity for 10 seconds...")
    
    if binary_market_listener is None:
        print("❌ Cannot monitor - listener not available")
        return
    
    initial_stats = binary_market_listener.stats.copy() if hasattr(binary_market_listener, 'stats') else {}
    
    print("Initial stats:", initial_stats)
    print("Waiting 10 seconds...")
    
    await asyncio.sleep(10)
    
    if hasattr(binary_market_listener, 'stats'):
        final_stats = binary_market_listener.stats
        print("Final stats:", final_stats)
        
        # Check for changes
        changes = {}
        for key in final_stats:
            if key in initial_stats:
                if final_stats[key] != initial_stats[key]:
                    changes[key] = f"{initial_stats[key]} → {final_stats[key]}"
            else:
                changes[key] = f"new: {final_stats[key]}"
        
        if changes:
            print("📈 Changes detected:")
            for key, change in changes.items():
                print(f"  {key}: {change}")
        else:
            print("❌ No activity detected - listener may not be processing messages")

async def main():
    """Run all tests"""
    print("🚀 Binary Listener Live Test")
    print("=" * 50)
    
    await check_listener_status()
    await test_manual_protobuf_parsing()
    await monitor_listener_activity()
    
    print("\n" + "=" * 50)
    print("🏁 Live test complete")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹️ Test stopped by user")
    except Exception as e:
        print(f"❌ Test failed: {e}")
        import traceback
        traceback.print_exc()
