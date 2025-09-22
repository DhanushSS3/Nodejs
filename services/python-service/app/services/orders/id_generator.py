"""
ID Generation Service for Python
Generates unique, time-based IDs for different entities

NUMERIC ORDER IDs: Uses Snowflake-inspired algorithm for purely numeric IDs
- No Redis dependency (works even after Redis flush)
- Unique across multiple workers
- Time-ordered for chronological sorting
- Format: 64-bit numeric ID

OTHER IDs: Redis-backed with prefixes for compatibility
"""

import os
import time
import hashlib
import socket
import threading
from datetime import datetime
from typing import Optional

from app.config.redis_config import redis_cluster


class NumericIdGenerator:
    """
    Snowflake-inspired numeric ID generator
    Structure: [41 bits: timestamp] [10 bits: worker_id] [12 bits: sequence] [1 bit: reserved]
    """
    
    def __init__(self):
        # Epoch start: January 1, 2024 00:00:00 UTC (same as Node.js)
        self.epoch = 1704067200000  # 2024-01-01T00:00:00.000Z
        
        # Generate unique worker ID
        self.worker_id = self._generate_worker_id()
        
        # Sequence tracking
        self.last_timestamp = 0
        self.sequence = 0
        self.max_sequence = 4095  # 12 bits = 4096 sequences per millisecond
        
        # Thread safety
        self._lock = threading.Lock()
        
        print(f"Python ID Generator initialized with Worker ID: {self.worker_id}")
    
    def _generate_worker_id(self) -> int:
        """Generate unique worker ID based on hostname, process ID, and random factor"""
        hostname = socket.gethostname()
        pid = os.getpid()
        
        # Create hash from hostname + pid + timestamp for uniqueness
        hash_input = f"{hostname}-{pid}-{int(time.time() * 1000)}"
        hash_obj = hashlib.md5(hash_input.encode())
        hash_hex = hash_obj.hexdigest()
        
        # Extract 10 bits (0-1023) for worker ID
        worker_id = int(hash_hex[:3], 16) % 1024
        return worker_id
    
    def _current_millis(self) -> int:
        """Get current timestamp in milliseconds"""
        return int(time.time() * 1000)
    
    def generate_order_id(self) -> str:
        """
        Generate purely numeric Order ID using Snowflake-inspired algorithm
        Format: 64-bit numeric ID (no Redis dependency)
        Returns: Numeric Order ID as string (e.g., '1234567890123456')
        """
        with self._lock:
            now = self._current_millis()
            
            # Handle clock going backwards
            if now < self.last_timestamp:
                raise RuntimeError(f"Clock moved backwards. Refusing to generate ID for {self.last_timestamp - now}ms")
            
            if now == self.last_timestamp:
                # Same millisecond, increment sequence
                self.sequence = (self.sequence + 1) & self.max_sequence
                if self.sequence == 0:
                    # Sequence overflow, wait for next millisecond
                    while self._current_millis() <= self.last_timestamp:
                        time.sleep(0.001)  # Sleep 1ms
                    return self.generate_order_id()  # Recursive call for next millisecond
            else:
                # New millisecond, reset sequence
                self.sequence = 0
            
            self.last_timestamp = now
            
            # Calculate timestamp offset from epoch
            timestamp_offset = now - self.epoch
            
            # Build the ID: [timestamp: 41 bits] [worker: 10 bits] [sequence: 12 bits] [reserved: 1 bit]
            id_value = (timestamp_offset << 23) | (self.worker_id << 13) | self.sequence
            
            # Convert to string and ensure it's numeric
            return str(id_value)
    
    def validate_order_id(self, order_id: str) -> bool:
        """Validate numeric order ID"""
        if not order_id or not isinstance(order_id, str):
            return False
        
        # Check if it's purely numeric and reasonable length
        return order_id.isdigit() and 10 <= len(order_id) <= 20
    
    def extract_timestamp_from_order_id(self, order_id: str) -> Optional[int]:
        """Extract timestamp from numeric order ID"""
        if not self.validate_order_id(order_id):
            return None
        
        try:
            # Parse the ID as integer
            id_value = int(order_id)
            
            # Extract timestamp (first 41 bits)
            timestamp_offset = id_value >> 23
            
            # Add back the epoch to get actual timestamp
            actual_timestamp = timestamp_offset + self.epoch
            
            # Validate if it's a reasonable timestamp (after 2024 and before 2050)
            if actual_timestamp > self.epoch and actual_timestamp < 2524608000000:
                return actual_timestamp
        except (ValueError, OverflowError):
            # Invalid integer conversion
            pass
        
        return None
    
    def extract_worker_id_from_order_id(self, order_id: str) -> Optional[int]:
        """Extract worker ID from numeric order ID"""
        if not self.validate_order_id(order_id):
            return None
        
        try:
            # Parse the ID as integer
            id_value = int(order_id)
            
            # Extract worker ID (10 bits after timestamp)
            worker_id = (id_value >> 13) & 0x3FF
            
            return worker_id
        except (ValueError, OverflowError):
            # Invalid integer conversion
            pass
        
        return None
    
    def generate_prefixed_id(self, prefix: str) -> str:
        """
        Generate Redis-independent ID with prefix using Snowflake algorithm
        Args:
            prefix: The prefix for the ID (e.g., 'TXN', 'SL')
        Returns:
            Generated ID with prefix (e.g., 'TXN1234567890123456')
        """
        with self._lock:
            now = self._current_millis()
            
            # Handle clock going backwards
            if now < self.last_timestamp:
                raise RuntimeError(f"Clock moved backwards. Refusing to generate ID for {self.last_timestamp - now}ms")
            
            # Use the same sequence counter as order IDs
            if now == self.last_timestamp:
                # Same millisecond, increment sequence
                self.sequence = (self.sequence + 1) & self.max_sequence
                if self.sequence == 0:
                    # Sequence overflow, wait for next millisecond
                    while self._current_millis() <= self.last_timestamp:
                        time.sleep(0.001)  # Sleep 1ms
                    return self.generate_prefixed_id(prefix)  # Recursive call for next millisecond
            else:
                # New millisecond, reset sequence
                self.sequence = 0
            
            self.last_timestamp = now
            
            # Calculate timestamp offset from epoch
            timestamp_offset = now - self.epoch
            
            # Build the ID: [timestamp: 41 bits] [worker: 10 bits] [sequence: 12 bits] [reserved: 1 bit]
            id_value = (timestamp_offset << 23) | (self.worker_id << 13) | self.sequence
            
            # Convert to string and add prefix
            return prefix + str(id_value)


# Global instance for numeric ID generation
_numeric_id_generator = NumericIdGenerator()


# Public API functions
def generate_numeric_order_id() -> str:
    """Generate purely numeric order ID"""
    return _numeric_id_generator.generate_order_id()


def validate_numeric_order_id(order_id: str) -> bool:
    """Validate numeric order ID"""
    return _numeric_id_generator.validate_order_id(order_id)


def extract_timestamp_from_order_id(order_id: str) -> Optional[int]:
    """Extract timestamp from numeric order ID"""
    return _numeric_id_generator.extract_timestamp_from_order_id(order_id)


def extract_worker_id_from_order_id(order_id: str) -> Optional[int]:
    """Extract worker ID from numeric order ID"""
    return _numeric_id_generator.extract_worker_id_from_order_id(order_id)


# Redis-independent prefixed ID generators
def generate_transaction_id() -> str:
    """Generate transaction ID: TXN1234567890123 (shorter for DB compatibility)"""
    with _numeric_id_generator._lock:
        now = _numeric_id_generator._current_millis()
        
        # Handle clock going backwards
        if now < _numeric_id_generator.last_timestamp:
            raise RuntimeError(f"Clock moved backwards. Refusing to generate ID for {_numeric_id_generator.last_timestamp - now}ms")
        
        if now == _numeric_id_generator.last_timestamp:
            # Same millisecond, increment sequence
            _numeric_id_generator.sequence = (_numeric_id_generator.sequence + 1) & _numeric_id_generator.max_sequence
            if _numeric_id_generator.sequence == 0:
                # Sequence overflow, wait for next millisecond
                while _numeric_id_generator._current_millis() <= _numeric_id_generator.last_timestamp:
                    time.sleep(0.001)  # Sleep 1ms
                return generate_transaction_id()  # Recursive call for next millisecond
        else:
            # New millisecond, reset sequence
            _numeric_id_generator.sequence = 0
        
        _numeric_id_generator.last_timestamp = now
        
        # Create shorter ID for database compatibility
        # Format: TXN + last 10 digits of timestamp + 3-digit worker + 3-digit sequence
        timestamp_str = str(now)[-10:]  # Last 10 digits
        worker_str = str(_numeric_id_generator.worker_id).zfill(3)[-3:]  # 3 digits
        seq_str = str(_numeric_id_generator.sequence).zfill(3)  # 3 digits
        
        # Total: TXN (3) + timestamp (10) + worker (3) + sequence (3) = 19 chars (fits in 20)
        return f"TXN{timestamp_str}{worker_str}{seq_str}"


def generate_stop_loss_id() -> str:
    """Generate stop loss ID: SL1234567890123456"""
    return _numeric_id_generator.generate_prefixed_id('SL')


def generate_take_profit_id() -> str:
    """Generate take profit ID: TP1234567890123456"""
    return _numeric_id_generator.generate_prefixed_id('TP')


def generate_position_id() -> str:
    """Generate position ID: POS1234567890123456"""
    return _numeric_id_generator.generate_prefixed_id('POS')


def generate_trade_id() -> str:
    """Generate trade ID: TRD1234567890123456"""
    return _numeric_id_generator.generate_prefixed_id('TRD')


def generate_account_id() -> str:
    """Generate account ID: ACC1234567890123456"""
    return _numeric_id_generator.generate_prefixed_id('ACC')


def generate_session_id() -> str:
    """Generate session ID: SES1234567890123456"""
    return _numeric_id_generator.generate_prefixed_id('SES')


def generate_money_request_id() -> str:
    """Generate money request ID: REQ1234567890123456"""
    return _numeric_id_generator.generate_prefixed_id('REQ')


def generate_modify_id() -> str:
    """Generate modify ID: MOD1234567890123456"""
    return _numeric_id_generator.generate_prefixed_id('MOD')


# Legacy Redis-backed ID generators (for non-order IDs)
async def _incr_with_ttl(key: str, ttl_seconds: int = 3 * 24 * 60 * 60) -> int:
    seq = await redis_cluster.incr(key)
    if seq == 1:
        try:
            await redis_cluster.expire(key, ttl_seconds)
        except Exception:
            pass
    return int(seq)


def _yyyymmdd(dt: Optional[datetime] = None) -> str:
    d = dt or datetime.utcnow()
    return f"{d.year:04d}{d.month:02d}{d.day:02d}"


def _pad(num: int, size: int) -> str:
    s = str(int(num))
    return s.zfill(size)


# Updated Redis-independent versions
def generate_close_id() -> str:
    """Generate close ID: CLS1234567890123456 (Redis-independent)"""
    return _numeric_id_generator.generate_prefixed_id('CLS')


def generate_stoploss_cancel_id() -> str:
    """Generate stop loss cancel ID: SLC1234567890123456 (Redis-independent)"""
    return _numeric_id_generator.generate_prefixed_id('SLC')


def generate_takeprofit_cancel_id() -> str:
    """Generate take profit cancel ID: TPC1234567890123456 (Redis-independent)"""
    return _numeric_id_generator.generate_prefixed_id('TPC')


# Legacy Redis-backed versions (kept for backward compatibility if needed)
async def generate_close_id_legacy() -> str:
    date_str = _yyyymmdd()
    seq = await _incr_with_ttl(f"cls_seq:{date_str}")
    return f"CLS{date_str}{_pad(seq, 6)}"


async def generate_stoploss_cancel_id_legacy() -> str:
    date_str = _yyyymmdd()
    seq = await _incr_with_ttl(f"slc_seq:{date_str}")
    return f"SLC{date_str}{_pad(seq, 6)}"


async def generate_takeprofit_cancel_id_legacy() -> str:
    date_str = _yyyymmdd()
    seq = await _incr_with_ttl(f"tpc_seq:{date_str}")
    return f"TPC{date_str}{_pad(seq, 6)}"
