const express = require('express');
const router = express.Router();
const adminManagementController = require('../controllers/admin.management.controller');
const { authenticateAdmin, checkPermissions } = require('../middlewares/auth.middleware');

// All routes in this file are protected and require authentication
router.use(authenticateAdmin);

// Route to create a new admin (only for superadmin with 'admin:create' permission)
router.post('/', checkPermissions(['admin:create']), adminManagementController.createAdmin);

// Route to list all admins (only for superadmin with 'admin:read' permission)
router.get('/', checkPermissions(['admin:read']), adminManagementController.listAdmins);

// Route to get a single admin by ID
router.get('/:id', checkPermissions(['admin:read']), adminManagementController.getAdminById);

// Route to update an admin
router.put('/:id', checkPermissions(['admin:update']), adminManagementController.updateAdmin);

// Route to delete an admin
router.delete('/:id', checkPermissions(['admin:delete']), adminManagementController.deleteAdmin);

module.exports = router;
