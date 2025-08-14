const express = require('express');
const router = express.Router();
const permissionManagementController = require('../controllers/permission.management.controller');
const { authenticateAdmin, checkPermissions } = require('../middlewares/auth.middleware');

// This entire router is for superadmins only.
router.use(authenticateAdmin, checkPermissions(['permission:manage']));

// Route to assign a permission to a role
router.post('/assign', permissionManagementController.assignPermissionToRole);

// Route to remove a permission from a role
router.post('/remove', permissionManagementController.removePermissionFromRole);

module.exports = router;
