/**
 * ID Generation Service
 * Generates unique, time-based IDs with prefixes for different entities
 * 
 * NUMERIC ORDER IDs: Uses Snowflake-inspired algorithm for purely numeric IDs
 * - No Redis dependency (works even after Redis flush)
 * - Unique across multiple workers
 * - Time-ordered for chronological sorting
 * - Format: 64-bit numeric ID
 * 
 * OTHER IDs: Alphanumeric format with prefixes (e.g., TXN1234567890)
 */

const os = require('os');
const crypto = require('crypto');

// Helpers for order ID formatting
function pad(num, size) {
  let s = String(num);
  while (s.length < size) s = '0' + s;
  return s;
}

function yyyymmdd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// Generate unique worker ID based on hostname, process ID, and random factor
function generateWorkerId() {
  const hostname = os.hostname();
  const pid = process.pid;
  const random = Math.floor(Math.random() * 1000);
  
  // Create hash from hostname + pid + random
  const hash = crypto.createHash('md5')
    .update(`${hostname}-${pid}-${random}`)
    .digest('hex');
  
  // Extract 10 bits (0-1023) for worker ID
  const workerId = parseInt(hash.substring(0, 3), 16) % 1024;
  return workerId;
}

// Use Redis-backed atomic order ID generator for non-order IDs (keeping existing functionality)
const orderIdService = require('./order.id.service');

class IdGeneratorService {
  constructor() {
    // Snowflake-inspired numeric ID generation (for order IDs only)
    this.workerId = generateWorkerId();
    this.lastTimestamp = 0;
    this.sequence = 0;
    this.maxSequence = 4095; // 12 bits = 4096 sequences per millisecond
    
    // Epoch start: January 1, 2024 00:00:00 UTC (reduces timestamp size)
    this.epoch = 1704067200000; // 2024-01-01T00:00:00.000Z
    
    // Legacy sequence for non-order IDs
    this.legacySequence = 0;
    this.legacyMaxSequence = 999;
    
    console.log(`ID Generator initialized with Worker ID: ${this.workerId}`);
  }

  /**
   * Generates a unique ID with the specified prefix and digit length
   * @param {string} prefix - The prefix for the ID (e.g., 'ORD', 'TXN')
   * @param {number} digitLength - Length of the numeric portion (default: 10)
   * @returns {string} Generated ID (e.g., 'ORD1234567890')
   */
  generateId(prefix, digitLength = 10) {
    if (!prefix || typeof prefix !== 'string') {
      throw new Error('Prefix is required and must be a string');
    }

    if (digitLength < 8 || digitLength > 20) {
      throw new Error('Digit length must be between 8 and 20');
    }

    const timestamp = Date.now();
    
    // Handle clock going backwards or same millisecond
    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1) % (this.maxSequence + 1);
      if (this.sequence === 0) {
        // Wait for next millisecond if sequence overflows
        while (Date.now() <= this.lastTimestamp) {
          // Busy wait
        }
      }
    } else {
      this.sequence = Math.floor(Math.random() * 100); // Random start for each millisecond
    }

    this.lastTimestamp = timestamp;

    // Create the numeric ID
    const timestampStr = timestamp.toString();
    const sequenceStr = this.sequence.toString().padStart(3, '0');
    
    // Combine timestamp + sequence and trim/pad to desired length
    let numericId = timestampStr + sequenceStr;
    
    if (numericId.length > digitLength) {
      // Take the last N digits to maintain recent timestamp info
      numericId = numericId.slice(-digitLength);
    } else if (numericId.length < digitLength) {
      // Pad with random digits at the beginning
      const paddingLength = digitLength - numericId.length;
      const padding = Math.floor(Math.random() * Math.pow(10, paddingLength))
        .toString()
        .padStart(paddingLength, '0');
      numericId = padding + numericId;
    }

    return prefix + numericId;
  }

  /**
   * Generate purely numeric Order ID using optimized Snowflake algorithm
   * Format: Shorter 12-13 digit numeric ID (no Redis dependency)
   * Structure: Optimized for shorter length while maintaining uniqueness
   * @returns {string} Numeric Order ID (e.g., '123456789012')
   */
  generateOrderId() {
    const now = Date.now();
    
    // Handle clock going backwards
    if (now < this.lastTimestamp) {
      throw new Error(`Clock moved backwards. Refusing to generate ID for ${this.lastTimestamp - now}ms`);
    }
    
    if (now === this.lastTimestamp) {
      // Same millisecond, increment sequence
      this.sequence = (this.sequence + 1) & this.maxSequence;
      if (this.sequence === 0) {
        // Sequence overflow, wait for next millisecond
        while (Date.now() <= this.lastTimestamp) {
          // Busy wait
        }
        return this.generateOrderId(); // Recursive call for next millisecond
      }
    } else {
      // New millisecond, reset sequence
      this.sequence = 0;
    }
    
    this.lastTimestamp = now;
    
    // Create shorter ID format for better usability
    // Use last 8 digits of timestamp + 2-digit worker + 3-digit sequence = 13 digits max
    const timestampStr = now.toString().slice(-8); // Last 8 digits of timestamp
    const workerStr = this.workerId.toString().padStart(2, '0').slice(-2); // 2 digits (0-99)
    const seqStr = this.sequence.toString().padStart(3, '0'); // 3 digits (0-4095, but padded to 3)
    
    // Total: 8 + 2 + 3 = 13 digits maximum
    return timestampStr + workerStr + seqStr;
  }

  /**
   * Generate Redis-independent ID with prefix using Snowflake algorithm
   * @param {string} prefix - The prefix for the ID (e.g., 'TXN', 'SL')
   * @returns {string} Generated ID with prefix (e.g., 'TXN1234567890123456')
   */
  generatePrefixedId(prefix) {
    const now = Date.now();
    
    // Handle clock going backwards
    if (now < this.lastTimestamp) {
      throw new Error(`Clock moved backwards. Refusing to generate ID for ${this.lastTimestamp - now}ms`);
    }
    
    if (now === this.lastTimestamp) {
      // Same millisecond, increment sequence
      this.legacySequence = (this.legacySequence + 1) & this.legacyMaxSequence;
      if (this.legacySequence === 0) {
        // Sequence overflow, wait for next millisecond
        while (Date.now() <= this.lastTimestamp) {
          // Busy wait
        }
        return this.generatePrefixedId(prefix); // Recursive call for next millisecond
      }
    } else {
      // New millisecond, reset sequence
      this.legacySequence = 0;
    }
    
    this.lastTimestamp = now;
    
    // Calculate timestamp offset from epoch
    const timestampOffset = now - this.epoch;
    
    // Build the ID: [timestamp: 41 bits] [worker: 10 bits] [sequence: 12 bits] [reserved: 1 bit]
    // Using BigInt to handle 64-bit operations safely
    const id = (BigInt(timestampOffset) << 23n) | 
               (BigInt(this.workerId) << 13n) | 
               BigInt(this.legacySequence);
    
    // Convert to string and add prefix
    return prefix + id.toString();
  }

  // Transaction IDs: TXN1234567890123456 (Redis-independent)
  // Special shorter format for database compatibility (max 20 chars)
  generateTransactionId() {
    const now = Date.now();
    
    // Handle clock going backwards
    if (now < this.lastTimestamp) {
      throw new Error(`Clock moved backwards. Refusing to generate ID for ${this.lastTimestamp - now}ms`);
    }
    
    if (now === this.lastTimestamp) {
      // Same millisecond, increment sequence
      this.legacySequence = (this.legacySequence + 1) & this.legacyMaxSequence;
      if (this.legacySequence === 0) {
        // Sequence overflow, wait for next millisecond
        while (Date.now() <= this.lastTimestamp) {
          // Busy wait
        }
        return this.generateTransactionId(); // Recursive call for next millisecond
      }
    } else {
      // New millisecond, reset sequence
      this.legacySequence = 0;
    }
    
    this.lastTimestamp = now;
    
    // Create shorter ID for database compatibility
    // Format: TXN + last 10 digits of timestamp + 3-digit worker + 3-digit sequence
    const timestampStr = now.toString().slice(-10); // Last 10 digits
    const workerStr = this.workerId.toString().padStart(3, '0').slice(-3); // 3 digits
    const seqStr = this.legacySequence.toString().padStart(3, '0'); // 3 digits
    
    // Total: TXN (3) + timestamp (10) + worker (3) + sequence (3) = 19 chars (fits in 20)
    return `TXN${timestampStr}${workerStr}${seqStr}`;
  }

  // Money Request IDs: REQ1234567890123456 (Redis-independent)
  generateMoneyRequestId() {
    return this.generatePrefixedId('REQ');
  }

  // Stop Loss IDs: SL1234567890123456 (Redis-independent)
  generateStopLossId() {
    return this.generatePrefixedId('SL');
  }

  // Take Profit IDs: TP1234567890123456 (Redis-independent)
  generateTakeProfitId() {
    return this.generatePrefixedId('TP');
  }

  // Position IDs: POS1234567890123456 (Redis-independent)
  generatePositionId() {
    return this.generatePrefixedId('POS');
  }

  // Trade IDs: TRD1234567890123456 (Redis-independent)
  generateTradeId() {
    return this.generatePrefixedId('TRD');
  }

  // Account IDs: ACC1234567890123456 (Redis-independent)
  generateAccountId() {
    return this.generatePrefixedId('ACC');
  }

  // Session IDs: SES1234567890123456 (Redis-independent)
  generateSessionId() {
    return this.generatePrefixedId('SES');
  }

  /**
   * Generate Stop Loss Cancel ID (Redis-independent)
   * @returns {string} Stop Loss Cancel ID (e.g., 'SLC1234567890123456')
   */
  generateStopLossCancelId() {
    return this.generatePrefixedId('SLC');
  }

  /**
   * Generate Take Profit Cancel ID (Redis-independent)
   * @returns {string} Take Profit Cancel ID (e.g., 'TPC1234567890123456')
   */
  generateTakeProfitCancelId() {
    return this.generatePrefixedId('TPC');
  }

  /**
   * Generate Cancel Order ID (Redis-independent)
   * @returns {string} Cancel Order ID (e.g., 'CXL1234567890123456')
   */
  generateCancelOrderId() {
    return this.generatePrefixedId('CXL');
  }

  /**
   * Generate Close Order ID (Redis-independent)
   * @returns {string} Close Order ID (e.g., 'CLS1234567890123456')
   */
  generateCloseOrderId() {
    return this.generatePrefixedId('CLS');
  }

  /**
   * Generate Modify Order ID (Redis-independent)
   * @returns {string} Modify ID (e.g., 'MOD1234567890123456')
   */
  generateModifyId() {
    return this.generatePrefixedId('MOD');
  }

  /**
   * Batch generate multiple IDs with the same prefix
   * @param {string} prefix - The prefix for the IDs
   * @param {number} count - Number of IDs to generate
   * @param {number} digitLength - Length of numeric portion (default: 10)
   * @returns {string[]} Array of generated IDs
   */
  generateBatch(prefix, count, digitLength = 10) {
    const ids = [];
    for (let i = 0; i < count; i++) {
      ids.push(this.generateId(prefix, digitLength));
    }
    return ids;
  }

  /**
   * Validate ID format
   * @param {string} id - The ID to validate
   * @param {string} expectedPrefix - Expected prefix (use 'NUMERIC' for order IDs)
   * @returns {boolean} True if valid format
   */
  validateId(id, expectedPrefix) {
    if (!id || typeof id !== 'string') return false;
    
    // Special case for numeric order IDs
    if (expectedPrefix === 'NUMERIC') {
      return /^\d+$/.test(id) && id.length >= 12 && id.length <= 13;
    }
    
    if (!id.startsWith(expectedPrefix)) return false;
    
    const numericPart = id.slice(expectedPrefix.length);
    return /^\d+$/.test(numericPart);
  }

  /**
   * Validate numeric order ID
   * @param {string} orderId - The order ID to validate
   * @returns {boolean} True if valid numeric order ID
   */
  validateOrderId(orderId) {
    return this.validateId(orderId, 'NUMERIC');
  }

  /**
   * Extract timestamp from numeric order ID
   * @param {string} orderId - The numeric order ID to analyze
   * @returns {number|null} Actual timestamp or null if invalid
   */
  extractTimestampFromOrderId(orderId) {
    if (!this.validateOrderId(orderId)) return null;
    
    try {
      // New format: 8 digits timestamp + 2 digits worker + 3 digits sequence
      const timestampPart = orderId.slice(0, 8); // First 8 digits
      
      // This is the last 8 digits of the actual timestamp
      // We need to reconstruct the full timestamp
      const currentTime = Date.now();
      const currentTimeStr = currentTime.toString();
      const currentPrefix = currentTimeStr.slice(0, -8);
      
      // Reconstruct full timestamp
      const reconstructedTimestamp = parseInt(currentPrefix + timestampPart);
      
      // Validate if it's a reasonable timestamp (within last year and next hour)
      const oneYearAgo = currentTime - (365 * 24 * 60 * 60 * 1000);
      const oneHourFromNow = currentTime + (60 * 60 * 1000);
      
      if (reconstructedTimestamp >= oneYearAgo && reconstructedTimestamp <= oneHourFromNow) {
        return reconstructedTimestamp;
      }
    } catch (error) {
      // Invalid parsing
    }
    
    return null;
  }

  /**
   * Extract worker ID from numeric order ID
   * @param {string} orderId - The numeric order ID to analyze
   * @returns {number|null} Worker ID or null if invalid
   */
  extractWorkerIdFromOrderId(orderId) {
    if (!this.validateOrderId(orderId)) return null;
    
    try {
      // New format: 8 digits timestamp + 2 digits worker + 3 digits sequence
      const workerPart = orderId.slice(8, 10); // Digits 8-9 (2 digits)
      
      const workerId = parseInt(workerPart);
      
      // Validate worker ID range (0-99 in new format)
      if (workerId >= 0 && workerId <= 99) {
        return workerId;
      }
    } catch (error) {
      // Invalid parsing
    }
    
    return null;
  }

  /**
   * Extract timestamp from legacy prefixed ID (approximate, for debugging)
   * @param {string} id - The ID to analyze
   * @param {string} prefix - The prefix to remove
   * @returns {number|null} Approximate timestamp or null if invalid
   */
  extractTimestamp(id, prefix) {
    if (!this.validateId(id, prefix)) return null;
    
    const numericPart = id.slice(prefix.length);
    // Try to extract timestamp from the end (last 13 digits typically)
    const possibleTimestamp = numericPart.slice(-13);
    const timestamp = parseInt(possibleTimestamp);
    
    // Validate if it's a reasonable timestamp (between 2020 and 2050)
    if (timestamp > 1577836800000 && timestamp < 2524608000000) {
      return timestamp;
    }
    
    return null;
  }
}

// Export singleton instance
module.exports = new IdGeneratorService();
