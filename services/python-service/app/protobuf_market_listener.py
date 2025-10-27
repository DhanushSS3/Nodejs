"""
Binary WebSocket Market Data Listener
Handles protobuf binary messages from wss://quotes.livefxhub.com:9001/?token=Lkj@asd@1234
Based on frontend JavaScript implementation with pako.inflate and protobuf decoding
"""
import asyncio
import logging
import time
import websockets
import zlib
import struct
from typing import Dict, Any, Optional
from collections import deque
from app.services.market_data_service import MarketDataService
from app.services.logging.execution_price_logger import log_websocket_issue, log_market_processing

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class ProtobufMarketListener:
    """
    WebSocket market data listener with protobuf decoding
    
    Matches the frontend JavaScript implementation:
    1. Connects to wss://quotes.livefxhub.com:9001/?token=Lkj@asd@1234
    2. Receives binary ArrayBuffer messages
    3. Decompresses using zlib (pako.inflate equivalent)
    4. Decodes protobuf using MarketUpdate schema
    """
    
    def __init__(self):
        self.ws_url = "wss://quotes.livefxhub.com:9001/?token=Lkj@asd@1234"
        self.market_service = MarketDataService()
        self.reconnect_delay = 5
        self.max_reconnect_attempts = 10
        self.is_running = False
        
        # High-frequency message processing
        self.message_queue = deque()
        self.batch_size = 50  # Process 50 messages per batch
        self.batch_timeout = 0.01  # 10ms batch timeout for low latency
        self.processing_task = None
        
        # Performance metrics
        self.stats = {
            'messages_processed': 0,
            'bytes_processed': 0,
            'parse_errors': 0,
            'successful_decodes': 0,
            'batches_processed': 0,
            'queue_size': 0,
            'avg_batch_size': 0
        }
        
    async def start(self):
        """Start the market listener with auto-reconnection and batch processing"""
        self.is_running = True
        reconnect_count = 0
        
        logger.info("Starting protobuf market data listener...")
        logger.info(f"Target WebSocket: {self.ws_url}")
        logger.info(f"Batch processing: {self.batch_size} messages per batch, {self.batch_timeout*1000}ms timeout")
        
        # Start batch processing task
        self.processing_task = asyncio.create_task(self._batch_processor())
        
        try:
            while self.is_running and reconnect_count < self.max_reconnect_attempts:
                try:
                    await self._connect_and_listen()
                    reconnect_count = 0
                    
                except websockets.exceptions.ConnectionClosed:
                    reconnect_count += 1
                    logger.warning(f"WebSocket connection closed. Reconnecting... (attempt {reconnect_count})")
                    await asyncio.sleep(self.reconnect_delay)
                    
                except Exception as e:
                    reconnect_count += 1
                    logger.error(f"WebSocket error: {e}")
                    await asyncio.sleep(self.reconnect_delay)
            
            if reconnect_count >= self.max_reconnect_attempts:
                logger.error("Max reconnection attempts reached. Stopping listener.")
        
        finally:
            # Clean shutdown
            if self.processing_task:
                self.processing_task.cancel()
                try:
                    await self.processing_task
                except asyncio.CancelledError:
                    pass
        
        logger.info("Protobuf market listener stopped")
    
    async def _connect_and_listen(self):
        """Establish WebSocket connection and listen for messages"""
        logger.info(f"Connecting to market feed: {self.ws_url}")
        
        async with websockets.connect(
            self.ws_url,
            ping_interval=None,  # Disable ping-pong - server sends continuous data
            ping_timeout=None,   # No ping timeout needed
            close_timeout=5,     # Faster close timeout
            max_size=10**7,      # 10MB max message size for high-frequency data
            read_limit=2**20     # 1MB read buffer for better throughput
        ) as websocket:
            logger.info("Connected to market feed successfully")
            
            async for message in websocket:
                try:
                    if isinstance(message, bytes):
                        # Queue message for batch processing instead of processing immediately
                        self.message_queue.append(message)
                        self.stats['messages_processed'] += 1
                        self.stats['bytes_processed'] += len(message)
                        self.stats['queue_size'] = len(self.message_queue)
                    else:
                        logger.warning(f"Received non-binary message, ignoring: {type(message)}")
                        
                except Exception as e:
                    logger.error(f"Error queuing message: {e}")
                    self.stats['parse_errors'] += 1
    
    async def _batch_processor(self):
        """Process messages in batches for high-frequency data handling"""
        logger.info("Starting batch processor for high-frequency market data")
        
        last_performance_log = time.time()
        performance_log_interval = 30  # Log performance every 30 seconds
        
        while self.is_running:
            try:
                # Wait for messages or timeout
                await asyncio.sleep(self.batch_timeout)
                
                # Periodic performance logging
                current_time = time.time()
                if current_time - last_performance_log >= performance_log_interval:
                    self.log_performance_summary()
                    last_performance_log = current_time
                
                if not self.message_queue:
                    continue
                
                # Extract batch of messages
                batch = []
                batch_size = min(self.batch_size, len(self.message_queue))
                
                for _ in range(batch_size):
                    if self.message_queue:
                        batch.append(self.message_queue.popleft())
                
                if batch:
                    # Process batch concurrently
                    await self._process_message_batch(batch)
                    
                    # Update stats
                    self.stats['batches_processed'] += 1
                    self.stats['avg_batch_size'] = (
                        (self.stats['avg_batch_size'] * (self.stats['batches_processed'] - 1) + len(batch)) 
                        / self.stats['batches_processed']
                    )
                    self.stats['queue_size'] = len(self.message_queue)
                    
            except asyncio.CancelledError:
                logger.info("Batch processor cancelled")
                break
            except Exception as e:
                logger.error(f"Batch processor error: {e}")
                await asyncio.sleep(0.1)  # Brief pause on error
    
    async def _process_message_batch(self, batch: list):
        """Process a batch of binary messages efficiently"""
        batch_start_time = time.time()
        
        # Decode all messages in parallel
        decode_tasks = []
        for message in batch:
            task = asyncio.create_task(self._decode_single_message(message))
            decode_tasks.append(task)
        
        # Wait for all decoding to complete
        decoded_results = await asyncio.gather(*decode_tasks, return_exceptions=True)
        
        # Collect all valid market data
        all_market_data = {}
        successful_decodes = 0
        
        for result in decoded_results:
            if isinstance(result, Exception):
                self.stats['parse_errors'] += 1
                continue
                
            if result and result.get('type') == 'market_update':
                market_data = result.get('data', {}).get('market_prices', {})
                if market_data:
                    all_market_data.update(market_data)
                    successful_decodes += 1
        
        # Process all market data in one batch
        if all_market_data:
            feed_data = {'market_prices': all_market_data}
            success = await self.market_service.process_market_feed(feed_data)
            
            if success:
                self.stats['successful_decodes'] += successful_decodes
                
            # Log batch processing metrics
            processing_time_ms = (time.time() - batch_start_time) * 1000
            log_market_processing(
                symbols_processed=len(all_market_data),
                processing_time_ms=processing_time_ms,
                batch_size=len(batch),
                success=success,
                total_symbols_received=len(all_market_data),
                valid_symbols=len(all_market_data)
            )
            
            logger.debug(f"Processed batch: {len(batch)} messages -> {len(all_market_data)} symbols in {processing_time_ms:.2f}ms")
    
    async def _decode_single_message(self, message: bytes):
        """Decode a single binary message (async version)"""
        try:
            # Step 1: Decompress binary data
            decompressed_data = zlib.decompress(message)
            
            # Step 2: Decode protobuf
            decoded_data = self._decode_market_update(decompressed_data)
            
            return decoded_data
            
        except Exception as e:
            logger.debug(f"Failed to decode message: {e}")
            return None
    
    async def _process_binary_message(self, message: bytes):
        """
        Process binary message following frontend JavaScript logic:
        1. Decompress with zlib (pako.inflate equivalent)
        2. Decode protobuf using MarketUpdate schema
        3. Extract market_prices data
        """
        start_time = time.time()
        
        try:
            self.stats['messages_processed'] += 1
            self.stats['bytes_processed'] += len(message)
            
            logger.debug(f"Processing binary message: {len(message)} bytes")
            
            # Step 1: Decompress binary data (equivalent to pako.inflate)
            try:
                decompressed_data = zlib.decompress(message)
                logger.debug(f"Decompressed data size: {len(decompressed_data)} bytes")
            except zlib.error as e:
                logger.error(f"Failed to decompress binary message: {e}")
                return
            
            # Step 2: Decode protobuf (equivalent to MarketUpdate.decode)
            decoded_data = self._decode_market_update(decompressed_data)
            
            if not decoded_data:
                logger.debug("No data decoded from protobuf")
                return
            
            # Step 3: Process market update (same as regular market_listener.py)
            if decoded_data.get('type') == 'market_update':
                market_data = decoded_data.get('data', {}).get('market_prices', {})
                
                if market_data:
                    logger.debug(f"Processing market update with {len(market_data)} symbols")
                    
                    # Use the same method as market_listener.py - process_market_feed
                    feed_data = {'market_prices': market_data}
                    success = await self.market_service.process_market_feed(feed_data)
                    
                    if success:
                        self.stats['successful_decodes'] += 1
                        logger.debug(f"✅ Successfully processed {len(market_data)} symbols via protobuf")
                    else:
                        logger.warning(f"❌ Failed to process protobuf market feed with {len(market_data)} symbols")
                    
                    # Log processing metrics (same format as market_listener.py)
                    processing_time_ms = (time.time() - start_time) * 1000
                    log_market_processing(
                        symbols_processed=len(market_data),
                        processing_time_ms=processing_time_ms,
                        batch_size=1,  # Single protobuf message
                        success=success,
                        total_symbols_received=len(market_data),
                        valid_symbols=len(market_data)
                    )
            
        except Exception as e:
            logger.error(f"Binary message processing error: {e}")
            self.stats['parse_errors'] += 1
            log_websocket_issue("PROTOBUF_DECODE_ERROR", 
                              message_size=len(message),
                              error=str(e))
    
    def _decode_market_update(self, data: bytes) -> Optional[Dict[str, Any]]:
        """
        Decode protobuf MarketUpdate message
        
        Schema (matching frontend JavaScript):
        MarketUpdate {
            type: string (id=1)
            data: MarketPrices (id=2)
        }
        
        MarketPrices {
            market_prices: map<string, MarketPrice> (id=1)
        }
        
        MarketPrice {
            buy: double (id=1)
            sell: double (id=2) 
            spread: double (id=3)
        }
        """
        try:
            result = {}
            offset = 0
            
            while offset < len(data):
                # Read field tag and wire type
                if offset >= len(data):
                    break
                    
                tag_byte = data[offset]
                wire_type = tag_byte & 0x07
                field_number = tag_byte >> 3
                offset += 1
                
                if field_number == 1 and wire_type == 2:  # type field (string)
                    length, bytes_read = self._read_varint(data, offset)
                    offset += bytes_read
                    
                    if offset + length <= len(data):
                        result['type'] = data[offset:offset + length].decode('utf-8')
                        offset += length
                        logger.debug(f"Decoded type: {result['type']}")
                
                elif field_number == 2 and wire_type == 2:  # data field (MarketPrices)
                    length, bytes_read = self._read_varint(data, offset)
                    offset += bytes_read
                    
                    if offset + length <= len(data):
                        market_prices_data = data[offset:offset + length]
                        market_prices = self._decode_market_prices(market_prices_data)
                        
                        if market_prices:
                            result['data'] = {'market_prices': market_prices}
                            logger.debug(f"Decoded {len(market_prices)} market prices")
                        
                        offset += length
                
                else:
                    # Skip unknown fields
                    offset = self._skip_field(data, offset, wire_type)
            
            return result if result else None
            
        except Exception as e:
            logger.error(f"Protobuf decode error: {e}")
            return None
    
    def _decode_market_prices(self, data: bytes) -> Dict[str, Dict[str, float]]:
        """Decode MarketPrices message containing map<string, MarketPrice>"""
        market_prices = {}
        offset = 0
        
        while offset < len(data):
            if offset >= len(data):
                break
                
            tag_byte = data[offset]
            wire_type = tag_byte & 0x07
            field_number = tag_byte >> 3
            offset += 1
            
            if field_number == 1 and wire_type == 2:  # market_prices map field
                length, bytes_read = self._read_varint(data, offset)
                offset += bytes_read
                
                if offset + length <= len(data):
                    map_entry_data = data[offset:offset + length]
                    symbol, price_data = self._decode_map_entry(map_entry_data)
                    
                    if symbol and price_data:
                        market_prices[symbol] = price_data
                    
                    offset += length
            else:
                offset = self._skip_field(data, offset, wire_type)
        
        return market_prices
    
    def _decode_map_entry(self, data: bytes) -> tuple:
        """Decode map entry: key=symbol (string), value=MarketPrice"""
        symbol = None
        price_data = None
        offset = 0
        
        while offset < len(data):
            if offset >= len(data):
                break
                
            tag_byte = data[offset]
            wire_type = tag_byte & 0x07
            field_number = tag_byte >> 3
            offset += 1
            
            if field_number == 1 and wire_type == 2:  # key (symbol string)
                length, bytes_read = self._read_varint(data, offset)
                offset += bytes_read
                
                if offset + length <= len(data):
                    symbol = data[offset:offset + length].decode('utf-8')
                    offset += length
            
            elif field_number == 2 and wire_type == 2:  # value (MarketPrice)
                length, bytes_read = self._read_varint(data, offset)
                offset += bytes_read
                
                if offset + length <= len(data):
                    price_message_data = data[offset:offset + length]
                    price_data = self._decode_market_price(price_message_data)
                    offset += length
            
            else:
                offset = self._skip_field(data, offset, wire_type)
        
        return symbol, price_data
    
    def _decode_market_price(self, data: bytes) -> Optional[Dict[str, float]]:
        """Decode MarketPrice message with buy, sell, spread fields"""
        price_data = {}
        offset = 0
        
        while offset < len(data):
            if offset >= len(data):
                break
                
            tag_byte = data[offset]
            wire_type = tag_byte & 0x07
            field_number = tag_byte >> 3
            offset += 1
            
            if wire_type == 1 and offset + 8 <= len(data):  # Fixed64 (double)
                price_bytes = data[offset:offset + 8]
                price = struct.unpack('<d', price_bytes)[0]
                
                if field_number == 1:  # buy field
                    price_data['buy'] = price
                elif field_number == 2:  # sell field  
                    price_data['sell'] = price
                elif field_number == 3:  # spread field
                    price_data['spread'] = price
                
                offset += 8
            else:
                offset = self._skip_field(data, offset, wire_type)
        
        return price_data if price_data else None
    
    def _read_varint(self, data: bytes, offset: int) -> tuple:
        """Read protobuf varint from data at offset, return (value, bytes_read)"""
        value = 0
        shift = 0
        bytes_read = 0
        
        while offset + bytes_read < len(data):
            byte = data[offset + bytes_read]
            bytes_read += 1
            
            value |= (byte & 0x7F) << shift
            
            if (byte & 0x80) == 0:
                break
                
            shift += 7
            
            if shift >= 64:  # Prevent infinite loop
                break
        
        return value, bytes_read
    
    def _skip_field(self, data: bytes, offset: int, wire_type: int) -> int:
        """Skip unknown protobuf field based on wire type"""
        if wire_type == 0:  # Varint
            _, bytes_read = self._read_varint(data, offset)
            return offset + bytes_read
        elif wire_type == 1:  # Fixed64
            return offset + 8
        elif wire_type == 2:  # Length-delimited
            length, bytes_read = self._read_varint(data, offset)
            return offset + bytes_read + length
        elif wire_type == 5:  # Fixed32
            return offset + 4
        else:
            # Unknown wire type, skip 1 byte
            return offset + 1
    
    def stop(self):
        """Stop the market listener"""
        self.is_running = False
        logger.info("Stopping protobuf market listener...")
    
    def get_stats(self) -> Dict[str, Any]:
        """Get comprehensive performance statistics for high-frequency monitoring"""
        stats = self.stats.copy()
        
        # Add calculated metrics
        if self.stats['batches_processed'] > 0:
            stats['messages_per_batch'] = self.stats['messages_processed'] / self.stats['batches_processed']
            stats['success_rate'] = (self.stats['successful_decodes'] / max(self.stats['messages_processed'], 1)) * 100
        else:
            stats['messages_per_batch'] = 0
            stats['success_rate'] = 0
            
        stats['current_queue_size'] = len(self.message_queue)
        stats['error_rate'] = (self.stats['parse_errors'] / max(self.stats['messages_processed'], 1)) * 100
        
        return stats
    
    def log_performance_summary(self):
        """Log performance summary for monitoring"""
        stats = self.get_stats()
        logger.info(f"📊 Performance Summary - Messages: {stats['messages_processed']}, "
                   f"Batches: {stats['batches_processed']}, "
                   f"Queue: {stats['current_queue_size']}, "
                   f"Success Rate: {stats['success_rate']:.1f}%, "
                   f"Avg Batch Size: {stats['avg_batch_size']:.1f}")
        
        if stats['error_rate'] > 5:  # Alert if error rate > 5%
            logger.warning(f"⚠️ High error rate detected: {stats['error_rate']:.1f}%")
    
    async def get_connection_status(self) -> Dict[str, Any]:
        """Get current connection status (for health_api.py compatibility)"""
        return {
            "is_running": self.is_running,
            "protocol": "protobuf_binary",
            "ws_url": self.ws_url,
            "reconnect_delay": self.reconnect_delay,
            "max_reconnect_attempts": self.max_reconnect_attempts,
            "performance": self.stats
        }

# Global listener instance (for health_api.py compatibility)
binary_market_listener = ProtobufMarketListener()

async def start_binary_market_listener():
    """Start the binary market listener as a background task (for main.py compatibility)"""
    await binary_market_listener.start()

# Main execution
async def main():
    """Main function to run the protobuf market listener"""
    listener = ProtobufMarketListener()
    
    try:
        await listener.start()
    except KeyboardInterrupt:
        logger.info("Received interrupt signal")
    finally:
        listener.stop()

if __name__ == "__main__":
    asyncio.run(main())
