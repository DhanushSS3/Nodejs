const sequelize = require('../config/db');
const LiveUser = require('../models/liveUser.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const UserTransaction = require('../models/userTransaction.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
const logger = require('./logger.service');

/**
 * Internal Transfer Service
 * Handles transfers between different wallet accounts for the same user
 */
class InternalTransferService {

  /**
   * Get all accounts for a user with their balances and margin info
   * @param {number} userId - Live user ID
   * @returns {Object} User accounts with balances
   */
  static async getUserAccounts(userId) {
    try {
      // Get main live user account
      const liveUser = await LiveUser.findByPk(userId, {
        attributes: ['id', 'name', 'email', 'wallet_balance', 'margin', 'net_profit', 'account_number']
      });

      if (!liveUser) {
        throw new Error('User not found');
      }

      // Get strategy provider accounts
      const strategyProviderAccounts = await StrategyProviderAccount.findAll({
        where: { user_id: userId, status: 1, is_active: 1 },
        attributes: ['id', 'strategy_name', 'wallet_balance', 'margin', 'net_profit', 'account_number']
      });

      // Get copy follower accounts
      const copyFollowerAccounts = await CopyFollowerAccount.findAll({
        where: { user_id: userId, status: 1, is_active: 1 },
        attributes: ['id', 'account_name', 'wallet_balance', 'margin', 'net_profit', 'account_number', 'strategy_provider_id']
      });

      // Get strategy provider names for copy follower accounts
      const strategyProviderIds = copyFollowerAccounts.map(acc => acc.strategy_provider_id);
      const strategyProviders = await StrategyProviderAccount.findAll({
        where: { id: strategyProviderIds },
        attributes: ['id', 'strategy_name']
      });
      
      const strategyProviderMap = {};
      strategyProviders.forEach(sp => {
        strategyProviderMap[sp.id] = sp.strategy_name;
      });

      return {
        mainAccount: {
          type: 'main',
          id: liveUser.id,
          name: 'Main Trading Account',
          account_number: liveUser.account_number,
          wallet_balance: parseFloat(liveUser.wallet_balance || 0),
          margin: parseFloat(liveUser.margin || 0),
          net_profit: parseFloat(liveUser.net_profit || 0),
          available_balance: parseFloat(liveUser.wallet_balance || 0) - parseFloat(liveUser.margin || 0)
        },
        strategyProviderAccounts: strategyProviderAccounts.map(account => ({
          type: 'strategy_provider',
          id: account.id,
          name: account.strategy_name,
          account_number: account.account_number,
          wallet_balance: parseFloat(account.wallet_balance || 0),
          margin: parseFloat(account.margin || 0),
          net_profit: parseFloat(account.net_profit || 0),
          available_balance: parseFloat(account.wallet_balance || 0) - parseFloat(account.margin || 0)
        })),
        copyFollowerAccounts: copyFollowerAccounts.map(account => ({
          type: 'copy_follower',
          id: account.id,
          name: account.account_name,
          account_number: account.account_number,
          wallet_balance: parseFloat(account.wallet_balance || 0),
          margin: parseFloat(account.margin || 0),
          net_profit: parseFloat(account.net_profit || 0),
          available_balance: parseFloat(account.wallet_balance || 0) - parseFloat(account.margin || 0),
          following_strategy: strategyProviderMap[account.strategy_provider_id] || 'Unknown Strategy'
        }))
      };
    } catch (error) {
      logger.error('Failed to get user accounts', {
        userId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Validate transfer request
   * @param {number} userId - Live user ID
   * @param {Object} transferData - Transfer details
   * @returns {Object} Validation result
   */
  static async validateTransfer(userId, transferData) {
    const { fromAccountType, fromAccountId, toAccountType, toAccountId, amount } = transferData;

    try {
      // Basic validation
      if (amount <= 0) {
        return { valid: false, error: 'Transfer amount must be greater than 0' };
      }

      if (fromAccountType === toAccountType && fromAccountId === toAccountId) {
        return { valid: false, error: 'Cannot transfer to the same account' };
      }

      // Get source account details
      const sourceAccount = await this.getAccountDetails(userId, fromAccountType, fromAccountId);
      if (!sourceAccount) {
        return { valid: false, error: 'Source account not found or not accessible' };
      }

      // Get destination account details
      const destinationAccount = await this.getAccountDetails(userId, toAccountType, toAccountId);
      if (!destinationAccount) {
        return { valid: false, error: 'Destination account not found or not accessible' };
      }

      // Check if source account has sufficient available balance
      const availableBalance = sourceAccount.wallet_balance - sourceAccount.margin;
      if (amount > availableBalance) {
        return { 
          valid: false, 
          error: `Insufficient available balance. Available: $${availableBalance.toFixed(2)}, Required: $${amount.toFixed(2)}`,
          availableBalance: availableBalance
        };
      }

      // Check if transfer would affect margin requirements for open orders
      const marginCheck = await this.checkMarginRequirements(userId, fromAccountType, fromAccountId, amount);
      if (!marginCheck.valid) {
        return marginCheck;
      }

      return {
        valid: true,
        sourceAccount,
        destinationAccount,
        availableBalance
      };
    } catch (error) {
      logger.error('Transfer validation failed', {
        userId,
        transferData,
        error: error.message
      });
      return { valid: false, error: 'Transfer validation failed: ' + error.message };
    }
  }

  /**
   * Get account details by type and ID
   * @param {number} userId - Live user ID
   * @param {string} accountType - Account type (main, strategy_provider, copy_follower)
   * @param {number} accountId - Account ID
   * @returns {Object} Account details
   */
  static async getAccountDetails(userId, accountType, accountId) {
    try {
      switch (accountType) {
        case 'main':
          const liveUser = await LiveUser.findOne({
            where: { id: userId },
            attributes: ['id', 'wallet_balance', 'margin', 'net_profit', 'account_number', 'name']
          });
          return liveUser ? {
            id: liveUser.id,
            type: 'main',
            wallet_balance: parseFloat(liveUser.wallet_balance || 0),
            margin: parseFloat(liveUser.margin || 0),
            net_profit: parseFloat(liveUser.net_profit || 0),
            account_number: liveUser.account_number,
            name: 'Main Trading Account'
          } : null;

        case 'strategy_provider':
          const strategyProvider = await StrategyProviderAccount.findOne({
            where: { id: accountId, user_id: userId, status: 1, is_active: 1 },
            attributes: ['id', 'wallet_balance', 'margin', 'net_profit', 'account_number', 'strategy_name']
          });
          return strategyProvider ? {
            id: strategyProvider.id,
            type: 'strategy_provider',
            wallet_balance: parseFloat(strategyProvider.wallet_balance || 0),
            margin: parseFloat(strategyProvider.margin || 0),
            net_profit: parseFloat(strategyProvider.net_profit || 0),
            account_number: strategyProvider.account_number,
            name: strategyProvider.strategy_name
          } : null;

        case 'copy_follower':
          const copyFollower = await CopyFollowerAccount.findOne({
            where: { id: accountId, user_id: userId, status: 1, is_active: 1 },
            attributes: ['id', 'wallet_balance', 'margin', 'net_profit', 'account_number', 'account_name']
          });
          return copyFollower ? {
            id: copyFollower.id,
            type: 'copy_follower',
            wallet_balance: parseFloat(copyFollower.wallet_balance || 0),
            margin: parseFloat(copyFollower.margin || 0),
            net_profit: parseFloat(copyFollower.net_profit || 0),
            account_number: copyFollower.account_number,
            name: copyFollower.account_name
          } : null;

        default:
          return null;
      }
    } catch (error) {
      logger.error('Failed to get account details', {
        userId,
        accountType,
        accountId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Check margin requirements for open orders
   * @param {number} userId - Live user ID
   * @param {string} accountType - Account type
   * @param {number} accountId - Account ID
   * @param {number} transferAmount - Amount to transfer
   * @returns {Object} Margin check result
   */
  static async checkMarginRequirements(userId, accountType, accountId, transferAmount) {
    try {
      let openOrdersCount = 0;
      let totalMarginRequired = 0;

      switch (accountType) {
        case 'main':
          const liveUserOrders = await LiveUserOrder.findAll({
            where: { 
              user_id: userId, 
              order_status: ['OPEN', 'PENDING', 'PARTIALLY_FILLED'] 
            },
            attributes: ['margin', 'order_status']
          });
          openOrdersCount = liveUserOrders.length;
          totalMarginRequired = liveUserOrders.reduce((sum, order) => 
            sum + parseFloat(order.margin || 0), 0
          );
          break;

        case 'strategy_provider':
          const strategyProviderOrders = await StrategyProviderOrder.findAll({
            where: { 
              order_user_id: accountId, 
              order_status: ['OPEN', 'PENDING', 'PARTIALLY_FILLED'] 
            },
            attributes: ['margin', 'order_status']
          });
          openOrdersCount = strategyProviderOrders.length;
          totalMarginRequired = strategyProviderOrders.reduce((sum, order) => 
            sum + parseFloat(order.margin || 0), 0
          );
          break;

        case 'copy_follower':
          const copyFollowerOrders = await CopyFollowerOrder.findAll({
            where: { 
              copy_follower_account_id: accountId, 
              order_status: ['OPEN', 'PENDING', 'PARTIALLY_FILLED'] 
            },
            attributes: ['margin', 'order_status']
          });
          openOrdersCount = copyFollowerOrders.length;
          totalMarginRequired = copyFollowerOrders.reduce((sum, order) => 
            sum + parseFloat(order.margin || 0), 0
          );
          break;
      }

      // Get current account balance
      const account = await this.getAccountDetails(userId, accountType, accountId);
      if (!account) {
        return { valid: false, error: 'Account not found for margin check' };
      }

      // Calculate balance after transfer
      const balanceAfterTransfer = account.wallet_balance - transferAmount;

      // Check if remaining balance can cover margin requirements
      if (balanceAfterTransfer < totalMarginRequired) {
        return {
          valid: false,
          error: `Transfer would violate margin requirements. You have ${openOrdersCount} open order(s) requiring $${totalMarginRequired.toFixed(2)} margin. Balance after transfer would be $${balanceAfterTransfer.toFixed(2)}.`,
          openOrdersCount,
          totalMarginRequired,
          balanceAfterTransfer
        };
      }

      return {
        valid: true,
        openOrdersCount,
        totalMarginRequired,
        balanceAfterTransfer
      };
    } catch (error) {
      logger.error('Margin requirements check failed', {
        userId,
        accountType,
        accountId,
        transferAmount,
        error: error.message
      });
      return { valid: false, error: 'Failed to check margin requirements: ' + error.message };
    }
  }

  /**
   * Execute internal transfer
   * @param {number} userId - Live user ID
   * @param {Object} transferData - Transfer details
   * @returns {Object} Transfer result
   */
  static async executeTransfer(userId, transferData) {
    const { fromAccountType, fromAccountId, toAccountType, toAccountId, amount, notes } = transferData;
    
    const transaction = await sequelize.transaction();
    
    try {
      // Validate transfer
      const validation = await this.validateTransfer(userId, transferData);
      if (!validation.valid) {
        await transaction.rollback();
        return { success: false, error: validation.error };
      }

      const { sourceAccount, destinationAccount } = validation;

      // Generate unique transaction ID
      const transactionId = `TXN${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

      // Update source account balance
      await this.updateAccountBalance(
        sourceAccount.type, 
        sourceAccount.id, 
        -amount, 
        transaction
      );

      // Update destination account balance
      await this.updateAccountBalance(
        destinationAccount.type, 
        destinationAccount.id, 
        amount, 
        transaction
      );

      // Create transaction records
      const sourceTransactionData = {
        transaction_id: `${transactionId}_OUT`,
        user_id: userId,
        user_type: this.mapAccountTypeToUserType(sourceAccount.type),
        type: 'transfer',
        amount: -amount,
        balance_before: sourceAccount.wallet_balance,
        balance_after: sourceAccount.wallet_balance - amount,
        status: 'completed',
        notes: notes || `Transfer to ${destinationAccount.name}`,
        metadata: {
          transfer_type: 'internal_transfer_out',
          from_account: {
            type: sourceAccount.type,
            id: sourceAccount.id,
            name: sourceAccount.name,
            account_number: sourceAccount.account_number
          },
          to_account: {
            type: destinationAccount.type,
            id: destinationAccount.id,
            name: destinationAccount.name,
            account_number: destinationAccount.account_number
          },
          related_transaction_id: `${transactionId}_IN`
        }
      };

      const destinationTransactionData = {
        transaction_id: `${transactionId}_IN`,
        user_id: userId,
        user_type: this.mapAccountTypeToUserType(destinationAccount.type),
        type: 'transfer',
        amount: amount,
        balance_before: destinationAccount.wallet_balance,
        balance_after: destinationAccount.wallet_balance + amount,
        status: 'completed',
        notes: notes || `Transfer from ${sourceAccount.name}`,
        metadata: {
          transfer_type: 'internal_transfer_in',
          from_account: {
            type: sourceAccount.type,
            id: sourceAccount.id,
            name: sourceAccount.name,
            account_number: sourceAccount.account_number
          },
          to_account: {
            type: destinationAccount.type,
            id: destinationAccount.id,
            name: destinationAccount.name,
            account_number: destinationAccount.account_number
          },
          related_transaction_id: `${transactionId}_OUT`
        }
      };

      // Create transaction records
      await UserTransaction.create(sourceTransactionData, { transaction });
      await UserTransaction.create(destinationTransactionData, { transaction });

      await transaction.commit();

      logger.info('Internal transfer completed successfully', {
        userId,
        transactionId,
        amount,
        fromAccount: `${sourceAccount.type}:${sourceAccount.id}`,
        toAccount: `${destinationAccount.type}:${destinationAccount.id}`
      });

      return {
        success: true,
        transactionId,
        amount,
        sourceAccount: {
          type: sourceAccount.type,
          id: sourceAccount.id,
          name: sourceAccount.name,
          balanceAfter: sourceAccount.wallet_balance - amount
        },
        destinationAccount: {
          type: destinationAccount.type,
          id: destinationAccount.id,
          name: destinationAccount.name,
          balanceAfter: destinationAccount.wallet_balance + amount
        }
      };

    } catch (error) {
      await transaction.rollback();
      logger.error('Internal transfer failed', {
        userId,
        transferData,
        error: error.message,
        stack: error.stack
      });
      return { success: false, error: 'Transfer failed: ' + error.message };
    }
  }

  /**
   * Update account balance
   * @param {string} accountType - Account type
   * @param {number} accountId - Account ID
   * @param {number} amount - Amount to add/subtract
   * @param {Object} transaction - Database transaction
   */
  static async updateAccountBalance(accountType, accountId, amount, transaction) {
    switch (accountType) {
      case 'main':
        await LiveUser.increment('wallet_balance', {
          by: amount,
          where: { id: accountId },
          transaction
        });
        break;

      case 'strategy_provider':
        await StrategyProviderAccount.increment('wallet_balance', {
          by: amount,
          where: { id: accountId },
          transaction
        });
        break;

      case 'copy_follower':
        await CopyFollowerAccount.increment('wallet_balance', {
          by: amount,
          where: { id: accountId },
          transaction
        });
        break;

      default:
        throw new Error(`Unknown account type: ${accountType}`);
    }
  }

  /**
   * Map account type to user type for transactions
   * @param {string} accountType - Account type
   * @returns {string} User type
   */
  static mapAccountTypeToUserType(accountType) {
    switch (accountType) {
      case 'main':
        return 'live';
      case 'strategy_provider':
        return 'strategy_provider';
      case 'copy_follower':
        return 'copy_follower';
      default:
        return 'live';
    }
  }

  /**
   * Get transfer history for a user
   * @param {number} userId - Live user ID
   * @param {Object} options - Query options
   * @returns {Array} Transfer history
   */
  static async getTransferHistory(userId, options = {}) {
    const { page = 1, limit = 20, accountType = null, accountId = null } = options;
    const offset = (page - 1) * limit;

    try {
      const whereClause = {
        user_id: userId,
        type: 'transfer'
      };

      if (accountType && accountId) {
        whereClause.user_type = this.mapAccountTypeToUserType(accountType);
      }

      const { count, rows } = await UserTransaction.findAndCountAll({
        where: whereClause,
        order: [['created_at', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset),
        attributes: [
          'id', 'transaction_id', 'amount', 'balance_before', 'balance_after',
          'status', 'notes', 'metadata', 'created_at'
        ]
      });

      return {
        transfers: rows.map(transfer => ({
          id: transfer.id,
          transaction_id: transfer.transaction_id,
          amount: parseFloat(transfer.amount),
          balance_before: parseFloat(transfer.balance_before),
          balance_after: parseFloat(transfer.balance_after),
          status: transfer.status,
          notes: transfer.notes,
          metadata: transfer.metadata,
          created_at: transfer.created_at,
          transfer_direction: transfer.amount > 0 ? 'incoming' : 'outgoing'
        })),
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          totalPages: Math.ceil(count / limit)
        }
      };
    } catch (error) {
      logger.error('Failed to get transfer history', {
        userId,
        options,
        error: error.message
      });
      throw error;
    }
  }
}

module.exports = InternalTransferService;
