const strategyProviderService = require('../services/strategyProvider.service');
const logger = require('../services/logger.service');

/**
 * Get user ID from JWT token
 * @param {Object} user - User object from JWT
 * @returns {number} User ID
 */
function getUserId(user) {
  return user?.sub || user?.user_id || user?.id;
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
    
    // Validate required fields
    const { strategy_name } = req.body;
    if (!strategy_name) {
      return res.status(400).json({
        success: false,
        message: 'Strategy name is required'
      });
    }
    
    // Create strategy provider account
    const strategyProvider = await strategyProviderService.createStrategyProviderAccount(
      userId, 
      req.body
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
    logger.error('Failed to create strategy provider account', {
      userId: getUserId(req.user),
      error: error.message,
      body: req.body,
      ip: req.ip
    });
    
    // Handle specific error types
    if (error.message.includes('Strategy name already exists')) {
      return res.status(409).json({
        success: false,
        message: 'Strategy name already exists. Please choose a different name.'
      });
    }
    
    if (error.message.includes('Validation failed')) {
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

module.exports = {
  createStrategyProviderAccount,
  getStrategyProviderAccount,
  getUserStrategyProviderAccounts,
  getPrivateStrategyByLink
};
