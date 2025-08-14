const express = require('express');
const router = express.Router();
const adminUserManagementController = require('../controllers/admin.user.management.controller');
const { authenticateAdmin, checkPermissions } = require('../middlewares/auth.middleware');
const { applyScope } = require('../middlewares/scope.middleware');

// This entire router is for authenticated admins.
router.use(authenticateAdmin);
// Apply country scoping for all routes in this file.
router.use(applyScope);

// Route to list live users, requires 'user:read' permission
router.get('/live-users', checkPermissions(['user:read']), adminUserManagementController.listLiveUsers);

// Route to list demo users, requires 'user:read' permission
router.get('/demo-users', checkPermissions(['user:read']), adminUserManagementController.listDemoUsers);

module.exports = router;
