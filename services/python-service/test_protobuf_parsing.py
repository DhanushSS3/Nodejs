"""
Test protobuf parsing on the decompressed binary data
"""
import zlib
import struct

# Sample hex data from your logs
sample_messages = [
    "78 9c e3 e2 cd 4d 2c ca 4e 2d 89 2f 2d 48 49 2c 49 15 92 e3 92 e1 62 73 77 0a 08 76 f5 16 12 e2 74 ab 51 4f db cb a1 e9 20 e8 d9 30 2b 6a 1b 9b a6 03 00 40 c7 0d 3d",
    "78 9c e3 e2 cd 4d 2c ca 4e 2d 89 2f 2d 48 49 2c 49 15 92 e3 92 e1 62 0b 0d 76 09 76 f5 16 12 e2 9c 55 b3 f9 6c ef 49 25 07 c1 2b ce 26 bb 9a 4f 28 39 00 00 60 0a 0f f1",
    "78 9c e3 e2 cd 4d 2c ca 4e 2d 89 2f 2d 48 49 2c 49 15 92 e3 92 e1 62 73 0d 0d 0a 76 f5 16 12 e2 94 7c 14 21 be fd a2 aa 83 e0 3f 35 11 a5 07 17 54 1d 00 4f 74 0e b7"
]

def hex_to_bytes(hex_string):
    """Convert hex string to bytes"""
    return bytes.fromhex(hex_string.replace(' ', ''))

def read_varint(data, offset):
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

def parse_nested_protobuf(data):
    """Parse nested protobuf data containing market information"""
    print(f"    Parsing nested protobuf: {len(data)} bytes")
    
    offset = 0
    symbol = None
    prices = []
    
    while offset < len(data):
        if offset >= len(data) - 1:
            break
            
        tag_byte = data[offset]
        wire_type = tag_byte & 0x07
        field_number = tag_byte >> 3
        offset += 1
        
        print(f"    Nested Field {field_number}, Wire type {wire_type}")
        
        if wire_type == 0:  # Varint
            value, bytes_read = read_varint(data, offset)
            offset += bytes_read
            print(f"      Varint: {value}")
            
        elif wire_type == 1:  # Fixed64 (double)
            if offset + 8 <= len(data):
                try:
                    price = struct.unpack('<d', data[offset:offset + 8])[0]
                    prices.append(price)
                    offset += 8
                    print(f"      Double: {price}")
                except struct.error:
                    offset += 8
            else:
                break
                
        elif wire_type == 2:  # Length-delimited
            length, bytes_read = read_varint(data, offset)
            offset += bytes_read
            
            if offset + length <= len(data):
                string_data = data[offset:offset + length]
                offset += length
                
                try:
                    text = string_data.decode('utf-8')
                    print(f"      String: '{text}'")
                    
                    if len(text) == 6 and text.isupper():
                        symbol = text
                        print(f"      -> Found symbol: {symbol}")
                        
                except UnicodeDecodeError:
                    print(f"      Binary: {string_data.hex()}")
                    
                    # Check if this is another nested level
                    if len(string_data) > 8:
                        print(f"      -> Parsing deeper nested level...")
                        deeper_data = parse_deeper_nested(string_data)
                        if deeper_data:
                            return deeper_data
            else:
                break
                
        elif wire_type == 5:  # Fixed32 (float)
            if offset + 4 <= len(data):
                try:
                    price = struct.unpack('<f', data[offset:offset + 4])[0]
                    prices.append(price)
                    offset += 4
                    print(f"      Float: {price}")
                except struct.error:
                    offset += 4
            else:
                break
        else:
            offset += 1
    
    if symbol and len(prices) >= 2:
        result = {symbol: {'sell': str(prices[0]), 'buy': str(prices[1])}}
        print(f"      -> Extracted: {result}")
        return result
    
    return None

def parse_deeper_nested(data):
    """Parse even deeper nested protobuf data"""
    print(f"      Parsing deeper level: {len(data)} bytes")
    
    offset = 0
    symbol = None
    prices = []
    
    while offset < len(data):
        if offset >= len(data) - 1:
            break
            
        tag_byte = data[offset]
        wire_type = tag_byte & 0x07
        field_number = tag_byte >> 3
        offset += 1
        
        print(f"      Deep Field {field_number}, Wire type {wire_type}")
        
        if wire_type == 0:  # Varint
            value, bytes_read = read_varint(data, offset)
            offset += bytes_read
            
        elif wire_type == 1:  # Fixed64 (double)
            if offset + 8 <= len(data):
                try:
                    price = struct.unpack('<d', data[offset:offset + 8])[0]
                    prices.append(price)
                    offset += 8
                    print(f"        Double: {price}")
                except struct.error:
                    offset += 8
            else:
                break
                
        elif wire_type == 2:  # Length-delimited
            length, bytes_read = read_varint(data, offset)
            offset += bytes_read
            
            if offset + length <= len(data):
                string_data = data[offset:offset + length]
                offset += length
                
                try:
                    text = string_data.decode('utf-8')
                    print(f"        String: '{text}'")
                    
                    if len(text) == 6 and text.isupper():
                        symbol = text
                        print(f"        -> Symbol: {symbol}")
                        
                except UnicodeDecodeError:
                    print(f"        Binary: {string_data.hex()}")
                    
                    # This binary data contains the prices, parse it
                    if len(string_data) >= 16:  # Should contain 2 doubles (8 bytes each)
                        print(f"        -> Parsing price data from binary...")
                        price_offset = 0
                        
                        while price_offset < len(string_data) - 1:
                            if price_offset >= len(string_data):
                                break
                                
                            price_tag = string_data[price_offset]
                            price_wire_type = price_tag & 0x07
                            price_field = price_tag >> 3
                            price_offset += 1
                            
                            print(f"          Price field {price_field}, wire type {price_wire_type}")
                            
                            if price_wire_type == 1 and price_offset + 8 <= len(string_data):  # Fixed64 double
                                try:
                                    price_bytes = string_data[price_offset:price_offset + 8]
                                    price = struct.unpack('<d', price_bytes)[0]
                                    prices.append(price)
                                    price_offset += 8
                                    print(f"          -> Price: {price}")
                                except struct.error as e:
                                    print(f"          -> Error reading price: {e}")
                                    price_offset += 8
                            else:
                                price_offset += 1
            else:
                break
                
        elif wire_type == 5:  # Fixed32 (float)
            if offset + 4 <= len(data):
                try:
                    price = struct.unpack('<f', data[offset:offset + 4])[0]
                    prices.append(price)
                    offset += 4
                    print(f"        Float: {price}")
                except struct.error:
                    offset += 4
            else:
                break
        else:
            offset += 1
    
    if symbol and len(prices) >= 2:
        result = {symbol: {'sell': str(prices[0]), 'buy': str(prices[1])}}
        print(f"        -> Final result: {result}")
        return result
    
    return None

def parse_protobuf_data(data):
    """Parse protobuf binary data"""
    print(f"Parsing protobuf data: {len(data)} bytes")
    hex_dump = ' '.join(f'{b:02x}' for b in data)
    print(f"Hex: {hex_dump}")
    
    offset = 0
    market_data = {}
    current_symbol = None
    prices = []
    
    while offset < len(data):
        if offset >= len(data) - 1:
            break
            
        # Read field tag
        tag_byte = data[offset]
        wire_type = tag_byte & 0x07
        field_number = tag_byte >> 3
        offset += 1
        
        print(f"Field {field_number}, Wire type {wire_type} at offset {offset-1}")
        
        if field_number == 0:
            break
        
        if wire_type == 0:  # Varint
            value, bytes_read = read_varint(data, offset)
            offset += bytes_read
            print(f"  Varint value: {value}")
            
        elif wire_type == 1:  # Fixed64 (double)
            if offset + 8 <= len(data):
                try:
                    price = struct.unpack('<d', data[offset:offset + 8])[0]
                    prices.append(price)
                    offset += 8
                    print(f"  Double price: {price}")
                except struct.error as e:
                    print(f"  Error reading double: {e}")
                    offset += 8
            else:
                break
                
        elif wire_type == 2:  # Length-delimited (string)
            length, bytes_read = read_varint(data, offset)
            offset += bytes_read
            
            if offset + length <= len(data):
                string_data = data[offset:offset + length]
                offset += length
                
                try:
                    text = string_data.decode('utf-8')
                    print(f"  String: '{text}'")
                    
                    if text == "market_update":
                        print("    -> Market update message type")
                    elif len(text) == 6 and text.isupper():
                        # Save previous symbol if exists
                        if current_symbol and len(prices) >= 2:
                            market_data[current_symbol] = {
                                'sell': str(prices[-2]),  # bid
                                'buy': str(prices[-1])    # ask
                            }
                            print(f"    -> Saved {current_symbol}: sell={prices[-2]}, buy={prices[-1]}")
                        
                        current_symbol = text
                        print(f"    -> New symbol: {text}")
                    
                except UnicodeDecodeError:
                    print(f"  Binary data: {string_data.hex()}")
                    
                    # This might be nested protobuf data, try to parse it
                    if len(string_data) > 10:
                        print("    -> Trying to parse as nested protobuf...")
                        nested_data = parse_nested_protobuf(string_data)
                        if nested_data:
                            market_data.update(nested_data)
            else:
                break
                
        elif wire_type == 5:  # Fixed32 (float)
            if offset + 4 <= len(data):
                try:
                    price = struct.unpack('<f', data[offset:offset + 4])[0]
                    prices.append(price)
                    offset += 4
                    print(f"  Float price: {price}")
                except struct.error as e:
                    print(f"  Error reading float: {e}")
                    offset += 4
            else:
                break
        else:
            print(f"  Unknown wire type {wire_type}, skipping")
            offset += 1
    
    # Handle the last symbol
    if current_symbol and len(prices) >= 2:
        market_data[current_symbol] = {
            'sell': str(prices[-2]),  # bid
            'buy': str(prices[-1])    # ask
        }
        print(f"Final symbol {current_symbol}: sell={prices[-2]}, buy={prices[-1]}")
    
    return market_data

def test_protobuf_parsing():
    """Test protobuf parsing on sample messages"""
    print("🔍 Testing protobuf parsing on decompressed binary data\n")
    
    for i, hex_msg in enumerate(sample_messages, 1):
        print(f"{'='*60}")
        print(f"MESSAGE #{i}")
        print(f"{'='*60}")
        
        try:
            # Convert hex to bytes and decompress
            binary_data = hex_to_bytes(hex_msg)
            decompressed = zlib.decompress(binary_data)
            
            print(f"Decompressed {len(binary_data)} -> {len(decompressed)} bytes")
            
            # Parse protobuf
            market_data = parse_protobuf_data(decompressed)
            
            if market_data:
                print(f"\n✅ SUCCESS: Extracted {len(market_data)} symbols:")
                for symbol, prices in market_data.items():
                    print(f"  {symbol}: sell={prices['sell']}, buy={prices['buy']}")
            else:
                print("\n❌ No market data extracted")
                
        except Exception as e:
            print(f"❌ Error: {e}")
        
        print()

if __name__ == "__main__":
    test_protobuf_parsing()
