const express = require('express');
const router = express.Router();
const copyTradingController = require('../controllers/copyTrading.controller');
const copyFollowerEquityMonitorController = require('../controllers/copyFollowerEquityMonitor.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { requireActiveLiveUser } = require('../middlewares/liveUserStatus.middleware');
const { validateSlTpSettingsUpdate, validateSlTpSettingsGet } = require('../middlewares/copyTrading.validation');

/**
 * Copy Trading Routes
 * All routes require JWT authentication
 */

router.use(authenticateJWT, requireActiveLiveUser('copy_trading'));

// Create follower account (start following a strategy)
router.post('/follow', copyTradingController.createFollowerAccount);

// Get user's follower accounts
router.get('/accounts', copyTradingController.getFollowerAccounts);

// Update follower account settings (legacy)
router.put('/accounts/:follower_id', copyTradingController.updateFollowerAccount);

// Update follower account settings with strict validation
router.put('/accounts/:id', copyTradingController.updateFollowerAccountStrict);

// Get follower account SL/TP settings
router.get('/accounts/:id/sl-tp-settings', 
  validateSlTpSettingsGet,
  copyTradingController.getFollowerSlTpSettings
);

// Update follower account SL/TP settings for future orders
router.put('/accounts/:id/sl-tp-settings', 
  validateSlTpSettingsUpdate,
  copyTradingController.updateFollowerSlTpSettings
);

// Stop following a strategy
router.delete('/accounts/:follower_id', copyTradingController.stopFollowing);

// Get user's copy trading overview (who they're following and total investments)
router.get('/overview', copyTradingController.getCopyTradingOverview);

// Equity Monitor Management Routes (for monitoring and debugging)
router.get('/equity-monitor/status', copyFollowerEquityMonitorController.getEquityMonitorStatus);

router.post('/equity-monitor/start', copyFollowerEquityMonitorController.startEquityMonitor);

router.post('/equity-monitor/stop', copyFollowerEquityMonitorController.stopEquityMonitor);

router.get('/equity-monitor/account/:id/check', copyFollowerEquityMonitorController.checkAccountThresholds);

module.exports = router;
