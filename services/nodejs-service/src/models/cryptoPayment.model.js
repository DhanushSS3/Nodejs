const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const { v4: uuidv4 } = require('uuid');

const CryptoPayment = sequelize.define('CryptoPayment', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'ID of the user making the payment',
  },
  userType: {
    type: DataTypes.ENUM('live', 'strategy_provider', 'copy_follower'),
    allowNull: false,
    defaultValue: 'live',
    comment: 'Type of account receiving the credit',
  },
  initiatorUserId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'User/account ID that initiated the deposit (if different)',
  },
  initiatorUserType: {
    type: DataTypes.ENUM('live', 'strategy_provider'),
    allowNull: true,
    comment: 'Account type of the initiator',
  },
  merchantOrderId: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    comment: 'Unique merchant order identifier in format: livefx_{uuid4}',
  },
  orderId: {
    type: DataTypes.STRING,
    allowNull: true,
    comment: 'Order ID received from payment provider webhook for future reference',
  },
  baseAmount: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: false,
    comment: 'Original amount in base currency',
  },
  baseCurrency: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Base currency code (e.g., USD, EUR)',
  },
  settledCurrency: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Currency in which payment will be settled',
  },
  networkSymbol: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Cryptocurrency network symbol (e.g., BTC, ETH, USDT)',
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'PENDING',
    comment: 'Payment status: PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED',
  },
  transactionDetails: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'JSON object containing transaction details from payment provider',
  },
  baseAmountReceived: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true,
    comment: 'Actual amount received in base currency',
  },
  settledAmountRequested: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true,
    comment: 'Amount requested to be settled',
  },
  settledAmountReceived: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true,
    comment: 'Actual amount received in settled currency',
  },
  settledAmountCredited: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true,
    comment: 'Amount credited to user account after processing',
  },
  commission: {
    type: DataTypes.DECIMAL(20, 8),
    allowNull: true,
    comment: 'Commission/fee charged for the transaction',
  },
}, {
  tableName: 'crypto_payments',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  hooks: {
    beforeCreate: (cryptoPayment) => {
      if (!cryptoPayment.merchantOrderId) {
        // Generate merchantOrderId in format: livefx_{short_uuid} (UUID hex minus 4 chars)
        const shortUuid = uuidv4().replace(/-/g, '').slice(0, -4);
        cryptoPayment.merchantOrderId = `livefx_${shortUuid}`;
      }
    },
  },
  indexes: [
    {
      fields: ['userId'],
      name: 'idx_crypto_payments_user_id',
    },
    {
      fields: ['userType'],
      name: 'idx_crypto_payments_user_type',
    },
    {
      fields: ['initiatorUserId'],
      name: 'idx_crypto_payments_initiator_user_id',
    },
    {
      fields: ['merchantOrderId'],
      unique: true,
      name: 'idx_crypto_payments_merchant_order_id',
    },
    {
      fields: ['orderId'],
      name: 'idx_crypto_payments_order_id',
    },
    {
      fields: ['status'],
      name: 'idx_crypto_payments_status',
    },
    {
      fields: ['created_at'],
      name: 'idx_crypto_payments_created_at',
    },
  ],
});

/**
 * Static method to generate a new merchant order ID
 * @returns {string} Merchant order ID in format: livefx_{uuid4}
 */
CryptoPayment.generateMerchantOrderId = function() {
  const shortUuid = uuidv4().replace(/-/g, '').slice(0, -4);
  return `livefx_${shortUuid}`;
};

/**
 * Static method to find payment by merchantOrderId or orderId
 * @param {string} merchantOrderId - Merchant order ID
 * @param {string} orderId - Provider order ID (fallback)
 * @returns {Promise<CryptoPayment|null>} Payment record or null
 */
CryptoPayment.findByOrderIds = async function(merchantOrderId, orderId) {
  // First try to find by merchantOrderId
  let payment = await this.findOne({
    where: { merchantOrderId }
  });
  
  // If not found and orderId is provided, try orderId
  if (!payment && orderId) {
    payment = await this.findOne({
      where: { orderId }
    });
  }
  
  return payment;
};

/**
 * Instance method to check if payment is in a final state
 * @returns {boolean} True if payment is completed, failed, or cancelled
 */
CryptoPayment.prototype.isFinalState = function() {
  return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(this.status);
};

/**
 * Instance method to check if payment can be updated
 * @returns {boolean} True if payment is still pending or processing
 */
CryptoPayment.prototype.canBeUpdated = function() {
  return ['PENDING', 'PROCESSING'].includes(this.status);
};

module.exports = CryptoPayment;
