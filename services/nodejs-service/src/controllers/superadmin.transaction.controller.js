const superadminTransactionService = require('../services/superadmin.transaction.service');
const { createAuditLog } = require('../middlewares/audit.middleware');
const logger = require('../utils/logger');
const { UserTransaction } = require('../models');
const sequelize = require('../config/db');

class SuperadminTransactionController {
  constructor() {
    this.processStrategyProviderDeposit = this.processStrategyProviderDeposit.bind(this);
    this.processStrategyProviderWithdrawal = this.processStrategyProviderWithdrawal.bind(this);
    this.processCopyFollowerDeposit = this.processCopyFollowerDeposit.bind(this);
    this.processCopyFollowerWithdrawal = this.processCopyFollowerWithdrawal.bind(this);
  }

  /**
   * Deposit for Strategy Provider account shorthand endpoint
   * POST /api/superadmin/strategy-providers/:accountId/deposit
   */
  async processStrategyProviderDeposit(req, res) {
    req.body = req.body || {};
    req.body.userType = 'strategy_provider';
    req.params.userId = req.params.accountId; // reuse existing logic
    return this.processDeposit(req, res);
  }

  /**
   * Withdrawal for Strategy Provider account shorthand endpoint
   * POST /api/superadmin/strategy-providers/:accountId/withdraw
   */
  async processStrategyProviderWithdrawal(req, res) {
    req.body = req.body || {};
    req.body.userType = 'strategy_provider';
    req.params.userId = req.params.accountId;
    return this.processWithdrawal(req, res);
  }

  /**
   * Deposit for Copy Follower account shorthand endpoint
   * POST /api/superadmin/copy-followers/:accountId/deposit
   */
  async processCopyFollowerDeposit(req, res) {
    req.body = req.body || {};
    req.body.userType = 'copy_follower';
    req.params.userId = req.params.accountId;
    return this.processDeposit(req, res);
  }

  /**
   * Withdrawal for Copy Follower account shorthand endpoint
   * POST /api/superadmin/copy-followers/:accountId/withdraw
   */
  async processCopyFollowerWithdrawal(req, res) {
    req.body = req.body || {};
    req.body.userType = 'copy_follower';
    req.params.userId = req.params.accountId;
    return this.processWithdrawal(req, res);
  }

  /**
   * Process deposit for a user
   * POST /api/superadmin/users/:userId/deposit
   */
  async processDeposit(req, res) {
    try {
      const { userId } = req.params;
      const { userType, amount, notes, referenceId, method_type } = req.body;
      const { admin } = req;

      // Validate required fields
      if (!userType || !amount) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: userType, amount'
        });
      }

      // Validate userType
      if (!['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userType)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid userType. Must be "live", "demo", "strategy_provider", or "copy_follower"'
        });
      }

      // Validate amount
      const depositAmount = parseFloat(amount);
      if (isNaN(depositAmount) || depositAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Amount must be a positive number'
        });
      }

      logger.info(`Deposit request received: ${userType} user ${userId}, amount: ${depositAmount}, admin: ${admin.id}`);

      // Process deposit
      const result = await superadminTransactionService.processDeposit({
        userId: parseInt(userId),
        userType,
        amount: depositAmount,
        adminId: admin.id,
        notes,
        referenceId,
        methodType: method_type || 'OTHER' // Default to 'OTHER' if not provided
      });

      // Create audit log
      await createAuditLog(
        admin.id,
        'USER_DEPOSIT',
        req.ip,
        {
          user_id: userId,
          user_type: userType,
          amount: depositAmount,
          transaction_id: result.transaction.transaction_id,
          balance_before: result.user.balance_before,
          balance_after: result.user.balance_after
        },
        'SUCCESS'
      );

      res.status(200).json({
        success: true,
        message: 'Deposit processed successfully',
        data: {
          transaction: {
            id: result.transaction.id,
            transaction_id: result.transaction.transaction_id,
            type: result.transaction.type,
            amount: result.transaction.amount,
            status: result.transaction.status,
            created_at: result.transaction.created_at
          },
          user: result.user
        }
      });

    } catch (error) {
      logger.error(`Deposit failed for user ${req.params.userId}:`, error);

      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'USER_DEPOSIT',
        req.ip,
        {
          user_id: req.params.userId,
          user_type: req.body.userType,
          amount: req.body.amount
        },
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  /**
   * Process withdrawal for a user
   * POST /api/superadmin/users/:userId/withdraw
   */
  async processWithdrawal(req, res) {
    try {
      const { userId } = req.params;
      const { userType, amount, notes, referenceId, method_type } = req.body;
      const { admin } = req;

      // Validate required fields
      if (!userType || !amount) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: userType, amount'
        });
      }

      // Validate userType
      if (!['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userType)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid userType. Must be "live", "demo", "strategy_provider", or "copy_follower"'
        });
      }

      // Validate amount
      const withdrawalAmount = parseFloat(amount);
      if (isNaN(withdrawalAmount) || withdrawalAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Amount must be a positive number'
        });
      }

      logger.info(`Withdrawal request received: ${userType} user ${userId}, amount: ${withdrawalAmount}, admin: ${admin.id}`);

      // Process withdrawal
      const result = await superadminTransactionService.processWithdrawal({
        userId: parseInt(userId),
        userType,
        amount: withdrawalAmount,
        adminId: admin.id,
        notes,
        referenceId,
        methodType: method_type || 'OTHER' // Default to 'OTHER' if not provided
      });

      // Create audit log
      await createAuditLog(
        admin.id,
        'USER_WITHDRAWAL',
        req.ip,
        {
          user_id: userId,
          user_type: userType,
          amount: withdrawalAmount,
          transaction_id: result.transaction.transaction_id,
          balance_before: result.user.balance_before,
          balance_after: result.user.balance_after
        },
        'SUCCESS'
      );

      res.status(200).json({
        success: true,
        message: 'Withdrawal processed successfully',
        data: {
          transaction: {
            id: result.transaction.id,
            transaction_id: result.transaction.transaction_id,
            type: result.transaction.type,
            amount: result.transaction.amount,
            status: result.transaction.status,
            created_at: result.transaction.created_at
          },
          user: result.user
        }
      });

    } catch (error) {
      logger.error(`Withdrawal failed for user ${req.params.userId}:`, error);

      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'USER_WITHDRAWAL',
        req.ip,
        {
          user_id: req.params.userId,
          user_type: req.body.userType,
          amount: req.body.amount
        },
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  /**
   * Get user balance
   * GET /api/superadmin/users/:userId/balance?userType=live|demo (userType is optional)
   */
  async getUserBalance(req, res) {
    try {
      const { userId } = req.params;
      const { userType } = req.query;

      // Validate userType if provided
      if (userType && !['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userType)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid userType. Must be "live", "demo", "strategy_provider", or "copy_follower"'
        });
      }

      const result = await superadminTransactionService.getUserBalance(
        parseInt(userId),
        userType
      );

      res.status(200).json({
        success: true,
        message: 'User balance retrieved successfully',
        data: {
          balance: result.balance,
          source: result.source,
          userType: result.userType,
          user: result.user
        }
      });

    } catch (error) {
      logger.error(`Failed to get balance for user ${req.params.userId}:`, error);

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  /**
   * Get user transaction history
   * GET /api/superadmin/users/:userId/transactions?userType=live|demo&limit=50&offset=0&type=deposit (userType is optional)
   */
  async getUserTransactionHistory(req, res) {
    try {
      const { userId } = req.params;
      const { userType, limit = 50, offset = 0, type } = req.query;

      // Validate userType if provided
      if (userType && !['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userType)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid userType. Must be "live", "demo", "strategy_provider", or "copy_follower"'
        });
      }

      // Validate pagination parameters
      const limitNum = parseInt(limit);
      const offsetNum = parseInt(offset);

      if (isNaN(limitNum) || limitNum <= 0 || limitNum > 100) {
        return res.status(400).json({
          success: false,
          message: 'Limit must be a positive number between 1 and 100'
        });
      }

      if (isNaN(offsetNum) || offsetNum < 0) {
        return res.status(400).json({
          success: false,
          message: 'Offset must be a non-negative number'
        });
      }

      const result = await superadminTransactionService.getUserTransactionHistory({
        userId: parseInt(userId),
        userType,
        limit: limitNum,
        offset: offsetNum,
        type
      });

      // Enhanced pagination response
      const totalPages = Math.ceil(result.total / limitNum);
      const currentPage = Math.floor(offsetNum / limitNum) + 1;

      res.status(200).json({
        success: true,
        message: 'Transaction history retrieved successfully',
        data: {
          transactions: result.transactions,
          pagination: {
            total: result.total,
            limit: limitNum,
            offset: offsetNum,
            currentPage,
            totalPages,
            hasNextPage: currentPage < totalPages,
            hasPreviousPage: currentPage > 1,
            nextOffset: currentPage < totalPages ? offsetNum + limitNum : null,
            previousOffset: currentPage > 1 ? Math.max(0, offsetNum - limitNum) : null
          }
        }
      });

    } catch (error) {
      logger.error(`Failed to get transaction history for user ${req.params.userId}:`, error);

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  /**
   * Get transaction statistics for dashboard
   * GET /api/superadmin/transactions/stats?userType=live|demo&days=30
   */
  async getTransactionStats(req, res) {
    try {
      const { userType, days = 30 } = req.query;

      // Validate userType if provided
      if (userType && !['live', 'demo', 'strategy_provider', 'copy_follower'].includes(userType)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid userType. Must be "live", "demo", "strategy_provider", or "copy_follower"'
        });
      }

      const daysNum = parseInt(days);
      if (isNaN(daysNum) || daysNum <= 0 || daysNum > 365) {
        return res.status(400).json({
          success: false,
          message: 'Days must be a positive number between 1 and 365'
        });
      }

      // Calculate date range
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNum);

      // Build where clause
      const whereClause = {
        created_at: {
          [sequelize.Sequelize.Op.between]: [startDate, endDate]
        },
        status: 'completed'
      };

      if (userType) {
        whereClause.user_type = userType;
      }

      // Get transaction statistics
      const stats = await UserTransaction.findAll({
        where: whereClause,
        attributes: [
          'user_type',
          'type',
          [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
          [sequelize.fn('SUM', sequelize.col('amount')), 'total_amount']
        ],
        group: ['user_type', 'type'],
        raw: true
      });

      res.status(200).json({
        success: true,
        message: 'Transaction statistics retrieved successfully',
        data: {
          period: {
            start_date: startDate.toISOString(),
            end_date: endDate.toISOString(),
            days: daysNum
          },
          statistics: stats
        }
      });

    } catch (error) {
      logger.error('Failed to get transaction statistics:', error);

      res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  }
}

module.exports = new SuperadminTransactionController();
