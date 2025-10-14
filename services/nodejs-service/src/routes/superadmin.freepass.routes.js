const express = require('express');
const router = express.Router();
const superadminFreePassController = require('../controllers/superadmin.freepass.controller');
const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     FreePassAccount:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           example: 123
 *         strategy_name:
 *           type: string
 *           example: "EURUSD Pro Strategy"
 *         total_return_percentage:
 *           type: number
 *           example: 25.75
 *         total_followers:
 *           type: integer
 *           example: 150
 *         free_pass:
 *           type: object
 *           properties:
 *             granted_by:
 *               type: integer
 *               example: 1
 *             granted_at:
 *               type: string
 *               format: date-time
 *               example: "2024-01-15T10:30:00.000Z"
 *             reason:
 *               type: string
 *               example: "Exceptional strategy with proven track record"
 *         is_catalog_eligible:
 *           type: boolean
 *           example: true
 *         status:
 *           type: integer
 *           example: 1
 *         is_active:
 *           type: integer
 *           example: 1
 *         owner:
 *           type: object
 *           properties:
 *             id:
 *               type: integer
 *               example: 456
 *             name:
 *               type: string
 *               example: "John Doe"
 *             email:
 *               type: string
 *               example: "john.doe@example.com"
 */

/**
 * @swagger
 * /api/superadmin/strategy-providers/{id}/catalog-free-pass:
 *   post:
 *     summary: Grant catalog free pass to a strategy provider
 *     description: Allow superadmins to grant catalog display free pass to strategy providers, bypassing normal eligibility requirements
 *     tags: [Superadmin - Free Pass Management]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Strategy provider ID
 *         example: 123
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reason
 *             properties:
 *               reason:
 *                 type: string
 *                 minLength: 10
 *                 description: Reason for granting free pass (minimum 10 characters)
 *                 example: "Exceptional strategy with proven track record and high-quality trading approach"
 *     responses:
 *       200:
 *         description: Free pass granted successfully
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
 *                   example: "Catalog free pass granted successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_provider_id:
 *                       type: integer
 *                       example: 123
 *                     strategy_name:
 *                       type: string
 *                       example: "EURUSD Pro Strategy"
 *                     granted_by:
 *                       type: integer
 *                       example: 1
 *                     granted_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-15T10:30:00.000Z"
 *                     reason:
 *                       type: string
 *                       example: "Exceptional strategy with proven track record"
 *                     owner:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                           example: 456
 *                         name:
 *                           type: string
 *                           example: "John Doe"
 *                         email:
 *                           type: string
 *                           example: "john.doe@example.com"
 *       400:
 *         description: Bad request - Invalid input or strategy already has free pass
 *       401:
 *         description: Unauthorized - Invalid or missing admin token
 *       404:
 *         description: Strategy provider not found
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/superadmin/strategy-providers/{id}/catalog-free-pass:
 *   delete:
 *     summary: Revoke catalog free pass from a strategy provider
 *     description: Remove catalog display free pass from a strategy provider, returning them to normal eligibility checking
 *     tags: [Superadmin - Free Pass Management]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Strategy provider ID
 *         example: 123
 *     responses:
 *       200:
 *         description: Free pass revoked successfully
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
 *                   example: "Catalog free pass revoked successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_provider_id:
 *                       type: integer
 *                       example: 123
 *                     strategy_name:
 *                       type: string
 *                       example: "EURUSD Pro Strategy"
 *                     revoked_by:
 *                       type: integer
 *                       example: 1
 *                     revoked_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-15T11:30:00.000Z"
 *                     previous_grant:
 *                       type: object
 *                       properties:
 *                         granted_by:
 *                           type: integer
 *                           example: 1
 *                         granted_at:
 *                           type: string
 *                           format: date-time
 *                           example: "2024-01-15T10:30:00.000Z"
 *                         reason:
 *                           type: string
 *                           example: "Exceptional strategy with proven track record"
 *       400:
 *         description: Bad request - Strategy does not have free pass
 *       401:
 *         description: Unauthorized - Invalid or missing admin token
 *       404:
 *         description: Strategy provider not found
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/superadmin/strategy-providers/catalog-free-pass:
 *   get:
 *     summary: Get all strategy providers with catalog free pass
 *     description: Retrieve paginated list of all strategy providers that have been granted catalog free pass
 *     tags: [Superadmin - Free Pass Management]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number
 *         example: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Items per page
 *         example: 20
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by strategy name
 *         example: "EURUSD"
 *       - in: query
 *         name: granted_by
 *         schema:
 *           type: integer
 *         description: Filter by admin ID who granted the free pass
 *         example: 1
 *     responses:
 *       200:
 *         description: Free pass accounts retrieved successfully
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
 *                   example: "Free pass accounts retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     free_pass_accounts:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/FreePassAccount'
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         current_page:
 *                           type: integer
 *                           example: 1
 *                         per_page:
 *                           type: integer
 *                           example: 20
 *                         total_items:
 *                           type: integer
 *                           example: 45
 *                         total_pages:
 *                           type: integer
 *                           example: 3
 *                         has_next_page:
 *                           type: boolean
 *                           example: true
 *                         has_prev_page:
 *                           type: boolean
 *                           example: false
 *                     filters_applied:
 *                       type: object
 *                       example: {"search": "EURUSD"}
 *       401:
 *         description: Unauthorized - Invalid or missing admin token
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/superadmin/strategy-providers/{id}/catalog-free-pass/history:
 *   get:
 *     summary: Get free pass history for a strategy provider
 *     description: Retrieve the current free pass status and history for a specific strategy provider
 *     tags: [Superadmin - Free Pass Management]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Strategy provider ID
 *         example: 123
 *     responses:
 *       200:
 *         description: Free pass history retrieved successfully
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
 *                   example: "Free pass history retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_provider:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: integer
 *                           example: 123
 *                         strategy_name:
 *                           type: string
 *                           example: "EURUSD Pro Strategy"
 *                         owner:
 *                           type: object
 *                           properties:
 *                             id:
 *                               type: integer
 *                               example: 456
 *                             name:
 *                               type: string
 *                               example: "John Doe"
 *                             email:
 *                               type: string
 *                               example: "john.doe@example.com"
 *                     current_free_pass_status:
 *                       type: object
 *                       properties:
 *                         has_free_pass:
 *                           type: boolean
 *                           example: true
 *                         granted_by:
 *                           type: integer
 *                           example: 1
 *                         granted_at:
 *                           type: string
 *                           format: date-time
 *                           example: "2024-01-15T10:30:00.000Z"
 *                         reason:
 *                           type: string
 *                           example: "Exceptional strategy with proven track record"
 *                         is_catalog_eligible:
 *                           type: boolean
 *                           example: true
 *       401:
 *         description: Unauthorized - Invalid or missing admin token
 *       404:
 *         description: Strategy provider not found
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/superadmin/strategy-providers/catalog-free-pass/statistics:
 *   get:
 *     summary: Get free pass statistics
 *     description: Retrieve overall statistics about catalog free pass usage
 *     tags: [Superadmin - Free Pass Management]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Free pass statistics retrieved successfully
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
 *                   example: "Free pass statistics retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     total_free_pass_accounts:
 *                       type: integer
 *                       description: Total number of accounts with free pass
 *                       example: 25
 *                     active_free_pass_accounts:
 *                       type: integer
 *                       description: Active accounts with free pass
 *                       example: 22
 *                     total_catalog_eligible:
 *                       type: integer
 *                       description: Total catalog eligible accounts
 *                       example: 150
 *                     free_pass_percentage:
 *                       type: number
 *                       description: Percentage of eligible accounts with free pass
 *                       example: 14.67
 *                     last_updated:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-15T12:00:00.000Z"
 *       401:
 *         description: Unauthorized - Invalid or missing admin token
 *       500:
 *         description: Internal server error
 */

// Apply superadmin authentication to all routes
router.use(authenticateAdmin);
router.use(requireRole(['superadmin']));

// Free pass management routes
router.post('/:id/catalog-free-pass', superadminFreePassController.grantCatalogFreePass);
router.delete('/:id/catalog-free-pass', superadminFreePassController.revokeCatalogFreePass);
router.get('/catalog-free-pass', superadminFreePassController.getFreePassAccounts);
router.get('/:id/catalog-free-pass/history', superadminFreePassController.getFreePassHistory);
router.get('/catalog-free-pass/statistics', superadminFreePassController.getFreePassStatistics);

module.exports = router;
