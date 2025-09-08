const UserTransaction = require('../models/userTransaction.model');
const { LiveUser, DemoUser } = require('../models');
const idGenerator = require('./idGenerator.service');
const logger = require('./logger.service');
const { Op } = require('sequelize');
const sequelize = require('../config/db');

/**
 * Wallet Service for managing user transactions and balances
 * Handles deposits, withdrawals, profits, losses, commissions, swaps, and adjustments
 */
class WalletService {
  
  /**
   * Get user model based on user type
   * @param {string} userType - 'live' or 'demo'
   * @returns {Model} Sequelize model
   */
  getUserModel(userType) {
    return userType === 'live' ? LiveUser : DemoUser;
  }

  /**
   * Get current user balance
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @returns {Promise<number>} Current balance
   */
  async getCurrentBalance(userId, userType) {
    const UserModel = this.getUserModel(userType);
    const user = await UserModel.findByPk(userId);
    
    if (!user) {
      throw new Error(`${userType} user not found`);
    }
    
    return parseFloat(user.wallet_balance) || 0;
  }

  /**
   * Create a new transaction and update user balance
   * @param {Object} transactionData - Transaction details
   * @returns {Promise<Object>} Created transaction
   */
  async createTransaction(transactionData) {
    const {
      userId,
      userType,
      type,
      amount,
      orderId = null,
      referenceId = null,
      adminId = null,
      notes = null,
      metadata = null,
      currency = 'USD'
    } = transactionData;

    const operationId = `wallet_transaction_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return await sequelize.transaction(async (dbTransaction) => {
      try {
        // Get current balance
        const currentBalance = await this.getCurrentBalance(userId, userType);
        
        // Calculate new balance
        const transactionAmount = parseFloat(amount);
        const newBalance = currentBalance + transactionAmount;

        // Validate sufficient balance for debits
        if (transactionAmount < 0 && newBalance < 0) {
          throw new Error('Insufficient balance for this transaction');
        }

        // Generate unique transaction ID (Redis-backed, atomic)
        const transactionId = await idGenerator.generateTransactionId();

        // Create transaction record
        const transaction = await UserTransaction.create({
          transaction_id: transactionId,
          user_id: userId,
          user_type: userType,
          order_id: orderId,
          type,
          amount: transactionAmount,
          balance_before: currentBalance,
          balance_after: newBalance,
          currency,
          status: 'completed',
          reference_id: referenceId,
          admin_id: adminId,
          notes,
          metadata
        }, { transaction: dbTransaction });

        // Update user balance
        const UserModel = this.getUserModel(userType);
        await UserModel.update(
          { wallet_balance: newBalance },
          { 
            where: { id: userId },
            transaction: dbTransaction
          }
        );

        // Log the transaction
        logger.info('Wallet transaction completed', {
          operationId,
          transactionId,
          userId,
          userType,
          type,
          amount: transactionAmount,
          balanceBefore: currentBalance,
          balanceAfter: newBalance,
          adminId
        });

        return transaction;

      } catch (error) {
        logger.error('Wallet transaction failed', {
          operationId,
          userId,
          userType,
          type,
          amount,
          error: error.message
        });
        throw error;
      }
    });
  }

  /**
   * Process deposit transaction
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {number} amount - Deposit amount (positive)
   * @param {string} referenceId - Payment reference
   * @param {number} adminId - Admin who approved
   * @param {string} notes - Additional notes
   * @returns {Promise<Object>} Transaction record
   */
  async deposit(userId, userType, amount, referenceId = null, adminId = null, notes = null) {
    if (amount <= 0) {
      throw new Error('Deposit amount must be positive');
    }

    return await this.createTransaction({
      userId,
      userType,
      type: 'deposit',
      amount: Math.abs(amount),
      referenceId,
      adminId,
      notes
    });
  }

  /**
   * Process withdrawal transaction
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {number} amount - Withdrawal amount (positive, will be converted to negative)
   * @param {string} referenceId - Payment reference
   * @param {number} adminId - Admin who approved
   * @param {string} notes - Additional notes
   * @returns {Promise<Object>} Transaction record
   */
  async withdraw(userId, userType, amount, referenceId = null, adminId = null, notes = null) {
    if (amount <= 0) {
      throw new Error('Withdrawal amount must be positive');
    }

    return await this.createTransaction({
      userId,
      userType,
      type: 'withdraw',
      amount: -Math.abs(amount), // Convert to negative
      referenceId,
      adminId,
      notes
    });
  }

  /**
   * Process profit transaction
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {number} amount - Profit amount
   * @param {number} orderId - Related order ID
   * @param {Object} metadata - Additional order data
   * @returns {Promise<Object>} Transaction record
   */
  async addProfit(userId, userType, amount, orderId = null, metadata = null) {
    if (amount <= 0) {
      throw new Error('Profit amount must be positive');
    }

    return await this.createTransaction({
      userId,
      userType,
      type: 'profit',
      amount: Math.abs(amount),
      orderId,
      metadata,
      notes: `Profit from order ${orderId || 'N/A'}`
    });
  }

  /**
   * Process loss transaction
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {number} amount - Loss amount (positive, will be converted to negative)
   * @param {number} orderId - Related order ID
   * @param {Object} metadata - Additional order data
   * @returns {Promise<Object>} Transaction record
   */
  async addLoss(userId, userType, amount, orderId = null, metadata = null) {
    if (amount <= 0) {
      throw new Error('Loss amount must be positive');
    }

    return await this.createTransaction({
      userId,
      userType,
      type: 'loss',
      amount: -Math.abs(amount), // Convert to negative
      orderId,
      metadata,
      notes: `Loss from order ${orderId || 'N/A'}`
    });
  }

  /**
   * Process commission transaction
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {number} amount - Commission amount (positive, will be converted to negative)
   * @param {number} orderId - Related order ID
   * @param {Object} metadata - Commission details
   * @returns {Promise<Object>} Transaction record
   */
  async deductCommission(userId, userType, amount, orderId = null, metadata = null) {
    if (amount <= 0) {
      throw new Error('Commission amount must be positive');
    }

    return await this.createTransaction({
      userId,
      userType,
      type: 'commission',
      amount: -Math.abs(amount), // Convert to negative
      orderId,
      metadata,
      notes: `Commission for order ${orderId || 'N/A'}`
    });
  }

  /**
   * Process swap transaction
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {number} amount - Swap amount (can be positive or negative)
   * @param {number} orderId - Related order ID
   * @param {Object} metadata - Swap details
   * @returns {Promise<Object>} Transaction record
   */
  async addSwap(userId, userType, amount, orderId = null, metadata = null) {
    if (amount === 0) {
      throw new Error('Swap amount cannot be zero');
    }

    return await this.createTransaction({
      userId,
      userType,
      type: 'swap',
      amount: parseFloat(amount),
      orderId,
      metadata,
      notes: `Swap ${amount > 0 ? 'credit' : 'charge'} for order ${orderId || 'N/A'}`
    });
  }

  /**
   * Process manual adjustment transaction
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {number} amount - Adjustment amount
   * @param {number} adminId - Admin making the adjustment
   * @param {string} notes - Reason for adjustment
   * @param {Object} metadata - Additional data
   * @returns {Promise<Object>} Transaction record
   */
  async makeAdjustment(userId, userType, amount, adminId, notes, metadata = null) {
    if (amount === 0) {
      throw new Error('Adjustment amount cannot be zero');
    }

    if (!adminId) {
      throw new Error('Admin ID is required for adjustments');
    }

    return await this.createTransaction({
      userId,
      userType,
      type: 'adjustment',
      amount: parseFloat(amount),
      adminId,
      notes: notes || 'Manual balance adjustment',
      metadata
    });
  }

  /**
   * Get transaction history for a user
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {Object} options - Query options
   * @returns {Promise<Object>} Transactions and pagination info
   */
  async getTransactionHistory(userId, userType, options = {}) {
    const {
      page = 1,
      limit = 50,
      type = null,
      status = null,
      startDate = null,
      endDate = null,
      orderId = null
    } = options;

    const offset = (page - 1) * limit;
    const whereClause = {
      user_id: userId,
      user_type: userType
    };

    // Add filters
    if (type) whereClause.type = type;
    if (status) whereClause.status = status;
    if (orderId) whereClause.order_id = orderId;
    
    if (startDate && endDate) {
      whereClause.created_at = {
        [Op.between]: [startDate, endDate]
      };
    } else if (startDate) {
      whereClause.created_at = {
        [Op.gte]: startDate
      };
    } else if (endDate) {
      whereClause.created_at = {
        [Op.lte]: endDate
      };
    }

    const { count, rows } = await UserTransaction.findAndCountAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
      offset: parseInt(offset)
    });

    return {
      transactions: rows,
      pagination: {
        total: count,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(count / limit)
      }
    };
  }

  /**
   * Get user balance summary
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @returns {Promise<Object>} Balance summary
   */
  async getBalanceSummary(userId, userType) {
    const currentBalance = await this.getCurrentBalance(userId, userType);
    
    // Get transaction summaries
    const summaries = await UserTransaction.findAll({
      where: {
        user_id: userId,
        user_type: userType,
        status: 'completed'
      },
      attributes: [
        'type',
        [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'transaction_count']
      ],
      group: ['type']
    });

    const summary = {
      current_balance: currentBalance,
      currency: 'USD',
      transaction_summary: {}
    };

    summaries.forEach(item => {
      summary.transaction_summary[item.type] = {
        total_amount: parseFloat(item.dataValues.total_amount) || 0,
        transaction_count: parseInt(item.dataValues.transaction_count) || 0
      };
    });

    return summary;
  }
}

module.exports = new WalletService();
