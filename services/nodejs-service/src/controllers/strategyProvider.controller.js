const strategyProviderService = require('../services/strategyProvider.service');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const StrategyProviderOrder = require('../models/strategyProviderOrder.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const LiveUser = require('../models/liveUser.model');
const UserTransaction = require('../models/userTransaction.model');
const jwt = require('jsonwebtoken');
const logger = require('../services/logger.service');
const redisUserCache = require('../services/redis.user.cache.service');
const { Op } = require('sequelize');
const sequelize = require('../config/db');
const copyTradingService = require('../services/copyTrading.service');
const copyTradingRedisService = require('../services/copyTradingRedis.service');
const CopyFollowerEquityMonitorService = require('../services/copyFollowerEquityMonitor.service');
const {
  closeStrategyProviderOrderInternal,
  cancelStrategyProviderOrderInternal
} = require('./copyTrading.orders.controller');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Get user ID from JWT token
 * @param {Object} user - User object from JWT
 * @returns {number} User ID
 */
function getUserId(user) {
  return user?.sub || user?.user_id || user?.id;
}

/**
 * Archive strategy provider account
 * POST /api/strategy-providers/:id/archive
 */
async function archiveStrategyProviderAccount(req, res) {
  const strategyProviderId = parseInt(req.params.id, 10);
  const userId = getUserId(req.user);

  if (!strategyProviderId || Number.isNaN(strategyProviderId)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid strategy provider ID'
    });
  }

  if (!userId) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required'
    });
  }

  const strategyProvider = await StrategyProviderAccount.findOne({
    where: {
      id: strategyProviderId,
      user_id: userId
    }
  });

  if (!strategyProvider) {
    return res.status(404).json({
      success: false,
      message: 'Strategy provider account not found'
    });
  }

  if (strategyProvider.is_archived) {
    return res.status(400).json({
      success: false,
      message: 'Strategy provider account already archived'
    });
  }

  try {
    // Load all active copy followers for this strategy
    const followers = await CopyFollowerAccount.findAll({
      where: {
        strategy_provider_id: strategyProviderId,
        status: 1,
        is_active: 1
      },
      transaction
    });

    // Close/cancel copy follower activity using existing helpers with strict status filters
    for (const follower of followers) {
      const closeResult = await CopyFollowerEquityMonitorService.closeAllCopyFollowerOrders(follower.id, {
        allowedStatuses: ['OPEN']
      });
      if (!closeResult.success || (closeResult.errors && closeResult.errors.length)) {
        throw new Error(`Failed to close copy follower orders for follower ${follower.id}`);
      }

      const cancelResult = await CopyFollowerEquityMonitorService.cancelAllPendingCopyFollowerOrders(follower.id, {
        allowedStatuses: ['PENDING']
      });
      if (!cancelResult.success || (cancelResult.errors && cancelResult.errors.length)) {
        throw new Error(`Failed to cancel pending copy follower orders for follower ${follower.id}`);
      }

      await CopyFollowerAccount.update({
        copy_status: 'stopped',
        status: 0,
        is_active: 0,
        stop_reason: 'strategy_archived'
      }, {
        where: { id: follower.id }
      });

      await copyTradingRedisService.cleanupCopyTradingRelationship(strategyProviderId, follower.id);
    }

    // Cancel pending strategy provider orders (PENDING only)
    const pendingOrders = await StrategyProviderOrder.findAll({
      where: {
        order_user_id: strategyProviderId,
        order_status: 'PENDING'
      }
    });

    for (const order of pendingOrders) {
      await cancelStrategyProviderOrderInternal({
        strategyAccount: strategyProvider,
        order,
        cancelMessage: 'Strategy archived',
        initiator: 'strategy_archive_flow'
      });
    }

    // Close open strategy provider orders (OPEN only)
    const openOrders = await StrategyProviderOrder.findAll({
      where: {
        order_user_id: strategyProviderId,
        order_status: 'OPEN'
      }
    });

    for (const order of openOrders) {
      await closeStrategyProviderOrderInternal({
        strategyAccount: strategyProvider,
        order,
        closeMessage: 'Strategy archived',
        initiator: 'strategy_archive_flow'
      });
    }

    // Final archival updates performed atomically
    await sequelize.transaction(async (transaction) => {
      await StrategyProviderAccount.update({
        status: 0,
        is_active: 0,
        is_archived: true,
        archived_at: new Date(),
        sending_orders: 'disabled',
        total_followers: 0,
        total_investment: 0
      }, {
        where: { id: strategyProviderId },
        transaction
      });
    });

    return res.status(200).json({
      success: true,
      message: 'Strategy provider account archived successfully'
    });
  } catch (error) {
    logger.error('Failed to archive strategy provider account', {
      userId,
      strategyProviderId,
      error: error.message
    });

    return res.status(500).json({
      success: false,
      message: 'Failed to archive strategy provider account',
      error: error.message
    });
  }
}

/**
 * Create a new strategy provider account for authenticated live user
 * POST /api/strategy-providers
 */
async function createStrategyProviderAccount(req, res) {
  try {
    // Extract user ID from JWT token
    const userId = getUserId(req.user);
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }
    
    // Validate user type (only live users can create strategy provider accounts)
    if (req.user.user_type !== 'live') {
      return res.status(403).json({
        success: false,
        message: 'Only live users can create strategy provider accounts'
      });
    }
    
    // Check if user can create more accounts
    const canCreate = await strategyProviderService.canCreateMoreAccounts(userId);
    if (!canCreate) {
      return res.status(400).json({
        success: false,
        message: 'Maximum number of strategy provider accounts reached'
      });
    }

    // Check if user has minimum balance of $100 to start trading
    const liveUser = await LiveUser.findByPk(userId);
    if (!liveUser) {
      return res.status(404).json({
        success: false,
        message: 'User account not found'
      });
    }

    const userBalance = parseFloat(liveUser.wallet_balance || 0);
    const minBalance = 100.00;
    
    if (userBalance < minBalance) {
      return res.status(400).json({
        success: false,
        message: `Minimum balance of $${minBalance} required to create a strategy provider account. Current balance: $${userBalance.toFixed(2)}`
      });
    }
    
    // Validate required fields
    const { strategy_name } = req.body;
    if (!strategy_name) {
      return res.status(400).json({
        success: false,
        message: 'Strategy name is required'
      });
    }
    
    // Handle profile image upload
    let profileImageUrl = null;
    if (req.file) {
      // Generate the URL for the uploaded file
      profileImageUrl = `/uploads/strategy-profiles/${req.file.filename}`;
      
      logger.info('Profile image uploaded', {
        userId,
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size
      });
    }
    
    // Prepare strategy data with profile image
    const strategyData = {
      ...req.body,
      profile_image_url: profileImageUrl
    };
    
    // Create strategy provider account
    const strategyProvider = await strategyProviderService.createStrategyProviderAccount(
      userId, 
      strategyData
    );
    
    logger.info('Strategy provider account created successfully', {
      userId,
      strategyProviderId: strategyProvider.id,
      strategyName: strategyProvider.strategy_name,
      ip: req.ip
    });
    
    return res.status(201).json({
      success: true,
      message: 'Strategy provider account created successfully',
      data: {
        strategy_provider: strategyProvider
      }
    });
    
  } catch (error) {
    // Clean up uploaded file if strategy creation fails
    if (req.file) {
      const fs = require('fs');
      const filePath = req.file.path;
      try {
        fs.unlinkSync(filePath);
        logger.info('Cleaned up uploaded file after error', {
          userId: getUserId(req.user),
          filename: req.file.filename
        });
      } catch (cleanupError) {
        logger.error('Failed to cleanup uploaded file', {
          userId: getUserId(req.user),
          filename: req.file.filename,
          error: cleanupError.message
        });
      }
    }
    
    logger.error('Failed to create strategy provider account', {
      userId: getUserId(req.user),
      error: error.message,
      body: req.body,
      hasFile: !!req.file,
      ip: req.ip
    });
    
    // Handle specific error types
    if (error.message.includes('Strategy name already exists')) {
      return res.status(409).json({
        success: false,
        message: 'Strategy name already exists. Please choose a different name.'
      });
    }
    
    if (error.message.includes('Validation failed') || error.message.includes('Validation error')) {
      // Handle profile image validation errors specifically
      if (error.message.includes('profile_image_url')) {
        return res.status(400).json({
          success: false,
          message: 'Invalid profile image URL format'
        });
      }
      
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    
    if (error.message.includes('User not found')) {
      return res.status(404).json({
        success: false,
        message: 'User account not found or inactive'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error while creating strategy provider account'
    });
  }
}

/**
 * Get strategy provider account by ID for authenticated user
 * GET /api/strategy-providers/:id
 */
async function getStrategyProviderAccount(req, res) {
  try {
    const userId = getUserId(req.user);
    const strategyProviderId = parseInt(req.params.id);
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }
    
    if (!strategyProviderId || isNaN(strategyProviderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid strategy provider ID'
      });
    }
    
    const strategyProvider = await strategyProviderService.getStrategyProviderAccount(
      userId, 
      strategyProviderId
    );
    
    return res.status(200).json({
      success: true,
      message: 'Strategy provider account retrieved successfully',
      data: {
        strategy_provider: strategyProvider
      }
    });
    
  } catch (error) {
    logger.error('Failed to get strategy provider account', {
      userId: getUserId(req.user),
      strategyProviderId: req.params.id,
      error: error.message,
      ip: req.ip
    });
    
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        message: 'Strategy provider account not found'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error while retrieving strategy provider account'
    });
  }
}

/**
 * Get all strategy provider accounts for authenticated user
 * GET /api/strategy-providers
 */
async function getUserStrategyProviderAccounts(req, res) {
  try {
    const userId = getUserId(req.user);
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }
    
    const strategyProviders = await strategyProviderService.getUserStrategyProviderAccounts(userId);
    
    return res.status(200).json({
      success: true,
      message: 'Strategy provider accounts retrieved successfully',
      data: {
        strategy_providers: strategyProviders,
        total: strategyProviders.length
      }
    });
    
  } catch (error) {
    logger.error('Failed to get user strategy provider accounts', {
      userId: getUserId(req.user),
      error: error.message,
      ip: req.ip
    });
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error while retrieving strategy provider accounts'
    });
  }
}

/**
 * Get private strategy provider by access link (authenticated live users only)
 * GET /api/strategy-providers/private/:accessLink
 */
async function getPrivateStrategyByLink(req, res) {
  try {
    const { accessLink } = req.params;
    const userId = getUserId(req.user);
    
    if (!accessLink) {
      return res.status(400).json({
        success: false,
        message: 'Access link is required'
      });
    }
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    
    // Validate user type (only live users can access private strategies)
    if (req.user.user_type !== 'live') {
      return res.status(403).json({
        success: false,
        message: 'Only live users can access private strategies'
      });
    }
    
    const strategyProvider = await strategyProviderService.getStrategyProviderByAccessLink(accessLink, userId);
    
    logger.info('Private strategy accessed successfully', {
      userId,
      strategyProviderId: strategyProvider.id,
      accessLink,
      ip: req.ip
    });
    
    return res.status(200).json({
      success: true,
      message: 'Private strategy retrieved successfully',
      data: {
        strategy_provider: strategyProvider
      }
    });
    
  } catch (error) {
    logger.error('Failed to get private strategy by link', {
      userId: getUserId(req.user),
      accessLink: req.params.accessLink,
      error: error.message,
      ip: req.ip
    });
    
    if (error.message.includes('Cannot follow your own strategy')) {
      return res.status(403).json({
        success: false,
        message: 'Cannot follow your own strategy'
      });
    }
    
    if (error.message.includes('does not meet requirements')) {
      return res.status(400).json({
        success: false,
        message: error.message
      });
    }
    
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        message: 'Private strategy not found or inactive'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error while retrieving private strategy'
    });
  }
}

/**
 * Get catalog eligible strategy providers (public endpoint)
 * GET /api/strategy-providers/catalog
 */
async function getCatalogStrategies(req, res) {
  try {
    // This is now a public endpoint - no authentication required
    const userId = req.user ? getUserId(req.user) : null;
    
    // Extract and validate query parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    // Validate pagination limits
    if (page < 1) {
      return res.status(400).json({
        success: false,
        message: 'Page number must be greater than 0'
      });
    }
    
    if (limit < 1 || limit > 100) {
      return res.status(400).json({
        success: false,
        message: 'Limit must be between 1 and 100'
      });
    }
    
    // Build filters from query parameters
    const filters = {};
    
    // Return percentage filters
    if (req.query.min_return !== undefined) {
      const minReturn = parseFloat(req.query.min_return);
      if (!isNaN(minReturn)) {
        filters.min_return = minReturn;
      }
    }
    
    if (req.query.max_return !== undefined) {
      const maxReturn = parseFloat(req.query.max_return);
      if (!isNaN(maxReturn)) {
        filters.max_return = maxReturn;
      }
    }
    
    // Followers filter
    if (req.query.min_followers !== undefined) {
      const minFollowers = parseInt(req.query.min_followers);
      if (!isNaN(minFollowers) && minFollowers >= 0) {
        filters.min_followers = minFollowers;
      }
    }
    
    // Performance fee filter
    if (req.query.performance_fee !== undefined) {
      const performanceFee = parseFloat(req.query.performance_fee);
      if (!isNaN(performanceFee) && performanceFee >= 0 && performanceFee <= 50) {
        filters.performance_fee = performanceFee;
      }
    }
    
    // Search filter
    if (req.query.search && req.query.search.trim()) {
      filters.search = req.query.search.trim();
    }
    
    // Max drawdown filter
    if (req.query.max_drawdown !== undefined) {
      const maxDrawdown = parseFloat(req.query.max_drawdown);
      if (!isNaN(maxDrawdown) && maxDrawdown >= 0) {
        filters.max_drawdown = maxDrawdown;
      }
    }

    // Three month return filter
    if (req.query.min_three_month_return !== undefined) {
      const minThreeMonthReturn = parseFloat(req.query.min_three_month_return);
      if (!isNaN(minThreeMonthReturn)) {
        filters.min_three_month_return = minThreeMonthReturn;
      }
    }

    // Sort filter
    const validSortOptions = ['performance', 'followers', 'newest', 'performance_fee', 'three_month_return', 'drawdown'];
    if (req.query.sort_by && validSortOptions.includes(req.query.sort_by)) {
      filters.sort_by = req.query.sort_by;
    }
    
    // Get catalog strategies
    const result = await strategyProviderService.getCatalogStrategies(filters, page, limit);
    
    logger.info('Catalog strategies retrieved successfully', {
      userId,
      filters,
      page,
      limit,
      totalStrategies: result.pagination.total_items,
      ip: req.ip
    });
    
    return res.status(200).json({
      success: true,
      message: 'Strategy catalog retrieved successfully',
      data: result
    });
    
  } catch (error) {
    logger.error('Failed to get catalog strategies', {
      userId: getUserId(req.user),
      query: req.query,
      error: error.message,
      ip: req.ip
    });
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error while retrieving strategy catalog'
    });
  }
}

/**
 * Check catalog eligibility for a specific strategy provider
 * GET /api/strategy-providers/:id/catalog-eligibility
 */
async function checkCatalogEligibility(req, res) {
  try {
    const userId = getUserId(req.user);
    const strategyProviderId = parseInt(req.params.id);
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    
    // Validate user type (only live users)
    if (req.user.user_type !== 'live') {
      return res.status(403).json({
        success: false,
        message: 'Only live users can check catalog eligibility'
      });
    }
    
    if (!strategyProviderId || isNaN(strategyProviderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid strategy provider ID'
      });
    }
    
    // Check catalog eligibility
    const eligibilityResult = await strategyProviderService.checkCatalogEligibility(strategyProviderId);
    
    logger.info('Catalog eligibility checked', {
      userId,
      strategyProviderId,
      eligible: eligibilityResult.eligible,
      ip: req.ip
    });
    
    return res.status(200).json({
      success: true,
      message: 'Catalog eligibility checked successfully',
      data: {
        strategy_provider_id: strategyProviderId,
        eligibility: eligibilityResult
      }
    });
    
  } catch (error) {
    logger.error('Failed to check catalog eligibility', {
      userId: getUserId(req.user),
      strategyProviderId: req.params.id,
      error: error.message,
      ip: req.ip
    });
    
    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        message: 'Strategy provider not found'
      });
    }
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error while checking catalog eligibility'
    });
  }
}

/**
 * Switch to strategy provider account
 * POST /api/strategy-providers/:id/switch
 */
async function switchToStrategyProvider(req, res) {
  try {
    const userId = getUserId(req.user);
    const { id: strategyProviderId } = req.params;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }

    // Get strategy provider account
    const strategyProvider = await StrategyProviderAccount.findOne({
      where: {
        id: strategyProviderId,
        user_id: userId,
        status: 1,
        is_active: 1
      },
      include: [
        {
          model: CopyFollowerAccount,
          as: 'followers',
          where: { copy_status: 'active', is_active: 1 },
          required: false,
          attributes: ['id', 'user_id', 'investment_amount', 'copy_status']
        }
      ]
    });

    if (!strategyProvider) {
      return res.status(404).json({
        success: false,
        message: 'Strategy provider account not found or you do not have access'
      });
    }

    // Generate new session ID for strategy provider context
    const sessionId = `sp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create JWT payload for strategy provider account
    const jwtPayload = {
      sub: userId,
      user_type: 'live',
      account_type: 'strategy_provider',
      strategy_provider_id: strategyProvider.id,
      strategy_provider_account_number: strategyProvider.account_number,
      group: strategyProvider.group,
      leverage: strategyProvider.leverage,
      sending_orders: strategyProvider.sending_orders,
      status: strategyProvider.status,
      is_active: strategyProvider.is_active,
      session_id: sessionId,
      user_id: userId,
      role: 'strategy_provider',
      followers: strategyProvider.followers ? strategyProvider.followers.map(f => ({
        id: f.id,
        user_id: f.user_id,
        investment_amount: f.investment_amount,
        copy_status: f.copy_status
      })) : []
    };

    // Generate access token (7 days expiry)
    const token = jwt.sign(jwtPayload, JWT_SECRET, { 
      expiresIn: '7d', 
      jwtid: sessionId 
    });

    // Generate refresh token for strategy provider (7 days expiry)
    const refreshToken = jwt.sign(
      { userId: userId, sessionId, strategyProviderId: strategyProvider.id },
      JWT_SECRET + '_REFRESH',
      { expiresIn: '7d' }
    );

    // Store session in Redis (same as live users) - enforces 3 session limit
    const { storeSession } = require('../utils/redisSession.util');
    const sessionResult = await storeSession(
      userId,
      sessionId,
      {
        ...jwtPayload,
        jwt: token,
        refresh_token: refreshToken
      },
      'strategy_provider', // Use strategy_provider as userType
      refreshToken
    );

    // Log if any sessions were revoked due to limit
    if (sessionResult.revokedSessions && sessionResult.revokedSessions.length > 0) {
      logger.info('Revoked old sessions due to concurrent session limit', {
        userId,
        userType: 'strategy_provider',
        strategyProviderId: strategyProvider.id,
        revokedSessions: sessionResult.revokedSessions,
        newSessionId: sessionId
      });
    }

    // Populate Redis config for strategy provider (same as live users)
    try {
      const strategyProviderData = {
        user_id: strategyProvider.id, // Use strategy provider account ID, not live user ID
        user_type: 'strategy_provider',
        group: strategyProvider.group || 'Standard',
        leverage: parseFloat(strategyProvider.leverage) || 100,
        status: strategyProvider.status,
        is_active: strategyProvider.is_active,
        sending_orders: strategyProvider.sending_orders || 'rock',
        wallet_balance: parseFloat(strategyProvider.wallet_balance) || 0,
        auto_cutoff_level: parseFloat(strategyProvider.auto_cutoff_level) || 50.0,
        original_user_id: userId, // Keep reference to original live user
        last_updated: new Date().toISOString()
      };
      
      // CRITICAL FIX: Use strategy provider account ID as the Redis key, not live user ID
      await redisUserCache.updateUser('strategy_provider', strategyProvider.id, strategyProviderData);
      logger.info('Strategy provider config populated in Redis', {
        userId,
        strategyProviderId: strategyProvider.id,
        sending_orders: strategyProvider.sending_orders || 'rock'
      });
    } catch (cacheError) {
      logger.error('Failed to populate strategy provider config in Redis', {
        userId,
        strategyProviderId: strategyProvider.id,
        error: cacheError.message
      });
    }

    logger.info('User switched to strategy provider account', {
      userId,
      strategyProviderId: strategyProvider.id,
      sessionId
    });

    res.json({
      success: true,
      message: 'Successfully switched to strategy provider account',
      access_token: token,
      refresh_token: refreshToken,
      expires_in: 1800, // 30 minutes in seconds
      token_type: 'Bearer',
      session_id: sessionId,
      account: {
        id: strategyProvider.id,
        account_number: strategyProvider.account_number,
        strategy_name: strategyProvider.strategy_name,
        group: strategyProvider.group,
        leverage: strategyProvider.leverage,
        status: strategyProvider.status,
        is_active: strategyProvider.is_active,
        total_followers: strategyProvider.total_followers,
        followers_count: strategyProvider.followers ? strategyProvider.followers.length : 0
      }
    });

  } catch (error) {
    logger.error('Failed to switch to strategy provider account', {
      userId: req.user?.id,
      strategyProviderId: req.params?.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to switch to strategy provider account',
      error: error.message
    });
  }
}

/**
 * Switch back to live user account
 * POST /api/strategy-providers/switch-back
 */
async function switchBackToLiveUser(req, res) {
  try {
    const userId = getUserId(req.user);
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token'
      });
    }

    // Get live user account
    const liveUser = await LiveUser.findByPk(userId);
    
    if (!liveUser) {
      return res.status(404).json({
        success: false,
        message: 'Live user account not found'
      });
    }

    // Generate new session ID for live user context
    const sessionId = `live_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Create JWT payload for live user account (similar to login)
    const jwtPayload = {
      sub: liveUser.id,
      user_type: liveUser.user_type,
      mam_status: liveUser.mam_status,
      pam_status: liveUser.pam_status,
      sending_orders: liveUser.sending_orders,
      group: liveUser.group,
      account_number: liveUser.account_number,
      session_id: sessionId,
      user_id: liveUser.id,
      status: liveUser.status,
      role: 'trader',
      is_self_trading: liveUser.is_self_trading,
      is_active: liveUser.is_active,
      account_type: 'live'
    };

    // Generate access token (7 days expiry)
    const token = jwt.sign(jwtPayload, JWT_SECRET, { 
      expiresIn: '7d', 
      jwtid: sessionId 
    });

    // Generate refresh token for live user (7 days expiry)
    const refreshToken = jwt.sign(
      { userId: userId, sessionId },
      JWT_SECRET + '_REFRESH',
      { expiresIn: '7d' }
    );

    // Store session in Redis (same as live user login) - enforces 3 session limit
    const { storeSession } = require('../utils/redisSession.util');
    const sessionResult = await storeSession(
      userId,
      sessionId,
      {
        ...jwtPayload,
        jwt: token,
        refresh_token: refreshToken
      },
      'live', // Back to live user type
      refreshToken
    );

    // Log if any sessions were revoked due to limit
    if (sessionResult.revokedSessions && sessionResult.revokedSessions.length > 0) {
      logger.info('Revoked old sessions due to concurrent session limit', {
        userId,
        userType: 'live',
        revokedSessions: sessionResult.revokedSessions,
        newSessionId: sessionId
      });
    }

    logger.info('User switched back to live user account', {
      userId,
      sessionId
    });

    res.json({
      success: true,
      message: 'Successfully switched back to live user account',
      access_token: token,
      refresh_token: refreshToken,
      expires_in: 1800, // 30 minutes in seconds
      token_type: 'Bearer',
      session_id: sessionId,
      account: {
        id: liveUser.id,
        account_number: liveUser.account_number,
        group: liveUser.group,
        user_type: liveUser.user_type,
        status: liveUser.status,
        is_active: liveUser.is_active,
        wallet_balance: liveUser.wallet_balance,
        equity: liveUser.equity
      }
    });

  } catch (error) {
    logger.error('Failed to switch back to live user account', {
      userId: req.user?.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to switch back to live user account',
      error: error.message
    });
  }
}

/**
 * Refresh strategy provider access token
 * POST /api/strategy-providers/refresh-token
 */
async function refreshStrategyProviderToken(req, res) {
  const { refresh_token: refreshToken } = req.body;
  const { validateRefreshToken, deleteRefreshToken, storeSession } = require('../utils/redisSession.util');
  
  if (!refreshToken) {
    return res.status(400).json({ 
      success: false, 
      message: 'Refresh token is required' 
    });
  }

  try {
    // Verify the refresh token
    const decoded = jwt.verify(refreshToken, JWT_SECRET + '_REFRESH');
    
    // Check if the refresh token exists in Redis and is valid
    const tokenData = await validateRefreshToken(refreshToken);
    if (!tokenData || tokenData.userId !== decoded.userId || tokenData.sessionId !== decoded.sessionId) {
      await deleteRefreshToken(refreshToken);
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid or expired refresh token' 
      });
    }

    // Get strategy provider account
    const strategyProvider = await StrategyProviderAccount.findOne({
      where: {
        id: decoded.strategyProviderId,
        user_id: decoded.userId,
        status: 1,
        is_active: 1
      }
    });

    if (!strategyProvider) {
      await deleteRefreshToken(refreshToken);
      return res.status(404).json({ 
        success: false, 
        message: 'Strategy provider account not found' 
      });
    }

    // Generate new tokens
    const sessionId = tokenData.sessionId;
    const jwtPayload = {
      sub: decoded.userId,
      user_type: 'live',
      account_type: 'strategy_provider',
      strategy_provider_id: strategyProvider.id,
      strategy_provider_account_number: strategyProvider.account_number,
      group: strategyProvider.group,
      leverage: strategyProvider.leverage,
      sending_orders: strategyProvider.sending_orders,
      status: strategyProvider.status,
      is_active: strategyProvider.is_active,
      session_id: sessionId,
      user_id: decoded.userId,
      role: 'strategy_provider'
    };
    
    const newAccessToken = jwt.sign(jwtPayload, JWT_SECRET, { 
      expiresIn: '7d', 
      jwtid: sessionId 
    });

    const newRefreshToken = jwt.sign(
      { userId: decoded.userId, sessionId, strategyProviderId: strategyProvider.id },
      JWT_SECRET + '_REFRESH',
      { expiresIn: '7d' }
    );

    // Update session in Redis
    await storeSession(
      decoded.userId,
      sessionId,
      {
        ...jwtPayload,
        jwt: newAccessToken,
        refresh_token: newRefreshToken
      },
      'strategy_provider',
      newRefreshToken
    );

    // Delete old refresh token
    await deleteRefreshToken(refreshToken);

    return res.status(200).json({
      success: true,
      message: 'Token refreshed successfully',
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      expires_in: 1800,
      token_type: 'Bearer',
      session_id: sessionId
    });
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      await deleteRefreshToken(refreshToken);
      return res.status(401).json({ 
        success: false, 
        message: 'Your session has expired. Please login again.' 
      });
    }
    
    logger.error('Failed to refresh strategy provider token', {
      error: error.message
    });
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error while refreshing token'
    });
  }
}

/**
 * Update catalog eligibility based on minimum balance requirement
 * POST /api/strategy-providers/update-catalog-eligibility
 */
async function updateCatalogEligibilityByBalance(req, res) {
  try {
    // This endpoint should be restricted to admin users or system processes
    const userId = getUserId(req.user);
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // Update catalog eligibility
    const result = await strategyProviderService.updateCatalogEligibilityByBalance();
    
    logger.info('Catalog eligibility updated by balance requirement', {
      userId,
      removedCount: result.removed_count,
      ip: req.ip
    });

    return res.status(200).json({
      success: true,
      message: 'Catalog eligibility updated successfully',
      data: result
    });

  } catch (error) {
    logger.error('Failed to update catalog eligibility by balance', {
      userId: getUserId(req.user),
      error: error.message,
      ip: req.ip
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error while updating catalog eligibility'
    });
  }
}

/**
 * Check trading eligibility for strategy provider
 * GET /api/strategy-providers/:id/trading-eligibility
 */
async function checkTradingEligibility(req, res) {
  try {
    const userId = getUserId(req.user);
    const strategyProviderId = parseInt(req.params.id);
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    
    if (!strategyProviderId || isNaN(strategyProviderId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid strategy provider ID'
      });
    }

    // Check trading eligibility
    const eligibilityResult = await strategyProviderService.checkTradingEligibility(strategyProviderId);
    
    logger.info('Trading eligibility checked', {
      userId,
      strategyProviderId,
      eligible: eligibilityResult.eligible,
      ip: req.ip
    });

    return res.status(200).json({
      success: true,
      message: 'Trading eligibility checked successfully',
      data: {
        strategy_provider_id: strategyProviderId,
        eligibility: eligibilityResult
      }
    });

  } catch (error) {
    logger.error('Failed to check trading eligibility', {
      userId: getUserId(req.user),
      strategyProviderId: req.params.id,
      error: error.message,
      ip: req.ip
    });

    return res.status(500).json({
      success: false,
      message: 'Internal server error while checking trading eligibility'
    });
  }
}

/**
 * Logout from strategy provider account
 * POST /api/strategy-providers/logout
 */
async function logoutStrategyProvider(req, res) {
  const { userId, sessionId, originalUserId, originalUserType } = req.user;
  const { refresh_token: refreshToken } = req.body;

  try {
    // Invalidate the strategy provider session and refresh token in Redis
    const { deleteSession } = require('../utils/redisSession.util');
    await deleteSession(userId, sessionId, 'strategy_provider', refreshToken);

    // Also invalidate the original live user session if it exists
    if (originalUserId && originalUserType) {
      try {
        // Find and invalidate all sessions for the original user
        const { redisCluster } = require('../../config/redis');
        const sessionPattern = `session:${originalUserType}:${originalUserId}:*`;
        
        // Use SCAN to find all session keys for the original user
        let cursor = '0';
        do {
          const result = await redisCluster.scan(cursor, 'MATCH', sessionPattern, 'COUNT', 100);
          cursor = result[0];
          const keys = result[1];
          
          if (keys && keys.length > 0) {
            await redisCluster.del(...keys);
            logger.info('Invalidated original user sessions', {
              originalUserId,
              originalUserType,
              sessionCount: keys.length
            });
          }
        } while (cursor !== '0');
        
      } catch (originalUserError) {
        logger.warn('Failed to invalidate original user sessions', {
          originalUserId,
          originalUserType,
          error: originalUserError.message
        });
        // Don't fail the logout if original user session cleanup fails
      }
    }

    logger.info('Strategy provider logged out successfully', {
      userId,
      sessionId,
      originalUserId,
      originalUserType
    });

    return res.status(200).json({ 
      success: true, 
      message: 'Logout successful' 
    });
  } catch (error) {
    logger.error('Failed to logout strategy provider', {
      userId,
      sessionId,
      error: error.message
    });
    
    return res.status(500).json({
      success: false,
      message: 'Internal server error during logout'
    });
  }
}

/**
 * Get strategy provider performance fee earnings overview with date filtering and daily aggregation
 * GET /api/strategy-providers/performance-fee-earnings
 * Query parameters:
 * - strategy_provider_id: Strategy provider ID (required if not using strategy provider JWT)
 * - from_date: Start date (YYYY-MM-DD format, optional)
 * - to_date: End date (YYYY-MM-DD format, optional)
 * - aggregation: 'daily' (default) or 'raw' for individual transactions
 */
async function getPerformanceFeeEarnings(req, res) {
  try {
    // Handle both strategy provider JWT and main account JWT
    let strategyProviderId = req.user?.strategy_provider_id;
    
    // If not strategy provider JWT, check if it's main account accessing specific strategy
    if (!strategyProviderId) {
      const requestedStrategyId = req.query.strategy_provider_id || req.params.strategy_provider_id;
      const userId = getUserId(req.user);
      
      if (!requestedStrategyId || !userId) {
        return res.status(401).json({
          success: false,
          message: 'Strategy provider ID required or strategy provider authentication required'
        });
      }
      
      // Parse strategy provider ID as integer
      const parsedStrategyId = parseInt(requestedStrategyId);
      if (isNaN(parsedStrategyId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid strategy provider ID format'
        });
      }
      
      // Verify the user owns this strategy provider account
      const strategyAccount = await StrategyProviderAccount.findOne({
        where: {
          id: parsedStrategyId,
          user_id: userId
        }
      });
      
      if (!strategyAccount) {
        return res.status(403).json({
          success: false,
          message: 'Strategy provider account not found or access denied'
        });
      }
      
      strategyProviderId = parsedStrategyId;
    }

    // Parse query parameters for date filtering
    const { from_date, to_date, aggregation = 'daily' } = req.query;
    
    // Validate date parameters
    let fromDate = null;
    let toDate = null;
    
    if (from_date) {
      fromDate = new Date(from_date);
      if (isNaN(fromDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid from_date format. Use YYYY-MM-DD format.'
        });
      }
      // Set to start of day
      fromDate.setHours(0, 0, 0, 0);
    }
    
    if (to_date) {
      toDate = new Date(to_date);
      if (isNaN(toDate.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid to_date format. Use YYYY-MM-DD format.'
        });
      }
      // Set to end of day
      toDate.setHours(23, 59, 59, 999);
    }
    
    // If no date range specified, default to last 1000 days
    if (!fromDate && !toDate) {
      toDate = new Date();
      toDate.setHours(23, 59, 59, 999);
      fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 1000);
      fromDate.setHours(0, 0, 0, 0);
    }

    logger.info('Getting performance fee earnings for strategy provider', { 
      strategyProviderId,
      fromDate: fromDate?.toISOString(),
      toDate: toDate?.toISOString(),
      aggregation,
      rawQuery: req.query
    });

    // Build where clause for performance fee transactions
    const performanceFeeWhere = {
      user_id: strategyProviderId,
      user_type: 'strategy_provider',
      type: 'performance_fee_earned',
      status: 'completed'
    };
    
    // Add date filters if specified
    if (fromDate || toDate) {
      performanceFeeWhere.created_at = {};
      if (fromDate) performanceFeeWhere.created_at[Op.gte] = fromDate;
      if (toDate) performanceFeeWhere.created_at[Op.lte] = toDate;
    }

    // Query performance fee transactions
    const performanceFeeTransactions = await UserTransaction.findAll({
      where: performanceFeeWhere,
      attributes: [
        'amount',
        'created_at'
      ],
      order: [['created_at', 'ASC']],
      raw: true
    });

    // Build where clause for copy follower investments
    const investmentWhere = {
      strategy_provider_id: strategyProviderId
    };
    
    // Add date filters for investments if specified
    if (fromDate || toDate) {
      investmentWhere.created_at = {};
      if (fromDate) investmentWhere.created_at[Op.gte] = fromDate;
      if (toDate) investmentWhere.created_at[Op.lte] = toDate;
    }

    // Query copy follower investments
    const copyFollowerInvestments = await CopyFollowerAccount.findAll({
      where: investmentWhere,
      attributes: [
        'investment_amount',
        'created_at'
      ],
      order: [['created_at', 'ASC']],
      raw: true
    });

    let totalEarnings = 0;
    let chartTransactions = [];
    let investmentTransactions = [];

    logger.info('Processing aggregation', { aggregation, aggregationType: typeof aggregation });
    
    if (aggregation === 'daily') {
      logger.info('Using daily aggregation path');
      // Aggregate performance fees by day
      const dailyEarnings = {};
      performanceFeeTransactions.forEach(txn => {
        const amount = parseFloat(txn.amount || 0);
        totalEarnings += amount;
        
        const dateKey = new Date(txn.created_at).toISOString().split('T')[0]; // YYYY-MM-DD
        if (!dailyEarnings[dateKey]) {
          dailyEarnings[dateKey] = 0;
        }
        dailyEarnings[dateKey] += amount;
      });

      // Convert to array format for frontend
      chartTransactions = Object.entries(dailyEarnings).map(([date, amount]) => ({
        date: date,
        amount: parseFloat(amount.toFixed(2))
      }));

      // Aggregate investments by day
      const dailyInvestments = {};
      copyFollowerInvestments.forEach(investment => {
        const amount = parseFloat(investment.investment_amount || 0);
        const dateKey = new Date(investment.created_at).toISOString().split('T')[0]; // YYYY-MM-DD
        if (!dailyInvestments[dateKey]) {
          dailyInvestments[dateKey] = 0;
        }
        dailyInvestments[dateKey] += amount;
      });

      // Convert to array format for frontend
      investmentTransactions = Object.entries(dailyInvestments).map(([date, amount]) => ({
        date: date,
        amount: parseFloat(amount.toFixed(2))
      }));
    } else {
      logger.info('Using raw transactions path');
      // Raw transactions (individual records)
      chartTransactions = performanceFeeTransactions.map(txn => {
        const amount = parseFloat(txn.amount || 0);
        totalEarnings += amount;
        
        return {
          amount: amount,
          date: txn.created_at
        };
      });

      investmentTransactions = copyFollowerInvestments.map(investment => ({
        amount: parseFloat(investment.investment_amount || 0),
        date: investment.created_at
      }));
    }

    const response = {
      strategy_provider_id: strategyProviderId,
      total_performance_fee_earned: parseFloat(totalEarnings.toFixed(2)),
      total_fee_transactions: performanceFeeTransactions.length,
      aggregation: aggregation,
      date_range: {
        from_date: fromDate?.toISOString().split('T')[0] || null,
        to_date: toDate?.toISOString().split('T')[0] || null
      },
      performance_fee_transactions: chartTransactions,
      copy_follower_investments: investmentTransactions
    };

    logger.info('Performance fee earnings retrieved successfully', {
      strategyProviderId,
      totalEarnings: totalEarnings.toFixed(2),
      totalTransactions: performanceFeeTransactions.length,
      aggregation,
      dateRange: response.date_range,
      performanceFeeTransactions: chartTransactions.length,
      copyFollowerInvestments: investmentTransactions.length
    });

    res.json({
      success: true,
      message: 'Performance fee earnings retrieved successfully',
      data: response
    });

  } catch (error) {
    logger.error('Failed to get performance fee earnings', {
      strategyProviderId: req.user?.strategy_provider_id,
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: 'Failed to get performance fee earnings',
      error: error.message
    });
  }
}

/**
 * Get copy follower investment details for strategy provider
 * GET /api/strategy-providers/copy-follower-investments
 * Returns: account number, copy status, net profit, total fees earned from each copy follower
 */
async function getCopyFollowerInvestments(req, res) {
  try {
    // Handle both strategy provider JWT and main account JWT
    let strategyProviderId = req.user?.strategy_provider_id;
    
    // If not strategy provider JWT, check if it's main account accessing specific strategy
    if (!strategyProviderId) {
      const requestedStrategyId = req.query.strategy_provider_id || req.params.strategy_provider_id;
      const userId = getUserId(req.user);
      
      if (!requestedStrategyId || !userId) {
        return res.status(401).json({
          success: false,
          message: 'Strategy provider ID required or strategy provider authentication required'
        });
      }
      
      // Parse strategy provider ID as integer
      const parsedStrategyId = parseInt(requestedStrategyId);
      if (isNaN(parsedStrategyId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid strategy provider ID format'
        });
      }
      
      // Verify the user owns this strategy provider account
      const strategyAccount = await StrategyProviderAccount.findOne({
        where: {
          id: parsedStrategyId,
          user_id: userId,
          status: 1,
          is_active: 1
        }
      });
      
      if (!strategyAccount) {
        return res.status(403).json({
          success: false,
          message: 'Strategy provider account not found or access denied'
        });
      }
      
      strategyProviderId = parsedStrategyId;
    }

    logger.info('Getting copy follower investments for strategy provider', { 
      strategyProviderId
    });

    // Get all copy follower accounts for this strategy provider
    const copyFollowerAccounts = await CopyFollowerAccount.findAll({
      where: {
        strategy_provider_id: strategyProviderId
      },
      attributes: [
        'id',
        'account_number',
        'account_name',
        'copy_status',
        'net_profit',
        'investment_amount',
        'initial_investment',
        'total_fees_paid',
        'subscription_date',
        'last_copy_date',
        'user_id'
      ],
      order: [['subscription_date', 'DESC']]
    });

    // Get performance fees earned from each copy follower
    const copyFollowerIds = copyFollowerAccounts.map(account => account.id);
    
    let performanceFeesEarned = [];
    if (copyFollowerIds.length > 0) {
      performanceFeesEarned = await UserTransaction.findAll({
        where: {
          user_id: strategyProviderId,
          user_type: 'strategy_provider',
          type: 'performance_fee_earned',
          status: 'completed'
        },
        attributes: [
          'id',
          'metadata',
          'amount',
          'created_at'
        ],
        raw: true
      });

      logger.info('Performance fee transactions found', {
        strategyProviderId,
        transactionCount: performanceFeesEarned.length,
        transactions: performanceFeesEarned.map(t => ({
          id: t.id,
          amount: t.amount,
          metadata: t.metadata
        }))
      });

      // Also check for any copy follower orders to see if there have been profitable closures
      const CopyFollowerOrder = require('../models/copyFollowerOrder.model');
      const copyFollowerOrders = await CopyFollowerOrder.findAll({
        where: {
          strategy_provider_id: strategyProviderId,
          order_status: 'CLOSED'
        },
        attributes: ['order_id', 'net_profit', 'performance_fee_amount', 'fee_status'],
        raw: true
      });

      logger.info('Copy follower closed orders found', {
        strategyProviderId,
        closedOrderCount: copyFollowerOrders.length,
        orders: copyFollowerOrders.map(o => ({
          order_id: o.order_id,
          net_profit: o.net_profit,
          performance_fee_amount: o.performance_fee_amount,
          fee_status: o.fee_status
        }))
      });
    }

    // Group performance fees by copy follower user ID
    const feesByFollower = {};
    performanceFeesEarned.forEach(fee => {
      try {
        const metadata = typeof fee.metadata === 'string' ? JSON.parse(fee.metadata) : fee.metadata;
        const copyFollowerUserId = metadata?.copy_follower_user_id;
        
        logger.info('Processing performance fee metadata', {
          feeId: fee.id,
          amount: fee.amount,
          metadataType: typeof fee.metadata,
          parsedMetadata: metadata,
          copyFollowerUserId,
          willAddToFees: !!copyFollowerUserId
        });
        
        if (copyFollowerUserId) {
          if (!feesByFollower[copyFollowerUserId]) {
            feesByFollower[copyFollowerUserId] = {
              total_fees_earned: 0,
              fee_transactions: 0
            };
          }
          feesByFollower[copyFollowerUserId].total_fees_earned += parseFloat(fee.amount || 0);
          feesByFollower[copyFollowerUserId].fee_transactions += 1;
        }
      } catch (error) {
        logger.warn('Failed to parse performance fee metadata', { 
          feeId: fee.id,
          error: error.message 
        });
      }
    });

    logger.info('Final feesByFollower object', {
      strategyProviderId,
      feesByFollower,
      copyFollowerAccountIds: copyFollowerAccounts.map(a => a.id),
      copyFollowerUserIds: copyFollowerAccounts.map(a => a.user_id)
    });

    // Format response data
    const copyFollowerInvestments = copyFollowerAccounts.map(account => {
      // Match against copy follower account ID, not live user ID
      const feesData = feesByFollower[account.id] || { 
        total_fees_earned: 0, 
        fee_transactions: 0 
      };

      return {
        copy_follower_account_id: account.id,
        account_number: account.account_number,
        account_name: account.account_name,
        copy_status: account.copy_status,
        investment_amount: parseFloat(account.investment_amount || 0),
        initial_investment: parseFloat(account.initial_investment || 0),
        net_profit: parseFloat(account.net_profit || 0),
        total_fees_paid_by_follower: parseFloat(account.total_fees_paid || 0),
        total_fees_earned_from_follower: parseFloat(feesData.total_fees_earned.toFixed(2)),
        fee_transactions_count: feesData.fee_transactions,
        subscription_date: account.subscription_date,
        last_copy_date: account.last_copy_date,
        // Calculate performance metrics
        roi_percentage: account.initial_investment > 0 
          ? parseFloat(((parseFloat(account.net_profit || 0) / parseFloat(account.initial_investment || 0)) * 100).toFixed(2))
          : 0,
        current_equity: parseFloat((parseFloat(account.investment_amount || 0) + parseFloat(account.net_profit || 0)).toFixed(2))
      };
    });

    // Calculate summary statistics
    const totalInvestments = copyFollowerInvestments.reduce((sum, inv) => sum + inv.investment_amount, 0);
    const totalFeesEarned = copyFollowerInvestments.reduce((sum, inv) => sum + inv.total_fees_earned_from_follower, 0);
    const totalNetProfit = copyFollowerInvestments.reduce((sum, inv) => sum + inv.net_profit, 0);
    const activeFollowers = copyFollowerInvestments.filter(inv => inv.copy_status === 'active').length;

    const response = {
      strategy_provider_id: strategyProviderId,
      summary: {
        total_copy_followers: copyFollowerInvestments.length,
        active_copy_followers: activeFollowers,
        total_investments: parseFloat(totalInvestments.toFixed(2)),
        total_fees_earned: parseFloat(totalFeesEarned.toFixed(2)),
        total_follower_net_profit: parseFloat(totalNetProfit.toFixed(2)),
        average_investment: copyFollowerInvestments.length > 0 
          ? parseFloat((totalInvestments / copyFollowerInvestments.length).toFixed(2))
          : 0
      },
      copy_follower_investments: copyFollowerInvestments
    };

    logger.info('Copy follower investments retrieved successfully', {
      strategyProviderId,
      totalFollowers: copyFollowerInvestments.length,
      activeFollowers,
      totalInvestments: totalInvestments.toFixed(2),
      totalFeesEarned: totalFeesEarned.toFixed(2)
    });

    res.json({
      success: true,
      message: 'Copy follower investments retrieved successfully',
      data: response
    });

  } catch (error) {
    logger.error('Failed to get copy follower investments', {
      strategyProviderId: req.user?.strategy_provider_id,
      error: error.message,
      stack: error.stack
    });

    res.status(500).json({
      success: false,
      message: 'Failed to get copy follower investments',
      error: error.message
    });
  }
}

module.exports = {
  createStrategyProviderAccount,
  getStrategyProviderAccount,
  getUserStrategyProviderAccounts,
  getPrivateStrategyByLink,
  getCatalogStrategies,
  checkCatalogEligibility,
  updateCatalogEligibilityByBalance,
  checkTradingEligibility,
  switchToStrategyProvider,
  switchBackToLiveUser,
  refreshStrategyProviderToken,
  logoutStrategyProvider,
  getPerformanceFeeEarnings,
  getCopyFollowerInvestments
};
