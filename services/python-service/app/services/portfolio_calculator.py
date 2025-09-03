"""
Portfolio Calculator Service - Step 1: Market Price Update Listener

This service implements the first step of the Portfolio Calculator:
- Listens to market_price_updates Redis pub/sub channel
- Fetches affected users from symbol_holders Redis sets
- Maintains dirty_user_ids in-memory sets for throttled processing
- Follows SOLID principles with single responsibility and dependency inversion
"""

import asyncio
import logging
from typing import Set, Dict
from threading import Lock
import time

from ..config.redis_config import redis_cluster, redis_pubsub_client


class PortfolioCalculatorListener:
    """
    Single Responsibility: Listen to market updates and collect dirty users
    Open/Closed: Can be extended with new user types without modification
    Dependency Inversion: Depends on Redis abstractions, not concrete implementations
    """
    
    def __init__(self):
        self.logger = logging.getLogger(__name__)
        
        # In-memory dirty user sets (thread-safe)
        self._dirty_users_lock = Lock()
        self._dirty_users: Dict[str, Set[str]] = {
            'live': set(),
            'demo': set()
        }
        
        # Statistics for monitoring
        self._stats = {
            'symbols_processed': 0,
            'users_affected_total': 0,
            'last_update_time': None,
            'start_time': time.time(),
            'users_processed': 0,
            'calculation_errors': 0
        }
        
        # Redis pub/sub subscription
        self._pubsub = None
        self._running = False
        
        # Throttled calculation loop task
        self._calculation_task = None

    async def start_listener(self):
        """Start the market price update listener and calculation loop"""
        self.logger.info("Starting Portfolio Calculator Listener...")
        try:
            self._pubsub = redis_pubsub_client.pubsub()
            await self._pubsub.subscribe('market_price_updates')
            self._running = True
            self.logger.info("Successfully subscribed to market_price_updates channel")

            # Start throttled calculation loop as a background task
            loop = asyncio.get_event_loop()
            self._calculation_task = loop.create_task(self._throttled_calculation_loop())

            # Start the main listening loop
            await self._listen_loop()
            
        except Exception as e:
            self.logger.error(f"Failed to start portfolio calculator listener: {e}")
            raise
    
    async def stop_listener(self):
        """Stop the listener and calculation loop gracefully"""
        self.logger.info("Stopping Portfolio Calculator Listener...")
        self._running = False
        if self._pubsub:
            await self._pubsub.unsubscribe('market_price_updates')
            await self._pubsub.close()
        if self._calculation_task:
            self._calculation_task.cancel()
        self.logger.info("Portfolio Calculator Listener stopped")

    async def _throttled_calculation_loop(self):
        """
        Throttled batch calculation loop (every 200ms):
        - Copies and clears dirty user sets
        - For each user, fetches holdings, market prices, calculates portfolio, writes to Redis
        """
        self.logger.info("Starting throttled portfolio calculation loop (200ms interval)")
        while self._running:
            await asyncio.sleep(0.2)
            batch = {'live': set(), 'demo': set()}
            with self._dirty_users_lock:
                for user_type in ('live', 'demo'):
                    batch[user_type] = set(self._dirty_users[user_type])
                    self._dirty_users[user_type].clear()
            for user_type in ('live', 'demo'):
                if not batch[user_type]:
                    continue
                await self._process_dirty_users_batch(batch[user_type], user_type)

    async def _process_dirty_users_batch(self, user_ids: Set[str], user_type: str):
        """
        For each dirty user, fetch holdings, fetch prices, calculate, and update Redis
        """
        for user_key in user_ids:
            try:
                # user_key format: 'live:12345' or 'demo:67890'
                if not user_key.startswith(f"{user_type}:"):
                    self.logger.warning(f"Invalid user_key format: {user_key}")
                    continue
                user_id = user_key.split(":", 1)[1]
                holdings = await self._fetch_user_holdings(user_type, user_id)
                if not holdings:
                    continue
                symbols = list(holdings.keys())
                prices = await self._fetch_market_prices(symbols)
                group_data = await self._fetch_user_group_data(user_type, user_id)
                portfolio = self._calculate_portfolio_metrics(holdings, prices, group_data)
                await self._update_user_portfolio(user_type, user_id, portfolio)
                self._stats['users_processed'] += 1
            except Exception as e:
                self.logger.error(f"Portfolio calculation error for {user_key}: {e}")
                self._stats['calculation_errors'] += 1

    async def _fetch_user_holdings(self, user_type: str, user_id: str) -> dict:
        """Fetch all open positions for a user from Redis hash user_holdings:{user_type}:{user_id}"""
        redis_key = f"user_holdings:{user_type}:{user_id}"
        try:
            holdings = await redis_cluster.hgetall(redis_key)
            # holdings: {symbol: quantity}
            return {symbol: float(qty) for symbol, qty in holdings.items()} if holdings else {}
        except Exception as e:
            self.logger.error(f"Error fetching holdings for {redis_key}: {e}")
            return {}

    async def _fetch_market_prices(self, symbols: list) -> dict:
        """Fetch latest market prices for all given symbols from Redis hashes market:{symbol}"""
        prices = {}
        try:
            for symbol in symbols:
                redis_key = f"market:{symbol}"
                price_data = await redis_cluster.hgetall(redis_key)
                # Expecting {bid, ask, ts}
                if price_data:
                    prices[symbol] = {k: float(v) for k, v in price_data.items() if k in ('bid', 'ask') and v is not None}
            return prices
        except Exception as e:
            self.logger.error(f"Error fetching market prices for symbols {symbols}: {e}")
            return prices

    async def _fetch_user_group_data(self, user_type: str, user_id: str) -> dict:
        """Stub for group data/currency conversion, can be extended for margin, contract size, etc."""
        # For now, return empty dict; extend as needed for margin, contract size, etc.
        return {}

    def _calculate_portfolio_metrics(self, holdings: dict, prices: dict, group_data: dict) -> dict:
        """
        Calculate PnL, equity, used margin, free margin, margin level, etc.
        holdings: {symbol: quantity}
        prices: {symbol: {bid, ask}}
        group_data: for future extension
        """
        balance = 10000  # Placeholder, should be fetched from user balance in DB/Redis
        contract_size = 1  # Placeholder, should be fetched from group_data or per-symbol
        total_pl = 0
        used_margin = 0
        for symbol, qty in holdings.items():
            price_info = prices.get(symbol)
            if not price_info:
                continue
            entry_price = 1  # Placeholder, should be fetched per order
            # Assume positive qty = BUY, negative qty = SELL
            if qty > 0:
                pnl = (price_info.get('bid', 0) - entry_price) * qty * contract_size
            else:
                pnl = (entry_price - price_info.get('ask', 0)) * abs(qty) * contract_size
            total_pl += pnl
            # used_margin calculation placeholder
            used_margin += abs(qty) * contract_size * 0.01  # Dummy margin formula
        equity = balance + total_pl
        free_margin = equity - used_margin
        margin_level = (equity / used_margin * 100) if used_margin > 0 else 0
        return {
            'equity': round(equity, 2),
            'free_margin': round(free_margin, 2),
            'used_margin': round(used_margin, 2),
            'margin_level': round(margin_level, 2),
            'total_pl': round(total_pl, 2)
        }

    async def _update_user_portfolio(self, user_type: str, user_id: str, portfolio: dict):
        """Write portfolio metrics to Redis hash user_portfolio:{user_type}:{user_id}"""
        redis_key = f"user_portfolio:{user_type}:{user_id}"
        try:
            await redis_cluster.hset(redis_key, mapping=portfolio)
            self.logger.debug(f"Updated portfolio for {redis_key}: {portfolio}")
        except Exception as e:
            self.logger.error(f"Error updating portfolio for {redis_key}: {e}")

    
    async def _listen_loop(self):
        """Main listening loop for market price updates"""
        self.logger.info("Portfolio Calculator Listener is now active")
        
        try:
            async for message in self._pubsub.listen():
                if not self._running:
                    break
                
                if message['type'] == 'message':
                    symbol = message['data']
                    await self._process_symbol_update(symbol)
                    
        except Exception as e:
            self.logger.error(f"Error in portfolio calculator listen loop: {e}")
            if self._running:
                # Attempt to reconnect after a delay
                await asyncio.sleep(5)
                await self.start_listener()
    
    async def _process_symbol_update(self, symbol: str):
        """
        Process a single symbol update by fetching affected users
        Single Responsibility: Only handles symbol update processing
        """
        try:
            self.logger.debug(f"Processing symbol update: {symbol}")
            
            # Fetch affected users for both user types
            live_users = await self._fetch_symbol_holders(symbol, 'live')
            demo_users = await self._fetch_symbol_holders(symbol, 'demo')
            
            # Add to dirty user sets
            users_added = 0
            if live_users:
                users_added += self._add_to_dirty_users(live_users, 'live')
            if demo_users:
                users_added += self._add_to_dirty_users(demo_users, 'demo')
            
            # Update statistics
            self._update_stats(symbol, users_added)
            
            if users_added > 0:
                self.logger.info(
                    f"Symbol {symbol}: Added {users_added} users to dirty sets "
                    f"(live: {len(live_users)}, demo: {len(demo_users)})"
                )
            
        except Exception as e:
            self.logger.error(f"Error processing symbol update for {symbol}: {e}")
    
    async def _fetch_symbol_holders(self, symbol: str, user_type: str) -> Set[str]:
        """
        Fetch all users holding positions in a specific symbol
        
        Args:
            symbol: The trading symbol (e.g., 'EURUSD')
            user_type: 'live' or 'demo'
            
        Returns:
            Set of user identifiers in format 'user_type:user_id'
        """
        try:
            redis_key = f"symbol_holders:{symbol}:{user_type}"
            
            # Use Redis SMEMBERS to get all users holding this symbol
            user_ids = await redis_cluster.smembers(redis_key)
            
            if user_ids:
                # Convert to set and ensure proper format
                formatted_users = {
                    f"{user_type}:{user_id}" if not user_id.startswith(f"{user_type}:") 
                    else user_id 
                    for user_id in user_ids
                }
                
                self.logger.debug(
                    f"Found {len(formatted_users)} {user_type} users for symbol {symbol}"
                )
                return formatted_users
            
            return set()
            
        except Exception as e:
            self.logger.error(
                f"Error fetching symbol holders for {symbol}:{user_type}: {e}"
            )
            return set()
    
    def _add_to_dirty_users(self, user_ids: Set[str], user_type: str) -> int:
        """
        Add user IDs to the dirty users set for a specific user type
        Thread-safe operation with automatic deduplication
        
        Args:
            user_ids: Set of user identifiers to add
            user_type: 'live' or 'demo'
            
        Returns:
            Number of new users added (excluding duplicates)
        """
        if not user_ids or user_type not in self._dirty_users:
            return 0
        
        with self._dirty_users_lock:
            # Get current size before adding
            before_size = len(self._dirty_users[user_type])
            
            # Add all user IDs (set automatically deduplicates)
            self._dirty_users[user_type].update(user_ids)
            
            # Calculate how many new users were actually added
            after_size = len(self._dirty_users[user_type])
            new_users_added = after_size - before_size
            
            return new_users_added
    
    def _update_stats(self, symbol: str, users_affected: int):
        """Update internal statistics for monitoring"""
        self._stats['symbols_processed'] += 1
        self._stats['users_affected_total'] += users_affected
        self._stats['last_update_time'] = time.time()
        
        # Log statistics periodically
        if self._stats['symbols_processed'] % 100 == 0:
            self._log_statistics()
    
    def _log_statistics(self):
        """Log current statistics for monitoring"""
        uptime = time.time() - self._stats['start_time']
        
        with self._dirty_users_lock:
            live_dirty = len(self._dirty_users['live'])
            demo_dirty = len(self._dirty_users['demo'])
        
        self.logger.info(
            f"Portfolio Calculator Stats - "
            f"Symbols processed: {self._stats['symbols_processed']}, "
            f"Total users affected: {self._stats['users_affected_total']}, "
            f"Current dirty users (live: {live_dirty}, demo: {demo_dirty}), "
            f"Uptime: {uptime:.1f}s"
        )
    
    def get_dirty_users(self, user_type: str) -> Set[str]:
        """
        Get current dirty users for a specific user type (read-only)
        Thread-safe operation
        
        Args:
            user_type: 'live' or 'demo'
            
        Returns:
            Copy of current dirty users set
        """
        with self._dirty_users_lock:
            return self._dirty_users.get(user_type, set()).copy()
    
    def get_and_clear_dirty_users(self, user_type: str) -> Set[str]:
        """
        Get and clear dirty users for a specific user type
        Thread-safe operation for throttled processing
        
        Args:
            user_type: 'live' or 'demo'
            
        Returns:
            Set of dirty users that were cleared
        """
        with self._dirty_users_lock:
            if user_type not in self._dirty_users:
                return set()
            
            dirty_users = self._dirty_users[user_type].copy()
            self._dirty_users[user_type].clear()
            
            if dirty_users:
                self.logger.debug(
                    f"Cleared {len(dirty_users)} dirty {user_type} users for processing"
                )
            
            return dirty_users
    
    def get_statistics(self) -> Dict:
        """Get current listener statistics"""
        uptime = time.time() - self._stats['start_time']
        
        with self._dirty_users_lock:
            current_stats = {
                **self._stats,
                'uptime_seconds': uptime,
                'dirty_users_live': len(self._dirty_users['live']),
                'dirty_users_demo': len(self._dirty_users['demo']),
                'is_running': self._running
            }
        
        return current_stats


# Global instance for the application
portfolio_listener = PortfolioCalculatorListener()


async def start_portfolio_listener():
    """Start the portfolio calculator listener as a background task"""
    await portfolio_listener.start_listener()


async def stop_portfolio_listener():
    """Stop the portfolio calculator listener"""
    await portfolio_listener.stop_listener()
