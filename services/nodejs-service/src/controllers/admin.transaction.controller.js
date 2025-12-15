const adminTransactionService = require('../services/admin.transaction.service');
const logger = require('../utils/logger');

const VALID_METHODS = ['BANK', 'UPI', 'SWIFT', 'IBAN', 'PAYPAL', 'CRYPTO', 'OTHER'];
const VALID_TRANSACTION_TYPES = [
  'deposit',
  'withdraw',
  'transfer',
  'profit',
  'loss',
  'commission',
  'swap',
  'adjustment',
  'performance_fee',
  'performance_fee_earned'
];
const VALID_TRANSACTION_STATUSES = ['completed', 'pending', 'failed', 'cancelled'];

class AdminTransactionController {
  /**
   * Get filtered deposit transactions with pagination and total sum
   * GET /api/admin/transactions/deposits
   */
  async getDeposits(req, res) {
    try {
      const { email, method_type, start_date, end_date, page, limit } = req.query;
      const { admin } = req;

      // Validate pagination parameters
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || 20;

      if (pageNum < 1) {
        return res.status(400).json({
          success: false,
          message: 'Page number must be greater than 0'
        });
      }

      if (limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
          success: false,
          message: 'Limit must be between 1 and 100'
        });
      }

      // Validate method_type if provided
      if (method_type) {
        if (!VALID_METHODS.includes(method_type.toUpperCase())) {
          return res.status(400).json({
            success: false,
            message: `Invalid method_type. Must be one of: ${VALID_METHODS.join(', ')}`
          });
        }
      }

      logger.info(`Deposit transactions request from admin ${admin.id}`, {
        email, method_type, start_date, end_date, page: pageNum, limit: limitNum
      });

      const result = await adminTransactionService.getFilteredTransactions({
        type: 'deposit',
        email,
        method_type: method_type?.toUpperCase(),
        start_date,
        end_date,
        page: pageNum,
        limit: limitNum,
        admin
      });

      res.status(200).json({
        success: true,
        message: 'Deposit transactions retrieved successfully',
        data: result
      });

    } catch (error) {
      logger.error(`Error fetching deposit transactions for admin ${req.admin?.id}:`, error);

      res.status(500).json({
        success: false,
        message: 'Failed to retrieve deposit transactions',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * Get filtered withdrawal transactions with pagination and total sum
   * GET /api/admin/transactions/withdrawals
   */
  async getWithdrawals(req, res) {
    try {
      const { email, method_type, start_date, end_date, page, limit } = req.query;
      const { admin } = req;

      // Validate pagination parameters
      const pageNum = parseInt(page) || 1;
      const limitNum = parseInt(limit) || 20;

      if (pageNum < 1) {
        return res.status(400).json({
          success: false,
          message: 'Page number must be greater than 0'
        });
      }

      if (limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
          success: false,
          message: 'Limit must be between 1 and 100'
        });
      }

      // Validate method_type if provided
      if (method_type) {
        const validMethods = ['BANK', 'UPI', 'SWIFT', 'IBAN', 'PAYPAL', 'CRYPTO', 'OTHER'];
        if (!validMethods.includes(method_type.toUpperCase())) {
          return res.status(400).json({
            success: false,
            message: `Invalid method_type. Must be one of: ${validMethods.join(', ')}`
          });
        }
      }

      logger.info(`Withdrawal transactions request from admin ${admin.id}`, {
        email, method_type, start_date, end_date, page: pageNum, limit: limitNum
      });

      const result = await adminTransactionService.getFilteredTransactions({
        type: 'withdraw',
        email,
        method_type: method_type?.toUpperCase(),
        start_date,
        end_date,
        page: pageNum,
        limit: limitNum,
        admin
      });

      res.status(200).json({
        success: true,
        message: 'Withdrawal transactions retrieved successfully',
        data: result
      });

    } catch (error) {
      logger.error(`Error fetching withdrawal transactions for admin ${req.admin?.id}:`, error);

      res.status(500).json({
        success: false,
        message: 'Failed to retrieve withdrawal transactions',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * Get transaction statistics summary
   * GET /api/admin/transactions/stats
   */
  async getTransactionStats(req, res) {
    try {
      const { admin } = req;

      logger.info(`Transaction statistics request from admin ${admin.id}`);

      const stats = await adminTransactionService.getTransactionStats({ admin });

      res.status(200).json({
        success: true,
        message: 'Transaction statistics retrieved successfully',
        data: stats
      });

    } catch (error) {
      logger.error(`Error fetching transaction statistics for admin ${req.admin?.id}:`, error);

      res.status(500).json({
        success: false,
        message: 'Failed to retrieve transaction statistics',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }

  /**
   * Get available method types for filtering
   * GET /api/admin/transactions/method-types
   */
  async getMethodTypes(req, res) {
    try {
      res.status(200).json({
        success: true,
        message: 'Method types retrieved successfully',
        data: {
          method_types: VALID_METHODS
        }
      });

    } catch (error) {
      logger.error(`Error fetching method types for admin ${req.admin?.id}:`, error);

      res.status(500).json({
        success: false,
        message: 'Failed to retrieve method types'
      });
    }
  }

  /**
   * Get wallet transactions for a specific strategy provider account
   * GET /api/admin/transactions/strategy-providers/:accountId/wallet-transactions
   */
  async getStrategyProviderWalletTransactions(req, res) {
    return this._handleAccountWalletTransactions(req, res, 'strategy_provider');
  }

  /**
   * Get wallet transactions for a specific copy follower account
   * GET /api/admin/transactions/copy-followers/:accountId/wallet-transactions
   */
  async getCopyFollowerWalletTransactions(req, res) {
    return this._handleAccountWalletTransactions(req, res, 'copy_follower');
  }

  async _handleAccountWalletTransactions(req, res, accountType) {
    try {
      const { accountId } = req.params;
      const { page = 1, limit = 20, type = null, status = 'completed', start_date = null, end_date = null } = req.query;
      const { admin } = req;

      if (!accountId || isNaN(parseInt(accountId))) {
        return res.status(400).json({
          success: false,
          message: 'accountId must be a valid number'
        });
      }

      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);

      if (isNaN(pageNum) || pageNum < 1) {
        return res.status(400).json({
          success: false,
          message: 'Page number must be a positive integer'
        });
      }

      if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
        return res.status(400).json({
          success: false,
          message: 'Limit must be between 1 and 100'
        });
      }

      if (type && !VALID_TRANSACTION_TYPES.includes(type)) {
        return res.status(400).json({
          success: false,
          message: `Invalid transaction type. Allowed types: ${VALID_TRANSACTION_TYPES.join(', ')}`
        });
      }

      if (status && !VALID_TRANSACTION_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Allowed statuses: ${VALID_TRANSACTION_STATUSES.join(', ')}`
        });
      }

      const result = await adminTransactionService.getAccountTransactions({
        accountId: parseInt(accountId),
        accountType,
        page: pageNum,
        limit: limitNum,
        type,
        status,
        start_date,
        end_date,
        admin
      });

      const subject =
        accountType === 'strategy_provider'
          ? 'Strategy provider'
          : 'Copy follower';

      res.status(200).json({
        success: true,
        message: `${subject} wallet transactions retrieved successfully`,
        data: result
      });
    } catch (error) {
      logger.error(
        `Error fetching ${accountType} wallet transactions for account ${req.params.accountId}:`,
        error
      );

      res.status(500).json({
        success: false,
        message: 'Failed to retrieve wallet transactions',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  }
}

module.exports = new AdminTransactionController();
