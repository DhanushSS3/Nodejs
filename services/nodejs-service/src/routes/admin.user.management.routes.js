const express = require('express');
const router = express.Router();
const adminUserManagementController = require('../controllers/admin.user.management.controller');
const { authenticateAdmin, requirePermissions } = require('../middlewares/auth.middleware');
const { applyScope } = require('../middlewares/scope.middleware');

// This entire router is for authenticated admins.
router.use(authenticateAdmin);
// Apply country scoping for all routes in this file.
router.use(applyScope);

/**
 * @swagger
 * /api/admin/users/live-users:
 *   get:
 *     summary: List all live users
 *     tags: [Admin User Management]
 *     security:
 *       - bearerAuth: []
 *     description: List all live users. Requires 'user:read' permission. Applies country scoping.
 *     responses:
 *       200:
 *         description: List of live users
 *       403:
 *         description: Forbidden
 */
router.get('/live-users', requirePermissions(['user:read']), adminUserManagementController.listLiveUsers);

/**
 * @swagger
 * /api/admin/users/demo-users:
 *   get:
 *     summary: List all demo users
 *     tags: [Admin User Management]
 *     security:
 *       - bearerAuth: []
 *     description: List all demo users. Requires 'user:read' permission. Applies country scoping.
 *     responses:
 *       200:
 *         description: List of demo users
 *       403:
 *         description: Forbidden
 */
router.get('/demo-users', requirePermissions(['user:read']), adminUserManagementController.listDemoUsers);

module.exports = router;
