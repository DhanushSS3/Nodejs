const express = require('express');
const router = express.Router();
const copyTradingController = require('../controllers/copyTrading.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');

/**
 * Copy Trading Routes
 * All routes require JWT authentication
 */

// Create follower account (start following a strategy)
router.post('/follow', 
  authenticateJWT,
  copyTradingController.createFollowerAccount
);

// Get user's follower accounts
router.get('/accounts', 
  authenticateJWT,
  copyTradingController.getFollowerAccounts
);

// Update follower account settings (legacy)
router.put('/accounts/:follower_id', 
  authenticateJWT,
  copyTradingController.updateFollowerAccount
);

// Update follower account settings with strict validation
router.put('/accounts/:id', 
  authenticateJWT,
  copyTradingController.updateFollowerAccountStrict
);

// Stop following a strategy
router.delete('/accounts/:follower_id', 
  authenticateJWT,
  copyTradingController.stopFollowing
);

// Get user's copy trading overview (who they're following and total investments)
router.get('/overview', 
  authenticateJWT,
  copyTradingController.getCopyTradingOverview
);

module.exports = router;
