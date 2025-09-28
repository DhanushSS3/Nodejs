const express = require('express');
const router = express.Router();
const groupsController = require('../controllers/groups.controller');
const { authenticateJWT, requireRole } = require('../middlewares/auth.middleware');

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
router.use(requireRole('superadmin'));

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
 * /api/superadmin/groups/dropdown:
 *   get:
 *     summary: Get all unique group names for dropdown
 *     description: Retrieve all unique group names for frontend dropdown selection (superadmin only)
 *     tags: [Superadmin - Groups]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Groups dropdown retrieved successfully
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
 *                   example: "Groups dropdown retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     total_groups:
 *                       type: integer
 *                       example: 5
 *                       description: Total number of unique group names
 *                     groups:
 *                       type: array
 *                       items:
 *                         type: string
 *                       example: ["VIP", "Royal+", "ECN", "Standard", "Premium"]
 *                       description: Array of unique group names sorted alphabetically
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.get('/dropdown', groupsController.getGroupsDropdown);

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

/**
 * @swagger
 * /api/superadmin/groups/copy:
 *   post:
 *     summary: Copy all instruments from existing group to new group
 *     description: Copy all instruments from a source group to a new target group with the same configuration (superadmin only)
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
 *               - sourceGroupName
 *               - targetGroupName
 *             properties:
 *               sourceGroupName:
 *                 type: string
 *                 example: "VIP"
 *                 description: Name of the existing group to copy from
 *               targetGroupName:
 *                 type: string
 *                 example: "Premium"
 *                 description: Name of the new group to create
 *     responses:
 *       201:
 *         description: Group instruments copied successfully
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
 *                   example: "Successfully copied 50 instruments from VIP to Premium"
 *                 data:
 *                   type: object
 *                   properties:
 *                     source_group_name:
 *                       type: string
 *                       example: "VIP"
 *                     target_group_name:
 *                       type: string
 *                       example: "Premium"
 *                     instruments_copied:
 *                       type: integer
 *                       example: 50
 *                     instruments:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           symbol:
 *                             type: string
 *                           name:
 *                             type: string
 *                           created_at:
 *                             type: string
 *                             format: date-time
 *       400:
 *         description: Bad request - Missing required fields or same group names
 *       404:
 *         description: Source group not found
 *       409:
 *         description: Target group already exists
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 */
router.post('/copy', groupsController.copyGroupInstruments);

/**
 * @swagger
 * /api/superadmin/groups:
 *   post:
 *     summary: Create a new group symbol record
 *     description: Create a new group symbol with trading configuration (superadmin only)
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
 *               - symbol
 *               - name
 *             properties:
 *               symbol:
 *                 type: string
 *                 example: "EURUSD"
 *                 description: Trading symbol
 *               name:
 *                 type: string
 *                 example: "VIP"
 *                 description: Group name
 *               commision_type:
 *                 type: integer
 *                 example: 1
 *                 default: 1
 *               commision_value_type:
 *                 type: integer
 *                 example: 1
 *                 default: 1
 *               type:
 *                 type: integer
 *                 example: 1
 *                 default: 1
 *               pip_currency:
 *                 type: string
 *                 example: "USD"
 *                 default: "USD"
 *               show_points:
 *                 type: integer
 *                 example: 5
 *                 default: 5
 *               swap_buy:
 *                 type: number
 *                 format: decimal
 *                 example: -2.5
 *                 default: 0
 *               swap_sell:
 *                 type: number
 *                 format: decimal
 *                 example: -1.8
 *                 default: 0
 *               commision:
 *                 type: number
 *                 format: decimal
 *                 example: 3.0
 *                 default: 0
 *               margin:
 *                 type: number
 *                 format: decimal
 *                 example: 100.0
 *                 default: 100
 *               spread:
 *                 type: number
 *                 format: decimal
 *                 example: 1.5
 *                 default: 0
 *               deviation:
 *                 type: number
 *                 format: decimal
 *                 example: 10.0
 *                 default: 10
 *               min_lot:
 *                 type: number
 *                 format: decimal
 *                 example: 0.01
 *                 default: 0.01
 *               max_lot:
 *                 type: number
 *                 format: decimal
 *                 example: 100.0
 *                 default: 100
 *               pips:
 *                 type: number
 *                 format: decimal
 *                 example: 0.0001
 *                 default: 0.0001
 *               spread_pip:
 *                 type: number
 *                 format: decimal
 *                 example: 1.5
 *                 default: 0
 *               contract_size:
 *                 type: number
 *                 format: decimal
 *                 example: 100000.0
 *                 default: 100000
 *               profit:
 *                 type: string
 *                 example: "currency"
 *                 default: "currency"
 *     responses:
 *       201:
 *         description: Group symbol created successfully
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
 *                   example: "Group symbol created successfully: VIP:EURUSD"
 *                 data:
 *                   type: object
 *                   properties:
 *                     group:
 *                       $ref: '#/components/schemas/Group'
 *       400:
 *         description: Bad request - Missing required fields
 *       409:
 *         description: Conflict - Group symbol already exists
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 */
router.post('/', groupsController.createGroupSymbol);

/**
 * @swagger
 * /api/superadmin/groups/{groupName}:
 *   delete:
 *     summary: Delete entire group with all instruments
 *     description: Delete all instruments belonging to a specific group name from both database and Redis cache (superadmin only)
 *     tags: [Superadmin - Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupName
 *         required: true
 *         schema:
 *           type: string
 *         description: Group name to delete (URL encoded for special characters)
 *         example: "VIP"
 *     responses:
 *       200:
 *         description: Entire group deleted successfully
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
 *                   example: "Successfully deleted entire group: VIP (50 instruments)"
 *                 data:
 *                   type: object
 *                   properties:
 *                     group_name:
 *                       type: string
 *                       example: "VIP"
 *                     instruments_deleted:
 *                       type: integer
 *                       example: 50
 *                     deleted_instruments:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                             example: 1
 *                           symbol:
 *                             type: string
 *                             example: "EURUSD"
 *                           name:
 *                             type: string
 *                             example: "VIP"
 *       404:
 *         description: Group not found
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 */
router.delete('/:groupName', groupsController.deleteEntireGroup);

/**
 * @swagger
 * /api/superadmin/groups/{groupName}/{symbol}:
 *   delete:
 *     summary: Delete a specific group symbol
 *     description: Delete a group symbol from both database and Redis cache (superadmin only)
 *     tags: [Superadmin - Groups]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: groupName
 *         required: true
 *         schema:
 *           type: string
 *         description: Group name (URL encoded for special characters)
 *         example: "VIP"
 *       - in: path
 *         name: symbol
 *         required: true
 *         schema:
 *           type: string
 *         description: Trading symbol
 *         example: "EURUSD"
 *     responses:
 *       200:
 *         description: Group symbol deleted successfully
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
 *                   example: "Group symbol deleted successfully: VIP:EURUSD"
 *                 data:
 *                   type: object
 *                   properties:
 *                     deleted_group:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                           example: 1
 *                         name:
 *                           type: string
 *                           example: "VIP"
 *                         symbol:
 *                           type: string
 *                           example: "EURUSD"
 *       404:
 *         description: Group not found
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 */
router.delete('/:groupName/:symbol', groupsController.deleteGroupSymbol);

/**
 * @swagger
 * /api/superadmin/groups/cache/refresh:
 *   post:
 *     summary: Refresh groups cache
 *     description: Clear and resync all groups from database to Redis cache. This will include any new fields like swap_type.
 *     tags: [Groups Management]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cache refreshed successfully
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
 *                   example: "Groups cache refreshed successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     cleared:
 *                       type: integer
 *                       example: 3000
 *                     synced:
 *                       type: integer
 *                       example: 3000
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *       403:
 *         description: Forbidden - Superadmin access required
 *       401:
 *         description: Unauthorized
 */
router.post('/cache/refresh', groupsController.refreshCache);

module.exports = router;
