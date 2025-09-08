"""
Test script for Portfolio Calculator Service - Step 1 validation

This script tests the Portfolio Calculator listener functionality:
- Simulates market price updates via Redis pub/sub
- Validates dirty user collection and deduplication
- Tests Redis symbol_holders data structures
- Monitors statistics and logging
"""

import asyncio
import redis.asyncio as redis
import time
import logging
from app.services.portfolio_calculator import PortfolioCalculatorListener

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class PortfolioCalculatorTester:
    """Test harness for Portfolio Calculator Step 1 functionality"""
    
    def __init__(self):
        self.redis_client = redis.Redis(host='127.0.0.1', port=7001, decode_responses=True)
        self.portfolio_listener = PortfolioCalculatorListener()
        
    async def setup_test_data(self):
        """Setup test symbol holders data in Redis"""
        logger.info("Setting up test data...")
        
        # Test data: symbol holders for different symbols and user types
        test_data = {
            'symbol_holders:EURUSD:live': ['live:1001', 'live:1002', 'live:1003'],
            'symbol_holders:EURUSD:demo': ['demo:2001', 'demo:2002'],
            'symbol_holders:GBPUSD:live': ['live:1001', 'live:1004'],  # live:1001 holds multiple symbols
            'symbol_holders:GBPUSD:demo': ['demo:2001', 'demo:2003'],
            'symbol_holders:USDJPY:live': ['live:1005'],
            'symbol_holders:USDJPY:demo': ['demo:2004', 'demo:2005', 'demo:2006']
        }
        
        # Clear existing test data
        for key in test_data.keys():
            await self.redis_client.delete(key)
        
        # Add test symbol holders
        for key, users in test_data.items():
            for user in users:
                await self.redis_client.sadd(key, user)
        
        logger.info(f"Created {len(test_data)} symbol holder sets with test data")
        
        # Verify data was created
        for key, expected_users in test_data.items():
            actual_users = await self.redis_client.smembers(key)
            logger.info(f"{key}: {len(actual_users)} users - {sorted(actual_users)}")
    
    async def simulate_market_updates(self, symbols: list, count: int = 5):
        """Simulate market price updates by publishing to Redis channel"""
        logger.info(f"Simulating {count} market updates for symbols: {symbols}")
        
        publisher = redis.Redis(host='127.0.0.1', port=7001, decode_responses=True)
        
        for i in range(count):
            for symbol in symbols:
                await publisher.publish('market_price_updates', symbol)
                logger.info(f"Published update #{i+1} for {symbol}")
                await asyncio.sleep(0.1)  # Small delay between updates
        
        await publisher.close()
        logger.info("Finished simulating market updates")
    
    async def monitor_dirty_users(self, duration: int = 10):
        """Monitor dirty user sets for a specified duration"""
        logger.info(f"Monitoring dirty users for {duration} seconds...")
        
        start_time = time.time()
        while time.time() - start_time < duration:
            stats = self.portfolio_listener.get_statistics()
            live_dirty = self.portfolio_listener.get_dirty_users('live')
            demo_dirty = self.portfolio_listener.get_dirty_users('demo')
            
            logger.info(
                f"Stats: {stats['symbols_processed']} symbols processed, "
                f"{stats['users_affected_total']} total users affected, "
                f"Current dirty: live={len(live_dirty)}, demo={len(demo_dirty)}"
            )
            
            if live_dirty:
                logger.info(f"Live dirty users: {sorted(live_dirty)}")
            if demo_dirty:
                logger.info(f"Demo dirty users: {sorted(demo_dirty)}")
            
            await asyncio.sleep(2)
    
    async def test_deduplication(self):
        """Test that duplicate users are properly deduplicated"""
        logger.info("Testing deduplication...")
        
        # Clear dirty users
        self.portfolio_listener.get_and_clear_dirty_users('live')
        self.portfolio_listener.get_and_clear_dirty_users('demo')
        
        # Simulate multiple updates for the same symbol (should deduplicate users)
        symbols = ['EURUSD', 'EURUSD', 'EURUSD']  # Same symbol multiple times
        await self.simulate_market_updates(symbols, count=1)
        
        await asyncio.sleep(2)  # Allow processing
        
        live_dirty = self.portfolio_listener.get_dirty_users('live')
        demo_dirty = self.portfolio_listener.get_dirty_users('demo')
        
        logger.info(f"After deduplication test - Live: {len(live_dirty)}, Demo: {len(demo_dirty)}")
        logger.info(f"Live users: {sorted(live_dirty)}")
        logger.info(f"Demo users: {sorted(demo_dirty)}")
        
        # Expected: 3 live users and 2 demo users for EURUSD (no duplicates)
        expected_live = 3
        expected_demo = 2
        
        if len(live_dirty) == expected_live and len(demo_dirty) == expected_demo:
            logger.info("✅ Deduplication test PASSED")
        else:
            logger.error(f"❌ Deduplication test FAILED - Expected live:{expected_live}, demo:{expected_demo}")
    
    async def test_cross_symbol_users(self):
        """Test users holding multiple symbols"""
        logger.info("Testing cross-symbol user handling...")
        
        # Clear dirty users
        self.portfolio_listener.get_and_clear_dirty_users('live')
        self.portfolio_listener.get_and_clear_dirty_users('demo')
        
        # Update symbols where some users hold multiple symbols
        symbols = ['EURUSD', 'GBPUSD']  # live:1001 and demo:2001 hold both
        await self.simulate_market_updates(symbols, count=1)
        
        await asyncio.sleep(2)  # Allow processing
        
        live_dirty = self.portfolio_listener.get_dirty_users('live')
        demo_dirty = self.portfolio_listener.get_dirty_users('demo')
        
        logger.info(f"Cross-symbol test - Live: {len(live_dirty)}, Demo: {len(demo_dirty)}")
        logger.info(f"Live users: {sorted(live_dirty)}")
        logger.info(f"Demo users: {sorted(demo_dirty)}")
        
        # Check if users holding multiple symbols are properly deduplicated
        if 'live:1001' in live_dirty and 'demo:2001' in demo_dirty:
            logger.info("✅ Cross-symbol user test PASSED")
        else:
            logger.error("❌ Cross-symbol user test FAILED")
    
    async def run_comprehensive_test(self):
        """Run comprehensive test suite"""
        logger.info("🚀 Starting Portfolio Calculator comprehensive test...")
        
        try:
            # Setup test data
            await self.setup_test_data()
            
            # Start portfolio listener in background
            listener_task = asyncio.create_task(self.portfolio_listener.start_listener())
            await asyncio.sleep(2)  # Allow listener to start
            
            # Run tests
            await self.test_deduplication()
            await asyncio.sleep(1)
            
            await self.test_cross_symbol_users()
            await asyncio.sleep(1)
            
            # Simulate continuous market updates
            update_task = asyncio.create_task(
                self.simulate_market_updates(['EURUSD', 'GBPUSD', 'USDJPY'], count=10)
            )
            
            # Monitor for a period
            monitor_task = asyncio.create_task(self.monitor_dirty_users(duration=15))
            
            # Wait for both tasks
            await asyncio.gather(update_task, monitor_task)
            
            # Final statistics
            final_stats = self.portfolio_listener.get_statistics()
            logger.info(f"🏁 Final Statistics: {final_stats}")
            
            # Stop listener
            await self.portfolio_listener.stop_listener()
            listener_task.cancel()
            
            logger.info("✅ Portfolio Calculator test completed successfully!")
            
        except Exception as e:
            logger.error(f"❌ Test failed with error: {e}")
            raise
        finally:
            await self.redis_client.close()

async def main():
    """Main test function"""
    tester = PortfolioCalculatorTester()
    await tester.run_comprehensive_test()

if __name__ == "__main__":
    asyncio.run(main())
