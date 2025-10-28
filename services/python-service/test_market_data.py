#!/usr/bin/env python3
"""
Quick test script to check if market data is being processed and stored in Redis
"""
import asyncio
import sys
import os
sys.path.append(os.path.join(os.path.dirname(__file__), 'app'))

from app.config.redis_config import redis_cluster

async def test_market_data():
    """Test if market data exists in Redis"""
    print("🔍 Testing Redis market data...")
    
    # Test symbols
    test_symbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD']
    
    try:
        # Check Redis connection
        await redis_cluster.ping()
        print("✅ Redis connection: OK")
        
        # Check for market data
        found_data = []
        for symbol in test_symbols:
            key = f"market:{symbol}"
            data = await redis_cluster.hgetall(key)
            if data:
                found_data.append({
                    'symbol': symbol,
                    'data': data,
                    'keys': list(data.keys())
                })
                print(f"✅ {symbol}: Found data with keys {list(data.keys())}")
            else:
                print(f"❌ {symbol}: No data found")
        
        # Check for any market keys
        all_market_keys = await redis_cluster.keys("market:*")
        print(f"\n📊 Total market keys in Redis: {len(all_market_keys)}")
        if all_market_keys:
            print(f"Sample keys: {all_market_keys[:10]}")
        
        # Summary
        print(f"\n📈 Summary:")
        print(f"- Tested symbols: {len(test_symbols)}")
        print(f"- Found data for: {len(found_data)} symbols")
        print(f"- Total market keys: {len(all_market_keys)}")
        
        if found_data:
            print("\n✅ Market data is being stored in Redis!")
            for item in found_data[:3]:  # Show first 3
                print(f"   {item['symbol']}: {item['data']}")
        else:
            print("\n❌ No market data found in Redis!")
            print("This indicates the market data pipeline is not working.")
        
    except Exception as e:
        print(f"❌ Error testing market data: {e}")

if __name__ == "__main__":
    asyncio.run(test_market_data())
