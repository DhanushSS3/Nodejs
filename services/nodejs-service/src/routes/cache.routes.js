const express = require('express');
const router = express.Router();
const { cacheHealthCheck, refreshCaches } = require('../middleware/cache.initialization.middleware');
const { authenticateJWT, requirePermissions } = require('../middlewares/auth.middleware');

/**
 * @route GET /api/cache/health
 * @desc Check cache health status
 * @access Private (Admin only)
 */
router.get('/health', 
  authenticateJWT,
  requirePermissions(['system:monitor']),
  cacheHealthCheck
);

/**
 * @route POST /api/cache/refresh
 * @desc Manually refresh all caches
 * @access Private (Admin only)
 */
router.post('/refresh',
  authenticateJWT,
  requirePermissions(['system:manage']),
  refreshCaches
);

module.exports = router;
