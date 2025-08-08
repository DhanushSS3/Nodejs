const { Sequelize } = require('sequelize');
const sequelize = require('../config/db');
const logger = require('./logger.service');

/**
 * Transaction service for high-concurrency financial operations
 * Provides deadlock retry logic and atomic operation handling
 */
class TransactionService {
  /**
   * Execute operation with transaction and deadlock retry
   * @param {Function} operation - Async function that receives transaction as parameter
   * @param {Object} options - Transaction options
   * @param {number} maxRetries - Maximum retry attempts for deadlocks
   * @returns {Promise<any>} - Operation result
   */
  static async executeWithRetry(operation, options = {}, maxRetries = 3) {
    let attempt = 0;
    
    while (attempt <= maxRetries) {
      const transaction = await sequelize.transaction({
        isolationLevel: options.isolationLevel || Sequelize.Transaction.ISOLATION_LEVELS.READ_COMMITTED,
        ...options
      });

      try {
        const result = await operation(transaction);
        await transaction.commit();
        
        if (attempt > 0) {
          logger.info(`Transaction succeeded after ${attempt} retries`);
        }
        
        return result;
      } catch (error) {
        await transaction.rollback();
        
        // Check if it's a deadlock error
        if (this.isDeadlockError(error) && attempt < maxRetries) {
          attempt++;
          const delay = this.calculateBackoffDelay(attempt);
          
          logger.warn(`Deadlock detected (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms`, {
            error: error.message,
            attempt,
            maxRetries
          });
          
          await this.sleep(delay);
          continue;
        }
        
        // Log the error with context
        logger.error('Transaction failed', {
          error: error.message,
          stack: error.stack,
          attempt,
          isDeadlock: this.isDeadlockError(error)
        });
        
        throw error;
      }
    }
  }

  /**
   * Check if error is a deadlock
   * @param {Error} error 
   * @returns {boolean}
   */
  static isDeadlockError(error) {
    return error.original && (
      error.original.code === 'ER_LOCK_DEADLOCK' ||
      error.original.errno === 1213 ||
      error.message.includes('Deadlock found')
    );
  }

  /**
   * Calculate exponential backoff delay
   * @param {number} attempt 
   * @returns {number} Delay in milliseconds
   */
  static calculateBackoffDelay(attempt) {
    const baseDelay = 10; // 10ms base
    const maxDelay = 100; // 100ms max
    const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
    
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.1 * delay;
    return Math.floor(delay + jitter);
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms 
   * @returns {Promise<void>}
   */
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute operation with user locking
   * Automatically locks user row before executing operation
   * @param {number} userId 
   * @param {Function} operation 
   * @param {Object} options 
   * @returns {Promise<any>}
   */
  static async executeWithUserLock(userId, operation, options = {}) {
    return this.executeWithRetry(async (transaction) => {
      // Lock the user row first
      const userModel = options.userModel || require('../models/demoUser.model');
      
      const user = await userModel.findByPk(userId, {
        lock: transaction.LOCK.UPDATE,
        transaction
      });

      if (!user) {
        throw new Error(`User with ID ${userId} not found`);
      }

      return await operation(transaction, user);
    }, options);
  }
}

module.exports = TransactionService;