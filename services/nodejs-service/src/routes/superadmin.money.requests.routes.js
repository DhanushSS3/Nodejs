const express = require('express');
const router = express.Router();
const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/superadmin.money.requests.controller');

// All routes here require superadmin
router.use(authenticateAdmin, requireRole(['superadmin']));

/**
 * @swagger
 * tags:
 *   name: Superadmin Money Requests
 *   description: Review and process user money requests
 */

/**
 * @swagger
 * /api/superadmin/money-requests/pending:
 *   get:
 *     summary: List pending money requests (withdraw/deposit)
 *     tags: [Superadmin Money Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [deposit, withdraw]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Pending requests
 */
router.get('/money-requests/pending', ctrl.getPending);

/**
 * @swagger
 * /api/superadmin/money-requests/{requestId}:
 *   get:
 *     summary: Get a money request by ID
 *     tags: [Superadmin Money Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Money request details
 */
router.get('/money-requests/:requestId', ctrl.getById);

/**
 * @swagger
 * /api/superadmin/money-requests/{requestId}/approve:
 *   post:
 *     summary: Approve a money request
 *     tags: [Superadmin Money Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Request approved and transaction created
 */
router.post('/money-requests/:requestId/approve', ctrl.approve);

/**
 * @swagger
 * /api/superadmin/money-requests/{requestId}/reject:
 *   post:
 *     summary: Reject a money request
 *     tags: [Superadmin Money Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Request rejected
 */
router.post('/money-requests/:requestId/reject', ctrl.reject);

/**
 * @swagger
 * /api/superadmin/money-requests/{requestId}/hold:
 *   post:
 *     summary: Put a money request on hold
 *     tags: [Superadmin Money Requests]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Request put on hold
 */
router.post('/money-requests/:requestId/hold', ctrl.hold);

module.exports = router;
