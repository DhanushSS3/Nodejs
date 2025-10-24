"""
Debug why the global binary listener instance is not running
"""
import asyncio
import sys
import os
import time

# Add the app directory to the path
sys.path.append(os.path.join(os.path.dirname(__file__), 'app'))

async def check_global_listener():
    """Check the global binary listener that should be running from main.py"""
    print("🔍 Checking Global Binary Listener...")
    
    try:
        from app.protobuf_market_listener import binary_market_listener
        
        print(f"✅ Global listener found: {binary_market_listener}")
        print(f"Is running: {binary_market_listener.is_running}")
        print(f"Stats: {binary_market_listener.stats}")
        
        if hasattr(binary_market_listener, 'websocket'):
            print(f"WebSocket attribute exists: {binary_market_listener.websocket is not None}")
        
        # Try to manually start it
        print("\n🚀 Attempting to start global listener...")
        
        try:
            # Start the listener
            await binary_market_listener.start()
            print("✅ Global listener started successfully")
            
            # Wait a bit and check stats
            await asyncio.sleep(3)
            
            print(f"After 3 seconds:")
            print(f"Is running: {binary_market_listener.is_running}")
            print(f"Stats: {binary_market_listener.stats}")
            
        except Exception as e:
            print(f"❌ Failed to start global listener: {e}")
            import traceback
            traceback.print_exc()
        
    except Exception as e:
        print(f"❌ Error accessing global listener: {e}")
        import traceback
        traceback.print_exc()

async def test_start_function():
    """Test the start_binary_market_listener function directly"""
    print("\n🧪 Testing start_binary_market_listener function...")
    
    try:
        from app.protobuf_market_listener import start_binary_market_listener
        
        print("Calling start_binary_market_listener()...")
        
        # This should start the global instance
        task = asyncio.create_task(start_binary_market_listener())
        
        # Wait a bit for it to start
        await asyncio.sleep(2)
        
        # Check if it's running now
        from app.protobuf_market_listener import binary_market_listener
        print(f"After start function call:")
        print(f"Is running: {binary_market_listener.is_running}")
        print(f"Stats: {binary_market_listener.stats}")
        
        # Let it run for a bit more
        await asyncio.sleep(3)
        
        print(f"After 5 seconds total:")
        print(f"Is running: {binary_market_listener.is_running}")
        print(f"Stats: {binary_market_listener.stats}")
        
        # Cancel the task
        task.cancel()
        
    except Exception as e:
        print(f"❌ Error testing start function: {e}")
        import traceback
        traceback.print_exc()

async def main():
    """Run all tests"""
    print("🚀 Global Binary Listener Debug")
    print("=" * 50)
    
    await check_global_listener()
    await test_start_function()
    
    print("\n" + "=" * 50)
    print("🏁 Debug complete")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹️ Debug stopped by user")
    except Exception as e:
        print(f"❌ Debug failed: {e}")
        import traceback
        traceback.print_exc()
