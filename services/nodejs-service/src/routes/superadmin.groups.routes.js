const express = require('express');
const router = express.Router();
const groupsController = require('../controllers/groups.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { requireSuperadmin } = require('../middlewares/rbac.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     GroupUpdateRequest:
 *       type: object
 *       properties:
 *         spread:
 *           type: number
 *           format: decimal
 *           example: 1.5
 *         margin:
 *           type: number
 *           format: decimal
 *           example: 100.0
 *         swap_buy:
 *           type: number
 *           format: decimal
 *           example: -2.5
 *         swap_sell:
 *           type: number
 *           format: decimal
 *           example: -1.8
 *         commision:
 *           type: number
 *           format: decimal
 *           example: 3.0
 *         min_lot:
 *           type: number
 *           format: decimal
 *           example: 0.01
 *         max_lot:
 *           type: number
 *           format: decimal
 *           example: 100.0
 *     CacheStats:
 *       type: object
 *       properties:
 *         total_cached_groups:
 *           type: integer
 *           example: 3000
 *         cache_pattern:
 *           type: string
 *           example: "groups:*"
 *         last_sync:
 *           type: string
 *           format: date-time
 *         total_synced:
 *           type: integer
 *           example: 3000
 *         sync_duration_ms:
 *           type: integer
 *           example: 2500
 */

/**
 * Superadmin Groups Routes
 * Administrative routes for group management (superadmin only)
 */

// All routes require superadmin access
router.use(authenticateJWT);
router.use(requireSuperadmin);

/**
 * @swagger
 * /api/superadmin/groups/{groupName}/{symbol}:
 *   put:
 *     summary: Update group configuration
 *     description: Update specific fields of a group configuration (superadmin only)
 *     tags: [Superadmin - Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupName
 *         required: true
 *         schema:
 *           type: string
 *         description: Group name
 *         example: "VIP"
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: Trading symbol
 *         example: "EURUSD"
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/GroupUpdateRequest'
 *     responses:
 *       200:
 *         description: Group updated successfully
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
 *                   example: "Group updated successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     group_name:
 *                       type: string
 *                       example: "VIP"
 *                     symbol:
 *                       type: string
 *                       example: "EURUSD"
 *                     updated_fields:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["spread", "margin"]
 *                     updated_at:
 *                       type: string
 *                       format: date-time
 *       404:
 *         description: Group not found
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 */
router.put('/:groupName/:symbol', groupsController.updateGroup);

/**
 * @swagger
 * /api/superadmin/groups/sync/{groupId}:
 *   post:
 *     summary: Sync group from database to Redis
 *     description: Force sync a specific group from database to Redis cache (superadmin only)
 *     tags: [Superadmin - Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupId
 *         required: true
 *         schema:
 *           type: integer
 *         description: Group ID to sync
 *         example: 1
 *     responses:
 *       200:
 *         description: Group synced successfully
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
 *                   example: "Group synced successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: true
 *                     group:
 *                       $ref: '#/components/schemas/Group'
 *       404:
 *         description: Group not found
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 */
router.post('/sync/:groupId', groupsController.syncGroup);

/**
 * @swagger
 * /api/superadmin/groups/cache/stats:
 *   get:
 *     summary: Get groups cache statistics
 *     description: Retrieve detailed statistics about the groups cache system (superadmin only)
 *     tags: [Superadmin - Groups]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cache statistics retrieved successfully
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
 *                   example: "Cache statistics retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     cache_stats:
 *                       $ref: '#/components/schemas/CacheStats'
 *                     health_check:
 *                       type: object
 *                       properties:
 *                         status:
 *                           type: string
 *                           example: "healthy"
 *                         message:
 *                           type: string
 *                           example: "Groups caching system operational"
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 */
router.get('/cache/stats', groupsController.getCacheStats);

/**
 * @swagger
 * /api/superadmin/groups/cache/resync:
 *   post:
 *     summary: Force re-sync all groups cache
 *     description: Force a complete re-sync of all groups from database to Redis (superadmin only)
 *     tags: [Superadmin - Groups]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Groups cache re-sync completed
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
 *                   example: "Groups cache re-sync completed"
 *                 data:
 *                   type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: true
 *                     synced:
 *                       type: integer
 *                       example: 3000
 *                     duration:
 *                       type: integer
 *                       example: 2500
 *                     message:
 *                       type: string
 *                       example: "Successfully synced 3000 groups"
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 */
router.post('/cache/resync', groupsController.forceResync);

/**
 * @swagger
 * /api/superadmin/groups/cache:
 *   delete:
 *     summary: Clear groups cache
 *     description: Clear all groups from Redis cache - DANGEROUS OPERATION (superadmin only)
 *     tags: [Superadmin - Groups]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - confirm
 *             properties:
 *               confirm:
 *                 type: string
 *                 example: "CLEAR_GROUPS_CACHE"
 *                 description: Must be exactly "CLEAR_GROUPS_CACHE" to confirm
 *     responses:
 *       200:
 *         description: Groups cache cleared successfully
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
 *                   example: "Groups cache cleared successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     success:
 *                       type: boolean
 *                       example: true
 *                     cleared:
 *                       type: integer
 *                       example: 3000
 *       400:
 *         description: Confirmation required
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 */
router.delete('/cache', groupsController.clearCache);

module.exports = router;
