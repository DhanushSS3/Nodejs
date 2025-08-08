const sequelize = require('../config/db');
const { DataTypes } = require('sequelize');

/**
 * Idempotency tracking model for preventing duplicate operations
 */
const IdempotencyKey = sequelize.define('IdempotencyKey', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  key: { type: DataTypes.STRING, unique: true, allowNull: false },
  response: { type: DataTypes.JSON, allowNull: true },
  status: { type: DataTypes.ENUM('processing', 'completed', 'failed'), defaultValue: 'processing' },
  expires_at: { type: DataTypes.DATE, allowNull: false }
}, {
  tableName: 'idempotency_keys',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['key'] },
    { fields: ['expires_at'] }
  ]
});

/**
 * Idempotency service for preventing duplicate financial operations
 */
class IdempotencyService {
  /**
   * Check if operation is already in progress or completed
   * @param {string} key - Unique idempotency key
   * @param {number} ttlMinutes - Time to live in minutes (default: 60)
   * @returns {Promise<{isExisting: boolean, record?: Object}>}
   */
  static async checkIdempotency(key, ttlMinutes = 60) {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    
    try {
      // Try to create the record (will fail if already exists)
      const record = await IdempotencyKey.create({
        key,
        expires_at: expiresAt
      });
      
      return { isExisting: false, record };
    } catch (error) {
      // If unique constraint violation, check existing record
      if (error.name === 'SequelizeUniqueConstraintError') {
        const existing = await IdempotencyKey.findOne({ where: { key } });
        
        if (existing && existing.expires_at > new Date()) {
          return { isExisting: true, record: existing };
        }
        
        // Expired record, delete and create new
        if (existing) {
          await existing.destroy();
          const record = await IdempotencyKey.create({
            key,
            expires_at: expiresAt
          });
          return { isExisting: false, record };
        }
      }
      
      throw error;
    }
  }

  /**
   * Mark operation as completed with response
   * @param {string} key 
   * @param {Object} response 
   * @returns {Promise<void>}
   */
  static async markCompleted(key, response) {
    await IdempotencyKey.update(
      { 
        status: 'completed',
        response: response 
      },
      { where: { key } }
    );
  }

  /**
   * Mark operation as failed
   * @param {string} key 
   * @param {Error} error 
   * @returns {Promise<void>}
   */
  static async markFailed(key, error) {
    await IdempotencyKey.update(
      { 
        status: 'failed',
        response: { error: error.message }
      },
      { where: { key } }
    );
  }

  /**
   * Generate idempotency key from request
   * @param {Object} req - Express request object
   * @param {string} operation - Operation name
   * @returns {string}
   */
  static generateKey(req, operation) {
    const crypto = require('crypto');
    const keyData = {
      operation,
      userId: req.user?.id || 'anonymous',
      body: req.body,
      ip: req.ip
    };
    
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(keyData))
      .digest('hex');
  }

  /**
   * Clean up expired idempotency keys (run as scheduled job)
   * @returns {Promise<number>} Number of deleted records
   */
  static async cleanupExpired() {
    const result = await IdempotencyKey.destroy({
      where: {
        expires_at: {
          [sequelize.Op.lt]: new Date()
        }
      }
    });
    
    return result;
  }
}

module.exports = { IdempotencyService, IdempotencyKey };