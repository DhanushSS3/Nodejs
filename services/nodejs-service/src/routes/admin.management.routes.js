const express = require('express');
const router = express.Router();
const adminManagementController = require('../controllers/admin.management.controller');
const { authenticateAdmin, requirePermissions } = require('../middlewares/auth.middleware');

// All routes in this file are protected and require authentication
router.use(authenticateAdmin);

/**
 * @swagger
 * /api/admins:
 *   post:
 *     summary: Create a new admin
 *     tags: [Admin Management]
 *     security:
 *       - bearerAuth: []
 *     description: Only superadmins with 'admin:create' permission can create new admins.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username, email, password, role_id]
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *               role_id:
 *                 type: integer
 *               country_id:
 *                 type: integer
 *                 nullable: true
 *     responses:
 *       201:
 *         description: Admin created successfully
 *       400:
 *         description: Invalid input
 *       403:
 *         description: Forbidden
 */
router.post('/', requirePermissions(['admin:create']), adminManagementController.createAdmin);

/**
 * @swagger
 * /api/admins:
 *   get:
 *     summary: List all admins
 *     tags: [Admin Management]
 *     security:
 *       - bearerAuth: []
 *     description: Only superadmins with 'admin:read' permission can list admins.
 *     responses:
 *       200:
 *         description: List of admins
 *       403:
 *         description: Forbidden
 */
router.get('/', requirePermissions(['admin:read']), adminManagementController.listAdmins);

/**
 * @swagger
 * /api/admins/{id}:
 *   get:
 *     summary: Get a single admin by ID
 *     tags: [Admin Management]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Admin ID
 *     responses:
 *       200:
 *         description: Admin details
 *       404:
 *         description: Admin not found
 *       403:
 *         description: Forbidden
 */
router.get('/:id', requirePermissions(['admin:read']), adminManagementController.getAdminById);

/**
 * @swagger
 * /api/admins/{id}:
 *   put:
 *     summary: Update an admin
 *     tags: [Admin Management]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Admin ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *               role_id:
 *                 type: integer
 *               country_id:
 *                 type: integer
 *                 nullable: true
 *               is_active:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Admin updated successfully
 *       400:
 *         description: Invalid input
 *       404:
 *         description: Admin not found
 *       403:
 *         description: Forbidden
 */
router.put('/:id', requirePermissions(['admin:update']), adminManagementController.updateAdmin);

/**
 * @swagger
 * /api/admins/{id}:
 *   delete:
 *     summary: Delete an admin
 *     tags: [Admin Management]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Admin ID
 *     responses:
 *       204:
 *         description: Admin deleted successfully
 *       404:
 *         description: Admin not found
 *       403:
 *         description: Forbidden
 */
router.delete('/:id', requirePermissions(['admin:delete']), adminManagementController.deleteAdmin);

module.exports = router;
