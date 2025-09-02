import orjson
import time
import asyncio
from typing import Dict, Any, Optional
from ..config.redis_config import redis_cluster
import logging
import math

logger = logging.getLogger(__name__)

class MarketDataService:
    """Service for processing and storing market price data in Redis"""
    
    def __init__(self):
        self.redis = redis_cluster
        self.staleness_threshold = 5  # 5 seconds
    
    async def process_market_feed(self, feed_data: Dict[str, Any]) -> bool:
        """
        Process bulk market feed data and store in Redis with pipeline sharding
        
        Args:
            feed_data: Dictionary containing 'datafeeds' with symbol price data
            
        Returns:
            bool: True if processing successful, False otherwise
        """
        try:
            datafeeds = feed_data.get('datafeeds', {})
            logger.debug(f"Received datafeeds: {datafeeds}")
            if not datafeeds:
                logger.warning("No datafeeds found in market feed")
                return False
            
            current_timestamp = int(time.time() * 1000)  # epoch milliseconds
            
            # Batch validate and prepare data first
            valid_prices = []
            for symbol, price_data in datafeeds.items():
                processed_data = self._validate_and_parse_price(symbol, price_data, current_timestamp)
                if processed_data:
                    valid_prices.append(processed_data)
            
            if not valid_prices:
                logger.warning("No valid prices to process")
                return False
            
            # Shard into multiple pipelines for high-volume bursts
            await self._process_prices_sharded(valid_prices)
            
            logger.info(f"Processed {len(valid_prices)} symbols in market feed")
            return True
            
        except Exception as e:
            logger.error(f"Failed to process market feed: {e}")
            return False
    
    async def _process_prices_sharded(self, valid_prices: list, shard_size: int = 500):
        """
        Process prices using multiple Redis pipelines for better performance
        
        Args:
            valid_prices: List of validated price tuples
            shard_size: Number of symbols per pipeline shard
        """
        # Split into shards
        shards = [valid_prices[i:i + shard_size] for i in range(0, len(valid_prices), shard_size)]
        
        # Process shards concurrently
        tasks = []
        for shard in shards:
            task = self._process_price_shard(shard)
            tasks.append(task)
        
        # Wait for all shards to complete
        await asyncio.gather(*tasks)
    
    async def _process_price_shard(self, price_shard: list):
        """
        Process a single shard of prices with one pipeline
        
        Args:
            price_shard: List of price tuples for this shard
        """
        try:
            async with self.redis.pipeline() as pipe:
                for symbol, bid, ask, timestamp in price_shard:
                    # Use hash-tagging for better cluster distribution
                    key = f"market:{{{symbol[:3]}}}:{symbol}"
                    pipe.hset(key, mapping={
                        "bid": bid,
                        "ask": ask,
                        "ts": timestamp
                    })
                
                await pipe.execute()
                
        except Exception as e:
            logger.error(f"Failed to process price shard: {e}")
    
    def _validate_and_parse_price(self, symbol: str, price_data: Dict[str, str], timestamp: int) -> Optional[tuple]:
        """
        Validate and parse individual symbol price data (sync for batch processing)
        
        Args:
            symbol: Trading symbol (e.g., 'EURUSD')
            price_data: Dict with 'buy' and 'sell' price strings
            timestamp: Current timestamp in milliseconds
            
        Returns:
            tuple: (symbol, bid, ask, timestamp) if valid, None otherwise
        """
        try:
            # Extract and validate price data
            buy_str = price_data.get('buy')
            sell_str = price_data.get('sell')
            
            if not buy_str or not sell_str:
                logger.debug(f"Missing price data for {symbol}: buy={buy_str}, sell={sell_str}")
                return None
            
            # Parse prices to floats
            # buy = market's ask price (what user pays when buying)
            # sell = market's bid price (what user gets when selling)
            ask_price = float(buy_str)  # buy -> ask
            bid_price = float(sell_str)  # sell -> bid
            
            # Validate prices
            if ask_price <= 0 or bid_price <= 0:
                logger.debug(f"Invalid prices for {symbol}: ask={ask_price}, bid={bid_price}")
                return None
            
            if bid_price > ask_price:
                logger.debug(f"Bid > Ask for {symbol}: bid={bid_price}, ask={ask_price}")
                return None
            
            return (symbol, bid_price, ask_price, timestamp)
            
        except (ValueError, TypeError) as e:
            logger.debug(f"Failed to parse prices for {symbol}: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error processing {symbol}: {e}")
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
            # Fetch from structured hash with hash-tagging for O(1) access
            key = f"market:{{{symbol[:3]}}}:{symbol}"
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
                # Batch fetch all symbols with hash-tagging
                for symbol in symbols:
                    key = f"market:{{{symbol[:3]}}}:{symbol}"
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
                    # Extract symbol from hash-tagged key: market:{EUR}:EURUSD -> EURUSD
                    if "}:" in key:
                        symbol = key.split("}:", 1)[1]
                    else:
                        # Fallback for non-hash-tagged keys
                        symbol = key[7:]  # Remove "market:" prefix
                    
                    if symbol and symbol != "prices":  # Skip market:prices if it exists
                        symbols.append(symbol)
            
            if not symbols:
                return {"timestamp": int(time.time() * 1000), "total_symbols": 0, "prices": {}}
            
            # Batch fetch all symbol prices with hash-tagging
            async with self.redis.pipeline() as pipe:
                for symbol in symbols:
                    key = f"market:{{{symbol[:3]}}}:{symbol}"
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
    
    def is_price_stale(self, timestamp: int) -> bool:
        """Check if price timestamp is stale (>5s old)"""
        current_time = int(time.time() * 1000)
        return (current_time - timestamp) > (self.staleness_threshold * 1000)
