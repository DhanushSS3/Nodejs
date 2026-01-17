const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
const logger = require('../services/logger.service');

function normalizeUserType(rawType) {
  if (!rawType) return 'live';
  return String(rawType).toLowerCase();
}

function extractUserId(user = {}) {
  return user.sub || user.user_id || user.id;
}

async function ensureTradingUserState(req, res, next) {
  try {
    const tokenUser = req.user;
    if (!tokenUser) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const userId = extractUserId(tokenUser);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Invalid authentication context' });
    }

    const userType = normalizeUserType(tokenUser.account_type || tokenUser.user_type);

    if (!['live', 'demo'].includes(userType)) {
      // Nothing to enforce for other account types
      return next();
    }

    const Model = userType === 'live' ? LiveUser : DemoUser;
    const freshUser = await Model.findByPk(userId);
    if (!freshUser) {
      return res.status(401).json({ success: false, message: 'Trading account not found' });
    }

    if (!Number(freshUser.is_active)) {
      return res.status(403).json({ success: false, message: 'Trading account is inactive' });
    }

    const latestSnapshot = freshUser.get({ plain: true });

    if (userType === 'live') {
      const isSelfTradingEnabled = String(latestSnapshot.is_self_trading) === '1';
      const isMamManaged = Number(latestSnapshot.mam_status) === 1;
      if (!isSelfTradingEnabled || isMamManaged) {
        return res.status(403).json({
          success: false,
          message: 'Manual trading is disabled while this account is managed by a MAM'
        });
      }
    }

    // Attach the resolved user to the request for downstream controllers
    req.userResolved = {
      id: userId,
      type: userType,
      record: latestSnapshot
    };

    // Also hydrate the JWT payload with fresh flags to minimize downstream changes
    req.user = {
      ...req.user,
      is_self_trading: latestSnapshot.is_self_trading,
      mam_status: latestSnapshot.mam_status,
      status: latestSnapshot.status,
      group: latestSnapshot.group,
      is_active: latestSnapshot.is_active
    };

    next();
  } catch (error) {
    logger.error('Failed to enforce trading user state', { error: error.message });
    return res.status(500).json({ success: false, message: 'Unable to verify trading permissions' });
  }
}

module.exports = {
  ensureTradingUserState
};
