const logger = require('../services/logger.service');
const UserFavorite = require('../models/userFavorite.model');
const SymbolModel = require('../models/symbol.model');

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

module.exports = { addFavorite, removeFavorite, getFavorites };
