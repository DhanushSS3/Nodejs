import asyncio
import orjson
import logging
import time
import websockets
from typing import Dict, Any, List
from .services.market_data_service import MarketDataService

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class MarketListener:
    """WebSocket market data listener for real-time price feeds"""
    
    def __init__(self):
        self.ws_url = "ws://188.241.62.105:9001/?token=Lkj@asd@123"
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
                    
                except websockets.exceptions.ConnectionClosed:
                    reconnect_count += 1
                    logger.warning(f"WebSocket connection closed. Reconnecting... (attempt {reconnect_count})")
                    await asyncio.sleep(self.reconnect_delay)
                    
                except websockets.exceptions.InvalidURI:
                    logger.error(f"Invalid WebSocket URI: {self.ws_url}")
                    break
                    
                except Exception as e:
                    reconnect_count += 1
                    logger.error(f"Unexpected error in market listener: {e}")
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
    
    async def _connect_and_listen(self):
        """Establish WebSocket connection and listen for market data"""
        logger.info(f"Connecting to market feed: {self.ws_url}")
        
        async with websockets.connect(
            self.ws_url,
            ping_interval=30,
            ping_timeout=10,
            close_timeout=10
        ) as websocket:
            logger.info("Connected to market feed successfully")
            
            async for message in websocket:
                try:
                    await self._process_message(message)
                except Exception as e:
                    logger.error(f"Error processing message: {e}")
                    # Continue listening even if one message fails
    
    async def _process_message(self, message: str):
        """
        Queue incoming WebSocket message for batch processing
        
        Args:
            message: Raw WebSocket message string
        """
        try:
            # Parse JSON message with orjson (5-10x faster)
            data = orjson.loads(message)
            logger.debug(f"Received message: {data}")
            # Validate message structure
            if 'datafeeds' not in data:
                logger.debug("Message does not contain datafeeds, skipping")
                return
            
            datafeeds = data['datafeeds']
            if not isinstance(datafeeds, dict):
                logger.warning("Invalid datafeeds format, expected dict")
                return
            
            # Add to batch queue
            self.message_queue.append(data)
            
            # Process batch if size threshold reached
            if len(self.message_queue) >= self.batch_size:
                await self._process_message_batch()
                
        except orjson.JSONDecodeError as e:
            logger.error(f"Invalid JSON in message: {e}")
        except Exception as e:
            logger.error(f"Unexpected error processing message: {e}")
    
    async def _process_message_batch(self):
        """
        Process queued messages in batch for better performance
        """
        if not self.message_queue:
            return
        
        batch = self.message_queue.copy()
        self.message_queue.clear()
        
        try:
            # Merge all datafeeds from batch into single feed
            merged_datafeeds = {}
            total_symbols = 0
            
            for data in batch:
                datafeeds = data.get('datafeeds', {})
                merged_datafeeds.update(datafeeds)
                total_symbols += len(datafeeds)
            
            if merged_datafeeds:
                # Process merged feed
                merged_data = {'datafeeds': merged_datafeeds}
                success = await self.market_service.process_market_feed(merged_data)
                
                if success:
                    logger.debug(f"Batch processed {len(merged_datafeeds)} unique symbols from {len(batch)} messages")
                else:
                    logger.warning(f"Failed to process batch of {len(batch)} messages")
            
        except Exception as e:
            logger.error(f"Error processing message batch: {e}")
    
    async def stop(self):
        """Stop the market listener gracefully"""
        logger.info("Stopping market listener...")
        self.is_running = False
    
    async def get_connection_status(self) -> Dict[str, Any]:
        """Get current connection status"""
        return {
            "is_running": self.is_running,
            "ws_url": self.ws_url,
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
