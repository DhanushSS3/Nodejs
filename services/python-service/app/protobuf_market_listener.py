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
        
        # ZERO TICK LOSS: Process every message immediately
        # No queuing, no batching, no delays - immediate Redis updates
        
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
        logger.info("🚀 ZERO TICK LOSS MODE: Every message processed immediately")
        
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
            # Clean shutdown - no batch processing to clean up
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
                        # ZERO TICK LOSS: Process every message immediately
                        await self._process_single_message_immediate(message)
                        self.stats['messages_processed'] += 1
                        self.stats['bytes_processed'] += len(message)
                    else:
                        logger.warning(f"Received non-binary message, ignoring: {type(message)}")
                        
                except Exception as e:
                    logger.error(f"Error processing message immediately: {e}")
                    self.stats['parse_errors'] += 1
    
    async def _process_single_message_immediate(self, message: bytes):
        """
        Process a single message immediately with zero delay
        ZERO TICK LOSS: Every message goes straight to Redis
        """
        try:
            # Step 1: Decompress binary data
            decompressed_data = zlib.decompress(message)
            
            # Step 2: Decode protobuf
            decoded_data = self._decode_market_update(decompressed_data)
            
            if not decoded_data:
                return
            
            # Step 3: Process market update immediately
            if decoded_data.get('type') == 'market_update':
                market_data = decoded_data.get('data', {}).get('market_prices', {})
                
                if market_data:
                    # IMMEDIATE Redis update - no batching, no delays
                    feed_data = {'market_prices': market_data}
                    success = await self.market_service.process_market_feed(feed_data)
                    
                    if success:
                        self.stats['successful_decodes'] += 1
                    
        except Exception as e:
            logger.error(f"Failed to process message immediately: {e}")
            self.stats['parse_errors'] += 1
    
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
            
            # logger.info(f"🔍 DEBUGGING: Decoding protobuf data, size: {len(data)} bytes")
            
            while offset < len(data):
                # Read field tag and wire type
                if offset >= len(data):
                    break
                    
                tag_byte = data[offset]
                wire_type = tag_byte & 0x07
                field_number = tag_byte >> 3
                offset += 1
                
                logger.info(f"🔍 DEBUGGING: Field {field_number}, wire_type {wire_type}")
                
                if field_number == 1 and wire_type == 2:  # type field (string)
                    length, bytes_read = self._read_varint(data, offset)
                    offset += bytes_read
                    
                    if offset + length <= len(data):
                        result['type'] = data[offset:offset + length].decode('utf-8')
                        offset += length
                        # logger.info(f"✅ DEBUGGING: Decoded type: {result['type']}")
                
                elif field_number == 2 and wire_type == 2:  # data field (MarketPrices)
                    length, bytes_read = self._read_varint(data, offset)
                    offset += bytes_read
                    
                    logger.info(f"🔍 DEBUGGING: MarketPrices data length: {length}")
                    
                    if offset + length <= len(data):
                        market_prices_data = data[offset:offset + length]
                        market_prices = self._decode_market_prices(market_prices_data)
                        
                        if market_prices:
                            result['data'] = {'market_prices': market_prices}
                            logger.info(f"✅ DEBUGGING: Decoded {len(market_prices)} market prices: {list(market_prices.keys())[:5]}")
                        else:
                            logger.error(f"❌ DEBUGGING: Failed to decode market prices from {length} bytes")
                        
                        offset += length
                
                else:
                    # Skip unknown fields
                    logger.info(f"⚠️ DEBUGGING: Skipping unknown field {field_number}")
                    offset = self._skip_field(data, offset, wire_type)
            
            if result:
                logger.info(f"✅ DEBUGGING: Successfully decoded protobuf with type: {result.get('type')}")
                if 'data' in result:
                    market_count = len(result['data'].get('market_prices', {}))
                    logger.info(f"✅ DEBUGGING: Market data contains {market_count} symbols")
                return result
            else:
                logger.error(f"❌ DEBUGGING: No valid data decoded from {len(data)} bytes")
                return None
            
        except Exception as e:
            logger.error(f"❌ DEBUGGING: Protobuf decode error: {e}")
            logger.error(f"❌ DEBUGGING: Data preview: {data[:50].hex() if len(data) >= 50 else data.hex()}")
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
