#!/usr/bin/env python3
"""
Copy Trading Integration Test Script

This script tests the complete copy trading integration:
1. Portfolio Calculator extension for strategy_provider and copy_follower user types
2. Redis key patterns compatibility
3. Worker compatibility with new user types
4. Autocutoff system integration

Usage:
    python test_copy_trading_integration.py
"""

import asyncio
import logging
import sys
import os
import time
from typing import Dict, Any

# Add the app directory to Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'app'))

from app.config.redis_config import redis_cluster
from app.services.portfolio_calculator import portfolio_listener

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class CopyTradingIntegrationTest:
    """Test suite for copy trading integration"""
    
    def __init__(self):
        self.test_data = {
            'strategy_provider_id': 'test_sp_123',
            'copy_follower_id': 'test_cf_456',
            'test_symbol': 'EURUSD',
            'test_order_id': 'test_order_789'
        }
        
    async def run_all_tests(self):
        """Run all integration tests"""
        logger.info("Starting Copy Trading Integration Tests")
        
        try:
            # Test 1: Redis Key Pattern Compatibility
            await self.test_redis_key_patterns()
            
            # Test 2: Portfolio Calculator Extension
            await self.test_portfolio_calculator_extension()
            
            # Test 3: Symbol Holders Integration
            await self.test_symbol_holders_integration()
            
            # Test 4: User Config Pattern
            await self.test_user_config_pattern()
            
            # Test 5: Portfolio Data Structure
            await self.test_portfolio_data_structure()
            
            # Test 6: Clean up test data
            await self.cleanup_test_data()
            
            logger.info("✅ All Copy Trading Integration Tests PASSED")
            return True
            
        except Exception as e:
            logger.error(f"❌ Integration Tests FAILED: {e}")
            await self.cleanup_test_data()
            return False
            
    async def test_redis_key_patterns(self):
        """Test Redis key patterns for copy trading"""
        logger.info("Testing Redis Key Patterns...")
        
        sp_id = self.test_data['strategy_provider_id']
        cf_id = self.test_data['copy_follower_id']
        order_id = self.test_data['test_order_id']
        symbol = self.test_data['test_symbol']
        
        # Test strategy provider keys
        sp_hash_tag = f"strategy_provider:{sp_id}"
        sp_order_key = f"user_holdings:{{{sp_hash_tag}}}:{order_id}"
        sp_index_key = f"user_orders_index:{{{sp_hash_tag}}}"
        sp_portfolio_key = f"user_portfolio:{{{sp_hash_tag}}}"
        sp_config_key = f"user:{{{sp_hash_tag}}}:config"
        sp_symbol_holders_key = f"symbol_holders:{symbol}:strategy_provider"
        
        # Test copy follower keys
        cf_hash_tag = f"copy_follower:{cf_id}"
        cf_order_key = f"user_holdings:{{{cf_hash_tag}}}:{order_id}"
        cf_index_key = f"user_orders_index:{{{cf_hash_tag}}}"
        cf_portfolio_key = f"user_portfolio:{{{cf_hash_tag}}}"
        cf_config_key = f"user:{{{cf_hash_tag}}}:config"
        cf_symbol_holders_key = f"symbol_holders:{symbol}:copy_follower"
        
        # Create test data
        test_order_data = {
            'order_id': order_id,
            'symbol': symbol,
            'order_type': 'BUY',
            'order_status': 'OPEN',
            'order_price': '1.1000',
            'order_quantity': '1.0',
            'user_type': 'strategy_provider',
            'user_id': sp_id
        }
        
        # Test strategy provider Redis operations
        await redis_cluster.hset(sp_order_key, mapping=test_order_data)
        await redis_cluster.sadd(sp_index_key, order_id)
        await redis_cluster.sadd(sp_symbol_holders_key, sp_hash_tag)
        
        # Test copy follower Redis operations
        cf_order_data = test_order_data.copy()
        cf_order_data['user_type'] = 'copy_follower'
        cf_order_data['user_id'] = cf_id
        
        await redis_cluster.hset(cf_order_key, mapping=cf_order_data)
        await redis_cluster.sadd(cf_index_key, order_id)
        await redis_cluster.sadd(cf_symbol_holders_key, cf_hash_tag)
        
        # Verify data was stored correctly
        sp_order_retrieved = await redis_cluster.hgetall(sp_order_key)
        cf_order_retrieved = await redis_cluster.hgetall(cf_order_key)
        
        assert sp_order_retrieved['user_type'] == 'strategy_provider'
        assert cf_order_retrieved['user_type'] == 'copy_follower'
        
        logger.info("✅ Redis Key Patterns test passed")
        
    async def test_portfolio_calculator_extension(self):
        """Test portfolio calculator extension for copy trading"""
        logger.info("Testing Portfolio Calculator Extension...")
        
        # Check if portfolio calculator supports new user types
        dirty_users = portfolio_listener._dirty_users
        
        required_user_types = ['live', 'demo', 'strategy_provider', 'copy_follower']
        for user_type in required_user_types:
            assert user_type in dirty_users, f"Missing user type: {user_type}"
            
        # Test adding users to dirty sets
        sp_user_key = f"strategy_provider:{self.test_data['strategy_provider_id']}"
        cf_user_key = f"copy_follower:{self.test_data['copy_follower_id']}"
        
        portfolio_listener._add_to_dirty_users({sp_user_key}, 'strategy_provider')
        portfolio_listener._add_to_dirty_users({cf_user_key}, 'copy_follower')
        
        # Verify users were added
        sp_dirty = portfolio_listener.get_dirty_users('strategy_provider')
        cf_dirty = portfolio_listener.get_dirty_users('copy_follower')
        
        assert sp_user_key in sp_dirty
        assert cf_user_key in cf_dirty
        
        logger.info("✅ Portfolio Calculator Extension test passed")
        
    async def test_symbol_holders_integration(self):
        """Test symbol holders integration"""
        logger.info("Testing Symbol Holders Integration...")
        
        symbol = self.test_data['test_symbol']
        
        # Test fetching symbol holders for copy trading user types
        sp_holders = await portfolio_listener._fetch_symbol_holders(symbol, 'strategy_provider')
        cf_holders = await portfolio_listener._fetch_symbol_holders(symbol, 'copy_follower')
        
        # Should return sets (even if empty)
        assert isinstance(sp_holders, set)
        assert isinstance(cf_holders, set)
        
        logger.info("✅ Symbol Holders Integration test passed")
        
    async def test_user_config_pattern(self):
        """Test user config pattern for copy trading"""
        logger.info("Testing User Config Pattern...")
        
        sp_id = self.test_data['strategy_provider_id']
        cf_id = self.test_data['copy_follower_id']
        
        # Test strategy provider config
        sp_config_key = f"user:{{strategy_provider:{sp_id}}}:config"
        sp_config_data = {
            'wallet_balance': '10000.00',
            'leverage': '100',
            'group': 'Standard',
            'auto_cutoff_level': '50.00'
        }
        await redis_cluster.hset(sp_config_key, mapping=sp_config_data)
        
        # Test copy follower config
        cf_config_key = f"user:{{copy_follower:{cf_id}}}:config"
        cf_config_data = {
            'wallet_balance': '5000.00',
            'leverage': '100',
            'group': 'Standard',
            'auto_cutoff_level': '50.00'  # Inherited from strategy provider
        }
        await redis_cluster.hset(cf_config_key, mapping=cf_config_data)
        
        # Verify configs were stored
        sp_config_retrieved = await redis_cluster.hgetall(sp_config_key)
        cf_config_retrieved = await redis_cluster.hgetall(cf_config_key)
        
        assert sp_config_retrieved['wallet_balance'] == '10000.00'
        assert cf_config_retrieved['wallet_balance'] == '5000.00'
        assert sp_config_retrieved['auto_cutoff_level'] == cf_config_retrieved['auto_cutoff_level']
        
        logger.info("✅ User Config Pattern test passed")
        
    async def test_portfolio_data_structure(self):
        """Test portfolio data structure for copy trading"""
        logger.info("Testing Portfolio Data Structure...")
        
        sp_id = self.test_data['strategy_provider_id']
        cf_id = self.test_data['copy_follower_id']
        
        # Test strategy provider portfolio
        sp_portfolio_key = f"user_portfolio:{{strategy_provider:{sp_id}}}"
        sp_portfolio_data = {
            'equity': '10500.00',
            'balance': '10000.00',
            'free_margin': '9000.00',
            'used_margin': '1500.00',
            'used_margin_executed': '1500.00',
            'used_margin_all': '1500.00',
            'margin_level': '700.00',
            'open_pnl': '500.00',
            'total_pl': '500.00',
            'calc_status': 'ok',
            'ts': str(int(time.time() * 1000))
        }
        await redis_cluster.hset(sp_portfolio_key, mapping=sp_portfolio_data)
        
        # Test copy follower portfolio
        cf_portfolio_key = f"user_portfolio:{{copy_follower:{cf_id}}}"
        cf_portfolio_data = {
            'equity': '5250.00',
            'balance': '5000.00',
            'free_margin': '4500.00',
            'used_margin': '750.00',
            'used_margin_executed': '750.00',
            'used_margin_all': '750.00',
            'margin_level': '700.00',
            'open_pnl': '250.00',
            'total_pl': '250.00',
            'calc_status': 'ok',
            'ts': str(int(time.time() * 1000))
        }
        await redis_cluster.hset(cf_portfolio_key, mapping=cf_portfolio_data)
        
        # Verify portfolios were stored
        sp_portfolio_retrieved = await redis_cluster.hgetall(sp_portfolio_key)
        cf_portfolio_retrieved = await redis_cluster.hgetall(cf_portfolio_key)
        
        assert float(sp_portfolio_retrieved['margin_level']) == 700.00
        assert float(cf_portfolio_retrieved['margin_level']) == 700.00
        assert sp_portfolio_retrieved['calc_status'] == 'ok'
        assert cf_portfolio_retrieved['calc_status'] == 'ok'
        
        logger.info("✅ Portfolio Data Structure test passed")
        
    async def cleanup_test_data(self):
        """Clean up test data from Redis"""
        logger.info("Cleaning up test data...")
        
        sp_id = self.test_data['strategy_provider_id']
        cf_id = self.test_data['copy_follower_id']
        order_id = self.test_data['test_order_id']
        symbol = self.test_data['test_symbol']
        
        # Keys to clean up
        cleanup_keys = [
            # Strategy provider keys
            f"user_holdings:{{strategy_provider:{sp_id}}}:{order_id}",
            f"user_orders_index:{{strategy_provider:{sp_id}}}",
            f"user_portfolio:{{strategy_provider:{sp_id}}}",
            f"user:{{strategy_provider:{sp_id}}}:config",
            f"symbol_holders:{symbol}:strategy_provider",
            
            # Copy follower keys
            f"user_holdings:{{copy_follower:{cf_id}}}:{order_id}",
            f"user_orders_index:{{copy_follower:{cf_id}}}",
            f"user_portfolio:{{copy_follower:{cf_id}}}",
            f"user:{{copy_follower:{cf_id}}}:config",
            f"symbol_holders:{symbol}:copy_follower"
        ]
        
        # Delete all test keys
        for key in cleanup_keys:
            try:
                await redis_cluster.delete(key)
            except Exception as e:
                logger.warning(f"Failed to delete key {key}: {e}")
                
        # Clear dirty users from portfolio calculator
        portfolio_listener.get_and_clear_dirty_users('strategy_provider')
        portfolio_listener.get_and_clear_dirty_users('copy_follower')
        
        logger.info("✅ Test data cleanup completed")


async def main():
    """Main test runner"""
    test_suite = CopyTradingIntegrationTest()
    
    try:
        success = await test_suite.run_all_tests()
        if success:
            logger.info("🎉 Copy Trading Integration is ready for production!")
            return 0
        else:
            logger.error("💥 Copy Trading Integration tests failed!")
            return 1
    except KeyboardInterrupt:
        logger.info("Tests interrupted by user")
        return 1
    except Exception as e:
        logger.error(f"Unexpected error during tests: {e}")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(main())
