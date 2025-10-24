"""
Debug script to check binary listener status and Redis data
"""
import asyncio
import sys
import os

# Add the app directory to the path
sys.path.append(os.path.join(os.path.dirname(__file__), 'app'))

from app.config.redis_config import redis_cluster
from app.services.market_data_service import MarketDataService

async def check_redis_data():
    """Check what data is actually in Redis"""
    print("🔍 Checking Redis data...")
    
    # Test symbols that should be coming from WebSocket
    test_symbols = ["GBPSEK", "USDSEK", "EURSEK", "EURUSD", "GBPUSD"]
    
    try:
        # Check Redis connection
        await redis_cluster.ping()
        print("✅ Redis connection successful")
        
        # Check for market data keys
        keys = await redis_cluster.keys("market:*")
        print(f"📊 Found {len(keys)} market keys in Redis:")
        for key in keys[:10]:  # Show first 10
            print(f"  - {key.decode() if isinstance(key, bytes) else key}")
        
        if len(keys) > 10:
            print(f"  ... and {len(keys) - 10} more")
        
        # Check specific symbols
        market_service = MarketDataService()
        print(f"\n🎯 Checking specific symbols:")
        
        for symbol in test_symbols:
            try:
                price_data = await market_service.get_symbol_price(symbol)
                if price_data:
                    print(f"  ✅ {symbol}: bid={price_data['bid']}, ask={price_data['ask']}, age={(int(asyncio.get_event_loop().time() * 1000) - price_data['ts'])/1000:.1f}s")
                else:
                    print(f"  ❌ {symbol}: No data found")
            except Exception as e:
                print(f"  ❌ {symbol}: Error - {e}")
        
        # Check raw Redis data for one symbol
        print(f"\n🔍 Raw Redis data for GBPSEK:")
        try:
            raw_data = await redis_cluster.hmget("market:GBPSEK", ["bid", "ask", "ts"])
            if any(raw_data):
                print(f"  Raw data: {raw_data}")
            else:
                print(f"  No raw data found")
        except Exception as e:
            print(f"  Error getting raw data: {e}")
            
    except Exception as e:
        print(f"❌ Redis connection failed: {e}")

async def check_listener_logs():
    """Check recent listener activity"""
    print(f"\n📋 Checking recent WebSocket logs...")
    
    log_files = [
        "logs/execution_price/execution_price_websocket.log",
        "logs/python_service_errors.log"
    ]
    
    for log_file in log_files:
        try:
            if os.path.exists(log_file):
                print(f"\n📄 {log_file} (last 5 lines):")
                with open(log_file, 'r') as f:
                    lines = f.readlines()
                    for line in lines[-5:]:
                        print(f"  {line.strip()}")
            else:
                print(f"❌ {log_file} not found")
        except Exception as e:
            print(f"❌ Error reading {log_file}: {e}")

async def test_market_service():
    """Test if market service can process data"""
    print(f"\n🧪 Testing market service processing...")
    
    try:
        market_service = MarketDataService()
        
        # Test with sample data in the correct format
        test_data = {
            'market_prices': {
                'TESTPAIR': {
                    'bid': '1.2345',
                    'ask': '1.2350'
                }
            }
        }
        
        success = await market_service.process_market_feed(test_data)
        print(f"  Market service test: {'✅ SUCCESS' if success else '❌ FAILED'}")
        
        # Check if test data was stored
        if success:
            stored_data = await market_service.get_symbol_price('TESTPAIR')
            if stored_data:
                print(f"  Test data stored: bid={stored_data['bid']}, ask={stored_data['ask']}")
            else:
                print(f"  ❌ Test data not found after storage")
                
    except Exception as e:
        print(f"❌ Market service test failed: {e}")

async def main():
    """Run all diagnostic checks"""
    print("🚀 Binary Listener Diagnostic Tool")
    print("=" * 50)
    
    await check_redis_data()
    await check_listener_logs()
    await test_market_service()
    
    print("\n" + "=" * 50)
    print("🏁 Diagnostic complete")

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹️ Diagnostic stopped by user")
    except Exception as e:
        print(f"❌ Diagnostic failed: {e}")
        import traceback
        traceback.print_exc()
