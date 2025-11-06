const logger = require('../services/logger.service');
const UserFavorite = require('../models/userFavorite.model');
const SymbolModel = require('../models/symbol.model');
const UserStrategyProviderFavorite = require('../models/userStrategyProviderFavorite.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');

function normalizeSymbol(sym) {
  if (!sym || typeof sym !== 'string') return null;
  return sym.trim().toUpperCase();
}

function getAuthUser(req) {
  // JWT payload fields observed in project: sub, user_id, user_type, account_type, is_active, strategy_provider_id
  const user = req.user || {};
  const isActive = !!user.is_active;
  
  // Handle strategy provider context
  if (user.account_type === 'strategy_provider' && user.strategy_provider_id) {
    return {
      userId: user.strategy_provider_id, // Use strategy provider ID for favorites
      userType: 'strategy_provider',
      isActive
    };
  }
  
  // Handle regular live/demo users
  const userId = user.sub || user.user_id || user.id;
  const userType = (user.user_type || user.account_type || 'live').toString().toLowerCase();
  return { userId, userType, isActive };
}

async function addFavorite(req, res) {
  const operationId = `fav_add_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try {
    const { userId, userType, isActive } = getAuthUser(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }

    const symbolRaw = req.body?.symbol;
    const symbol = normalizeSymbol(symbolRaw);
    if (!symbol) {
      return res.status(400).json({ success: false, message: 'symbol is required' });
    }

    // Lookup symbol id efficiently by name (indexed in DB by primary key; ensure name column has index if needed)
    const sym = await SymbolModel.findOne({ where: { name: symbol }, attributes: ['id', 'name'] });
    if (!sym) {
      return res.status(404).json({ success: false, message: 'Symbol not found' });
    }

    logger.transactionStart('favorite_add', { operationId, userId, symbol });

    // Idempotent add using unique constraint (user_id, symbol_id, user_type)
    const [fav, created] = await UserFavorite.findOrCreate({
      where: { user_id: userId, user_type: userType, symbol_id: sym.id },
      defaults: { user_id: userId, user_type: userType, symbol_id: sym.id },
    });

    logger.transactionSuccess('favorite_add', { operationId, userId, symbol, created });

    return res.status(created ? 201 : 200).json({
      success: true,
      message: created ? 'Added to favorites' : 'Already in favorites',
      data: { id: fav.id, user_id: userId, user_type: userType, symbol: sym.name, symbol_id: sym.id },
    });
  } catch (error) {
    logger.transactionFailure('favorite_add', error, {});
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function removeFavorite(req, res) {
  const operationId = `fav_remove_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try {
    const { userId, userType, isActive } = getAuthUser(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }

    const symbolRaw = req.body?.symbol;
    const symbol = normalizeSymbol(symbolRaw);
    if (!symbol) {
      return res.status(400).json({ success: false, message: 'symbol is required' });
    }

    const sym = await SymbolModel.findOne({ where: { name: symbol }, attributes: ['id', 'name'] });
    if (!sym) {
      // Treat missing symbol as 404 so client knows invalid symbol payload
      return res.status(404).json({ success: false, message: 'Symbol not found' });
    }

    logger.transactionStart('favorite_remove', { operationId, userId, symbol });

    const removed = await UserFavorite.destroy({ where: { user_id: userId, user_type: userType, symbol_id: sym.id } });

    logger.transactionSuccess('favorite_remove', { operationId, userId, symbol, removed });

    return res.status(200).json({
      success: true,
      message: removed ? 'Removed from favorites' : 'Not present in favorites',
      removed: removed > 0,
    });
  } catch (error) {
    logger.transactionFailure('favorite_remove', error, {});
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

async function getFavorites(req, res) {
  const operationId = `fav_get_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try {
    const { userId, userType, isActive } = getAuthUser(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }

    logger.transactionStart('favorite_get', { operationId, userId });

    const rows = await UserFavorite.findAll({
      where: { user_id: userId, user_type: userType },
      include: [{ model: SymbolModel, as: 'symbol', attributes: ['id', 'name'] }],
      order: [['created_at', 'DESC']],
    });

    const symbols = rows.map(r => r.symbol?.name).filter(Boolean);

    logger.transactionSuccess('favorite_get', { operationId, userId, count: symbols.length });

    return res.status(200).json({symbols});
  } catch (error) {
    logger.transactionFailure('favorite_get', error, {});
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// ==================== STRATEGY PROVIDER FAVORITES ====================

/**
 * Add a strategy provider to user's favorites
 * POST /api/favorites/strategy-providers
 */
async function addStrategyProviderFavorite(req, res) {
  const operationId = `sp_fav_add_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try {
    const { userId, userType, isActive } = getAuthUser(req);
    
    // Only allow live users to favorite strategy providers
    if (!userId || userType !== 'live') {
      return res.status(401).json({ success: false, message: 'Unauthorized - Only live users can favorite strategy providers' });
    }
    if (!isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }

    const strategyProviderId = parseInt(req.body?.strategy_provider_id);
    if (!strategyProviderId || strategyProviderId <= 0) {
      return res.status(400).json({ success: false, message: 'strategy_provider_id is required and must be a positive integer' });
    }

    // Verify strategy provider exists and is active
    const strategyProvider = await StrategyProviderAccount.findOne({ 
      where: { 
        id: strategyProviderId,
        status: 1,
        is_active: 1,
        visibility: 'public' // Only allow favoriting public strategy providers
      },
      attributes: ['id', 'strategy_name', 'user_id', 'total_followers', 'performance_fee', 'total_return_percentage']
    });

    if (!strategyProvider) {
      return res.status(404).json({ success: false, message: 'Strategy provider not found or not available for favoriting' });
    }

    // Prevent users from favoriting their own strategy provider accounts
    if (strategyProvider.user_id === userId) {
      return res.status(400).json({ success: false, message: 'Cannot favorite your own strategy provider account' });
    }

    logger.transactionStart('sp_favorite_add', { operationId, userId, strategyProviderId });

    // Idempotent add using unique constraint (user_id, strategy_provider_id, user_type)
    const [favorite, created] = await UserStrategyProviderFavorite.findOrCreate({
      where: { user_id: userId, user_type: userType, strategy_provider_id: strategyProviderId },
      defaults: { user_id: userId, user_type: userType, strategy_provider_id: strategyProviderId },
    });

    logger.transactionSuccess('sp_favorite_add', { operationId, userId, strategyProviderId, created });

    return res.status(created ? 201 : 200).json({
      success: true,
      message: created ? 'Strategy provider added to favorites' : 'Strategy provider already in favorites',
      data: { 
        id: favorite.id, 
        user_id: userId, 
        user_type: userType, 
        strategy_provider_id: strategyProviderId,
        strategy_name: strategyProvider.strategy_name
      },
    });
  } catch (error) {
    logger.transactionFailure('sp_favorite_add', error, { operationId });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * Remove a strategy provider from user's favorites
 * DELETE /api/favorites/strategy-providers
 */
async function removeStrategyProviderFavorite(req, res) {
  const operationId = `sp_fav_remove_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try {
    const { userId, userType, isActive } = getAuthUser(req);
    
    // Only allow live users to manage strategy provider favorites
    if (!userId || userType !== 'live') {
      return res.status(401).json({ success: false, message: 'Unauthorized - Only live users can manage strategy provider favorites' });
    }
    if (!isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }

    const strategyProviderId = parseInt(req.body?.strategy_provider_id);
    if (!strategyProviderId || strategyProviderId <= 0) {
      return res.status(400).json({ success: false, message: 'strategy_provider_id is required and must be a positive integer' });
    }

    logger.transactionStart('sp_favorite_remove', { operationId, userId, strategyProviderId });

    const removed = await UserStrategyProviderFavorite.destroy({ 
      where: { user_id: userId, user_type: userType, strategy_provider_id: strategyProviderId } 
    });

    logger.transactionSuccess('sp_favorite_remove', { operationId, userId, strategyProviderId, removed });

    return res.status(200).json({
      success: true,
      message: removed ? 'Strategy provider removed from favorites' : 'Strategy provider not found in favorites',
      removed: removed > 0,
    });
  } catch (error) {
    logger.transactionFailure('sp_favorite_remove', error, { operationId });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

/**
 * Get user's favorite strategy providers
 * GET /api/favorites/strategy-providers
 */
async function getStrategyProviderFavorites(req, res) {
  const operationId = `sp_fav_get_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  try {
    const { userId, userType, isActive } = getAuthUser(req);
    
    // Only allow live users to view strategy provider favorites
    if (!userId || userType !== 'live') {
      return res.status(401).json({ success: false, message: 'Unauthorized - Only live users can view strategy provider favorites' });
    }
    if (!isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }

    logger.transactionStart('sp_favorite_get', { operationId, userId });

    const favorites = await UserStrategyProviderFavorite.findAll({
      where: { user_id: userId, user_type: userType },
      include: [{ 
        model: StrategyProviderAccount, 
        as: 'strategyProvider',
        attributes: [
          'id', 'strategy_name', 'description', 'account_number',
          'performance_fee', 'total_followers', 'total_return_percentage',
          'three_month_return', 'max_drawdown', 'win_rate', 'total_trades',
          'closed_trades', 'profile_image_url', 'min_investment', 'created_at'
        ],
        where: {
          status: 1,
          is_active: 1
        }
      }],
      order: [['created_at', 'DESC']],
    });

    const strategyProviders = favorites.map(fav => ({
      favorite_id: fav.id,
      favorited_at: fav.created_at,
      strategy_provider: {
        id: fav.strategyProvider.id,
        strategy_name: fav.strategyProvider.strategy_name,
        description: fav.strategyProvider.description,
        account_number: fav.strategyProvider.account_number,
        performance_fee: parseFloat(fav.strategyProvider.performance_fee) || 0,
        total_followers: fav.strategyProvider.total_followers || 0,
        total_return_percentage: parseFloat(fav.strategyProvider.total_return_percentage) || 0,
        three_month_return: parseFloat(fav.strategyProvider.three_month_return) || 0,
        max_drawdown: parseFloat(fav.strategyProvider.max_drawdown) || 0,
        win_rate: parseFloat(fav.strategyProvider.win_rate) || 0,
        total_trades: fav.strategyProvider.total_trades || 0,
        closed_trades: fav.strategyProvider.closed_trades || 0,
        profile_image_url: fav.strategyProvider.profile_image_url,
        min_investment: parseFloat(fav.strategyProvider.min_investment) || 0,
        created_at: fav.strategyProvider.created_at
      }
    }));

    logger.transactionSuccess('sp_favorite_get', { operationId, userId, count: strategyProviders.length });

    return res.status(200).json({
      success: true,
      message: 'Favorite strategy providers retrieved successfully',
      data: strategyProviders,
      count: strategyProviders.length
    });
  } catch (error) {
    logger.transactionFailure('sp_favorite_get', error, { operationId });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { 
  // Symbol favorites (existing)
  addFavorite, 
  removeFavorite, 
  getFavorites,
  // Strategy provider favorites (new)
  addStrategyProviderFavorite,
  removeStrategyProviderFavorite,
  getStrategyProviderFavorites
};
