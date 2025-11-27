const sequelize = require('../config/db');
const LiveUser = require('../models/liveUser.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const UserTransaction = require('../models/userTransaction.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
const logger = require('./logger.service');
const { redisCluster } = require('../../config/redis');
const CatalogEligibilityRealtimeService = require('./catalogEligibilityRealtime.service');

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

      // Get ALL copy follower accounts (active, inactive, closed)
      const copyFollowerAccounts = await CopyFollowerAccount.findAll({
        where: { user_id: userId },
        attributes: ['id', 'account_name', 'wallet_balance', 'margin', 'net_profit', 'account_number', 'strategy_provider_id', 'status', 'is_active', 'created_at', 'updated_at'],
        order: [
          ['status', 'DESC'],    // Active (1) before inactive (0)
          ['is_active', 'DESC'], // Active (1) before inactive (0)
          ['created_at', 'DESC'] // Newest first within same status
        ]
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
        mainAccount: liveUser ? {
          type: 'live',
          id: liveUser.id,
          name: 'Main Trading Account',
          account_number: liveUser.account_number,
          wallet_balance: parseFloat(liveUser.wallet_balance || 0),
          margin: parseFloat(liveUser.margin || 0),
          available_balance: parseFloat(liveUser.wallet_balance || 0) - parseFloat(liveUser.margin || 0),
          lifetime_profit_loss: parseFloat(liveUser.net_profit || 0)
        } : null,
        strategyProviderAccounts: strategyProviderAccounts.map(account => ({
          type: 'strategy_provider',
          id: account.id,
          name: account.strategy_name,
          account_number: account.account_number,
          wallet_balance: parseFloat(account.wallet_balance || 0),
          margin: parseFloat(account.margin || 0),
          available_balance: parseFloat(account.wallet_balance || 0) - parseFloat(account.margin || 0),
          lifetime_profit_loss: parseFloat(account.net_profit || 0)
        })),
        copyFollowerAccounts: copyFollowerAccounts.map(account => ({
          type: 'copy_follower',
          id: account.id,
          name: account.account_name,
          account_number: account.account_number,
          wallet_balance: parseFloat(account.wallet_balance || 0),
          margin: parseFloat(account.margin || 0),
          available_balance: parseFloat(account.wallet_balance || 0) - parseFloat(account.margin || 0),
          lifetime_profit_loss: parseFloat(account.net_profit || 0),
          following_strategy: strategyProviderMap[account.strategy_provider_id] || 'Unknown Strategy',
          status: account.status,
          is_active: account.is_active,
          account_status: this.getAccountStatusLabel(account.status, account.is_active),
          created_at: account.created_at,
          updated_at: account.updated_at
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
   * Get human-readable account status label
   * @param {number} status - Account status (0 = inactive, 1 = active)
   * @param {number} is_active - Account active flag (0 = inactive, 1 = active)
   * @returns {string} Status label
   */
  static getAccountStatusLabel(status, is_active) {
    if (status === 1 && is_active === 1) {
      return 'Active';
    } else if (status === 1 && is_active === 0) {
      return 'Inactive';
    } else if (status === 0) {
      return 'Closed';
    } else {
      return 'Unknown';
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
      // Skip validation for new copy follower account creation (toAccountId will be null)
      // since the account doesn't exist yet and will be created after validation passes
      let destinationAccount = null;
      if (!(toAccountType === 'copy_follower' && toAccountId === null)) {
        destinationAccount = await this.getAccountDetails(userId, toAccountType, toAccountId);
        if (!destinationAccount) {
          return { valid: false, error: 'Destination account not found or not accessible' };
        }
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
            where: { id: userId, status: 1, is_active: 1 },
            attributes: ['id', 'wallet_balance', 'margin', 'net_profit', 'account_number', 'leverage', 'group']
          });
          return liveUser ? {
            id: liveUser.id,
            type: 'main',
            wallet_balance: parseFloat(liveUser.wallet_balance || 0),
            margin: parseFloat(liveUser.margin || 0),
            net_profit: parseFloat(liveUser.net_profit || 0),
            account_number: liveUser.account_number,
            name: 'Main Trading Account',
            leverage: parseFloat(liveUser.leverage || 100),
            group: liveUser.group || 'Standard'
          } : null;

        case 'strategy_provider':
          const strategyProvider = await StrategyProviderAccount.findOne({
            where: { id: accountId, user_id: userId, status: 1, is_active: 1 },
            attributes: ['id', 'wallet_balance', 'margin', 'net_profit', 'account_number', 'strategy_name', 'leverage', 'group']
          });
          return strategyProvider ? {
            id: strategyProvider.id,
            type: 'strategy_provider',
            wallet_balance: parseFloat(strategyProvider.wallet_balance || 0),
            margin: parseFloat(strategyProvider.margin || 0),
            net_profit: parseFloat(strategyProvider.net_profit || 0),
            account_number: strategyProvider.account_number,
            name: strategyProvider.strategy_name,
            leverage: parseFloat(strategyProvider.leverage || 100),
            group: strategyProvider.group || 'Standard'
          } : null;

        case 'copy_follower':
          const copyFollower = await CopyFollowerAccount.findOne({
            where: { id: accountId, user_id: userId, status: 1, is_active: 1 },
            attributes: ['id', 'wallet_balance', 'margin', 'net_profit', 'account_number', 'account_name', 'leverage', 'group']
          });
          return copyFollower ? {
            id: copyFollower.id,
            type: 'copy_follower',
            wallet_balance: parseFloat(copyFollower.wallet_balance || 0),
            margin: parseFloat(copyFollower.margin || 0),
            net_profit: parseFloat(copyFollower.net_profit || 0),
            account_number: copyFollower.account_number,
            name: copyFollower.account_name,
            leverage: parseFloat(copyFollower.leverage || 100),
            group: copyFollower.group || 'Standard'
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
              order_user_id: userId, 
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

      // Get current account balance first (needed for both portfolio and basic validation)
      const account = await this.getAccountDetails(userId, accountType, accountId);
      if (!account) {
        return { valid: false, error: 'Account not found for margin check' };
      }

      // Calculate balance after transfer
      const balanceAfterTransfer = account.wallet_balance - transferAmount;

      // Fetch current portfolio data from Python portfolio calculator (Redis)
      const portfolioData = await this.getPortfolioFromRedis(accountType, accountId);
      
      if (!portfolioData) {
        logger.warn('Portfolio data not found in Redis, falling back to basic margin check only', {
          userId, accountType, accountId
        });
        // Continue with basic margin check only
      } else {
        // Use existing calculated equity and PnL from Python portfolio calculator
        const currentEquity = parseFloat(portfolioData.equity || 0);
        const currentOpenPnL = parseFloat(portfolioData.open_pnl || 0);
        const currentUsedMargin = parseFloat(portfolioData.used_margin || 0);
        
        // Calculate equity after transfer (current equity - transfer amount)
        const equityAfterTransfer = currentEquity - transferAmount;
        
        // Use the margin from portfolio data (more accurate than our calculation)
        const usedMargin = currentUsedMargin > 0 ? currentUsedMargin : totalMarginRequired;

        // Check margin level to prevent margin calls (equity/margin ratio should be > 100%)
        if (usedMargin > 0) {
          const marginLevel = (equityAfterTransfer / usedMargin) * 100;
          if (marginLevel < 100) {
            return {
              valid: false,
              error: `Transfer would result in margin call. Margin level after transfer: ${marginLevel.toFixed(2)}% (minimum required: 100%). Current equity: $${currentEquity.toFixed(2)}, Equity after transfer: $${equityAfterTransfer.toFixed(2)}, Used margin: $${usedMargin.toFixed(2)}.`,
              openOrdersCount,
              totalMarginRequired,
              balanceAfterTransfer,
              currentEquity,
              equityAfterTransfer,
              currentOpenPnL,
              usedMargin,
              marginLevel: marginLevel.toFixed(2) + '%'
            };
          }
        }
      }

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
        balanceAfterTransfer,
        portfolioData: portfolioData || null
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

      // Generate unique transaction IDs (separate for source and destination)
      const sourceTransactionId = `TXN${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
      const destinationTransactionId = `TXN${Date.now() + 1}${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

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
        transaction_id: sourceTransactionId,
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
          related_transaction_id: destinationTransactionId
        }
      };

      const destinationTransactionData = {
        transaction_id: destinationTransactionId,
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
          related_transaction_id: sourceTransactionId
        }
      };

      // Create transaction records
      await UserTransaction.create(sourceTransactionData, { transaction });
      await UserTransaction.create(destinationTransactionData, { transaction });

      // Update copy follower investment tracking
      if (destinationAccount.type === 'copy_follower') {
        // Money transferred TO copy follower = additional investment
        await this.updateCopyFollowerInvestment(destinationAccount.id, amount, transaction);
        // Also update strategy provider's total_investment
        await this.updateStrategyProviderTotalInvestment(destinationAccount.id, amount, transaction);
      }
      
      if (sourceAccount.type === 'copy_follower') {
        // Money transferred FROM copy follower = withdrawal (reduce investment)
        await this.updateCopyFollowerInvestment(sourceAccount.id, -amount, transaction);
        // Also update strategy provider's total_investment
        await this.updateStrategyProviderTotalInvestment(sourceAccount.id, -amount, transaction);
      }

      // Update strategy provider's own investment tracking
      if (destinationAccount.type === 'strategy_provider') {
        // Money transferred TO strategy provider = additional provider investment
        await this.updateStrategyProviderOwnInvestment(destinationAccount.id, amount, transaction);
      }
      
      if (sourceAccount.type === 'strategy_provider') {
        // Money transferred FROM strategy provider = withdrawal (reduce provider investment)
        await this.updateStrategyProviderOwnInvestment(sourceAccount.id, -amount, transaction);
      }

      await transaction.commit();

      // Update Redis with new balances for background services
      try {
        await this.updateRedisBalances(sourceAccount, destinationAccount, amount);
        logger.info('Redis balances updated successfully after transfer', {
          sourceTransactionId,
          destinationTransactionId,
          sourceAccount: `${sourceAccount.type}:${sourceAccount.id}`,
          destinationAccount: `${destinationAccount.type}:${destinationAccount.id}`
        });
      } catch (redisError) {
        logger.error('Failed to update Redis balances after transfer', {
          sourceTransactionId,
          destinationTransactionId,
          sourceAccount: `${sourceAccount.type}:${sourceAccount.id}`,
          destinationAccount: `${destinationAccount.type}:${destinationAccount.id}`,
          error: redisError.message
          // Transfer was successful, Redis update failure is non-critical
        });
      }

      // Update catalog eligibility for strategy provider accounts in real-time
      const eligibilityUpdates = [];
      
      if (sourceAccount.type === 'strategy_provider') {
        try {
          const eligibilityResult = await CatalogEligibilityRealtimeService.updateStrategyProviderEligibility(
            sourceAccount.id, 
            'internal_transfer_out'
          );
          eligibilityUpdates.push({
            account: 'source',
            strategyProviderId: sourceAccount.id,
            ...eligibilityResult
          });
        } catch (eligibilityError) {
          logger.error('Failed to update catalog eligibility for source strategy provider', {
            strategyProviderId: sourceAccount.id,
            error: eligibilityError.message
          });
        }
      }
      
      if (destinationAccount.type === 'strategy_provider') {
        try {
          const eligibilityResult = await CatalogEligibilityRealtimeService.updateStrategyProviderEligibility(
            destinationAccount.id, 
            'internal_transfer_in'
          );
          eligibilityUpdates.push({
            account: 'destination',
            strategyProviderId: destinationAccount.id,
            ...eligibilityResult
          });
        } catch (eligibilityError) {
          logger.error('Failed to update catalog eligibility for destination strategy provider', {
            strategyProviderId: destinationAccount.id,
            error: eligibilityError.message
          });
        }
      }

      logger.info('Internal transfer completed successfully', {
        userId,
        sourceTransactionId,
        destinationTransactionId,
        amount,
        fromAccount: `${sourceAccount.type}:${sourceAccount.id}`,
        toAccount: `${destinationAccount.type}:${destinationAccount.id}`,
        catalogEligibilityUpdates: eligibilityUpdates.length > 0 ? eligibilityUpdates : 'none_required'
      });

      return {
        success: true,
        sourceTransactionId,
        destinationTransactionId,
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
        },
        catalogEligibilityUpdates: eligibilityUpdates
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
      case 'live':
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

  /**
   * Update Redis with new account balances after transfer (comprehensive update for portfolio calculator)
   * @param {Object} sourceAccount - Source account details
   * @param {Object} destinationAccount - Destination account details
   * @param {number} amount - Transfer amount
   */
  static async updateRedisBalances(sourceAccount, destinationAccount, amount) {
    try {
      // Calculate new balances
      const sourceBalanceAfter = sourceAccount.wallet_balance - amount;
      const destinationBalanceAfter = destinationAccount.wallet_balance + amount;

      // FIXED: Separate pipelines for different accounts to avoid Redis Cluster slot group errors
      // Each account's keys belong to different hash slots, so they must be in separate pipelines
      
      // Pipeline 1: Update source account keys (all belong to same slot)
      const sourcePipeline = redisCluster.pipeline();
      const sourceConfigKey = this.getPortfolioCalculatorConfigKey(sourceAccount.type, sourceAccount.id);
      const sourceLegacyKey = this.getLegacyConfigKey(sourceAccount.type, sourceAccount.id);
      const sourcePortfolioKey = this.getPortfolioKey(sourceAccount.type, sourceAccount.id);
      
      sourcePipeline.hset(sourceConfigKey, {
        'balance': sourceBalanceAfter.toString(),
        'wallet_balance': sourceBalanceAfter.toString(),
        'leverage': (sourceAccount.leverage || 100).toString(),
        'group': sourceAccount.group || 'Standard'
      });
      sourcePipeline.del(sourcePortfolioKey);
      
      // Pipeline 2: Update destination account keys (all belong to same slot)
      const destinationPipeline = redisCluster.pipeline();
      const destinationConfigKey = this.getPortfolioCalculatorConfigKey(destinationAccount.type, destinationAccount.id);
      const destinationLegacyKey = this.getLegacyConfigKey(destinationAccount.type, destinationAccount.id);
      const destinationPortfolioKey = this.getPortfolioKey(destinationAccount.type, destinationAccount.id);
      
      destinationPipeline.hset(destinationConfigKey, {
        'balance': destinationBalanceAfter.toString(),
        'wallet_balance': destinationBalanceAfter.toString(),
        'leverage': (destinationAccount.leverage || 100).toString(),
        'group': destinationAccount.group || 'Standard'
      });
      destinationPipeline.del(destinationPortfolioKey);
      
      // Execute account-specific pipelines in parallel
      const [sourceResults, destinationResults] = await Promise.all([
        sourcePipeline.exec(),
        destinationPipeline.exec()
      ]);

      // Legacy keys use classic naming (no hash tags) so update them outside the pipelines
      await Promise.all([
        redisCluster.hset(sourceLegacyKey, {
          'balance': sourceBalanceAfter.toString(),
          'wallet_balance': sourceBalanceAfter.toString()
        }),
        redisCluster.expire(sourceLegacyKey, 86400),
        redisCluster.hset(destinationLegacyKey, {
          'balance': destinationBalanceAfter.toString(),
          'wallet_balance': destinationBalanceAfter.toString()
        }),
        redisCluster.expire(destinationLegacyKey, 86400)
      ]);
      
      // Handle dirty user keys separately (they may be in different hash slots)
      const sourceDirtyKey = this.getDirtyUserKey(sourceAccount.type);
      const destinationDirtyKey = this.getDirtyUserKey(destinationAccount.type);
      
      // Update dirty user keys individually to avoid cross-slot errors
      await Promise.all([
        redisCluster.sadd(sourceDirtyKey, sourceAccount.id.toString()),
        redisCluster.sadd(destinationDirtyKey, destinationAccount.id.toString())
      ]);
      
      // Combine results for error checking
      const results = [...(sourceResults || []), ...(destinationResults || [])];
      
      // Publish force recalc message separately (doesn't need to be in pipeline)
      const forceRecalcMessage = {
        type: 'FORCE_PORTFOLIO_RECALC',
        users: [
          { user_type: sourceAccount.type === 'main' ? 'live' : sourceAccount.type, user_id: sourceAccount.id.toString() },
          { user_type: destinationAccount.type === 'main' ? 'live' : destinationAccount.type, user_id: destinationAccount.id.toString() }
        ],
        reason: 'internal_transfer_completed',
        timestamp: new Date().toISOString()
      };
      
      await redisCluster.publish('portfolio_force_recalc', JSON.stringify(forceRecalcMessage));

      logger.info('Internal transfer Redis operations completed', {
        sourceAccount: { type: sourceAccount.type, id: sourceAccount.id },
        destinationAccount: { type: destinationAccount.type, id: destinationAccount.id },
        portfolioKeysDeleted: [sourcePortfolioKey, destinationPortfolioKey],
        dirtyUsersAdded: [sourceDirtyKey, destinationDirtyKey],
        forceRecalcPublished: true,
        sourcePipelineOperations: sourceResults?.length || 0,
        destinationPipelineOperations: destinationResults?.length || 0,
        totalOperations: results.length,
        pipelineStrategy: 'separate_pipelines_and_individual_dirty_keys_for_cluster_compatibility'
      });

      // Check for Redis pipeline errors
      let hasErrors = false;
      const errorDetails = [];
      
      if (results) {
        results.forEach((result, index) => {
          if (result[0]) { // result[0] is error, result[1] is response
            hasErrors = true;
            errorDetails.push(`Pipeline step ${index}: ${result[0].message}`);
          }
        });
      }

      if (hasErrors) {
        logger.error('Redis pipeline errors during balance update', {
          errors: errorDetails,
          sourceAccount: `${sourceAccount.type}:${sourceAccount.id}`,
          destinationAccount: `${destinationAccount.type}:${destinationAccount.id}`
        });
        throw new Error(`Redis pipeline failed: ${errorDetails.join(', ')}`);
      }

      logger.info('Redis balances updated comprehensively for portfolio calculator', {
        sourceAccount: {
          configKey: sourceConfigKey,
          legacyKey: sourceLegacyKey,
          portfolioKey: sourcePortfolioKey,
          balanceAfter: sourceBalanceAfter
        },
        destinationAccount: {
          configKey: destinationConfigKey,
          legacyKey: destinationLegacyKey,
          portfolioKey: destinationPortfolioKey,
          balanceAfter: destinationBalanceAfter
        },
        pipelineResults: results?.length || 0
      });

      // Verify the update worked by reading back the values
      try {
        const sourceVerification = await redisCluster.hget(sourceConfigKey, 'wallet_balance');
        const destinationVerification = await redisCluster.hget(destinationConfigKey, 'wallet_balance');
        
        logger.info('Redis balance update verification', {
          sourceAccount: {
            key: sourceConfigKey,
            expectedBalance: sourceBalanceAfter,
            actualBalance: sourceVerification,
            updateSuccessful: Math.abs(parseFloat(sourceVerification || 0) - sourceBalanceAfter) < 0.01
          },
          destinationAccount: {
            key: destinationConfigKey,
            expectedBalance: destinationBalanceAfter,
            actualBalance: destinationVerification,
            updateSuccessful: Math.abs(parseFloat(destinationVerification || 0) - destinationBalanceAfter) < 0.01
          }
        });
      } catch (verifyError) {
        logger.error('Failed to verify Redis balance updates', {
          error: verifyError.message
        });
      }

    } catch (error) {
      logger.error('Failed to update Redis account balances', {
        sourceAccount: sourceAccount.type + ':' + sourceAccount.id,
        destinationAccount: destinationAccount.type + ':' + destinationAccount.id,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Fetch portfolio data from Python portfolio calculator (Redis)
   * @param {string} accountType - Account type
   * @param {number} accountId - Account ID
   * @returns {Object|null} Portfolio data from Redis
   */
  static async getPortfolioFromRedis(accountType, accountId) {
    try {
      let redisKey;
      
      // Generate Redis key based on account type (matching Python portfolio calculator)
      switch (accountType) {
        case 'main':
          redisKey = `user_portfolio:{live:${accountId}}`;
          break;
        case 'strategy_provider':
          redisKey = `user_portfolio:{strategy_provider:${accountId}}`;
          break;
        case 'copy_follower':
          redisKey = `user_portfolio:{copy_follower:${accountId}}`;
          break;
        default:
          logger.error('Unknown account type for portfolio fetch', { accountType, accountId });
          return null;
      }

      // Fetch portfolio data from Redis
      const portfolioData = await redisCluster.hgetall(redisKey);
      
      if (!portfolioData || Object.keys(portfolioData).length === 0) {
        logger.info('No portfolio data found in Redis', { redisKey, accountType, accountId });
        return null;
      }

      logger.info('Portfolio data fetched from Redis', {
        redisKey,
        accountType,
        accountId,
        equity: portfolioData.equity,
        used_margin: portfolioData.used_margin,
        margin_level: portfolioData.margin_level,
        open_pnl: portfolioData.open_pnl
      });

      return portfolioData;

    } catch (error) {
      logger.error('Failed to fetch portfolio data from Redis', {
        accountType,
        accountId,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Generate Redis key for portfolio calculator config (hash-tagged for cluster)
   * @param {string} accountType - Account type
   * @param {number} accountId - Account ID
   * @returns {string} Redis key
   */
  static getPortfolioCalculatorConfigKey(accountType, accountId) {
    let userType;
    switch (accountType) {
      case 'main':
        userType = 'live';
        break;
      case 'strategy_provider':
        userType = 'strategy_provider';
        break;
      case 'copy_follower':
        userType = 'copy_follower';
        break;
      default:
        throw new Error(`Unknown account type: ${accountType}`);
    }
    return `user:{${userType}:${accountId}}:config`;
  }

  /**
   * Generate legacy Redis key for backward compatibility
   * @param {string} accountType - Account type
   * @param {number} accountId - Account ID
   * @returns {string} Redis key
   */
  static getLegacyConfigKey(accountType, accountId) {
    let userType;
    switch (accountType) {
      case 'main':
        userType = 'live';
        break;
      case 'strategy_provider':
        userType = 'strategy_provider';
        break;
      case 'copy_follower':
        userType = 'copy_follower';
        break;
      default:
        throw new Error(`Unknown account type: ${accountType}`);
    }
    return `user:${userType}:${accountId}:config`;
  }

  /**
   * Generate portfolio cache key for invalidation
   * @param {string} accountType - Account type
   * @param {number} accountId - Account ID
   * @returns {string} Redis key
   */
  static getPortfolioKey(accountType, accountId) {
    let userType;
    switch (accountType) {
      case 'main':
        userType = 'live';
        break;
      case 'strategy_provider':
        userType = 'strategy_provider';
        break;
      case 'copy_follower':
        userType = 'copy_follower';
        break;
      default:
        throw new Error(`Unknown account type: ${accountType}`);
    }
    return `user_portfolio:{${userType}:${accountId}}`;
  }

  /**
   * Generate dirty user set key for portfolio recalculation
   * @param {string} accountType - Account type
   * @returns {string} Redis key
   */
  static getDirtyUserKey(accountType) {
    let userType;
    switch (accountType) {
      case 'main':
        userType = 'live';
        break;
      case 'strategy_provider':
        userType = 'strategy_provider';
        break;
      case 'copy_follower':
        userType = 'copy_follower';
        break;
      default:
        throw new Error(`Unknown account type: ${accountType}`);
    }
    return `dirty_users:${userType}`;
  }

  /**
   * Generate Redis key for account balance caching (legacy)
   * @param {string} accountType - Account type
   * @param {number} accountId - Account ID
   * @returns {string} Redis key
   */
  static getRedisAccountKey(accountType, accountId) {
    switch (accountType) {
      case 'main':
        return `live_user:${accountId}:balance`;
      case 'strategy_provider':
        return `strategy_provider:${accountId}:balance`;
      case 'copy_follower':
        return `copy_follower:${accountId}:balance`;
      default:
        throw new Error(`Unknown account type: ${accountType}`);
    }
  }

  /**
   * Update copy follower investment tracking when money is transferred to/from the account
   * This is crucial for accurate return calculations
   * @param {number} copyFollowerAccountId - Copy follower account ID
   * @param {number} transferAmount - Amount being transferred (positive for deposits, negative for withdrawals)
   * @param {Object} transaction - Database transaction
   */
  static async updateCopyFollowerInvestment(copyFollowerAccountId, transferAmount, transaction) {
    try {
      const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
      
      // Get current copy follower account
      const copyFollowerAccount = await CopyFollowerAccount.findByPk(copyFollowerAccountId, { transaction });
      
      if (!copyFollowerAccount) {
        throw new Error(`Copy follower account ${copyFollowerAccountId} not found`);
      }

      // Update investment amounts
      const currentInvestment = parseFloat(copyFollowerAccount.investment_amount || 0);
      const newInvestmentAmount = Math.max(0, currentInvestment + transferAmount); // Prevent negative investment

      // Determine transfer type for logging
      const transferType = transferAmount > 0 ? 'deposit' : 'withdrawal';
      
      // Update the account with new investment amount
      // Note: We don't update initial_investment as it should remain the original amount
      // The return calculation will use current vs initial to show total return including additional investments
      await copyFollowerAccount.update({
        investment_amount: newInvestmentAmount
      }, { transaction });

      logger.info('Updated copy follower investment tracking', {
        copyFollowerAccountId,
        transferType,
        transferAmount,
        previousInvestment: currentInvestment,
        newInvestmentAmount,
        initialInvestment: copyFollowerAccount.initial_investment
      });

    } catch (error) {
      logger.error('Failed to update copy follower investment tracking', {
        copyFollowerAccountId,
        transferAmount,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Update strategy provider's total_investment when copy followers add/withdraw money
   * @param {number} copyFollowerAccountId - Copy follower account ID
   * @param {number} transferAmount - Amount being transferred (positive for deposits, negative for withdrawals)
   * @param {Object} transaction - Database transaction
   */
  static async updateStrategyProviderTotalInvestment(copyFollowerAccountId, transferAmount, transaction) {
    try {
      const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
      const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
      
      // Get copy follower account to find the strategy provider
      const copyFollowerAccount = await CopyFollowerAccount.findByPk(copyFollowerAccountId, { 
        attributes: ['strategy_provider_id'],
        transaction 
      });
      
      if (!copyFollowerAccount) {
        throw new Error(`Copy follower account ${copyFollowerAccountId} not found`);
      }

      // Update strategy provider's total_investment
      const strategyProviderId = copyFollowerAccount.strategy_provider_id;
      const transferType = transferAmount > 0 ? 'deposit' : 'withdrawal';
      
      if (transferAmount > 0) {
        // Increase total_investment
        await StrategyProviderAccount.increment('total_investment', {
          by: transferAmount,
          where: { id: strategyProviderId },
          transaction
        });
      } else {
        // Decrease total_investment (but don't go below 0)
        const strategyProvider = await StrategyProviderAccount.findByPk(strategyProviderId, { transaction });
        const currentTotalInvestment = parseFloat(strategyProvider.total_investment || 0);
        const newTotalInvestment = Math.max(0, currentTotalInvestment + transferAmount);
        
        await StrategyProviderAccount.update({
          total_investment: newTotalInvestment
        }, {
          where: { id: strategyProviderId },
          transaction
        });
      }

      logger.info('Updated strategy provider total_investment', {
        strategyProviderId,
        copyFollowerAccountId,
        transferType,
        transferAmount
      });

    } catch (error) {
      logger.error('Failed to update strategy provider total_investment', {
        copyFollowerAccountId,
        transferAmount,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Update strategy provider's own investment tracking when they deposit/withdraw money
   * @param {number} strategyProviderAccountId - Strategy provider account ID
   * @param {number} transferAmount - Amount being transferred (positive for deposits, negative for withdrawals)
   * @param {Object} transaction - Database transaction
   */
  static async updateStrategyProviderOwnInvestment(strategyProviderAccountId, transferAmount, transaction) {
    try {
      const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
      
      // Get current strategy provider account
      const strategyProviderAccount = await StrategyProviderAccount.findByPk(strategyProviderAccountId, { transaction });
      
      if (!strategyProviderAccount) {
        throw new Error(`Strategy provider account ${strategyProviderAccountId} not found`);
      }

      // Update provider investment amounts
      const currentInvestment = parseFloat(strategyProviderAccount.provider_investment_amount || 0);
      const newInvestmentAmount = Math.max(0, currentInvestment + transferAmount); // Prevent negative investment

      // Determine transfer type for logging
      const transferType = transferAmount > 0 ? 'deposit' : 'withdrawal';
      
      // Update the account with new provider investment amount
      await strategyProviderAccount.update({
        provider_investment_amount: newInvestmentAmount
      }, { transaction });

      logger.info('Updated strategy provider own investment tracking', {
        strategyProviderAccountId,
        transferType,
        transferAmount,
        previousInvestment: currentInvestment,
        newInvestmentAmount,
        initialInvestment: strategyProviderAccount.provider_initial_investment
      });

    } catch (error) {
      logger.error('Failed to update strategy provider own investment tracking', {
        strategyProviderAccountId,
        transferAmount,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Force refresh user balance in Redis (manual cache invalidation)
   * @param {string} accountType - Account type (main, strategy_provider, copy_follower)
   * @param {number} accountId - Account ID
   * @returns {boolean} Success status
   */
  static async forceRefreshUserBalance(accountType, accountId) {
    try {
      // Get fresh balance from database
      const account = await this.getAccountDetails(null, accountType, accountId);
      if (!account) {
        throw new Error('Account not found');
      }

      const pipeline = redisCluster.pipeline();
      
      // Update both config keys with fresh balance
      const configKey = this.getPortfolioCalculatorConfigKey(accountType, accountId);
      const legacyKey = this.getLegacyConfigKey(accountType, accountId);
      
      const balanceData = {
        'balance': account.wallet_balance.toString(),
        'wallet_balance': account.wallet_balance.toString(),
        'leverage': (account.leverage || 100).toString(),
        'group': account.group || 'Standard'
      };
      
      pipeline.hset(configKey, balanceData);
      pipeline.hset(legacyKey, balanceData);
      
      // Invalidate portfolio cache
      const portfolioKey = this.getPortfolioKey(accountType, accountId);
      pipeline.del(portfolioKey);
      
      // Mark user as dirty for recalculation
      const dirtyKey = this.getDirtyUserKey(accountType);
      pipeline.sadd(dirtyKey, accountId.toString());
      
      await pipeline.exec();
      
      logger.info('Force refreshed user balance in Redis', {
        accountType,
        accountId,
        configKey,
        legacyKey,
        portfolioKey,
        balance: account.wallet_balance
      });
      
      return true;
    } catch (error) {
      logger.error('Failed to force refresh user balance', {
        accountType,
        accountId,
        error: error.message
      });
      return false;
    }
  }
}

module.exports = InternalTransferService;
