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
 * Get catalog eligible strategy providers for authenticated live users
 * GET /api/strategy-providers/catalog
 */
async function getCatalogStrategies(req, res) {
  try {
    const userId = getUserId(req.user);
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    
    // Validate user type (only live users can access catalog)
    if (req.user.user_type !== 'live') {
      return res.status(403).json({
        success: false,
        message: 'Only live users can access strategy catalog'
      });
    }
    
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
    
    // Sort filter
    const validSortOptions = ['performance', 'followers', 'newest', 'performance_fee'];
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

module.exports = {
  createStrategyProviderAccount,
  getStrategyProviderAccount,
  getUserStrategyProviderAccounts,
  getPrivateStrategyByLink,
  getCatalogStrategies,
  checkCatalogEligibility
};
