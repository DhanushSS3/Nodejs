"""
Test the market service directly to see what's failing
"""
import asyncio
import sys
import os
import traceback

# Add the app directory to the path
sys.path.append(os.path.join(os.path.dirname(__file__), 'app'))

from app.services.market_data_service import MarketDataService
from app.config.redis_config import redis_cluster

async def test_market_service_detailed():
    """Test market service with detailed error reporting"""
    print("🧪 Testing MarketDataService in detail...")
    
    try:
        # Test Redis connection first
        print("1. Testing Redis connection...")
        await redis_cluster.ping()
        print("   ✅ Redis ping successful")
        
        # Create market service
        print("2. Creating MarketDataService...")
        market_service = MarketDataService()
        print("   ✅ MarketDataService created")
        
        # Test with simple data
        print("3. Testing with simple market data...")
        test_data = {
            'market_prices': {
                'TESTPAIR': {
                    'sell': '1.2345',
                    'buy': '1.2350'
                }
            }
        }
        
        print(f"   Input data: {test_data}")
        
        # Call process_market_feed with detailed error handling
        print("4. Calling process_market_feed...")
        try:
            success = await market_service.process_market_feed(test_data)
            print(f"   Result: {success}")
            
            if success:
                print("5. Checking if data was stored...")
                stored_data = await market_service.get_symbol_price('TESTPAIR')
                if stored_data:
                    print(f"   ✅ Data stored successfully: {stored_data}")
                else:
                    print("   ❌ Data not found after storage")
            else:
                print("   ❌ process_market_feed returned False")
                
        except Exception as e:
            print(f"   ❌ process_market_feed failed: {e}")
            traceback.print_exc()
        
        # Test with binary listener format
        print("6. Testing with binary listener format...")
        binary_test_data = {
            'market_prices': {
                'GBPSEK': {
                    'sell': '12.51258',
                    'buy': '12.51645'
                }
            }
        }
        
        try:
            success = await market_service.process_market_feed(binary_test_data)
            print(f"   Binary format result: {success}")
            
            if success:
                stored_data = await market_service.get_symbol_price('GBPSEK')
                if stored_data:
                    print(f"   ✅ Binary format data stored: {stored_data}")
                else:
                    print("   ❌ Binary format data not found")
            
        except Exception as e:
            print(f"   ❌ Binary format test failed: {e}")
            traceback.print_exc()
            
    except Exception as e:
        print(f"❌ Overall test failed: {e}")
        traceback.print_exc()

async def test_redis_direct():
    """Test Redis operations directly"""
    print("\n🔍 Testing Redis operations directly...")
    
    try:
        # Test direct Redis write
        print("1. Testing direct Redis write...")
        key = "market:DIRECTTEST"
        await redis_cluster.hmset(key, {
            "bid": "1.2345",
            "ask": "1.2350", 
            "ts": str(int(asyncio.get_event_loop().time() * 1000))
        })
        print("   ✅ Direct Redis write successful")
        
        # Test direct Redis read
        print("2. Testing direct Redis read...")
        data = await redis_cluster.hmget(key, ["bid", "ask", "ts"])
        print(f"   Read data: {data}")
        
        # Clean up
        await redis_cluster.delete(key)
        print("   ✅ Cleanup successful")
        
    except Exception as e:
        print(f"❌ Direct Redis test failed: {e}")
        traceback.print_exc()

async def main():
    await test_redis_direct()
    await test_market_service_detailed()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"❌ Test failed: {e}")
        traceback.print_exc()
