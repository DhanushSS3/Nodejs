#!/usr/bin/env python3
"""
Test script to verify that the MarketDataService correctly publishes
notifications to Redis Pub/Sub after processing a market feed.
"""

import asyncio
import logging
import orjson
import time
from typing import Dict, Any, Optional

# Assuming these imports work correctly based on your project structure
# from app.config.redis_config import redis_cluster, redis_pubsub_client
# from app.services.market_data_service import MarketDataService

# --- MOCK IMPORTS FOR STANDALONE TESTING ---
# In a real scenario, you would use the imports from your project.
# For this self-contained script, we'll create a simple mock of the required classes.
# This ensures the script is runnable on its own.

class MockRedisCluster:
    """A mock RedisCluster client for testing purposes."""
    def __init__(self):
        self.pubsub_instance = self.MockPubSub()
        self.published_messages = []
        self._keys = {}

    def pubsub(self):
        return self.pubsub_instance
        
    async def hmget(self, key, fields):
        return [self._keys.get(key, {}).get(field) for field in fields]

    async def hset(self, key, mapping):
        if key not in self._keys:
            self._keys[key] = {}
        self._keys[key].update(mapping)

    async def publish(self, channel, message):
        self.published_messages.append({'channel': channel, 'data': message})
        
        # --- FIX: Pass the message to the subscribed channel's queue
        if channel in self.pubsub_instance.channels:
            await self.pubsub_instance.channels[channel].put(message.encode('utf-8'))
        
        return 1
        
    class MockPubSub:
        """A mock PubSub object for testing."""
        def __init__(self):
            self.channels = {}
            
        async def subscribe(self, channel):
            self.channels[channel] = asyncio.Queue()

        async def get_message(self, ignore_subscribe_messages=True):
            if not self.channels:
                return None
            try:
                # Get a message from the queue with a timeout
                message = await asyncio.wait_for(self.channels[list(self.channels.keys())[0]].get(), timeout=1.0)
                return {'type': 'message', 'data': message}
            except asyncio.TimeoutError:
                return None
        
        async def unsubscribe(self, channel):
            if channel in self.channels:
                del self.channels[channel]

        async def close(self):
            self.channels = {}

# Mocking the clients for this test file. Replace these with your actual imports.
# In a real test, you'd mock or patch the imports. Here, we'll create a local instance.
# To run this, you would need to adjust the imports to point to your actual redis clients.
redis_cluster = MockRedisCluster()
redis_pubsub_client = MockRedisCluster()

class MarketDataService:
    """Service for processing and storing market price data in Redis"""
    
    def __init__(self):
        self.redis = redis_cluster
        self.pubsub_redis = redis_pubsub_client
        self.staleness_threshold = 5  # 5 seconds
        
    async def process_market_feed(self, feed_data: Dict[str, Any]) -> bool:
        """
        Process bulk market feed data and store in Redis with pipeline sharding
        Handles partial price updates (buy or sell only)
        
        Args:
            feed_data: Dictionary containing 'market_prices' with symbol price data
            
        Returns:
            bool: True if processing successful, False otherwise
        """
        try:
            market_prices = feed_data.get('market_prices', {})
            logger.debug(f"Processing {len(market_prices)} symbols")
            if not market_prices:
                logger.warning("No market_prices found in market feed")
                return False
            
            current_timestamp = int(time.time() * 1000)
            
            valid_updates = []
            for symbol, price_data in market_prices.items():
                processed_data = await self._validate_and_parse_partial_price(symbol, price_data, current_timestamp)
                if processed_data:
                    valid_updates.append(processed_data)
            
            if not valid_updates:
                logger.warning("No valid price updates to process")
                return False
            
            await self._process_partial_updates_sharded(valid_updates)
            
            await self._publish_price_update_notifications(valid_updates)
            
            logger.debug(f"Processed {len(market_prices)} symbol updates")
            return True
            
        except Exception as e:
            logger.error(f"Failed to process market feed: {e}")
            return False

    async def _process_partial_updates_sharded(self, valid_updates: list):
        # MOCK IMPLEMENTATION
        for symbol, update_fields, timestamp in valid_updates:
            key = f"market:{{{symbol[:3]}}}:{symbol}"
            await self.redis.hset(key, mapping=update_fields)
    
    async def _validate_and_parse_partial_price(self, symbol: str, price_data: Dict[str, str], timestamp: int) -> Optional[tuple]:
        # MOCK IMPLEMENTATION
        buy_str = price_data.get('buy')
        sell_str = price_data.get('sell')
        
        if not buy_str and not sell_str:
            return None
        
        update_fields = {}
        if buy_str:
            update_fields['bid'] = float(buy_str)
        if sell_str:
            update_fields['ask'] = float(sell_str)
        
        return (symbol, update_fields, timestamp)

    async def _publish_price_update_notifications(self, valid_updates: list):
        if not valid_updates:
            return
        
        symbols_in_message = [update[0] for update in valid_updates]
        
        logger.debug(f"Publishing price update notifications for {len(symbols_in_message)} symbols")
        
        for symbol in symbols_in_message:
            try:
                # Use the dedicated Redis client for pub/sub operations
                await self.pubsub_redis.publish("market_price_updates", symbol)
                logger.debug(f"Published price update notification for {symbol}")
            except Exception as e:
                logger.error(f"Failed to publish symbol {symbol}: {e}")

# --- TEST SCRIPT LOGIC ---
logger = logging.getLogger(__name__)

class PublishingTester:
    def __init__(self):
        self.market_service = MarketDataService()
        self.pubsub_client = redis_pubsub_client
        self.received_messages = []
        
    async def subscribe_and_listen(self, duration: int = 10):
        # The test explicitly subscribes to the correct channel
        pubsub = self.pubsub_client.pubsub()
        await pubsub.subscribe("market_price_updates")
        
        start_time = asyncio.get_event_loop().time()
        
        while (asyncio.get_event_loop().time() - start_time) < duration:
            message = await pubsub.get_message(ignore_subscribe_messages=True)
            if message and message['type'] == 'message':
                self.received_messages.append(message['data'].decode('utf-8'))
                logger.info(f"✅ Received notification: {message['data'].decode('utf-8')}")
        
        await pubsub.unsubscribe("market_price_updates")
        await pubsub.close()
    
    async def run_test(self):
        """Simulate a market feed and test publishing"""
        test_feed = {
            "market_prices": {
                "EURUSD": {"buy": "1.12345", "sell": "1.12350"},
                "GBPUSD": {"buy": "1.35678", "sell": "1.35685"},
                "JPYUSD": {"buy": "105.120", "sell": "105.125"}
            }
        }
        
        # Run subscriber and publisher concurrently
        subscribe_task = asyncio.create_task(self.subscribe_and_listen(5))
        
        # Give a moment for subscription to be established
        await asyncio.sleep(1)
        
        # Process the market feed, which should trigger publishing
        logger.info("Triggering market feed processing...")
        await self.market_service.process_market_feed(test_feed)
        
        # Wait for the listener to complete
        await subscribe_task
        
        # Verify the results
        expected_symbols = sorted(test_feed['market_prices'].keys())
        received_symbols = sorted(self.received_messages)
        
        print("\n--- Test Results ---")
        if received_symbols == expected_symbols:
            print("✅ Test Succeeded: All expected symbols were received!")
        else:
            print("❌ Test Failed:")
            print(f"  Expected: {expected_symbols}")
            print(f"  Received: {received_symbols}")
            
        print(f"Total messages published: {len(self.pubsub_client.published_messages)}")
        print(f"Total messages received: {len(self.received_messages)}")

async def main():
    tester = PublishingTester()
    await tester.run_test()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nTest stopped by user.")
    except Exception as e:
        print(f"An error occurred: {e}")
