"""
Binary WebSocket Message Analyzer
Connects to wss://quotes.livefxhub.com:9001/?token=Lkj@asd@1234 
and analyzes the binary message format to understand the structure.
"""
import asyncio
import websockets
import logging
import time
import struct
import json

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class BinaryMessageAnalyzer:
    def __init__(self):
        self.ws_url = "wss://quotes.livefxhub.com:9001/?token=Lkj@asd@1234"
        self.message_count = 0
        self.max_messages = 20  # Analyze first 20 messages
        
    async def analyze_messages(self):
        """Connect and analyze binary messages"""
        logger.info(f"Connecting to: {self.ws_url}")
        logger.info("Analyzing binary message format...")
        
        try:
            async with websockets.connect(self.ws_url) as websocket:
                logger.info("✅ Connected successfully!")
                
                async for message in websocket:
                    if self.message_count >= self.max_messages:
                        break
                        
                    self.message_count += 1
                    await self.analyze_single_message(message, self.message_count)
                    
                    # Small delay between messages
                    await asyncio.sleep(0.1)
                    
        except Exception as e:
            logger.error(f"Connection failed: {e}")
    
    async def analyze_single_message(self, message, msg_num):
        """Analyze a single binary message"""
        logger.info(f"\n{'='*60}")
        logger.info(f"MESSAGE #{msg_num}")
        logger.info(f"{'='*60}")
        
        if isinstance(message, bytes):
            logger.info(f"✅ Binary message received")
            logger.info(f"Length: {len(message)} bytes")
            
            # Hex dump
            hex_dump = ' '.join(f'{b:02x}' for b in message)
            logger.info(f"Hex: {hex_dump}")
            
            # Try to find ASCII strings
            ascii_strings = self.extract_ascii_strings(message)
            if ascii_strings:
                logger.info(f"ASCII strings: {ascii_strings}")
            
            # Try different interpretations
            await self.try_interpretations(message)
            
        else:
            logger.info(f"❌ Non-binary message: {type(message)}")
            logger.info(f"Content: {message}")
    
    def extract_ascii_strings(self, data):
        """Extract printable ASCII strings from binary data"""
        strings = []
        current = ""
        
        for byte in data:
            if 32 <= byte <= 126:  # Printable ASCII
                current += chr(byte)
            else:
                if len(current) >= 3:
                    strings.append(current)
                current = ""
        
        if len(current) >= 3:
            strings.append(current)
            
        return strings
    
    async def try_interpretations(self, data):
        """Try different ways to interpret the binary data"""
        
        # 1. Try as UTF-8
        try:
            utf8_text = data.decode('utf-8')
            logger.info(f"UTF-8 decode: {utf8_text}")
            
            # Look for JSON
            if '{' in utf8_text:
                try:
                    json_data = json.loads(utf8_text)
                    logger.info(f"✅ JSON found: {json_data}")
                except:
                    pass
                    
        except UnicodeDecodeError:
            logger.info("❌ Not valid UTF-8")
        
        # 2. Try as fixed-width records
        if len(data) >= 8:
            logger.info("Trying fixed-width interpretations:")
            
            # Try 4-byte integers
            if len(data) % 4 == 0:
                ints = []
                for i in range(0, min(len(data), 16), 4):
                    try:
                        val = struct.unpack('>I', data[i:i+4])[0]
                        ints.append(val)
                    except:
                        break
                if ints:
                    logger.info(f"As 4-byte big-endian ints: {ints}")
            
            # Try 8-byte doubles
            if len(data) % 8 == 0:
                doubles = []
                for i in range(0, min(len(data), 16), 8):
                    try:
                        val = struct.unpack('>d', data[i:i+8])[0]
                        if 0.0001 < abs(val) < 1000000:  # Reasonable price range
                            doubles.append(val)
                    except:
                        break
                if doubles:
                    logger.info(f"As 8-byte doubles: {doubles}")
        
        # 3. Try protobuf-like parsing
        if len(data) >= 2:
            logger.info("Trying protobuf-like parsing:")
            try:
                offset = 0
                fields = []
                
                while offset < len(data) - 1 and len(fields) < 5:
                    tag_byte = data[offset]
                    wire_type = tag_byte & 0x07
                    field_number = tag_byte >> 3
                    
                    if field_number == 0:
                        break
                        
                    fields.append(f"Field {field_number}, Wire type {wire_type}")
                    offset += 1
                    
                    if wire_type == 0:  # Varint
                        value, bytes_read = self.read_varint(data, offset)
                        offset += bytes_read
                        fields.append(f"  Value: {value}")
                    elif wire_type == 2:  # Length-delimited
                        length, bytes_read = self.read_varint(data, offset)
                        offset += bytes_read
                        if offset + length <= len(data):
                            field_data = data[offset:offset + length]
                            offset += length
                            try:
                                text = field_data.decode('utf-8')
                                fields.append(f"  String: {text}")
                            except:
                                fields.append(f"  Binary: {field_data.hex()}")
                        else:
                            break
                    else:
                        break
                
                if fields:
                    logger.info("Protobuf fields:")
                    for field in fields:
                        logger.info(f"  {field}")
                        
            except Exception as e:
                logger.info(f"Protobuf parsing failed: {e}")
    
    def read_varint(self, data, offset):
        """Read protobuf varint"""
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
            
            if shift >= 64:
                break
        
        return value, bytes_read

async def main():
    """Run the binary message analyzer"""
    analyzer = BinaryMessageAnalyzer()
    await analyzer.analyze_messages()
    
    logger.info(f"\n{'='*60}")
    logger.info(f"ANALYSIS COMPLETE - {analyzer.message_count} messages analyzed")
    logger.info(f"{'='*60}")

if __name__ == "__main__":
    print("🔍 Binary WebSocket Message Analyzer")
    print("This will connect and analyze the binary message format")
    print("Press Ctrl+C to stop\n")
    
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n⏹️ Analysis stopped by user")
    except Exception as e:
        print(f"❌ Analysis failed: {e}")
        import traceback
        traceback.print_exc()
