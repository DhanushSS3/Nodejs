const InternalTransferService = require('../services/internalTransfer.service');
const logger = require('../services/logger.service');

/**
 * Internal Transfer Controller
 * Handles API endpoints for internal transfers between user accounts
 */
class InternalTransferController {

  /**
   * Get all user accounts with balances
   * GET /api/internal-transfers/accounts
   */
  static async getUserAccounts(req, res) {
    try {
      const user = req.user || {};
      const userId = user.sub || user.user_id || user.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      logger.info('Getting user accounts for internal transfer', { userId });

      const accounts = await InternalTransferService.getUserAccounts(userId);

      return res.json({
        success: true,
        data: accounts
      });

    } catch (error) {
      logger.error('Failed to get user accounts', {
        userId: req.user?.id,
        error: error.message
      });

      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve accounts',
        error: error.message
      });
    }
  }

  /**
   * Validate transfer request
   * POST /api/internal-transfers/validate
   */
  static async validateTransfer(req, res) {
    try {
      const user = req.user || {};
      const userId = user.sub || user.user_id || user.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const { fromAccountType, fromAccountId, toAccountType, toAccountId, amount } = req.body;

      // Validate required fields
      if (!fromAccountType || !toAccountType || !amount) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: fromAccountType, toAccountType, amount'
        });
      }

      // Validate account IDs for non-main accounts
      if (fromAccountType !== 'main' && !fromAccountId) {
        return res.status(400).json({
          success: false,
          message: 'fromAccountId is required for non-main accounts'
        });
      }

      if (toAccountType !== 'main' && !toAccountId) {
        return res.status(400).json({
          success: false,
          message: 'toAccountId is required for non-main accounts'
        });
      }

      // For main account, use userId as accountId
      const transferData = {
        fromAccountType,
        fromAccountId: fromAccountType === 'main' ? userId : fromAccountId,
        toAccountType,
        toAccountId: toAccountType === 'main' ? userId : toAccountId,
        amount: parseFloat(amount)
      };

      logger.info('Validating internal transfer', { userId, transferData });

      const validation = await InternalTransferService.validateTransfer(userId, transferData);

      if (!validation.valid) {
        return res.status(400).json({
          success: false,
          message: validation.error,
          details: {
            availableBalance: validation.availableBalance,
            openOrdersCount: validation.openOrdersCount,
            totalMarginRequired: validation.totalMarginRequired
          }
        });
      }

      return res.json({
        success: true,
        message: 'Transfer validation successful',
        data: {
          sourceAccount: {
            type: validation.sourceAccount.type,
            name: validation.sourceAccount.name,
            currentBalance: validation.sourceAccount.wallet_balance,
            balanceAfterTransfer: validation.sourceAccount.wallet_balance - transferData.amount
          },
          destinationAccount: {
            type: validation.destinationAccount.type,
            name: validation.destinationAccount.name,
            currentBalance: validation.destinationAccount.wallet_balance,
            balanceAfterTransfer: validation.destinationAccount.wallet_balance + transferData.amount
          },
          transferAmount: transferData.amount,
          availableBalance: validation.availableBalance
        }
      });

    } catch (error) {
      logger.error('Transfer validation failed', {
        userId: req.user?.id,
        body: req.body,
        error: error.message
      });

      return res.status(500).json({
        success: false,
        message: 'Transfer validation failed',
        error: error.message
      });
    }
  }

  /**
   * Execute internal transfer
   * POST /api/internal-transfers/execute
   */
  static async executeTransfer(req, res) {
    try {
      const user = req.user || {};
      const userId = user.sub || user.user_id || user.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const { fromAccountType, fromAccountId, toAccountType, toAccountId, amount, notes } = req.body;

      // Validate required fields
      if (!fromAccountType || !toAccountType || !amount) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields: fromAccountType, toAccountType, amount'
        });
      }

      // Validate account IDs for non-main accounts
      if (fromAccountType !== 'main' && !fromAccountId) {
        return res.status(400).json({
          success: false,
          message: 'fromAccountId is required for non-main accounts'
        });
      }

      if (toAccountType !== 'main' && !toAccountId) {
        return res.status(400).json({
          success: false,
          message: 'toAccountId is required for non-main accounts'
        });
      }

      // Validate amount
      const transferAmount = parseFloat(amount);
      if (isNaN(transferAmount) || transferAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid transfer amount'
        });
      }

      // For main account, use userId as accountId
      const transferData = {
        fromAccountType,
        fromAccountId: fromAccountType === 'main' ? userId : fromAccountId,
        toAccountType,
        toAccountId: toAccountType === 'main' ? userId : toAccountId,
        amount: transferAmount,
        notes: notes || ''
      };

      logger.info('Executing internal transfer', { userId, transferData });

      const result = await InternalTransferService.executeTransfer(userId, transferData);

      if (!result.success) {
        return res.status(400).json({
          success: false,
          message: result.error
        });
      }

      return res.json({
        success: true,
        message: 'Transfer completed successfully',
        data: {
          transactionId: result.transactionId,
          amount: result.amount,
          sourceAccount: result.sourceAccount,
          destinationAccount: result.destinationAccount
        }
      });

    } catch (error) {
      logger.error('Transfer execution failed', {
        userId: req.user?.id,
        body: req.body,
        error: error.message,
        stack: error.stack
      });

      return res.status(500).json({
        success: false,
        message: 'Transfer execution failed',
        error: error.message
      });
    }
  }

  /**
   * Get transfer history
   * GET /api/internal-transfers/history
   */
  static async getTransferHistory(req, res) {
    try {
      const user = req.user || {};
      const userId = user.sub || user.user_id || user.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const { page = 1, limit = 20, accountType, accountId } = req.query;

      logger.info('Getting transfer history', { userId, page, limit, accountType, accountId });

      const history = await InternalTransferService.getTransferHistory(userId, {
        page: parseInt(page),
        limit: parseInt(limit),
        accountType,
        accountId: accountId ? parseInt(accountId) : null
      });

      return res.json({
        success: true,
        data: history
      });

    } catch (error) {
      logger.error('Failed to get transfer history', {
        userId: req.user?.id,
        query: req.query,
        error: error.message
      });

      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve transfer history',
        error: error.message
      });
    }
  }

  /**
   * Get account balance and margin info
   * GET /api/internal-transfers/account/:accountType/:accountId/balance
   */
  static async getAccountBalance(req, res) {
    try {
      const user = req.user || {};
      const userId = user.sub || user.user_id || user.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const { accountType, accountId } = req.params;

      // For main account, use userId as accountId
      const actualAccountId = accountType === 'main' ? userId : parseInt(accountId);

      logger.info('Getting account balance', { userId, accountType, accountId: actualAccountId });

      const accountDetails = await InternalTransferService.getAccountDetails(userId, accountType, actualAccountId);

      if (!accountDetails) {
        return res.status(404).json({
          success: false,
          message: 'Account not found or not accessible'
        });
      }

      // Check margin requirements
      const marginCheck = await InternalTransferService.checkMarginRequirements(userId, accountType, actualAccountId, 0);

      return res.json({
        success: true,
        data: {
          ...accountDetails,
          availableBalance: accountDetails.wallet_balance - accountDetails.margin,
          marginInfo: {
            openOrdersCount: marginCheck.openOrdersCount || 0,
            totalMarginRequired: marginCheck.totalMarginRequired || 0
          }
        }
      });

    } catch (error) {
      logger.error('Failed to get account balance', {
        userId: req.user?.id,
        params: req.params,
        error: error.message
      });

      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve account balance',
        error: error.message
      });
    }
  }
}

module.exports = InternalTransferController;
