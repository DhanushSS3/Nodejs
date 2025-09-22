import orjson
import time
import asyncio
from typing import Dict, Any, Optional
from ..config.redis_config import redis_cluster, redis_pubsub_client
import logging
import math

logger = logging.getLogger(__name__)

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
            
            current_timestamp = int(time.time() * 1000)  # epoch milliseconds
            
            # Batch validate and prepare data with partial update support
            valid_updates = []
            for symbol, price_data in market_prices.items():
                processed_data = await self._validate_and_parse_partial_price(symbol, price_data, current_timestamp)
                if processed_data:
                    valid_updates.append(processed_data)
            
            if not valid_updates:
                logger.debug("No valid price updates to process")
                return False
            
            # Process partial updates with Redis merge logic
            await self._process_partial_updates_sharded(valid_updates)
            
            # Publish price update notifications for Portfolio Calculator
            await self._publish_price_update_notifications(valid_updates)
            
            logger.debug(f"Processed {len(market_prices)} symbol updates")
            return True
            
        except Exception as e:
            logger.error(f"Failed to process market feed: {e}")
            return False
    
    async def _process_partial_updates_sharded(self, valid_updates: list, shard_size: int = 500):
        """
        Process partial price updates using multiple Redis pipelines for better performance
        
        Args:
            valid_updates: List of validated partial price update tuples
            shard_size: Number of symbols per pipeline shard
        """
        # Split into shards
        shards = [valid_updates[i:i + shard_size] for i in range(0, len(valid_updates), shard_size)]
        
        # Process shards concurrently
        tasks = []
        for shard in shards:
            task = self._process_partial_update_shard(shard)
            tasks.append(task)
        
        # Wait for all shards to complete
        await asyncio.gather(*tasks)
    
    async def _process_partial_update_shard(self, update_shard: list):
        """
        Process a single shard of partial price updates with Redis merge logic
        
        Args:
            update_shard: List of partial price update tuples for this shard
        """
        max_retries = 3
        retry_delay = 0.1  # 100ms
        
        for attempt in range(max_retries):
            try:
                async with self.redis.pipeline() as pipe:
                    for symbol, update_fields, timestamp in update_shard:
                        # Use simple format to match all readers
                        key = f"market:{symbol}"
                        
                        # Always update timestamp
                        update_fields['ts'] = timestamp
                        
                        # Use HSET to update only the provided fields (bid/ask/ts)
                        # This preserves existing bid or ask if only one is updated
                        pipe.hset(key, mapping=update_fields)
                    
                    await pipe.execute()
                    return  # Success, exit retry loop
                    
            except (ConnectionError, TimeoutError, OSError) as e:
                if attempt < max_retries - 1:
                    logger.warning(f"Redis connection error on attempt {attempt + 1}/{max_retries}: {e}. Retrying in {retry_delay}s...")
                    await asyncio.sleep(retry_delay)
                    retry_delay *= 2  # Exponential backoff
                else:
                    logger.error(f"Failed to process partial update shard after {max_retries} attempts: {e}")
                    # Continue processing other shards even if this one fails
                    
            except Exception as e:
                logger.error(f"Unexpected error processing partial update shard: {e}")
                break  # Don't retry for unexpected errors
    
    async def _validate_and_parse_partial_price(self, symbol: str, price_data: Dict[str, str], timestamp: int) -> Optional[tuple]:
        """
        Parse individual symbol partial price data (no bid/ask relational validation)
        Handles cases where only 'buy' or 'sell' is provided. Any provided side is accepted
        and written as-is after float parsing.
        
        Price mapping: buy -> ask (price users pay to buy), sell -> bid (price users get when selling)
        
        Args:
            symbol: Trading symbol (e.g., 'EURUSD')
            price_data: Dict with optional 'buy' and/or 'sell' price strings
            timestamp: Current timestamp in milliseconds
            
        Returns:
            tuple: (symbol, update_fields_dict, timestamp) if valid, None otherwise
        """
        try:
            # Extract price data (partial updates allowed)
            buy_str = price_data.get('buy')
            sell_str = price_data.get('sell')

            if buy_str is None and sell_str is None:
                logger.debug(f"No price data provided for {symbol}")
                return None

            update_fields = {}

            # Parse buy price if provided (buy -> ask)
            if buy_str is not None:
                try:
                    update_fields['ask'] = float(buy_str)
                except (ValueError, TypeError) as e:
                    logger.debug(f"Failed to parse buy price for {symbol}: {e}")

            # Parse sell price if provided (sell -> bid)
            if sell_str is not None:
                try:
                    update_fields['bid'] = float(sell_str)
                except (ValueError, TypeError) as e:
                    logger.debug(f"Failed to parse sell price for {symbol}: {e}")

            # If neither side parsed successfully, skip
            if not update_fields:
                return None

            return (symbol, update_fields, timestamp)

        except Exception as e:
            logger.error(f"Unexpected error processing partial price for {symbol}: {e}")
            return None
    
    async def _get_existing_price_for_validation(self, symbol: str) -> Optional[Dict[str, float]]:
        """
        Get existing price from Redis for validation purposes
        
        Args:
            symbol: Trading symbol
            
        Returns:
            Dict with existing bid/ask prices or None
        """
        try:
            key = f"market:{symbol}"
            price_data = await self.redis.hmget(key, ["bid", "ask"])
            
            if price_data and any(price_data):
                result = {}
                if price_data[0]:  # bid exists
                    result['bid'] = float(price_data[0])
                if price_data[1]:  # ask exists
                    result['ask'] = float(price_data[1])
                return result
            
            return None
            
        except Exception as e:
            logger.debug(f"Could not get existing price for {symbol}: {e}")
            return None
    
    async def get_symbol_price(self, symbol: str) -> Optional[Dict[str, float]]:
        """
        Get current price for a symbol with staleness check
        
        Args:
            symbol: Trading symbol
            
        Returns:
            Dict with bid, ask, ts or None if stale/missing
        """
        try:
            # Fetch from structured hash
            key = f"market:{symbol}"
            price_data = await self.redis.hmget(key, ["bid", "ask", "ts"])
            
            if not all(price_data):
                logger.debug(f"No price data found for {symbol}")
                return None
            
            bid, ask, ts = price_data
            timestamp = int(ts)
            current_time = int(time.time() * 1000)
            
            # Check staleness (reject if >5s old)
            if current_time - timestamp > (self.staleness_threshold * 1000):
                logger.warning(f"Stale price data for {symbol}: {(current_time - timestamp) / 1000}s old")
                return None
            
            return {
                "bid": float(bid),
                "ask": float(ask),
                "ts": timestamp
            }
            
        except Exception as e:
            logger.error(f"Failed to get price for {symbol}: {e}")
            return None
    
    async def get_multiple_prices(self, symbols: list) -> Dict[str, Dict[str, float]]:
        """
        Get prices for multiple symbols efficiently
        
        Args:
            symbols: List of trading symbols
            
        Returns:
            Dict mapping symbol to price data
        """
        try:
            async with self.redis.pipeline() as pipe:
                # Batch fetch all symbols
                for symbol in symbols:
                    key = f"market:{symbol}"
                    pipe.hmget(key, ["bid", "ask", "ts"])
                
                results = await pipe.execute()
            
            current_time = int(time.time() * 1000)
            
            prices = {}
            for i, symbol in enumerate(symbols):
                price_data = results[i]
                if all(price_data):
                    bid, ask, ts = price_data
                    timestamp = int(ts)
                    
                    # Check staleness
                    if current_time - timestamp <= (self.staleness_threshold * 1000):
                        prices[symbol] = {
                            "bid": float(bid),
                            "ask": float(ask),
                            "ts": timestamp
                        }
            
            return prices
            
        except Exception as e:
            logger.error(f"Failed to get multiple prices: {e}")
            return {}
    
    async def get_all_prices_snapshot(self) -> Dict[str, Any]:
        """
        Get complete market snapshot for monitoring/dashboards
        Build from structured hashes instead of separate JSON storage
        
        Returns:
            Dict with all current prices
        """
        try:
            # Scan for all market: keys to get symbols (handle hash-tagged keys)
            symbols = []
            async for key in self.redis.scan_iter(match="market:*", count=1000):
                if key.startswith("market:"):
                    # Extract symbol from key: market:EURUSD -> EURUSD
                    symbol = key[7:]  # Remove "market:" prefix
                    
                    if symbol and symbol != "prices":  # Skip market:prices if it exists
                        symbols.append(symbol)
            
            if not symbols:
                return {"timestamp": int(time.time() * 1000), "total_symbols": 0, "prices": {}}
            
            # Batch fetch all symbol prices
            async with self.redis.pipeline() as pipe:
                for symbol in symbols:
                    key = f"market:{symbol}"
                    pipe.hmget(key, ["bid", "ask", "ts"])
                
                results = await pipe.execute()
            
            # Build snapshot with staleness check
            current_time = int(time.time() * 1000)
            valid_prices = {}
            
            for i, symbol in enumerate(symbols):
                price_data = results[i]
                if all(price_data):
                    bid, ask, ts = price_data
                    timestamp = int(ts)
                    
                    # Check staleness
                    if current_time - timestamp <= (self.staleness_threshold * 1000):
                        valid_prices[symbol] = {
                            "bid": float(bid),
                            "ask": float(ask),
                            "ts": timestamp
                        }
            
            return {
                "timestamp": current_time,
                "total_symbols": len(valid_prices),
                "prices": valid_prices
            }
            
        except Exception as e:
            logger.error(f"Failed to get price snapshot: {e}")
            return {"timestamp": int(time.time() * 1000), "total_symbols": 0, "prices": {}}
    
    async def _publish_price_update_notifications(self, valid_updates: list):
        """
        Publish symbol notifications to Redis Pub/Sub for Portfolio Calculator
        
        Args:
            valid_updates: List of validated price update tuples (symbol, update_fields, timestamp)
        """
        if not valid_updates:
            return
        
        # Extract unique symbols from valid updates
        symbols_in_message = [update[0] for update in valid_updates]  # symbol is first element in tuple
        
        logger.debug(f"Publishing price update notifications for {len(symbols_in_message)} symbols")
        
        # Use dedicated Redis client for pub/sub operations
        for symbol in symbols_in_message:
            try:
                await self.pubsub_redis.publish("market_price_updates", symbol)
                logger.debug(f"Published price update notification for {symbol}")
            except Exception as e:
                logger.error(f"Failed to publish symbol {symbol}: {e}")
                # Continue with other symbols even if one fails
    
    def is_price_stale(self, timestamp: int) -> bool:
        """Check if price timestamp is stale (>5s old)"""
        current_time = int(time.time() * 1000)
        return (current_time - timestamp) > (self.staleness_threshold * 1000)
