const liveUserStatusService = require('../services/liveUserStatus.service');

function extractUserId(user = {}) {
  return user.sub || user.user_id || user.id;
}

function resolveAccountType(user = {}) {
  return (user.account_type || user.user_type || 'live').toString().toLowerCase();
}

function requireActiveLiveUser(context = 'live_route') {
  return async (req, res, next) => {
    try {
      const accountType = resolveAccountType(req.user || {});
      if (accountType !== 'live') {
        return res.status(403).json({
          success: false,
          message: 'Only live user accounts can access this endpoint'
        });
      }

      const userId = extractUserId(req.user || {});
      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      const liveUser = await liveUserStatusService.assertActive(userId, { context });
      req.liveUser = liveUser;
      next();
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Unable to verify account status'
      });
    }
  };
}

module.exports = {
  requireActiveLiveUser
};
