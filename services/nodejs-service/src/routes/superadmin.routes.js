/**
 * @swagger
 * /api/superadmin/roles:
 *   post:
 *     summary: Create a new role with permissions
 *     tags: [Superadmin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 description: Unique name for the role
 *                 example: financial_analyst
 *               description:
 *                 type: string
 *                 description: Description of the role
 *                 example: Can view and analyze financial data
 *               permission_ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Array of permission IDs to assign to the role
 *                 example: [1, 3, 7, 12]
 *     responses:
 *       201:
 *         description: Role created successfully with permissions
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
 *                   $ref: '#/components/schemas/RoleWithPermissions'
 *       400:
 *         description: Invalid input, role already exists, or invalid permission IDs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized (missing or invalid token)
 *       403:
 *         description: Forbidden (not a superadmin)
 *   get:
 *     summary: Get all roles with their permissions
 *     tags: [Superadmin]
 *     security:
 *       - bearerAuth: []
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
 *                     $ref: '#/components/schemas/RoleWithPermissions'
 * 
 * /api/superadmin/permissions:
 *   get:
 *     summary: Get all permissions
 *     tags: [Superadmin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Permissions retrieved successfully
 * 
 * /api/superadmin/permissions/dropdown:
 *   get:
 *     summary: Get permissions grouped by category for dropdown UI
 *     tags: [Superadmin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Grouped permissions for dropdown retrieved successfully
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
 *                   additionalProperties:
 *                     type: array
 *                     items:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                         name:
 *                           type: string
 *                         displayName:
 *                           type: string
 *                         description:
 *                           type: string
 */
const express = require('express');
const router = express.Router();

const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');
const { handleValidationErrors } = require('../middlewares/error.middleware');
const { 
  createRole, 
  createPermission,
  getAllPermissions, 
  getPermissionsForDropdown,
  getRolesWithPermissions 
} = require('../controllers/superadmin.controller');

// All endpoints in this router require the user to be authenticated as a superadmin
router.use(authenticateAdmin);

// Role management routes
router.post('/roles', requireRole(['superadmin']), handleValidationErrors, createRole);
router.get('/roles', requireRole(['superadmin']), getRolesWithPermissions);

// Permission management routes
router.post('/permissions', requireRole(['superadmin']), handleValidationErrors, createPermission);
router.get('/permissions', requireRole(['superadmin']), getAllPermissions);
router.get('/permissions/dropdown', requireRole(['superadmin']), getPermissionsForDropdown);

module.exports = router;
