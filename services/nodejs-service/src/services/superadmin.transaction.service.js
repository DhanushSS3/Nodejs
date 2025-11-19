const { LiveUser, DemoUser, UserTransaction } = require('../models');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const sequelize = require('../config/db');
const { redisCluster } = require('../../config/redis');
const logger = require('../utils/logger');
const idGenerator = require('./idGenerator.service');
const redisSyncService = require('./redis.sync.service');

class SuperadminTransactionService {
  /**
   * Generate unique transaction ID (Redis-backed, atomic)
   * @returns {Promise<string>} Transaction ID
   */
  async generateTransactionId() {
    return idGenerator.generateTransactionId();
  }

  /**
   * Get user model based on user type
   * @param {string} userType - 'live' or 'demo'
   * @returns {Object} Sequelize model
   */
  getUserModel(userType) {
    switch (userType) {
      case 'live':
        return LiveUser;
      case 'demo':
        return DemoUser;
      case 'strategy_provider':
        return StrategyProviderAccount;
      default:
        throw new Error(`Invalid user type: ${userType}`);
    }
  }

  /**
   * Get user balance from Redis cache
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @returns {Promise<number|null>} Cached balance or null if not found
   */
  async getCachedBalance(userId, userType) {
    try {
      const cacheKey = `user_balance:${userType}:${userId}`;
      const cachedBalance = await redisCluster.get(cacheKey);
      return cachedBalance ? parseFloat(cachedBalance) : null;
    } catch (error) {
      logger.error('Redis get error:', error);
      return null;
    }
  }

  /**
   * Update user balance in Redis cache
   * @param {number} userId - User ID
   * @param {string} userType - 'live' or 'demo'
   * @param {number} balance - New balance
   */
  async updateCachedBalance(userId, userType, balance) {
    try {
      const cacheKey = `user_balance:${userType}:${userId}`;
      await redisCluster.setex(cacheKey, 3600, balance.toString()); // Cache for 1 hour
      logger.info(`Updated cached balance for ${userType} user ${userId}: ${balance}`);
    } catch (error) {
      logger.error('Redis set error:', error);
      // Don't throw error for cache failures - continue with DB operation
    }
  }

  /**
   * Process deposit transaction for a user
   * @param {Object} params - Deposit parameters
   * @param {number} params.userId - User ID
   * @param {string} params.userType - 'live' or 'demo'
   * @param {number} params.amount - Deposit amount (must be positive)
   * @param {number} params.adminId - Admin ID performing the operation
   * @param {string} [params.notes] - Optional notes
   * @param {string} [params.referenceId] - Optional external reference
   * @param {string} [params.userEmail] - User email (will be fetched if not provided)
   * @param {string} [params.methodType] - Payment method type
   * @returns {Promise<Object>} Transaction result
   */
  async processDeposit({ userId, userType, amount, adminId, notes = null, referenceId = null, userEmail = null, methodType = null }) {
    // Validate input
    if (!userId || !userType || !amount || !adminId) {
      throw new Error('Missing required parameters: userId, userType, amount, adminId');
    }

    if (!['live', 'demo', 'strategy_provider'].includes(userType)) {
      throw new Error('Invalid user type. Must be "live", "demo", or "strategy_provider"');
    }

    const depositAmount = parseFloat(amount);
    if (depositAmount <= 0) {
      throw new Error('Deposit amount must be positive');
    }

    const transaction = await sequelize.transaction();

    try {
      // Get user model and find user
      const UserModel = this.getUserModel(userType);
      // Lock the row for update to serialize concurrent balance updates
      const user = await UserModel.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
      
      if (!user) {
        throw new Error(`${userType} user not found with ID: ${userId}`);
      }

      if (!user.is_active) {
        throw new Error('Cannot process deposit for inactive user');
      }

      const balanceBefore = parseFloat(user.wallet_balance) || 0;
      const balanceAfter = balanceBefore + depositAmount;

      // Update user balance
      await user.update({ 
        wallet_balance: balanceAfter 
      }, { transaction });

      // Generate transaction id (Redis-backed)
      const transactionId = await this.generateTransactionId();

      // Create transaction record
      const transactionRecord = await UserTransaction.create({
        transaction_id: transactionId,
        user_id: userId,
        user_type: userType,
        type: 'deposit',
        amount: depositAmount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        status: 'completed',
        admin_id: adminId,
        user_email: userEmail || user.email, // Use provided email or fetch from user
        method_type: methodType,
        reference_id: referenceId,
        notes: notes,
        metadata: {
          processed_by: 'superadmin',
          processing_timestamp: new Date().toISOString()
        }
      }, { transaction });

      // Commit database transaction
      await transaction.commit();

      // Comprehensive Redis sync after successful database commit
      try {
        await redisSyncService.syncUserAfterBalanceChange(userId, userType, {
          wallet_balance: balanceAfter,
          last_deposit_amount: depositAmount,
          last_admin_action: 'deposit'
        }, {
          operation_type: 'deposit',
          admin_id: adminId,
          transaction_id: transactionRecord.transaction_id
        });
      } catch (redisSyncError) {
        logger.error('Redis sync failed after deposit - database is still consistent', {
          error: redisSyncError.message,
          userId,
          userType,
          balanceAfter
        });
        // Don't throw - database transaction is already committed and consistent
      }

      logger.info(`Deposit processed successfully: ${userType} user ${userId}, amount: ${depositAmount}, new balance: ${balanceAfter}`);

      return {
        success: true,
        transaction: transactionRecord,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          balance_before: balanceBefore,
          balance_after: balanceAfter
        }
      };

    } catch (error) {
      await transaction.rollback();
      logger.error(`Deposit failed for ${userType} user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Process withdrawal transaction for a user
   * @param {Object} params - Withdrawal parameters
   * @param {number} params.userId - User ID
   * @param {string} params.userType - 'live' or 'demo'
   * @param {number} params.amount - Withdrawal amount (must be positive)
   * @param {number} params.adminId - Admin ID performing the operation
   * @param {string} [params.notes] - Optional notes
   * @param {string} [params.referenceId] - Optional external reference
   * @param {string} [params.userEmail] - User email (will be fetched if not provided)
   * @param {string} [params.methodType] - Payment method type
   * @returns {Promise<Object>} Transaction result
   */
  async processWithdrawal({ userId, userType, amount, adminId, notes = null, referenceId = null, userEmail = null, methodType = null }) {
    // Validate input
    if (!userId || !userType || !amount || !adminId) {
      throw new Error('Missing required parameters: userId, userType, amount, adminId');
    }

    if (!['live', 'demo', 'strategy_provider'].includes(userType)) {
      throw new Error('Invalid user type. Must be "live", "demo", or "strategy_provider"');
    }

    const withdrawalAmount = parseFloat(amount);
    if (withdrawalAmount <= 0) {
      throw new Error('Withdrawal amount must be positive');
    }

    const transaction = await sequelize.transaction();

    try {
      // Get user model and find user
      const UserModel = this.getUserModel(userType);
      // Lock the row for update to serialize concurrent balance updates
      const user = await UserModel.findByPk(userId, { transaction, lock: transaction.LOCK.UPDATE });
      
      if (!user) {
        throw new Error(`${userType} user not found with ID: ${userId}`);
      }

      if (!user.is_active) {
        throw new Error('Cannot process withdrawal for inactive user');
      }

      const balanceBefore = parseFloat(user.wallet_balance) || 0;
      
      // Validate sufficient balance
      if (balanceBefore < withdrawalAmount) {
        throw new Error(`Insufficient balance. Available: ${balanceBefore}, Requested: ${withdrawalAmount}`);
      }

      const balanceAfter = balanceBefore - withdrawalAmount;

      // Update user balance
      await user.update({ 
        wallet_balance: balanceAfter 
      }, { transaction });

      // Generate transaction id (Redis-backed)
      const transactionId = await this.generateTransactionId();

      // Create transaction record
      const transactionRecord = await UserTransaction.create({
        transaction_id: transactionId,
        user_id: userId,
        user_type: userType,
        type: 'withdraw',
        amount: -withdrawalAmount, // Negative for withdrawal
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        status: 'completed',
        admin_id: adminId,
        user_email: userEmail || user.email, // Use provided email or fetch from user
        method_type: methodType,
        reference_id: referenceId,
        notes: notes,
        metadata: {
          processed_by: 'superadmin',
          processing_timestamp: new Date().toISOString()
        }
      }, { transaction });

      // Commit database transaction
      await transaction.commit();

      // Comprehensive Redis sync after successful database commit
      try {
        await redisSyncService.syncUserAfterBalanceChange(userId, userType, {
          wallet_balance: balanceAfter,
          last_withdrawal_amount: withdrawalAmount,
          last_admin_action: 'withdrawal'
        }, {
          operation_type: 'withdrawal',
          admin_id: adminId,
          transaction_id: transactionRecord.transaction_id
        });
      } catch (redisSyncError) {
        logger.error('Redis sync failed after withdrawal - database is still consistent', {
          error: redisSyncError.message,
          userId,
          userType,
          balanceAfter
        });
        // Don't throw - database transaction is already committed and consistent
      }

      logger.info(`Withdrawal processed successfully: ${userType} user ${userId}, amount: ${withdrawalAmount}, new balance: ${balanceAfter}`);

      return {
        success: true,
        transaction: transactionRecord,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          balance_before: balanceBefore,
          balance_after: balanceAfter
        }
      };

    } catch (error) {
      await transaction.rollback();
      logger.error(`Withdrawal failed for ${userType} user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Get user transaction history
   * @param {Object} params - Query parameters
   * @param {number} params.userId - User ID
   * @param {string} [params.userType] - 'live' or 'demo' (optional, will check both if not provided)
   * @param {number} params.limit - Number of records to return
   * @param {number} params.offset - Offset for pagination
   * @param {string} params.type - Transaction type filter
   * @returns {Promise<Object>} Transaction history
   */
  async getUserTransactionHistory({ userId, userType = null, limit = 50, offset = 0, type }) {
    const whereClause = {
      user_id: userId
    };

    // If userType is provided, filter by it; otherwise get transactions from both live and demo
    if (userType) {
      whereClause.user_type = userType;
    }

    if (type) {
      whereClause.type = type;
    }

    const { count, rows } = await UserTransaction.findAndCountAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
      limit: Math.min(limit, 100), // Cap at 100 records
      offset,
      attributes: [
        'id', 'transaction_id', 'type', 'amount', 
        'balance_before', 'balance_after', 'status',
        'reference_id', 'notes', 'created_at'
      ]
    });

    return {
      total: count,
      transactions: rows,
      pagination: {
        limit,
        offset,
        hasMore: count > (offset + limit)
      }
    };
  }

  /**
   * Get user current balance (with Redis cache fallback)
   * @param {number} userId - User ID
   * @param {string} [userType] - 'live' or 'demo' (optional, will check both if not provided)
   * @returns {Promise<Object>} User balance information
   */
  async getUserBalance(userId, userType = null) {
    // If userType is not provided, we need to check both live and demo users
    if (!userType) {
      // Try to find user in both tables
      let user = null;
      let foundUserType = null;

      // Check live users first
      try {
        user = await LiveUser.findByPk(userId, {
          attributes: ['id', 'name', 'email', 'wallet_balance', 'is_active']
        });
        if (user) {
          foundUserType = 'live';
        }
      } catch (error) {
        // Continue to check demo users
      }

      // If not found in live users, check demo users
      if (!user) {
        try {
          user = await DemoUser.findByPk(userId, {
            attributes: ['id', 'name', 'email', 'wallet_balance', 'is_active']
          });
          if (user) {
            foundUserType = 'demo';
          }
        } catch (error) {
          // User not found in either table
        }
      }

      if (!user) {
        throw new Error(`User not found with ID: ${userId}`);
      }

      const balance = parseFloat(user.wallet_balance) || 0;
      
      // Update cache for next time
      await this.updateCachedBalance(userId, foundUserType, balance);

      return {
        balance,
        source: 'database',
        userType: foundUserType,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          is_active: user.is_active
        }
      };
    }

    // If userType is provided, use the original logic with cache
    const cachedBalance = await this.getCachedBalance(userId, userType);
    
    if (cachedBalance !== null) {
      return {
        balance: cachedBalance,
        source: 'cache',
        userType
      };
    }

    // Fallback to database
    const UserModel = this.getUserModel(userType);
    const user = await UserModel.findByPk(userId, {
      attributes: ['id', 'name', 'email', 'wallet_balance', 'is_active']
    });

    if (!user) {
      throw new Error(`${userType} user not found with ID: ${userId}`);
    }

    const balance = parseFloat(user.wallet_balance) || 0;
    
    // Update cache for next time
    await this.updateCachedBalance(userId, userType, balance);

    return {
      balance,
      source: 'database',
      userType,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        is_active: user.is_active
      }
    };
  }
}

module.exports = new SuperadminTransactionService();
