


import asyncio
import orjson
import logging
import time
import websockets
from typing import Dict, Any, List
# from services.market_data_service import MarketDataService
from app.services.market_data_service import MarketDataService
from app.services.logging.execution_price_logger import log_websocket_issue
from app.market_data_warmup import warmup_after_reconnection

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class MarketListener:
    """WebSocket market data listener for real-time price feeds"""
    
    def __init__(self):
        # Primary WebSocket URL with fallback to IP address
        self.ws_urls = [
            "wss://quotes.livefxhub.com:9001/?token=Lkj@asd@123",
            "wss://188.241.62.105:9001/?token=Lkj@asd@123"  # IP fallback for DNS issues
        ]
        self.current_url_index = 0
        self.market_service = MarketDataService()
        self.reconnect_delay = 5  # seconds
        self.max_reconnect_attempts = 10
        self.is_running = False
        self.message_queue = []
        self.batch_size = 10  # Process messages in batches
        self.batch_timeout = 0.1  # 100ms batch timeout
        
    async def start(self):
        """Start the market listener with auto-reconnection and batch processing"""
        self.is_running = True
        reconnect_count = 0
        
        logger.info("Starting market data listener...")
        
        # Start batch timeout task
        batch_task = asyncio.create_task(self._batch_timeout_handler())
        
        try:
            while self.is_running and reconnect_count < self.max_reconnect_attempts:
                try:
                    await self._connect_and_listen()
                    reconnect_count = 0  # Reset on successful connection
                    
                except websockets.exceptions.ConnectionClosed as e:
                    reconnect_count += 1
                    logger.warning(f"🔌 WebSocket connection closed: {e}")
                    logger.warning(f"🔄 Reconnecting... (attempt {reconnect_count}/{self.max_reconnect_attempts})")
                    logger.info(f"⏳ Waiting {self.reconnect_delay}s before reconnection")
                    await asyncio.sleep(self.reconnect_delay)
                    
                except websockets.exceptions.InvalidURI:
                    current_url = self.ws_urls[self.current_url_index]
                    logger.error(f"Invalid WebSocket URI: {current_url}")
                    # Try next URL if available
                    if self._try_next_url():
                        logger.info(f"Switching to fallback URL: {self.ws_urls[self.current_url_index]}")
                        continue
                    else:
                        break
                    
                except (OSError, ConnectionRefusedError, Exception) as e:
                    reconnect_count += 1
                    current_url = self.ws_urls[self.current_url_index]
                    
                    # Handle DNS resolution errors specifically
                    if "getaddrinfo failed" in str(e) or "Name or service not known" in str(e):
                        logger.error(f"DNS resolution failed for {current_url}: {e}")
                        if self._try_next_url():
                            logger.info(f"Switching to IP fallback: {self.ws_urls[self.current_url_index]}")
                            reconnect_count = 0  # Reset count when switching URLs
                            continue
                    
                    logger.error(f"Connection error with {current_url}: {e}")
                    await asyncio.sleep(self.reconnect_delay)
            
            if reconnect_count >= self.max_reconnect_attempts:
                logger.error("Max reconnection attempts reached. Stopping market listener.")
        
        finally:
            # Clean up batch task
            batch_task.cancel()
            try:
                await batch_task
            except asyncio.CancelledError:
                pass
            
            # Process any remaining messages
            if self.message_queue:
                await self._process_message_batch()
        
        logger.info("Market listener stopped")
    
    async def _batch_timeout_handler(self):
        """Handle batch timeout to prevent messages from sitting too long"""
        while self.is_running:
            await asyncio.sleep(self.batch_timeout)
            if self.message_queue:
                await self._process_message_batch()
    
    def _try_next_url(self):
        """Try the next URL in the list. Returns True if switched, False if no more URLs."""
        if self.current_url_index < len(self.ws_urls) - 1:
            self.current_url_index += 1
            return True
        return False
    
    def _get_current_url(self):
        """Get the current WebSocket URL"""
        return self.ws_urls[self.current_url_index]
    
    async def _connect_and_listen(self):
        """Establish WebSocket connection and listen for market data"""
        current_url = self._get_current_url()
        logger.info(f"Connecting to market feed: {current_url}")
        
        async with websockets.connect(
            current_url,
            ping_interval=None,    # Disable ping temporarily to test
            ping_timeout=None,     # Disable ping timeout
            close_timeout=10,
            max_size=10**7,        # Handle large messages
            compression=None       # Disable compression for stability
        ) as websocket:
            logger.info("Connected to market feed successfully")
            logger.info("WebSocket ping: DISABLED (testing mode)")
            
            # Warmup market data immediately after connection to prevent stale prices
            logger.info("🔥 Warming up market data after connection...")
            warmup_success = await warmup_after_reconnection()
            if warmup_success:
                logger.info("✅ Market data warmup successful")
            else:
                logger.warning("⚠️ Market data warmup had issues, but continuing...")
            
            # Track connection health
            message_count = 0
            last_message_time = time.time()
            
            async for message in websocket:
                try:
                    message_count += 1
                    current_time = time.time()
                    
                    # Log periodic health info
                    if message_count % 100 == 0:
                        uptime = current_time - last_message_time if message_count == 100 else current_time - last_message_time
                        logger.info(f"📈 Received {message_count} messages, connection stable for {uptime:.1f}s")
                    
                    await self._process_message(message)
                    last_message_time = current_time
                    
                except Exception as e:
                    logger.error(f"Error processing message: {e}")
                    # Continue listening even if one message fails
            
            logger.warning("WebSocket message loop ended")
    
    async def _process_message(self, message: str):
        """
        Queue incoming WebSocket message for batch processing
        
        Args:
            message: Raw WebSocket message string
        """
        start_time = time.time()
        
        try:
            # Parse JSON message with orjson (5-10x faster)
            data = orjson.loads(message)
            logger.debug(f"[WEBSOCKET] Received message: {len(message)} chars")
            
            # Validate new message structure
            if data.get('type') != 'market_update':
                log_websocket_issue("INVALID_MESSAGE_TYPE", 
                                  message_size=len(message),
                                  message_type=data.get('type'))
                logger.warning(f"[WEBSOCKET] Message type is not 'market_update': {data.get('type')}")
                return
            
            if 'data' not in data:
                log_websocket_issue("MISSING_DATA_KEY", 
                                  message_size=len(message),
                                  available_keys=list(data.keys()))
                logger.warning(f"[WEBSOCKET] Message missing 'data' key. Available keys: {list(data.keys())}")
                return
            
            message_data = data['data']
            if 'market_prices' not in message_data:
                log_websocket_issue("MISSING_MARKET_PRICES_KEY", 
                                  message_size=len(message),
                                  available_keys=list(message_data.keys()))
                logger.warning(f"[WEBSOCKET] Message data missing 'market_prices' key. Available keys: {list(message_data.keys())}")
                return
            
            market_prices = message_data['market_prices']
            if not isinstance(market_prices, dict):
                log_websocket_issue("INVALID_MARKET_PRICES_FORMAT", 
                                  message_size=len(message),
                                  actual_type=type(market_prices).__name__)
                logger.error(f"[WEBSOCKET] Invalid market_prices format: {type(market_prices)}, expected dict")
                return
            
            # Log processing time for large messages
            processing_time_ms = (time.time() - start_time) * 1000
            if processing_time_ms > 50 or len(message) > 10000:  # Log slow processing or large messages
                log_websocket_issue("SLOW_MESSAGE_PROCESSING", 
                                  message_size=len(message),
                                  processing_time_ms=processing_time_ms,
                                  symbols_count=len(market_prices))
            
            logger.debug(f"[WEBSOCKET] Valid market_prices: {len(market_prices)} symbols")
            
            # Add to batch queue with normalized structure
            normalized_data = {'market_prices': market_prices}
            self.message_queue.append(normalized_data)
            
            # Process batch if size threshold reached
            if len(self.message_queue) >= self.batch_size:
                await self._process_message_batch()
                
        except orjson.JSONDecodeError as e:
            log_websocket_issue("JSON_DECODE_ERROR", 
                              message_size=len(message),
                              error=str(e),
                              message_preview=message[:200])
            logger.error(f"[WEBSOCKET] Invalid JSON in message: {e}. Message preview: {message[:200]}...")
        except Exception as e:
            log_websocket_issue("UNEXPECTED_ERROR", 
                              message_size=len(message),
                              error=str(e))
            logger.error(f"[WEBSOCKET] Unexpected error processing message: {e}")
    
    async def _process_message_batch(self):
        """
        Process queued messages in batch for better performance
        """
        if not self.message_queue:
            logger.debug("[BATCH] No messages in queue to process")
            return
        
        batch = self.message_queue.copy()
        self.message_queue.clear()
        
        logger.debug(f"[BATCH] Processing {len(batch)} messages")
        
        try:
            # Merge all market_prices from batch into single feed
            merged_market_prices = {}
            total_symbols = 0
            
            for data in batch:
                market_prices = data.get('market_prices', {})
                
                # Merge partial price updates - later updates override earlier ones
                for symbol, price_data in market_prices.items():
                    if symbol not in merged_market_prices:
                        merged_market_prices[symbol] = {}
                    
                    # Merge buy/sell prices (partial updates)
                    # buy -> ask (price users pay to buy), sell -> bid (price users get when selling)
                    if 'buy' in price_data:
                        merged_market_prices[symbol]['buy'] = price_data['buy']
                    if 'sell' in price_data:
                        merged_market_prices[symbol]['sell'] = price_data['sell']
                
                total_symbols += len(market_prices)
            
            if merged_market_prices:
                # Process merged feed with new structure
                merged_data = {'market_prices': merged_market_prices}
                success = await self.market_service.process_market_feed(merged_data)
                
                if success:
                    logger.debug(f"[BATCH] ✅ Successfully processed {len(merged_market_prices)} unique symbols from {len(batch)} messages")
                else:
                    logger.info(f"[BATCH] ❌ Failed to process batch of {len(batch)} messages with {len(merged_market_prices)} symbols")
            else:
                logger.warning(f"[BATCH] No market_prices found in batch of {len(batch)} messages")
            
        except Exception as e:
            logger.error(f"[BATCH] Error processing message batch: {e}")
    
    async def stop(self):
        """Stop the market listener gracefully"""
        logger.info("Stopping market listener...")
        self.is_running = False
    
    async def get_connection_status(self) -> Dict[str, Any]:
        """Get current connection status"""
        return {
            "is_running": self.is_running,
            "current_ws_url": self._get_current_url(),
            "all_ws_urls": self.ws_urls,
            "current_url_index": self.current_url_index,
            "reconnect_delay": self.reconnect_delay,
            "max_reconnect_attempts": self.max_reconnect_attempts,
            "batch_size": self.batch_size,
            "batch_timeout": self.batch_timeout,
            "queued_messages": len(self.message_queue)
        }

# Global market listener instance
market_listener = MarketListener()

async def start_market_listener():
    """Start the market listener as a background task"""
    await market_listener.start()

async def stop_market_listener():
    """Stop the market listener"""
    await market_listener.stop()

if __name__ == "__main__":
    """Run market listener when executed directly"""
    print("Starting Market Data Listener...")
    try:
        asyncio.run(start_market_listener())
    except KeyboardInterrupt:
        print("\nMarket listener stopped by user")
    except Exception as e:
        print(f"Market listener error: {e}")
        import traceback
        traceback.print_exc()
