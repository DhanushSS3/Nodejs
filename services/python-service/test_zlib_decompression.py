"""
Test zlib decompression on the binary WebSocket messages
"""
import zlib

# Sample hex data from your logs
sample_messages = [
    "78 9c e3 e2 cd 4d 2c ca 4e 2d 89 2f 2d 48 49 2c 49 15 92 e3 92 e1 62 73 77 0a 08 76 f5 16 12 e2 74 ab 51 4f db cb a1 e9 20 e8 d9 30 2b 6a 1b 9b a6 03 00 40 c7 0d 3d",
    "78 9c e3 e2 cd 4d 2c ca 4e 2d 89 2f 2d 48 49 2c 49 15 92 e3 92 e1 62 0b 0d 76 09 76 f5 16 12 e2 9c 55 b3 f9 6c ef 49 25 07 c1 2b ce 26 bb 9a 4f 28 39 00 00 60 0a 0f f1",
    "78 9c e3 e2 cd 4d 2c ca 4e 2d 89 2f 2d 48 49 2c 49 15 92 e3 92 e1 62 73 0d 0d 0a 76 f5 16 12 e2 94 7c 14 21 be fd a2 aa 83 e0 3f 35 11 a5 07 17 54 1d 00 4f 74 0e b7"
]

def hex_to_bytes(hex_string):
    """Convert hex string to bytes"""
    return bytes.fromhex(hex_string.replace(' ', ''))

def test_decompression():
    """Test zlib decompression on sample messages"""
    print("🔍 Testing zlib decompression on binary WebSocket messages\n")
    
    for i, hex_msg in enumerate(sample_messages, 1):
        print(f"{'='*60}")
        print(f"MESSAGE #{i}")
        print(f"{'='*60}")
        
        try:
            # Convert hex to bytes
            binary_data = hex_to_bytes(hex_msg)
            print(f"Binary length: {len(binary_data)} bytes")
            print(f"First 4 bytes: {' '.join(f'{b:02x}' for b in binary_data[:4])}")
            
            # Check zlib header
            if binary_data[0] == 0x78 and binary_data[1] == 0x9c:
                print("✅ Zlib header detected (0x78 0x9c)")
                
                # Decompress
                decompressed = zlib.decompress(binary_data)
                print(f"✅ Decompressed successfully!")
                print(f"Decompressed length: {len(decompressed)} bytes")
                
                # Show hex dump of decompressed data
                hex_dump = ' '.join(f'{b:02x}' for b in decompressed[:50])
                print(f"Decompressed hex (first 50 bytes): {hex_dump}")
                
                # Try to decode as UTF-8
                try:
                    decompressed_text = decompressed.decode('utf-8')
                    print(f"✅ UTF-8 decode successful!")
                    print(f"Decompressed content: {decompressed_text}")
                    
                    # Try to parse as JSON
                    try:
                        import json
                        json_data = json.loads(decompressed_text)
                        print(f"✅ Valid JSON structure!")
                        print(f"JSON keys: {list(json_data.keys()) if isinstance(json_data, dict) else 'Not a dict'}")
                        
                        # Look for market data
                        if isinstance(json_data, dict):
                            if 'market_prices' in json_data:
                                print(f"✅ Found market_prices with {len(json_data['market_prices'])} symbols")
                            elif 'data' in json_data and isinstance(json_data['data'], dict):
                                if 'market_prices' in json_data['data']:
                                    print(f"✅ Found nested market_prices with {len(json_data['data']['market_prices'])} symbols")
                            else:
                                print(f"❓ Unknown JSON structure: {json_data}")
                    
                    except json.JSONDecodeError as e:
                        print(f"❌ Not valid JSON: {e}")
                        print(f"Raw text: {decompressed_text}")
                        
                except UnicodeDecodeError as e:
                    print(f"❌ UTF-8 decode failed: {e}")
                    
                    # Try other encodings
                    encodings_to_try = ['latin-1', 'cp1252', 'ascii']
                    for encoding in encodings_to_try:
                        try:
                            decoded_text = decompressed.decode(encoding)
                            print(f"✅ Decoded with {encoding}: {decoded_text}")
                            break
                        except UnicodeDecodeError:
                            continue
                    else:
                        print("❌ Could not decode with any common encoding")
                        
                        # Look for ASCII strings in the binary data
                        ascii_strings = []
                        current = ""
                        for byte in decompressed:
                            if 32 <= byte <= 126:  # Printable ASCII
                                current += chr(byte)
                            else:
                                if len(current) >= 3:
                                    ascii_strings.append(current)
                                current = ""
                        if current and len(current) >= 3:
                            ascii_strings.append(current)
                        
                        if ascii_strings:
                            print(f"ASCII strings found: {ascii_strings}")
                        
                        # Try to find patterns that look like forex symbols
                        import re
                        text_repr = ''.join(chr(b) if 32 <= b <= 126 else '.' for b in decompressed)
                        symbols = re.findall(r'[A-Z]{6}', text_repr)
                        if symbols:
                            print(f"Potential forex symbols: {symbols}")
                        
                        # Try to find price-like patterns
                        prices = re.findall(r'\d+\.\d{4,6}', text_repr)
                        if prices:
                            print(f"Potential prices: {prices}")
                
            else:
                print(f"❌ Not zlib compressed (header: {binary_data[0]:02x} {binary_data[1]:02x})")
                
        except Exception as e:
            print(f"❌ Error processing message: {e}")
        
        print()

if __name__ == "__main__":
    test_decompression()
