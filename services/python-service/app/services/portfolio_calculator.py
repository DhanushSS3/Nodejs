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
        
        # In-memory FX cache with short TTL to reduce Redis calls for conversion pairs
        self._fx_cache = {
            'ttl': 1.0,  # seconds
            'rates': {}  # mapping: symbol -> {'ts': epoch_seconds, 'bid': float, 'ask': float}
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
        - For each user, fetches all open orders, market prices, calculates portfolio, writes to Redis
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
        For each dirty user, fetch all open orders, fetch prices, calculate, and update Redis
        """
        for user_key in user_ids:
            try:
                if not user_key.startswith(f"{user_type}:"):
                    self.logger.warning(f"Invalid user_key format: {user_key}")
                    continue
                user_id = user_key.split(":", 1)[1]
                orders = await self._fetch_user_orders(user_type, user_id)
                if not orders:
                    continue
                symbols = list({order['symbol'] for order in orders if 'symbol' in order})
                prices = await self._fetch_market_prices(symbols)
                # Fetch user config (balance, leverage, group)
                balance, leverage, group = await self._fetch_user_balance_and_leverage(user_type, user_id)
                # Fetch group data for all symbols (user group with fallback to Standard)
                group_data = await self._fetch_group_data_batch(symbols, group)
                portfolio = await self._calculate_portfolio_metrics(orders, prices, group_data, balance, leverage)
                await self._update_user_portfolio(user_type, user_id, portfolio)
                self._stats['users_processed'] += 1
            except Exception as e:
                self.logger.error(f"Portfolio calculation error for {user_key}: {e}")
                self._stats['calculation_errors'] += 1

    async def _fetch_user_orders(self, user_type: str, user_id: str) -> list:
        """
        Fetch all open order hashes for a user from Redis: user_holdings:{user_type}:{user_id}:{order_id}
        Returns a list of order dicts.
        """
        pattern = f"user_holdings:{user_type}:{user_id}:*"
        try:
            # Scan for all order keys for this user
            cursor = b'0'
            order_keys = []
            while cursor:
                cursor, keys = await redis_cluster.scan(cursor=cursor, match=pattern, count=50)
                order_keys.extend(keys)
                if cursor == b'0' or cursor == 0:
                    break
            if not order_keys:
                return []
            # Pipeline hgetall for all orders
            orders = await asyncio.gather(*(redis_cluster.hgetall(k) for k in order_keys))
            # Add symbol field from key if missing
            for i, k in enumerate(order_keys):
                if 'symbol' not in orders[i]:
                    # Try to extract symbol from order fields or key
                    pass  # Extend as needed
            return orders
        except Exception as e:
            self.logger.error(f"Error fetching orders for {user_type}:{user_id}: {e}")
            return []

    async def _fetch_market_prices(self, symbols: list) -> dict:
        """
        Fetch latest market prices for all given symbols from Redis hashes market:{symbol}
        Returns dict: {symbol: {'bid':..., 'ask':...}}
        """
        prices = {}
        try:
            for symbol in symbols:
                redis_key = f"market:{symbol}"
                price_data = await redis_cluster.hgetall(redis_key)
                if price_data:
                    prices[symbol] = {k: float(v) for k, v in price_data.items() if k in ('bid', 'ask') and v is not None}
            return prices
        except Exception as e:
            self.logger.error(f"Error fetching market prices for symbols {symbols}: {e}")
            return prices

    async def _fetch_user_balance_and_leverage(self, user_type: str, user_id: str):
        """
        Fetch user's wallet balance, leverage, and group from Redis:
        Key: user:{user_type}:{user_id}:config (Hash)
        Fallbacks: balance=0.0, leverage=100.0, group="Standard"
        """
        try:
            key = f"user:{user_type}:{user_id}:config"
            data = await redis_cluster.hgetall(key)
            if not data:
                return 0.0, 100.0, "Standard"
            # Safe parsing
            balance_raw = data.get('wallet_balance', 0)
            leverage_raw = data.get('leverage', 100)
            group = data.get('group', 'Standard') or 'Standard'
            try:
                balance = float(balance_raw)
            except (TypeError, ValueError):
                balance = 0.0
            try:
                leverage = float(leverage_raw)
            except (TypeError, ValueError):
                leverage = 100.0
            if leverage <= 0:
                leverage = 100.0
            return balance, leverage, group
        except Exception as e:
            self.logger.error(f"Error fetching user config for {user_type}:{user_id}: {e}")
            return 0.0, 100.0, "Standard"

    async def _fetch_group_data_batch(self, symbols: list, group: str) -> dict:
        """
        Fetch contract_size and profit currency for each symbol from groups:{group}:{symbol},
        with fallback to groups:{Standard}:{symbol} if missing.
        Returns dict: {symbol: {'contract_size': float, 'profit': str}}
        """
        group_data = {}
        try:
            # First try user-specific group keys in parallel
            grp_keys = [f"groups:{{{group}}}:{symbol}" for symbol in symbols]
            grp_results = await asyncio.gather(*(redis_cluster.hgetall(k) for k in grp_keys))

            # Collect missing symbols to fallback to Standard
            missing_indices = [i for i, data in enumerate(grp_results) if not data]
            std_results_map = {}
            if missing_indices:
                std_keys = [f"groups:{{Standard}}:{symbols[i]}" for i in missing_indices]
                std_results = await asyncio.gather(*(redis_cluster.hgetall(k) for k in std_keys))
                for idx, data in zip(missing_indices, std_results):
                    std_results_map[idx] = data

            for i, symbol in enumerate(symbols):
                data = grp_results[i] if grp_results[i] else std_results_map.get(i, None)
                if data:
                    try:
                        contract_size = float(data.get('contract_size', 1))
                    except (TypeError, ValueError):
                        contract_size = 1.0
                    profit = data.get('profit', 'USD') or 'USD'
                else:
                    contract_size = 1.0
                    profit = 'USD'
                group_data[symbol] = {'contract_size': contract_size, 'profit': profit}
            return group_data
        except Exception as e:
            self.logger.error(f"Error fetching group data for symbols {symbols}: {e}")
            return group_data

    async def _calculate_portfolio_metrics(self, orders: list, prices: dict, group_data: dict, balance: float, leverage: float) -> dict:
        """
        Calculate PnL, equity, used margin, free margin, margin level, etc.
        - Swap and commission are handled per order
        - Contract size and profit currency are fetched from user's group (fallback to Standard)
        - PnL is always converted to USD
        """
        total_pl_usd = 0.0
        used_margin = 0.0
        for order in orders:
            try:
                symbol = order.get('symbol')
                if not symbol or symbol not in prices or symbol not in group_data:
                    continue
                order_type = (order.get('order_type') or '').upper()
                # Safe float parsing from Redis string values
                try:
                    entry_price = float(order.get('order_price', 0) or 0)
                except (TypeError, ValueError):
                    entry_price = 0.0
                try:
                    quantity = float(order.get('order_quantity', 0) or 0)
                except (TypeError, ValueError):
                    quantity = 0.0
                try:
                    margin = float(order.get('margin', 0) or 0)
                except (TypeError, ValueError):
                    margin = 0.0
                try:
                    swap = float(order.get('swap', 0) or 0)
                except (TypeError, ValueError):
                    swap = 0.0
                try:
                    commission = float(order.get('commission', 0) or 0)
                except (TypeError, ValueError):
                    commission = 0.0
                try:
                    contract_size = float(group_data[symbol].get('contract_size', 1) or 1)
                except (TypeError, ValueError):
                    contract_size = 1.0
                profit_currency = group_data[symbol].get('profit', 'USD')
                # Use latest market prices
                market_bid = prices[symbol].get('bid', 0)
                market_ask = prices[symbol].get('ask', 0)
                if order_type == 'BUY':
                    pnl = (market_bid - entry_price) * quantity * contract_size
                elif order_type == 'SELL':
                    pnl = (entry_price - market_ask) * quantity * contract_size
                else:
                    pnl = 0
                pnl += swap - commission
                pnl_usd = await self.convert_to_usd(pnl, profit_currency, symbol, prices)
                total_pl_usd += pnl_usd
                # Dynamic margin calculation if missing or non-positive
                if margin and margin > 0:
                    used_margin += margin
                else:
                    if leverage and leverage > 0:
                        dyn_margin = (contract_size * quantity) / leverage
                    else:
                        dyn_margin = (contract_size * quantity) / 100.0  # default leverage fallback
                    used_margin += dyn_margin
            except Exception as e:
                self.logger.error(f"Error calculating order PnL: {order}: {e}")
                continue
        equity = balance + total_pl_usd
        free_margin = equity - used_margin
        margin_level = (equity / used_margin * 100) if used_margin > 0 else 0
        return {
            'equity': round(equity, 2),
            'balance': round(balance, 2),
            'free_margin': round(free_margin, 2),
            'used_margin': round(used_margin, 2),
            'margin_level': round(margin_level, 2),
            'open_pnl': round(total_pl_usd, 2),
            'total_pl': round(total_pl_usd, 2),
            'ts': int(time.time() * 1000),
        }

    async def convert_to_usd(self, amount: float, from_currency: str, symbol: str, prices: dict = None) -> float:
        """
        Convert amount from from_currency to USD using current market rates.
        - If from_currency is USD, return amount.
        - Otherwise, fetch the appropriate market:{symbol} for conversion.
        - 'prices' may be passed in for efficiency.
        """
        try:
            if from_currency.upper() == 'USD':
                return amount
            # Determine available conversion symbol and orientation
            conversion_symbol = None
            invert = False
            prices = prices or {}

            # 1) Check passed-in prices
            if f"{from_currency}USD" in prices:
                conversion_symbol = f"{from_currency}USD"
                invert = False
                conv_price = float(prices[conversion_symbol].get('bid', 0) or 0)
            elif f"USD{from_currency}" in prices:
                conversion_symbol = f"USD{from_currency}"
                invert = True
                conv_price = float(prices[conversion_symbol].get('bid', 0) or 0)
            else:
                conv_price = 0.0

            # 2) Check cache if not found or zero
            if (not conversion_symbol) or (conv_price == 0):
                now = time.time()
                # Prefer direct from_currencyUSD
                cached = self._fx_cache['rates'].get(f"{from_currency}USD")
                if cached and (now - cached['ts'] <= self._fx_cache['ttl']):
                    conversion_symbol = f"{from_currency}USD"
                    invert = False
                    conv_price = cached.get('bid', 0) or 0
                else:
                    cached_inv = self._fx_cache['rates'].get(f"USD{from_currency}")
                    if cached_inv and (now - cached_inv['ts'] <= self._fx_cache['ttl']):
                        conversion_symbol = f"USD{from_currency}"
                        invert = True
                        conv_price = cached_inv.get('bid', 0) or 0

            # 3) Fetch from Redis if still missing or zero
            if (not conversion_symbol) or (conv_price == 0):
                # Try direct pair first
                conv_price_data = await redis_cluster.hgetall(f"market:{from_currency}USD")
                if conv_price_data:
                    conversion_symbol = f"{from_currency}USD"
                    invert = False
                    try:
                        conv_price = float(conv_price_data.get('bid', 0) or 0)
                    except (TypeError, ValueError):
                        conv_price = 0.0
                    # Update cache
                    self._fx_cache['rates'][conversion_symbol] = {
                        'ts': time.time(),
                        'bid': conv_price,
                        'ask': float(conv_price_data.get('ask', 0) or 0) if conv_price_data else 0,
                    }
                else:
                    conv_price_data2 = await redis_cluster.hgetall(f"market:USD{from_currency}")
                    if conv_price_data2:
                        conversion_symbol = f"USD{from_currency}"
                        invert = True
                        try:
                            conv_price = float(conv_price_data2.get('bid', 0) or 0)
                        except (TypeError, ValueError):
                            conv_price = 0.0
                        self._fx_cache['rates'][conversion_symbol] = {
                            'ts': time.time(),
                            'bid': conv_price,
                            'ask': float(conv_price_data2.get('ask', 0) or 0) if conv_price_data2 else 0,
                        }

            if conv_price == 0:
                self.logger.warning(f"Conversion rate for {conversion_symbol} is 0, returning amount unchanged.")
                return amount
            # If USD is base, invert
            if invert:
                return amount / conv_price
            else:
                return amount * conv_price
        except Exception as e:
            self.logger.error(f"Error converting {amount} {from_currency} to USD: {e}")
            return amount

    async def _update_user_portfolio(self, user_type: str, user_id: str, portfolio: dict):
        """
        Write portfolio metrics to Redis hash user_portfolio:{user_type}:{user_id}
        """
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
