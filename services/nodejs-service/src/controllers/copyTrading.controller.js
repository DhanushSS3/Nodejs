const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
const LiveUser = require('../models/liveUser.model');
const UserTransaction = require('../models/userTransaction.model');
const logger = require('../services/logger.service');
const strategyProviderService = require('../services/strategyProvider.service');
const InternalTransferService = require('../services/internalTransfer.service');
const sequelize = require('../config/db');
const { redisCluster } = require('../../config/redis');

/**
 * Create a copy follower account to follow a strategy provider
 */
async function createFollowerAccount(req, res) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const {
      strategy_provider_id,
      investment_amount,
      account_name,
      copy_sl_mode = 'none',
      copy_tp_mode = 'none',
      sl_percentage,
      tp_percentage,
      sl_amount,
      tp_amount,
      max_lot_size,
      max_daily_loss,
      stop_copying_on_drawdown
    } = req.body;

    // Validate required fields
    if (!strategy_provider_id || !investment_amount || !account_name) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: strategy_provider_id, investment_amount, account_name'
      });
    }

    // Validate account_name uniqueness for the user
    const existingAccountName = await CopyFollowerAccount.findOne({
      where: {
        user_id: userId,
        account_name: account_name,
        status: 1
      }
    });

    if (existingAccountName) {
      return res.status(400).json({
        success: false,
        message: 'Account name already exists. Please choose a different account name.'
      });
    }

    // Validate SL/TP modes and their corresponding values
    if (copy_sl_mode && copy_sl_mode !== 'none') {
      if (copy_sl_mode === 'percentage' && (!sl_percentage || parseFloat(sl_percentage) <= 0)) {
        return res.status(400).json({
          success: false,
          message: 'SL percentage is required and must be greater than 0 when copy_sl_mode is percentage'
        });
      }
      if (copy_sl_mode === 'amount' && (!sl_amount || parseFloat(sl_amount) <= 0)) {
        return res.status(400).json({
          success: false,
          message: 'SL amount is required and must be greater than 0 when copy_sl_mode is amount'
        });
      }
    }

    if (copy_tp_mode && copy_tp_mode !== 'none') {
      if (copy_tp_mode === 'percentage' && (!tp_percentage || parseFloat(tp_percentage) <= 0)) {
        return res.status(400).json({
          success: false,
          message: 'TP percentage is required and must be greater than 0 when copy_tp_mode is percentage'
        });
      }
      if (copy_tp_mode === 'amount' && (!tp_amount || parseFloat(tp_amount) <= 0)) {
        return res.status(400).json({
          success: false,
          message: 'TP amount is required and must be greater than 0 when copy_tp_mode is amount'
        });
      }
    }

    // Get strategy provider and validate first
    const strategyProvider = await StrategyProviderAccount.findOne({
      where: {
        id: strategy_provider_id,
        status: 1,
        is_active: 1
      }
    });

    if (!strategyProvider) {
      return res.status(404).json({
        success: false,
        message: 'Strategy provider not found or inactive'
      });
    }

    // Check if user is trying to follow their own strategy (FIRST CHECK)
    if (strategyProvider.user_id === userId) {
      return res.status(400).json({
        success: false,
        error_code: 'SELF_FOLLOW_NOT_ALLOWED',
        message: 'You cannot follow your own strategy account. Please select a different strategy provider to follow.'
      });
    }

    // Validate investment amount against strategy provider's minimum investment
    const minInvestment = parseFloat(strategyProvider.min_investment || 100);
    if (parseFloat(investment_amount) < minInvestment) {
      return res.status(400).json({
        success: false,
        message: `Minimum investment amount is $${minInvestment} for this strategy`
      });
    }

    // Check if strategy provider has minimum balance to accept followers
    const strategyProviderEquity = parseFloat(strategyProvider.wallet_balance || 0) + parseFloat(strategyProvider.net_profit || 0);
    const minStrategyBalance = 100.00;
    
    if (strategyProviderEquity < minStrategyBalance) {
      return res.status(400).json({
        success: false,
        message: `Strategy provider does not meet minimum balance requirement of $${minStrategyBalance}. Current equity: $${strategyProviderEquity.toFixed(2)}`
      });
    }

    // Check if strategy has reached maximum followers
    if (strategyProvider.max_followers && strategyProvider.total_followers >= strategyProvider.max_followers) {
      return res.status(400).json({
        success: false,
        message: 'Strategy has reached maximum number of followers'
      });
    }

    // Check if user already follows this strategy
    const existingFollower = await CopyFollowerAccount.findOne({
      where: {
        user_id: userId,
        strategy_provider_id: strategy_provider_id,
        status: 1,
        is_active: 1
      }
    });

    if (existingFollower) {
      return res.status(409).json({
        success: false,
        error_code: 'ALREADY_FOLLOWING_STRATEGY',
        message: 'You are already following this strategy. Each strategy can only be followed once per account.'
      });
    }

    // Get user details for inheritance and balance check
    const liveUser = await LiveUser.findByPk(userId);
    if (!liveUser) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Comprehensive validation using internal transfer service logic
    const investmentAmountFloat = parseFloat(investment_amount);
    const minBalance = 100.00;
    
    // Check minimum balance requirement
    const userBalance = parseFloat(liveUser.wallet_balance || 0);
    if (userBalance < minBalance) {
      return res.status(400).json({
        success: false,
        message: `Minimum balance of $${minBalance} required to start copy trading. Current balance: $${userBalance.toFixed(2)}`
      });
    }
    
    // Use internal transfer validation for comprehensive margin and balance checks
    logger.info('Validating copy follower investment transfer', { 
      userId, 
      investmentAmount: investmentAmountFloat,
      userBalance 
    });
    
    const transferValidation = await InternalTransferService.validateTransfer(userId, {
      fromAccountType: 'live',
      fromAccountId: userId,
      toAccountType: 'copy_follower', // Temporary - will be created
      toAccountId: null, // Will be set after account creation
      amount: investmentAmountFloat
    });
    
    if (!transferValidation.valid) {
      logger.warn('Copy follower investment validation failed', {
        userId,
        investmentAmount: investmentAmountFloat,
        error: transferValidation.error
      });
      
      return res.status(400).json({
        success: false,
        message: `Investment validation failed: ${transferValidation.error}`,
        details: {
          availableBalance: transferValidation.availableBalance,
          openOrdersCount: transferValidation.openOrdersCount,
          totalMarginRequired: transferValidation.totalMarginRequired
        }
      });
    }
    
    logger.info('Copy follower investment validation passed', {
      userId,
      investmentAmount: investmentAmountFloat,
      availableBalance: transferValidation.availableBalance
    });

    // Generate unique account number
    const generateAccountNumber = () => {
      const timestamp = Date.now().toString();
      const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      return `CF${timestamp}${random}`;
    };

    let accountNumber = generateAccountNumber();
    
    // Ensure account number is unique (very unlikely to collide, but safety check)
    let existingAccount = await CopyFollowerAccount.findOne({ where: { account_number: accountNumber } });
    while (existingAccount) {
      accountNumber = generateAccountNumber();
      existingAccount = await CopyFollowerAccount.findOne({ where: { account_number: accountNumber } });
    }

    // Create follower account
    const followerData = {
      user_id: userId,
      strategy_provider_id: strategy_provider_id,
      account_name: account_name,
      account_number: accountNumber,
      investment_amount: investmentAmountFloat,
      initial_investment: investmentAmountFloat,
      
      // Inherit settings from strategy provider
      group: strategyProvider.group,
      leverage: strategyProvider.leverage,
      sending_orders: strategyProvider.sending_orders,
      auto_cutoff_level: strategyProvider.auto_cutoff_level,
      
      // Copy settings
      copy_sl_mode,
      copy_tp_mode,
      sl_percentage: sl_percentage ? parseFloat(sl_percentage) : null,
      tp_percentage: tp_percentage ? parseFloat(tp_percentage) : null,
      sl_amount: sl_amount ? parseFloat(sl_amount) : null,
      tp_amount: tp_amount ? parseFloat(tp_amount) : null,
      
      // Risk management
      max_lot_size: max_lot_size ? parseFloat(max_lot_size) : null,
      max_daily_loss: max_daily_loss ? parseFloat(max_daily_loss) : null,
      stop_copying_on_drawdown: stop_copying_on_drawdown ? parseFloat(stop_copying_on_drawdown) : null,
      
      // Initial financial state
      wallet_balance: investmentAmountFloat,
      equity: investmentAmountFloat,
      
      // Status
      status: 1,
      is_active: 1,
      copy_status: 'active'
    };

    // Validate sequelize connection
    if (!sequelize || typeof sequelize.transaction !== 'function') {
      throw new Error('Database connection not available');
    }

    // Validate UserTransaction model
    if (!UserTransaction || typeof UserTransaction.create !== 'function') {
      throw new Error('UserTransaction model not properly loaded');
    }

    // Execute all operations in a database transaction
    let result;
    try {
      logger.info('Starting database transaction for copy follower account creation', { userId, strategy_provider_id });
      
      result = await sequelize.transaction(async (t) => {
        logger.info('Transaction started successfully', { userId });
        
        // Create follower account
        const followerAccount = await CopyFollowerAccount.create(followerData, { transaction: t });
        logger.info('Follower account created', { followerId: followerAccount.id, userId });

      // Get current user balance for transaction record
      const currentUser = await LiveUser.findByPk(userId, { 
        attributes: ['wallet_balance'],
        transaction: t,
        lock: true // Lock the row to prevent concurrent modifications
      });

      const balanceBefore = parseFloat(currentUser.wallet_balance || 0);
      const balanceAfter = balanceBefore - investmentAmountFloat;

      // Deduct investment amount from user's main account balance
      await LiveUser.update({
        wallet_balance: balanceAfter
      }, {
        where: { id: userId },
        transaction: t
      });

      // Create transaction record for transfer from main wallet
      logger.info('Creating transfer transaction record for main wallet', { userId, balanceBefore, balanceAfter });
      const transactionId = `TXN${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
      await UserTransaction.create({
        transaction_id: transactionId,
        user_id: userId,
        user_type: 'live',
        type: 'transfer', // Changed from 'withdraw' to 'transfer'
        amount: -investmentAmountFloat, // Negative for debit
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        status: 'completed',
        notes: `Transfer to copy follower account: ${followerAccount.account_name}`,
        user_email: liveUser.email,
        metadata: {
          copy_follower_account_id: followerAccount.id,
          strategy_provider_id: strategy_provider_id,
          account_name: followerAccount.account_name,
          transfer_type: 'copy_follower_investment',
          transfer_direction: 'outgoing'
        }
      }, { transaction: t });

      // Create corresponding credit transaction for copy follower account
      const creditTransactionId = `TXN${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
      await UserTransaction.create({
        transaction_id: creditTransactionId,
        user_id: followerAccount.id, // Use follower account ID as user_id for copy_follower type
        user_type: 'copy_follower',
        type: 'transfer', // Changed from 'deposit' to 'transfer'
        amount: investmentAmountFloat, // Positive for credit
        balance_before: 0,
        balance_after: investmentAmountFloat,
        status: 'completed',
        notes: `Transfer from main wallet for copy trading investment`,
        user_email: liveUser.email,
        metadata: {
          main_user_id: userId,
          strategy_provider_id: strategy_provider_id,
          account_name: followerAccount.account_name,
          transfer_type: 'copy_follower_investment',
          transfer_direction: 'incoming'
        }
      }, { transaction: t });

      // Update strategy provider follower count and total investment
      await StrategyProviderAccount.increment({
        total_followers: 1,
        total_investment: investmentAmountFloat
      }, {
        where: { id: strategy_provider_id },
        transaction: t
      });

        return followerAccount;
      });
    } catch (transactionError) {
      logger.error('Database transaction failed during copy follower account creation', {
        userId,
        error: transactionError.message,
        stack: transactionError.stack,
        body: req.body
      });
      throw transactionError;
    }

    const followerAccount = result;

    // Update Redis with new balances for portfolio calculator and autocutoff logic
    try {
      const sourceAccount = {
        id: userId,
        type: 'live',
        wallet_balance: parseFloat(liveUser.wallet_balance || 0),
        leverage: parseFloat(liveUser.leverage || 100),
        group: liveUser.group || 'Standard'
      };
      
      const destinationAccount = {
        id: followerAccount.id,
        type: 'copy_follower',
        wallet_balance: 0, // Starting balance before transfer
        leverage: parseFloat(followerAccount.leverage || 100),
        group: followerAccount.group || 'Standard'
      };

      await InternalTransferService.updateRedisBalances(sourceAccount, destinationAccount, investmentAmountFloat);
      
      logger.info('Redis balances updated successfully after copy follower account creation', {
        userId,
        followerId: followerAccount.id,
        investmentAmount: investmentAmountFloat,
        sourceBalance: sourceAccount.wallet_balance - investmentAmountFloat,
        destinationBalance: investmentAmountFloat
      });

      try {
        const followerConfigKey = `user:{copy_follower:${followerAccount.id}}:config`;
        const followerConfig = await redisCluster.hgetall(followerConfigKey);
        const followerPortfolioKey = `user_portfolio:{copy_follower:${followerAccount.id}}`;
        const followerPortfolio = await redisCluster.hgetall(followerPortfolioKey);

        logger.info('Copy follower Redis state after account creation', {
          userId,
          followerId: followerAccount.id,
          followerConfigKey,
          followerConfigWalletBalance: followerConfig && followerConfig.wallet_balance,
          followerConfigBalance: followerConfig && followerConfig.balance,
          followerConfigLeverage: followerConfig && followerConfig.leverage,
          followerConfigGroup: followerConfig && followerConfig.group,
          followerConfigSendingOrders: followerConfig && followerConfig.sending_orders,
          followerPortfolioKey,
          followerPortfolioFields: followerPortfolio ? Object.keys(followerPortfolio) : null,
          followerPortfolioSnapshot: followerPortfolio
        });
      } catch (debugError) {
        logger.warn('Failed to read copy follower Redis state after account creation', {
          userId,
          followerId: followerAccount.id,
          error: debugError.message
        });
      }
    } catch (redisError) {
      // Log Redis error but don't fail the operation since DB transaction already committed
      logger.error('Failed to update Redis balances after copy follower account creation', {
        userId,
        followerId: followerAccount.id,
        investmentAmount: investmentAmountFloat,
        error: redisError.message
      });
    }

    logger.info('Copy follower account created', {
      userId,
      followerId: followerAccount.id,
      strategyProviderId: strategy_provider_id,
      investmentAmount: investment_amount
    });

    res.status(201).json({
      success: true,
      message: 'Successfully started following strategy',
      follower_account: {
        id: followerAccount.id,
        account_number: followerAccount.account_number,
        account_name: followerAccount.account_name,
        investment_amount: followerAccount.investment_amount,
        copy_status: followerAccount.copy_status,
        created_at: followerAccount.created_at
      }
    });

  } catch (error) {
    logger.error('Failed to create copy follower account', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      body: req.body,
      errorType: error.constructor.name
    });

    // Provide more specific error messages based on error type
    let errorMessage = 'Failed to create follower account';
    let statusCode = 500;

    if (error.name === 'SequelizeValidationError') {
      errorMessage = 'Validation error: ' + error.errors.map(e => e.message).join(', ');
      statusCode = 400;
    } else if (error.name === 'SequelizeUniqueConstraintError') {
      errorMessage = 'Account name already exists or duplicate entry detected';
      statusCode = 409;
    } else if (error.name === 'SequelizeDatabaseError') {
      errorMessage = 'Database error occurred while creating account';
    } else if (error.message.includes('transaction')) {
      errorMessage = 'Transaction error: Unable to process account creation';
    }

    res.status(statusCode).json({
      success: false,
      message: errorMessage,
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

/**
 * Get user's copy follower accounts
 */
async function getFollowerAccounts(req, res) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const followerAccounts = await CopyFollowerAccount.findAll({
      where: { user_id: userId },
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        attributes: [
          'id', 'strategy_name', 'performance_fee', 'total_return_percentage',
          'win_rate', 'max_drawdown', 'total_followers'
        ]
      }],
      order: [['created_at', 'DESC']]
    });

    const formattedAccounts = followerAccounts.map(account => ({
      id: account.id,
      account_number: account.account_number,
      account_name: account.account_name,
      investment_amount: parseFloat(account.investment_amount),
      current_equity: parseFloat(account.equity || 0),
      total_profit_loss: parseFloat(account.total_profit_loss || 0),
      total_fees_paid: parseFloat(account.total_fees_paid || 0),
      copy_status: account.copy_status,
      successful_copies: account.successful_copies || 0,
      failed_copies: account.failed_copies || 0,
      created_at: account.created_at,
      strategy_provider: account.strategyProvider ? {
        id: account.strategyProvider.id,
        strategy_name: account.strategyProvider.strategy_name,
        performance_fee: parseFloat(account.strategyProvider.performance_fee || 0),
        total_return_percentage: parseFloat(account.strategyProvider.total_return_percentage || 0),
        win_rate: parseFloat(account.strategyProvider.win_rate || 0),
        max_drawdown: parseFloat(account.strategyProvider.max_drawdown || 0),
        total_followers: account.strategyProvider.total_followers || 0
      } : null
    }));

    res.json({
      success: true,
      follower_accounts: formattedAccounts
    });

  } catch (error) {
    logger.error('Failed to get follower accounts', {
      userId: req.user?.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to get follower accounts',
      error: error.message
    });
  }
}

/**
 * Update copy follower account settings (legacy - keeping for backward compatibility)
 */
async function updateFollowerAccount(req, res) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    const { follower_id } = req.params;
    
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const followerAccount = await CopyFollowerAccount.findOne({
      where: {
        id: follower_id,
        user_id: userId
      }
    });

    if (!followerAccount) {
      return res.status(404).json({
        success: false,
        message: 'Follower account not found'
      });
    }

    const {
      copy_status,
      copy_sl_mode,
      copy_tp_mode,
      sl_percentage,
      tp_percentage,
      sl_amount,
      tp_amount,
      max_lot_size,
      max_daily_loss,
      stop_copying_on_drawdown,
      pause_reason
    } = req.body;

    const updateFields = {};

    // Update copy status
    if (copy_status && ['active', 'paused', 'stopped'].includes(copy_status)) {
      updateFields.copy_status = copy_status;
      
      if (copy_status === 'paused' && pause_reason) {
        updateFields.pause_reason = pause_reason;
      } else if (copy_status === 'stopped') {
        updateFields.stop_reason = req.body.stop_reason || 'Manually stopped by user';
      }
    }

    // Update SL/TP settings
    if (copy_sl_mode !== undefined) updateFields.copy_sl_mode = copy_sl_mode;
    if (copy_tp_mode !== undefined) updateFields.copy_tp_mode = copy_tp_mode;
    if (sl_percentage !== undefined) updateFields.sl_percentage = sl_percentage ? parseFloat(sl_percentage) : null;
    if (tp_percentage !== undefined) updateFields.tp_percentage = tp_percentage ? parseFloat(tp_percentage) : null;
    if (sl_amount !== undefined) updateFields.sl_amount = sl_amount ? parseFloat(sl_amount) : null;
    if (tp_amount !== undefined) updateFields.tp_amount = tp_amount ? parseFloat(tp_amount) : null;

    // Update risk management
    if (max_lot_size !== undefined) updateFields.max_lot_size = max_lot_size ? parseFloat(max_lot_size) : null;
    if (max_daily_loss !== undefined) updateFields.max_daily_loss = max_daily_loss ? parseFloat(max_daily_loss) : null;
    if (stop_copying_on_drawdown !== undefined) updateFields.stop_copying_on_drawdown = stop_copying_on_drawdown ? parseFloat(stop_copying_on_drawdown) : null;

    await CopyFollowerAccount.update(updateFields, {
      where: { id: follower_id }
    });

    logger.info('Copy follower account updated', {
      userId,
      followerId: follower_id,
      updateFields
    });

    res.json({
      success: true,
      message: 'Follower account updated successfully'
    });

  } catch (error) {
    logger.error('Failed to update follower account', {
      userId: req.user?.id,
      followerId: req.params?.follower_id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to update follower account',
      error: error.message
    });
  }
}

/**
 * Update copy follower account settings with strict validation
 */
async function updateFollowerAccountStrict(req, res) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    const { id } = req.params;
    
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Verify account belongs to user
    const followerAccount = await CopyFollowerAccount.findOne({
      where: {
        id: id,
        user_id: userId,
        status: 1
      }
    });

    if (!followerAccount) {
      return res.status(404).json({
        success: false,
        message: 'Follower account not found or does not belong to you'
      });
    }

    const {
      copy_sl_mode,
      copy_tp_mode,
      copy_sl_percent,
      copy_sl_value,
      copy_tp_percent,
      copy_tp_value,
      copy_status,
      reason
    } = req.body;

    const updateFields = {};

    // Validate and update copy_sl_mode
    if (copy_sl_mode !== undefined) {
      if (!['none', 'percentage', 'amount'].includes(copy_sl_mode)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid copy_sl_mode. Must be one of: none, percentage, amount'
        });
      }
      
      if (copy_sl_mode === 'percentage') {
        if (!copy_sl_percent || parseFloat(copy_sl_percent) <= 0) {
          return res.status(400).json({
            success: false,
            message: 'copy_sl_percent is required and must be greater than 0 when copy_sl_mode is percentage'
          });
        }
        updateFields.copy_sl_mode = copy_sl_mode;
        updateFields.sl_percentage = parseFloat(copy_sl_percent);
        updateFields.sl_amount = null;
      } else if (copy_sl_mode === 'amount') {
        if (!copy_sl_value || parseFloat(copy_sl_value) <= 0) {
          return res.status(400).json({
            success: false,
            message: 'copy_sl_value is required and must be greater than 0 when copy_sl_mode is amount'
          });
        }
        updateFields.copy_sl_mode = copy_sl_mode;
        updateFields.sl_amount = parseFloat(copy_sl_value);
        updateFields.sl_percentage = null;
      } else {
        updateFields.copy_sl_mode = 'none';
        updateFields.sl_percentage = null;
        updateFields.sl_amount = null;
      }
    }

    // Validate and update copy_tp_mode
    if (copy_tp_mode !== undefined) {
      if (!['none', 'percentage', 'amount'].includes(copy_tp_mode)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid copy_tp_mode. Must be one of: none, percentage, amount'
        });
      }
      
      if (copy_tp_mode === 'percentage') {
        if (!copy_tp_percent || parseFloat(copy_tp_percent) <= 0) {
          return res.status(400).json({
            success: false,
            message: 'copy_tp_percent is required and must be greater than 0 when copy_tp_mode is percentage'
          });
        }
        updateFields.copy_tp_mode = copy_tp_mode;
        updateFields.tp_percentage = parseFloat(copy_tp_percent);
        updateFields.tp_amount = null;
      } else if (copy_tp_mode === 'amount') {
        if (!copy_tp_value || parseFloat(copy_tp_value) <= 0) {
          return res.status(400).json({
            success: false,
            message: 'copy_tp_value is required and must be greater than 0 when copy_tp_mode is amount'
          });
        }
        updateFields.copy_tp_mode = copy_tp_mode;
        updateFields.tp_amount = parseFloat(copy_tp_value);
        updateFields.tp_percentage = null;
      } else {
        updateFields.copy_tp_mode = 'none';
        updateFields.tp_percentage = null;
        updateFields.tp_amount = null;
      }
    }

    // Update copy status
    if (copy_status !== undefined) {
      if (!['active', 'paused', 'stopped'].includes(copy_status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid copy_status. Must be one of: active, paused, stopped'
        });
      }
      updateFields.copy_status = copy_status;
    }

    // Update reason
    if (reason !== undefined) {
      updateFields.pause_reason = reason;
    }

    // Ensure at least one field is being updated
    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields provided for update'
      });
    }

    await CopyFollowerAccount.update(updateFields, {
      where: { id: id }
    });

    logger.info('Copy follower account updated (strict)', {
      userId,
      followerId: id,
      updateFields
    });

    res.json({
      success: true,
      message: 'Follower account updated successfully',
      updated_fields: Object.keys(updateFields)
    });

  } catch (error) {
    logger.error('Failed to update follower account (strict)', {
      userId: req.user?.id,
      followerId: req.params?.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to update follower account',
      error: error.message
    });
  }
}

/**
 * Update copy follower SL/TP settings for future orders
 */
async function updateFollowerSlTpSettings(req, res) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    const { id } = req.params;
    
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Verify account belongs to user and is active
    const followerAccount = await CopyFollowerAccount.findOne({
      where: {
        id: id,
        user_id: userId,
        status: 1,
        is_active: 1
      },
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        attributes: ['id', 'strategy_name', 'account_number']
      }],
      attributes: [
        'id', 'account_name', 'account_number', 'user_id', 'strategy_provider_id',
        'investment_amount', 'initial_investment', 'wallet_balance', 'net_profit',
        'copy_sl_mode', 'sl_percentage', 'sl_amount',
        'copy_tp_mode', 'tp_percentage', 'tp_amount'
      ]
    });

    if (!followerAccount) {
      return res.status(404).json({
        success: false,
        message: 'Copy follower account not found or does not belong to you'
      });
    }

    const {
      copy_sl_mode,
      sl_percentage,
      sl_amount,
      copy_tp_mode,
      tp_percentage,
      tp_amount
    } = req.body;

    const updateFields = {};
    const validationErrors = [];

    // Calculate current balance for validation
    const currentWalletBalance = parseFloat(followerAccount.wallet_balance || 0);
    const currentNetProfit = parseFloat(followerAccount.net_profit || 0);
    const currentEquity = currentWalletBalance;
    const investmentAmount = parseFloat(
      followerAccount.investment_amount ?? followerAccount.initial_investment ?? 0
    );

    // Validate and update Stop Loss settings
    if (copy_sl_mode !== undefined) {
      if (!['none', 'percentage', 'amount'].includes(copy_sl_mode)) {
        validationErrors.push('copy_sl_mode must be one of: none, percentage, amount');
      } else {
        updateFields.copy_sl_mode = copy_sl_mode;
        
        if (copy_sl_mode === 'percentage') {
          if (sl_percentage === undefined || sl_percentage === null) {
            validationErrors.push('sl_percentage is required when copy_sl_mode is percentage');
          } else {
            const slPercent = parseFloat(sl_percentage);
            if (isNaN(slPercent) || slPercent <= 0 || slPercent > 100) {
              validationErrors.push('sl_percentage must be between 0.01 and 100.00');
            } else {
              // Validate that SL percentage results in a value less than current equity
              const slThreshold = investmentAmount * (slPercent / 100);
              if (slThreshold >= currentEquity) {
                validationErrors.push(`Stop loss percentage (${slPercent}%) results in threshold $${slThreshold.toFixed(2)} which must be less than current equity $${currentEquity.toFixed(2)}`);
              } else {
                updateFields.sl_percentage = slPercent;
                updateFields.sl_amount = null; // Clear amount when using percentage
              }
            }
          }
        } else if (copy_sl_mode === 'amount') {
          if (sl_amount === undefined || sl_amount === null) {
            validationErrors.push('sl_amount is required when copy_sl_mode is amount');
          } else {
            const slAmt = parseFloat(sl_amount);
            if (isNaN(slAmt) || slAmt <= 0) {
              validationErrors.push('sl_amount must be greater than 0');
            } else if (slAmt >= currentEquity) {
              validationErrors.push(`Stop loss amount $${slAmt.toFixed(2)} must be less than current equity $${currentEquity.toFixed(2)}`);
            } else {
              updateFields.sl_amount = slAmt;
              updateFields.sl_percentage = null; // Clear percentage when using amount
            }
          }
        } else {
          // copy_sl_mode === 'none'
          updateFields.sl_percentage = null;
          updateFields.sl_amount = null;
        }
      }
    }

    // Validate and update Take Profit settings
    if (copy_tp_mode !== undefined) {
      if (!['none', 'percentage', 'amount'].includes(copy_tp_mode)) {
        validationErrors.push('copy_tp_mode must be one of: none, percentage, amount');
      } else {
        updateFields.copy_tp_mode = copy_tp_mode;
        
        if (copy_tp_mode === 'percentage') {
          if (tp_percentage === undefined || tp_percentage === null) {
            validationErrors.push('tp_percentage is required when copy_tp_mode is percentage');
          } else {
            const tpPercent = parseFloat(tp_percentage);
            if (isNaN(tpPercent) || tpPercent <= 0 || tpPercent > 1000) {
              validationErrors.push('tp_percentage must be between 0.01 and 1000.00');
            } else {
              // Validate that TP percentage results in a value greater than current equity
              const tpThreshold = investmentAmount * (1 + tpPercent / 100);
              if (tpThreshold <= currentEquity) {
                validationErrors.push(`Take profit percentage (${tpPercent}%) results in threshold $${tpThreshold.toFixed(2)} which must be greater than current equity $${currentEquity.toFixed(2)}`);
              } else {
                updateFields.tp_percentage = tpPercent;
                updateFields.tp_amount = null; // Clear amount when using percentage
              }
            }
          }
        } else if (copy_tp_mode === 'amount') {
          if (tp_amount === undefined || tp_amount === null) {
            validationErrors.push('tp_amount is required when copy_tp_mode is amount');
          } else {
            const tpAmt = parseFloat(tp_amount);
            if (isNaN(tpAmt) || tpAmt <= 0) {
              validationErrors.push('tp_amount must be greater than 0');
            } else if (tpAmt <= currentEquity) {
              validationErrors.push(`Take profit amount $${tpAmt.toFixed(2)} must be greater than current equity $${currentEquity.toFixed(2)}`);
            } else {
              updateFields.tp_amount = tpAmt;
              updateFields.tp_percentage = null; // Clear percentage when using amount
            }
          }
        } else {
          // copy_tp_mode === 'none'
          updateFields.tp_percentage = null;
          updateFields.tp_amount = null;
        }
      }
    }

    // Return validation errors if any
    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }

    // Ensure at least one field is being updated
    if (Object.keys(updateFields).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No SL/TP settings provided for update'
      });
    }

    // Update the account
    await CopyFollowerAccount.update(updateFields, {
      where: { id: id }
    });

    // Get updated account for response
    const updatedAccount = await CopyFollowerAccount.findByPk(id, {
      attributes: [
        'id', 'account_name', 'copy_sl_mode', 'sl_percentage', 'sl_amount',
        'copy_tp_mode', 'tp_percentage', 'tp_amount'
      ]
    });

    logger.info('Copy follower SL/TP settings updated', {
      userId,
      followerId: id,
      strategyProvider: followerAccount.strategyProvider?.strategy_name,
      updateFields
    });

    res.json({
      success: true,
      message: 'SL/TP settings updated successfully. These settings will apply to future orders.',
      data: {
        account_id: updatedAccount.id,
        account_name: updatedAccount.account_name,
        stop_loss_settings: {
          mode: updatedAccount.copy_sl_mode,
          percentage: updatedAccount.sl_percentage,
          amount: updatedAccount.sl_amount
        },
        take_profit_settings: {
          mode: updatedAccount.copy_tp_mode,
          percentage: updatedAccount.tp_percentage,
          amount: updatedAccount.tp_amount
        }
      },
      updated_fields: Object.keys(updateFields)
    });

  } catch (error) {
    logger.error('Failed to update copy follower SL/TP settings', {
      userId: req.user?.id,
      followerId: req.params?.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to update SL/TP settings',
      error: error.message
    });
  }
}

/**
 * Get copy follower SL/TP settings
 */
async function getFollowerSlTpSettings(req, res) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    const { id } = req.params;
    
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Verify account belongs to user
    const followerAccount = await CopyFollowerAccount.findOne({
      where: {
        id: id,
        user_id: userId,
        status: 1,
        is_active: 1
      },
      attributes: [
        'id', 'account_name', 'account_number', 'investment_amount',
        'copy_sl_mode', 'sl_percentage', 'sl_amount',
        'copy_tp_mode', 'tp_percentage', 'tp_amount'
      ],
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        attributes: ['id', 'strategy_name', 'account_number']
      }]
    });

    if (!followerAccount) {
      return res.status(404).json({
        success: false,
        message: 'Copy follower account not found or does not belong to you'
      });
    }

    logger.info('Copy follower SL/TP settings retrieved', {
      userId,
      followerId: id,
      strategyProvider: followerAccount.strategyProvider?.strategy_name
    });

    res.json({
      success: true,
      message: 'SL/TP settings retrieved successfully',
      data: {
        account_info: {
          id: followerAccount.id,
          account_name: followerAccount.account_name,
          account_number: followerAccount.account_number,
          investment_amount: followerAccount.investment_amount,
          strategy_provider: followerAccount.strategyProvider
        },
        stop_loss_settings: {
          mode: followerAccount.copy_sl_mode || 'none',
          percentage: followerAccount.sl_percentage,
          amount: followerAccount.sl_amount
        },
        take_profit_settings: {
          mode: followerAccount.copy_tp_mode || 'none',
          percentage: followerAccount.tp_percentage,
          amount: followerAccount.tp_amount
        }
      }
    });

  } catch (error) {
    logger.error('Failed to get copy follower SL/TP settings', {
      userId: req.user?.id,
      followerId: req.params?.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to get SL/TP settings',
      error: error.message
    });
  }
}

/**
 * Stop following a strategy (close follower account)
 */
async function stopFollowing(req, res) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    const { follower_id } = req.params;
    
    logger.info('Stop following request received', { 
      userId, 
      follower_id, 
      hasBody: !!req.body,
      bodyKeys: req.body ? Object.keys(req.body) : []
    });
    
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    if (!follower_id || isNaN(parseInt(follower_id))) {
      return res.status(400).json({ 
        success: false, 
        message: 'Invalid follower account ID' 
      });
    }

    const followerAccount = await CopyFollowerAccount.findOne({
      where: {
        id: follower_id,
        user_id: userId
      }
    });

    if (!followerAccount) {
      return res.status(404).json({
        success: false,
        message: 'Follower account not found'
      });
    }

    // Check for open orders - block stopping if there are any open/pending orders
    const openOrdersCount = await CopyFollowerOrder.count({
      where: {
        copy_follower_account_id: follower_id,
        order_status: ['OPEN', 'PENDING', 'PARTIALLY_FILLED']
      }
    });

    // Block stopping if there are open orders
    if (openOrdersCount > 0) {
      return res.status(400).json({
        success: false,
        error_code: 'OPEN_ORDERS_EXIST',
        message: `Cannot stop following strategy while you have ${openOrdersCount} open order(s). Please close all orders before stopping.`,
        open_orders_count: openOrdersCount
      });
    }

    // Update follower account to stopped status - set all required fields
    logger.info('Updating follower account to stopped status', { follower_id, userId });
    
    await CopyFollowerAccount.update({
      status: 0,           // Set status to 0
      is_active: 0,        // Set is_active to 0  
      copy_status: 'stopped', // Set copy_status to 'stopped'
      stop_reason:  'Manually stopped by user'
    }, {
      where: { id: follower_id }
    });
    
    logger.info('Follower account updated successfully', { follower_id });

    // Update strategy provider follower count
    await StrategyProviderAccount.decrement({
      total_followers: 1,
      total_investment: parseFloat(followerAccount.investment_amount || 0)
    }, {
      where: { id: followerAccount.strategy_provider_id }
    });

    logger.info('User stopped following strategy', {
      userId,
      followerId: follower_id,
      strategyProviderId: followerAccount.strategy_provider_id
    });

    res.json({
      success: true,
      message: 'Successfully stopped following strategy',
      follower_account_id: follower_id,
      updated_fields: ['status', 'is_active', 'copy_status']
    });

  } catch (error) {
    logger.error('Failed to stop following strategy', {
      userId: req.user?.id,
      followerId: req.params?.follower_id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to stop following strategy',
      error: error.message
    });
  }
}

/**
 * Get user's copy trading overview - who they're following and total investments
 */
async function getCopyTradingOverview(req, res) {
  try {
    const user = req.user || {};
    const userId = user.sub || user.user_id || user.id;
    
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    logger.info('Getting copy trading overview for user', { userId });

    // Get all copy follower accounts for this user with strategy provider details (including inactive)
    const copyFollowerAccounts = await CopyFollowerAccount.findAll({
      where: {
        user_id: userId
        // Removed status filter to include inactive accounts
      },
      include: [{
        model: StrategyProviderAccount,
        as: 'strategyProvider',
        attributes: ['id', 'strategy_name', 'account_number', 'user_id'],
        required: false // Changed to false to avoid issues if association fails
      }],
      attributes: [
        'id',
        'strategy_provider_id',
        'account_name', 
        'account_number',
        'investment_amount',
        'initial_investment',
        'wallet_balance',
        'net_profit',
        'current_equity_ratio',
        'copy_status',
        'status',
        'is_active',
        'created_at',
        'copy_sl_mode',
        'sl_percentage',
        'sl_amount',
        'copy_tp_mode',
        'tp_percentage',
        'tp_amount'
      ],
      order: [['created_at', 'DESC']]
    });

    // Calculate totals
    let totalCurrentInvestment = 0;
    let totalInitialInvestment = 0;
    let totalWalletBalance = 0;
    let totalNetProfit = 0;

    // Format strategy provider details
    const followingStrategies = [];
    
    for (const account of copyFollowerAccounts) {
      const currentInvestment = parseFloat(account.investment_amount || 0);
      const initialInvestment = parseFloat(account.initial_investment || 0);
      const walletBalance = parseFloat(account.wallet_balance || 0);
      const netProfit = parseFloat(account.net_profit || 0);

      // Add to totals
      totalCurrentInvestment += currentInvestment;
      totalInitialInvestment += initialInvestment;
      totalWalletBalance += walletBalance;
      totalNetProfit += netProfit;

      // Get strategy provider details (fallback if association didn't work)
      let strategyProviderDetails = null;
      if (account.strategyProvider) {
        strategyProviderDetails = {
          id: account.strategyProvider.id,
          strategy_name: account.strategyProvider.strategy_name,
          account_number: account.strategyProvider.account_number
        };
      } else if (account.strategy_provider_id) {
        // Fallback: fetch strategy provider details manually
        try {
          const strategyProvider = await StrategyProviderAccount.findByPk(account.strategy_provider_id, {
            attributes: ['id', 'strategy_name', 'account_number']
          });
          if (strategyProvider) {
            strategyProviderDetails = {
              id: strategyProvider.id,
              strategy_name: strategyProvider.strategy_name,
              account_number: strategyProvider.account_number
            };
          }
        } catch (err) {
          logger.warn('Failed to fetch strategy provider details', {
            strategy_provider_id: account.strategy_provider_id,
            error: err.message
          });
        }
      }

      // Calculate individual return for this copy follower account based on realized net profit
      // Return = Net Profit / Investment * 100
      const individualReturn = currentInvestment > 0 ?
        ((netProfit / currentInvestment) * 100) : 0;

      followingStrategies.push({
        copy_follower_account_id: account.id,
        copy_follower_account_name: account.account_name,
        copy_follower_account_number: account.account_number,
        strategy_provider_id: account.strategy_provider_id,
        strategy_name: strategyProviderDetails?.strategy_name || 'Unknown Strategy',
        strategy_provider_account_number: strategyProviderDetails?.account_number || 'Unknown Account',
        user_investment_amount: currentInvestment,
        initial_investment_amount: initialInvestment,
        current_wallet_balance: walletBalance,
        net_profit: netProfit,
        current_equity_ratio: parseFloat(account.current_equity_ratio || 1.0),
        return_percentage: parseFloat(individualReturn.toFixed(2)),
        copy_status: account.copy_status,
        account_status: account.status, // 1 = active, 0 = inactive
        is_active: account.is_active, // 1 = active, 0 = inactive
        created_at: account.created_at,
        // SL/TP Settings
        copy_sl_mode: account.copy_sl_mode || 'none',
        sl_percentage: account.sl_percentage,
        sl_amount: account.sl_amount,
        copy_tp_mode: account.copy_tp_mode || 'none',
        tp_percentage: account.tp_percentage,
        tp_amount: account.tp_amount
      });
    }

    if (copyFollowerAccounts.length && followingStrategies.length === 0) {
      logger.warn('Copy trading overview detected follower accounts with zero strategies in memory', {
        userId,
        followerAccountIds: copyFollowerAccounts.map((acc) => acc.id)
      });
    } else if (copyFollowerAccounts.length !== followingStrategies.length) {
      logger.info('Copy trading overview follower account mismatch', {
        userId,
        followerAccounts: copyFollowerAccounts.length,
        strategiesBuilt: followingStrategies.length
      });
    }

    // Calculate overall return percentage using aggregate net profit
    // Total Return = Total Net Profit / Total Investment * 100
    const totalReturnPercentage = totalCurrentInvestment > 0 ?
      ((totalNetProfit / totalCurrentInvestment) * 100) : 0;

    const overview = {
      user_id: userId,
      total_strategies_following: copyFollowerAccounts.length,
      active_strategies_count: followingStrategies.filter((s) => s.copy_status === 'active').length,
      total_current_investment: totalCurrentInvestment,
      total_initial_investment: totalInitialInvestment,
      total_wallet_balance: totalWalletBalance,
      total_net_profit: totalNetProfit,
      total_return_percentage: parseFloat(totalReturnPercentage.toFixed(2)),
      following_strategies: followingStrategies
    };

    logger.info('Copy trading overview retrieved successfully', {
      userId,
      strategiesCount: followingStrategies.length,
      totalInvestment: totalCurrentInvestment
    });

    res.json({
      success: true,
      data: overview
    });

  } catch (error) {
    logger.error('Failed to get copy trading overview', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: 'Failed to get copy trading overview',
      error: error.message
    });
  }
}

module.exports = {
  createFollowerAccount,
  getFollowerAccounts,
  updateFollowerAccount,
  updateFollowerAccountStrict,
  updateFollowerSlTpSettings,
  getFollowerSlTpSettings,
  stopFollowing,
  getCopyTradingOverview
};
