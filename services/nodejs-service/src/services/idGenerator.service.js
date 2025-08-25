/**
 * ID Generation Service
 * Generates unique, time-based IDs with prefixes for different entities
 * Format: <PREFIX><DIGITS> (e.g., ORD1234567890, TXN9876543210)
 */

class IdGeneratorService {
  constructor() {
    this.lastTimestamp = 0;
    this.sequence = 0;
    this.maxSequence = 999; // 3-digit sequence for collision prevention
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
   * Generate Order ID
   * @param {number} digitLength - Length of numeric portion (default: 10)
   * @returns {string} Order ID (e.g., 'ORD1234567890')
   */

  // Order IDs: ORD1234567890 (10 digits)
  generateOrderId() {
    return this.generateId('ORD', 10);
  }

  // Transaction IDs: TXN1234567890 (10 digits)
  generateTransactionId() {
    return this.generateId('TXN', 10);
  }

  // Money Request IDs: REQ1234567890 (10 digits)
  generateMoneyRequestId() {
    return this.generateId('REQ', 10);
  }

  // Stop Loss IDs: SL123456789 (9 digits)
  generateStopLossId() {
    return this.generateId('SL', 9);
  }

  // Take Profit IDs: TP123456789 (9 digits)
  generateTakeProfitId() {
    return this.generateId('TP', 9);
  }

  // Position IDs: POS12345678 (8 digits)
  generatePositionId() {
    return this.generateId('POS', 8);
  }

  // Trade IDs: TRD1234567890 (10 digits)
  generateTradeId() {
    return this.generateId('TRD', 10);
  }

  // Account IDs: ACC123456789 (9 digits)
  generateAccountId() {
    return this.generateId('ACC', 9);
  }

  // Session IDs: SES1234567890 (10 digits)
  generateSessionId() {
    return this.generateId('SES', 10);
  }

  /**
   * Generate Stop Loss Cancel ID
   * @param {number} digitLength - Length of numeric portion (default: 10)
   * @returns {string} Stop Loss Cancel ID (e.g., 'SLC1234567890')
   */
  generateStopLossCancelId(digitLength = 10) {
    return this.generateId('SLC', digitLength);
  }

  /**
   * Generate Take Profit Cancel ID
   * @param {number} digitLength - Length of numeric portion (default: 10)
   * @returns {string} Take Profit Cancel ID (e.g., 'TPC1234567890')
   */
  generateTakeProfitCancelId(digitLength = 10) {
    return this.generateId('TPC', digitLength);
  }

  /**
   * Generate Cancel Order ID
   * @param {number} digitLength - Length of numeric portion (default: 10)
   * @returns {string} Cancel Order ID (e.g., 'CXL1234567890')
   */
  generateCancelOrderId(digitLength = 10) {
    return this.generateId('CXL', digitLength);
  }

  /**
   * Generate Close Order ID
   * @param {number} digitLength - Length of numeric portion (default: 10)
   * @returns {string} Close Order ID (e.g., 'CLS1234567890')
   */
  generateCloseOrderId(digitLength = 10) {
    return this.generateId('CLS', digitLength);
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
   * @param {string} expectedPrefix - Expected prefix
   * @returns {boolean} True if valid format
   */
  validateId(id, expectedPrefix) {
    if (!id || typeof id !== 'string') return false;
    if (!id.startsWith(expectedPrefix)) return false;
    
    const numericPart = id.slice(expectedPrefix.length);
    return /^\d+$/.test(numericPart);
  }

  /**
   * Extract timestamp from ID (approximate, for debugging)
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
