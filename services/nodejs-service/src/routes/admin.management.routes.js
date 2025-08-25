const express = require('express');
const router = express.Router();
const adminManagementController = require('../controllers/admin.management.controller');
const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');

// All routes in this file are protected and require authentication
router.use(authenticateAdmin);

/**
 * @swagger
 * /api/admin/management:
 *   post:
 *     summary: Create a new admin
 *     tags: [Admin Management]
 *     security:
 *       - bearerAuth: []
 *     description: Only superadmins can get admin details.
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
router.post('/', requireRole(['superadmin']), adminManagementController.createAdmin);

/**
 * @swagger
 * /api/admin/management:
 *   get:
 *     summary: List all admins
 *     tags: [Admin Management]
 *     security:
 *       - bearerAuth: []
 *     description: Only superadmins can list admins.
 *     responses:
 *       200:
 *         description: List of admins
 *       403:
 *         description: Forbidden
 */
router.get('/', requireRole(['superadmin']), adminManagementController.listAdmins);

/**
 * @swagger
 * /api/admin/management/dropdown-data:
 *   get:
 *     summary: Get dropdown data for admin forms (countries and roles)
 *     tags: [Admin Management]
 *     security:
 *       - bearerAuth: []
 *     description: Returns countries and roles data for admin creation/editing forms. Only superadmins can access this endpoint.
 *     responses:
 *       200:
 *         description: Dropdown data retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     countries:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           name:
 *                             type: string
 *                           iso_code:
 *                             type: string
 *                           display_name:
 *                             type: string
 *                     roles:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           name:
 *                             type: string
 *                           description:
 *                             type: string
 *                           display_name:
 *                             type: string
 *                           requires_country:
 *                             type: boolean
 *                     metadata:
 *                       type: object
 *                       properties:
 *                         total_countries:
 *                           type: integer
 *                         total_roles:
 *                           type: integer
 *                         generated_at:
 *                           type: string
 *                           format: date-time
 *       403:
 *         description: Forbidden
 *       500:
 *         description: Internal server error
 */
router.get('/dropdown-data', requireRole(['superadmin']), adminManagementController.getDropdownData);

/**
 * @swagger
 * /api/admin/management/countries:
 *   get:
 *     summary: Get countries dropdown only
 *     tags: [Admin Management]
 *     security:
 *       - bearerAuth: []
 *     description: Returns only countries data for dropdown. Only superadmins can access this endpoint.
 *     responses:
 *       200:
 *         description: Countries retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       name:
 *                         type: string
 *                       iso_code:
 *                         type: string
 *                       display_name:
 *                         type: string
 *       403:
 *         description: Forbidden
 *       500:
 *         description: Internal server error
 */
router.get('/countries', requireRole(['superadmin']), adminManagementController.getCountriesDropdown);

/**
 * @swagger
 * /api/admin/management/roles:
 *   get:
 *     summary: Get roles dropdown only
 *     tags: [Admin Management]
 *     security:
 *       - bearerAuth: []
 *     description: Returns only roles data for dropdown. Only superadmins can access this endpoint.
 *     responses:
 *       200:
 *         description: Roles retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: integer
 *                       name:
 *                         type: string
 *                       description:
 *                         type: string
 *                       display_name:
 *                         type: string
 *                       requires_country:
 *                         type: boolean
 *       403:
 *         description: Forbidden
 *       500:
 *         description: Internal server error
 */
router.get('/roles', requireRole(['superadmin']), adminManagementController.getRolesDropdown);

/**
 * @swagger
 * /api/admin/management/{id}:
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
router.get('/:id', requireRole(['superadmin']), adminManagementController.getAdminById);

/**
 * @swagger
 * /api/admin/management/{id}:
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
router.put('/:id', requireRole(['superadmin']), adminManagementController.updateAdmin);

/**
 * @swagger
 * /api/admin/management/{id}:
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
router.delete('/:id', requireRole(['superadmin']), adminManagementController.deleteAdmin);

module.exports = router;
