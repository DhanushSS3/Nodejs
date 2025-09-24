const express = require('express');
const { param, query } = require('express-validator');
const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');
const { handleValidationErrors } = require('../middlewares/error.middleware');
const RedisHealthController = require('../controllers/redis.health.controller');

const router = express.Router();

/**
 * @swagger
 * /api/redis-health/status:
 *   get:
 *     summary: Get Redis sync service health status
 *     tags: [Redis Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Redis sync service is healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Redis sync service is healthy"
 *                 data:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       example: "healthy"
 *                     redis_connected:
 *                       type: boolean
 *                       example: true
 *                     cache_operations:
 *                       type: string
 *                       example: "working"
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *       503:
 *         description: Redis sync service is unhealthy
 */
router.get('/status',
  authenticateAdmin,
  RedisHealthController.getHealthStatus
);

/**
 * @swagger
 * /api/redis-health/user/{userId}/consistency:
 *   get:
 *     summary: Check Redis-Database consistency for a specific user (Superadmin only)
 *     tags: [Redis Health]
 *     security:
 *       - adminAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *         description: User ID to check consistency for
 *       - in: query
 *         name: userType
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *           default: live
 *         description: Type of user account
 *     responses:
 *       200:
 *         description: User consistency check completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                   example: "User consistency check PASSED"
 *                 data:
 *                   type: object
 *                   properties:
 *                     user_id:
 *                       type: integer
 *                     user_type:
 *                       type: string
 *                     is_consistent:
 *                       type: boolean
 *                     database:
 *                       type: object
 *                       description: User data from database
 *                     redis_config:
 *                       type: object
 *                       description: User data from Redis config
 *                     redis_balance_cache:
 *                       type: object
 *                       description: Balance data from Redis cache
 *                     consistency_check:
 *                       type: object
 *                       properties:
 *                         balance_matches:
 *                           type: boolean
 *                         cache_matches:
 *                           type: boolean
 *                         all_consistent:
 *                           type: boolean
 *       400:
 *         description: Invalid parameters
 *       404:
 *         description: User not found
 *       500:
 *         description: Internal server error
 */
router.get('/user/:userId/consistency',
  authenticateAdmin,
  requireRole(['superadmin']),
  [
    param('userId').isInt({ min: 1 }).withMessage('User ID must be a positive integer'),
    query('userType').optional().isIn(['live', 'demo']).withMessage('User type must be live or demo')
  ],
  handleValidationErrors,
  RedisHealthController.checkUserConsistency
);

/**
 * @swagger
 * /api/redis-health/user/{userId}/force-refresh:
 *   post:
 *     summary: Force refresh user data from database to Redis (Superadmin only)
 *     tags: [Redis Health]
 *     security:
 *       - adminAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: integer
 *         description: User ID to refresh
 *       - in: query
 *         name: userType
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *           default: live
 *         description: Type of user account
 *     responses:
 *       200:
 *         description: User data refreshed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "User live:123 refreshed successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     user_id:
 *                       type: integer
 *                     user_type:
 *                       type: string
 *                     refreshed_fields:
 *                       type: object
 *                       description: Fields that were refreshed in Redis
 *       400:
 *         description: Invalid parameters or refresh failed
 *       500:
 *         description: Internal server error
 */
router.post('/user/:userId/force-refresh',
  authenticateAdmin,
  requireRole(['superadmin']),
  [
    param('userId').isInt({ min: 1 }).withMessage('User ID must be a positive integer'),
    query('userType').optional().isIn(['live', 'demo']).withMessage('User type must be live or demo')
  ],
  handleValidationErrors,
  RedisHealthController.forceRefreshUser
);

/**
 * @swagger
 * /api/redis-health/cluster-info:
 *   get:
 *     summary: Get Redis cluster information and key statistics (Superadmin only)
 *     tags: [Redis Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Redis cluster information retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Redis cluster information retrieved"
 *                 data:
 *                   type: object
 *                   properties:
 *                     nodes:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           host:
 *                             type: string
 *                           port:
 *                             type: integer
 *                           status:
 *                             type: string
 *                           keys:
 *                             type: integer
 *                           user_configs:
 *                             type: integer
 *                           balance_caches:
 *                             type: integer
 *                     total_keys:
 *                       type: integer
 *                     user_config_keys:
 *                       type: integer
 *                     balance_cache_keys:
 *                       type: integer
 *       500:
 *         description: Internal server error
 */
router.get('/cluster-info',
  authenticateAdmin,
  requireRole(['superadmin']),
  RedisHealthController.getClusterInfo
);

module.exports = router;
