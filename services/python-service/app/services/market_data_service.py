import json
import time
import asyncio
from typing import Dict, Any, Optional
from ..config.redis_config import redis_cluster
import logging

logger = logging.getLogger(__name__)

class MarketDataService:
    """Service for processing and storing market price data in Redis"""
    
    def __init__(self):
        self.redis = redis_cluster
        self.staleness_threshold = 5  # 5 seconds
    
    async def process_market_feed(self, feed_data: Dict[str, Any]) -> bool:
        """
        Process bulk market feed data and store in Redis
        
        Args:
            feed_data: Dictionary containing 'datafeeds' with symbol price data
            
        Returns:
            bool: True if processing successful, False otherwise
        """
        try:
            datafeeds = feed_data.get('datafeeds', {})
            if not datafeeds:
                logger.warning("No datafeeds found in market feed")
                return False
            
            current_timestamp = int(time.time() * 1000)  # epoch milliseconds
            
            # Use Redis pipeline for batch operations
            pipe = self.redis.pipeline()
            
            processed_count = 0
            for symbol, price_data in datafeeds.items():
                if await self._process_symbol_price(pipe, symbol, price_data, current_timestamp):
                    processed_count += 1
            
            # Execute all Redis operations in batch
            pipe.execute()
            
            logger.info(f"Processed {processed_count} symbols in market feed")
            return True
            
        except Exception as e:
            logger.error(f"Failed to process market feed: {e}")
            return False
    
    async def _process_symbol_price(self, pipe, symbol: str, price_data: Dict[str, str], timestamp: int) -> bool:
        """
        Process individual symbol price data
        
        Args:
            pipe: Redis pipeline for batch operations
            symbol: Trading symbol (e.g., 'EURUSD')
            price_data: Dict with 'buy' and 'sell' price strings
            timestamp: Current timestamp in milliseconds
            
        Returns:
            bool: True if processing successful
        """
        try:
            # Extract and validate price data
            buy_str = price_data.get('buy')
            sell_str = price_data.get('sell')
            
            if not buy_str or not sell_str:
                logger.warning(f"Missing price data for {symbol}: buy={buy_str}, sell={sell_str}")
                return False
            
            # Parse prices to floats
            # buy = market's ask price (what user pays when buying)
            # sell = market's bid price (what user gets when selling)
            ask_price = float(buy_str)  # buy -> ask
            bid_price = float(sell_str)  # sell -> bid
            
            # Validate prices
            if ask_price <= 0 or bid_price <= 0:
                logger.warning(f"Invalid prices for {symbol}: ask={ask_price}, bid={bid_price}")
                return False
            
            if bid_price > ask_price:
                logger.warning(f"Bid > Ask for {symbol}: bid={bid_price}, ask={ask_price}")
                return False
            
            # 1. Store in global snapshot hash (JSON format)
            price_json = json.dumps({
                "bid": bid_price,
                "ask": ask_price,
                "ts": timestamp
            })
            pipe.hset("market:prices", symbol, price_json)
            
            # 2. Store in per-symbol structured hash (direct floats)
            pipe.hset(f"market:{symbol}", mapping={
                "bid": bid_price,
                "ask": ask_price,
                "ts": timestamp
            })
            
            return True
            
        except (ValueError, TypeError) as e:
            logger.error(f"Failed to parse prices for {symbol}: {e}")
            return False
        except Exception as e:
            logger.error(f"Unexpected error processing {symbol}: {e}")
            return False
    
    async def get_symbol_price(self, symbol: str) -> Optional[Dict[str, float]]:
        """
        Get current price for a symbol with staleness check
        
        Args:
            symbol: Trading symbol
            
        Returns:
            Dict with bid, ask, ts or None if stale/missing
        """
        try:
            # Fetch from structured hash for O(1) access
            price_data = self.redis.hmget(f"market:{symbol}", ["bid", "ask", "ts"])
            
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
            pipe = self.redis.pipeline()
            
            # Batch fetch all symbols
            for symbol in symbols:
                pipe.hmget(f"market:{symbol}", ["bid", "ask", "ts"])
            
            results = pipe.execute()
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
        
        Returns:
            Dict with all current prices
        """
        try:
            # Fetch from global snapshot hash
            snapshot = self.redis.hgetall("market:prices")
            
            # Parse JSON values and check staleness
            current_time = int(time.time() * 1000)
            valid_prices = {}
            
            for symbol, price_json in snapshot.items():
                try:
                    price_data = json.loads(price_json)
                    timestamp = price_data.get('ts', 0)
                    
                    # Check staleness
                    if current_time - timestamp <= (self.staleness_threshold * 1000):
                        valid_prices[symbol] = price_data
                        
                except json.JSONDecodeError:
                    logger.warning(f"Invalid JSON for {symbol}: {price_json}")
                    continue
            
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
