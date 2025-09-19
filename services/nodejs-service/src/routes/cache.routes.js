const express = require('express');
const router = express.Router();
const { cacheHealthCheck, refreshCaches, forceFullRebuild } = require('../middleware/cache.initialization.middleware');
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
 * @desc Manually refresh all caches (safe mode - no service interruption)
 * @access Private (Admin only)
 */
router.post('/refresh',
  authenticateJWT,
  requirePermissions(['system:manage']),
  refreshCaches
);

/**
 * @route POST /api/cache/force-rebuild
 * @desc Force full cache rebuild (admin only - causes brief service interruption)
 * @access Private (Superadmin only)
 */
router.post('/force-rebuild',
  authenticateJWT,
  requirePermissions(['system:admin']),
  forceFullRebuild
);

module.exports = router;
