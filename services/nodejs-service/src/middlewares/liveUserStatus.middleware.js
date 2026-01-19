const liveUserStatusService = require('../services/liveUserStatus.service');
const strategyProviderAccountService = require('../services/strategyProviderAccount.service');

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

function requireActiveLiveOrStrategyProvider(context = 'live_or_strategy_provider_route') {
  return async (req, res, next) => {
    try {
      const user = req.user || {};
      const accountType = resolveAccountType(user);
      const userId = extractUserId(user);

      if (!userId) {
        return res.status(401).json({
          success: false,
          message: 'Authentication required'
        });
      }

      if (accountType === 'live') {
        const liveUser = await liveUserStatusService.assertActive(userId, { context });
        req.liveUser = liveUser;
        return next();
      }

      if (accountType === 'strategy_provider') {
        const strategyProviderId = user.strategy_provider_id || user.strategyProviderId;
        if (!strategyProviderId) {
          return res.status(403).json({
            success: false,
            message: 'Strategy provider account not found in token'
          });
        }

        try {
          await strategyProviderAccountService.assertActiveStrategyProviderAccount({
            userId,
            strategyProviderAccountId: strategyProviderId,
            context
          });
        } catch (err) {
          return res.status(err.statusCode || 403).json({
            success: false,
            message: err.message || 'Strategy provider account inactive'
          });
        }

        req.strategyProviderAccount = {
          id: strategyProviderId,
          user_id: userId
        };
        return next();
      }

      return res.status(403).json({
        success: false,
        message: 'Only live users or strategy providers can access this endpoint'
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({
        success: false,
        message: error.message || 'Unable to verify account status'
      });
    }
  };
}

module.exports = {
  requireActiveLiveUser,
  requireActiveLiveOrStrategyProvider
};
