const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
const LiveUser = require('../models/liveUser.model');
const logger = require('../services/logger.service');
const strategyProviderService = require('../services/strategyProvider.service');

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

    // Validate investment amount
    if (parseFloat(investment_amount) < 100) {
      return res.status(400).json({
        success: false,
        message: 'Minimum investment amount is $100'
      });
    }

    // Get strategy provider and validate
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

    // Check if strategy provider has minimum balance to accept followers
    const strategyProviderEquity = parseFloat(strategyProvider.wallet_balance || 0) + parseFloat(strategyProvider.net_profit || 0);
    const minStrategyBalance = 100.00;
    
    if (strategyProviderEquity < minStrategyBalance) {
      return res.status(400).json({
        success: false,
        message: `Strategy provider does not meet minimum balance requirement of $${minStrategyBalance}. Current equity: $${strategyProviderEquity.toFixed(2)}`
      });
    }

    // Check if user is trying to follow their own strategy
    if (strategyProvider.user_id === userId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot follow your own strategy'
      });
    }

    // Validate investment amount meets strategy requirements
    if (strategyProvider.min_investment && parseFloat(investment_amount) < parseFloat(strategyProvider.min_investment)) {
      return res.status(400).json({
        success: false,
        message: `Minimum investment for this strategy is $${strategyProvider.min_investment}`
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
      return res.status(400).json({
        success: false,
        message: 'You are already following this strategy'
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

    // Check if user has sufficient balance and meets minimum balance requirement
    const userBalance = parseFloat(liveUser.wallet_balance || 0);
    const investmentAmountFloat = parseFloat(investment_amount);
    const minBalance = 100.00;
    
    // Check minimum balance requirement
    if (userBalance < minBalance) {
      return res.status(400).json({
        success: false,
        message: `Minimum balance of $${minBalance} required to start copy trading. Current balance: $${userBalance.toFixed(2)}`
      });
    }
    
    // Check if user has sufficient balance for investment
    if (userBalance < investmentAmountFloat) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. Required: $${investmentAmountFloat}, Available: $${userBalance}`
      });
    }

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

    const followerAccount = await CopyFollowerAccount.create(followerData);

    // Deduct investment amount from user's main account balance
    await LiveUser.decrement({
      wallet_balance: investmentAmountFloat
    }, {
      where: { id: userId }
    });

    // Update strategy provider follower count and total investment
    await StrategyProviderAccount.increment({
      total_followers: 1,
      total_investment: investmentAmountFloat
    }, {
      where: { id: strategy_provider_id }
    });

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
      body: req.body
    });

    res.status(500).json({
      success: false,
      message: 'Failed to create follower account',
      error: error.message
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
 * Update copy follower account settings
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
 * Stop following a strategy (close follower account)
 */
async function stopFollowing(req, res) {
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

    // Check for open orders before allowing unfollowing
    const openOrdersCount = await CopyFollowerOrder.count({
      where: {
        order_user_id: follower_id,
        order_status: ['OPEN', 'PENDING', 'PARTIALLY_FILLED']
      }
    });

    if (openOrdersCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot stop following strategy. You have ${openOrdersCount} open order(s). Please close all open positions before unfollowing.`,
        open_orders_count: openOrdersCount
      });
    }

    // Update follower account to stopped status
    await CopyFollowerAccount.update({
      copy_status: 'stopped',
      is_active: 0,
      stop_reason: req.body.reason || 'Manually stopped by user'
    }, {
      where: { id: follower_id }
    });

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
      message: 'Successfully stopped following strategy'
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

module.exports = {
  createFollowerAccount,
  getFollowerAccounts,
  updateFollowerAccount,
  stopFollowing
};
