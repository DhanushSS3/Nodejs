const express = require('express');
const router = express.Router();
const cronController = require('../controllers/cron.controller');
const { authenticateAdmin } = require('../middlewares/auth.middleware');

/**
 * @swagger
 * components:
 *   schemas:
 *     CronJobStatus:
 *       type: object
 *       properties:
 *         enabled:
 *           type: boolean
 *           description: Whether the cron job is enabled
 *           example: true
 *         cronExpression:
 *           type: string
 *           description: Cron expression for scheduling
 *           example: "0 2 * * *"
 *         timezone:
 *           type: string
 *           description: Timezone for cron execution
 *           example: "UTC"
 *         description:
 *           type: string
 *           description: Human-readable description
 *           example: "Daily catalog eligibility update at 2:00 AM UTC"
 *         nextRun:
 *           type: string
 *           format: date-time
 *           description: Next scheduled run time
 */

/**
 * @swagger
 * /api/admin/cron/catalog-eligibility/trigger:
 *   post:
 *     summary: Manually trigger catalog eligibility update
 *     description: Trigger the catalog eligibility update job manually (admin only)
 *     tags: [Admin - Cron Jobs]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Catalog eligibility update triggered successfully
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
 *                   example: "Catalog eligibility update triggered successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     triggered_at:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-15T10:30:00.000Z"
 *                     triggered_by:
 *                       type: string
 *                       example: "admin@livefxhub.com"
 *                     status:
 *                       type: string
 *                       example: "Update job started - check logs for progress"
 *       401:
 *         description: Unauthorized - Invalid or missing admin token
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/admin/cron/catalog-eligibility/status:
 *   get:
 *     summary: Get catalog eligibility cron job status
 *     description: Get the current status and configuration of the catalog eligibility cron job
 *     tags: [Admin - Cron Jobs]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Cron job status retrieved successfully
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
 *                   example: "Catalog eligibility cron job status retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     cron_job:
 *                       $ref: '#/components/schemas/CronJobStatus'
 *                     last_checked:
 *                       type: string
 *                       format: date-time
 *                       example: "2024-01-15T10:30:00.000Z"
 *       401:
 *         description: Unauthorized - Invalid or missing admin token
 *       500:
 *         description: Internal server error
 */

// Apply admin authentication to all routes
router.use(authenticateAdmin);

// Catalog eligibility cron job routes
router.post('/catalog-eligibility/trigger', cronController.triggerCatalogEligibilityUpdate);
router.get('/catalog-eligibility/status', cronController.getCatalogEligibilityStatus);

module.exports = router;
