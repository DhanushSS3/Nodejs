const express = require('express');
const { body, param } = require('express-validator');
const EquityMonitorController = require('../controllers/equityMonitor.controller');
const { validateRequest } = require('../middleware/validation.middleware');
const { authenticateJWT } = require('../middleware/auth.middleware');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Equity Monitor
 *   description: Copy follower equity monitoring and auto stop copying management
 */

/**
 * @swagger
 * /api/equity-monitor/job/status:
 *   get:
 *     summary: Get equity monitoring job status
 *     tags: [Equity Monitor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Job status retrieved successfully
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
 *                     isScheduled:
 *                       type: boolean
 *                     isRunning:
 *                       type: boolean
 *                     intervalSeconds:
 *                       type: number
 *                     nextRun:
 *                       type: string
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.get('/job/status', authenticateJWT, EquityMonitorController.getJobStatus);

/**
 * @swagger
 * /api/equity-monitor/job/start:
 *   post:
 *     summary: Start equity monitoring job
 *     tags: [Equity Monitor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Job started successfully
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.post('/job/start', authenticateJWT, EquityMonitorController.startJob);

/**
 * @swagger
 * /api/equity-monitor/job/stop:
 *   post:
 *     summary: Stop equity monitoring job
 *     tags: [Equity Monitor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Job stopped successfully
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.post('/job/stop', authenticateJWT, EquityMonitorController.stopJob);

/**
 * @swagger
 * /api/equity-monitor/run-once:
 *   post:
 *     summary: Run equity monitoring once manually
 *     tags: [Equity Monitor]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Monitoring completed successfully
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
 *                     totalAccounts:
 *                       type: number
 *                     checkedCount:
 *                       type: number
 *                     triggeredCount:
 *                       type: number
 *                     errors:
 *                       type: array
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.post('/run-once', authenticateJWT, EquityMonitorController.runOnce);

/**
 * @swagger
 * /api/equity-monitor/account/{copy_follower_account_id}/check:
 *   get:
 *     summary: Check equity thresholds for specific copy follower account
 *     tags: [Equity Monitor]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: copy_follower_account_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Copy follower account ID
 *     responses:
 *       200:
 *         description: Thresholds checked successfully
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
 *                     copy_follower_account_id:
 *                       type: number
 *                     account_name:
 *                       type: string
 *                     thresholdCheck:
 *                       type: object
 *                       properties:
 *                         shouldStopCopying:
 *                           type: boolean
 *                         reason:
 *                           type: string
 *                         thresholdType:
 *                           type: string
 *                         currentEquity:
 *                           type: number
 *                         thresholdValue:
 *                           type: number
 *                         initialInvestment:
 *                           type: number
 *       400:
 *         description: Invalid account ID
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Account not found
 *       500:
 *         description: Internal server error
 */
router.get(
  '/account/:copy_follower_account_id/check',
  authenticateJWT,
  [
    param('copy_follower_account_id')
      .isInt({ min: 1 })
      .withMessage('Copy follower account ID must be a positive integer')
  ],
  validateRequest,
  EquityMonitorController.checkAccountThresholds
);

/**
 * @swagger
 * /api/equity-monitor/validate-settings:
 *   post:
 *     summary: Validate SL/TP settings for copy follower account
 *     tags: [Equity Monitor]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               copy_sl_mode:
 *                 type: string
 *                 enum: [percentage, amount, none]
 *               sl_percentage:
 *                 type: number
 *                 minimum: 0.01
 *                 maximum: 100
 *               sl_amount:
 *                 type: number
 *                 minimum: 0.01
 *               copy_tp_mode:
 *                 type: string
 *                 enum: [percentage, amount, none]
 *               tp_percentage:
 *                 type: number
 *                 minimum: 0.01
 *                 maximum: 1000
 *               tp_amount:
 *                 type: number
 *                 minimum: 0.01
 *               initial_investment:
 *                 type: number
 *                 minimum: 0.01
 *     responses:
 *       200:
 *         description: Settings validated successfully
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
 *                     isValid:
 *                       type: boolean
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: string
 *                     warnings:
 *                       type: array
 *                       items:
 *                         type: string
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Internal server error
 */
router.post(
  '/validate-settings',
  authenticateJWT,
  [
    body('copy_sl_mode')
      .optional()
      .isIn(['percentage', 'amount', 'none'])
      .withMessage('Stop loss mode must be percentage, amount, or none'),
    body('sl_percentage')
      .optional()
      .isFloat({ min: 0.01, max: 100 })
      .withMessage('Stop loss percentage must be between 0.01% and 100%'),
    body('sl_amount')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('Stop loss amount must be greater than 0.01'),
    body('copy_tp_mode')
      .optional()
      .isIn(['percentage', 'amount', 'none'])
      .withMessage('Take profit mode must be percentage, amount, or none'),
    body('tp_percentage')
      .optional()
      .isFloat({ min: 0.01, max: 1000 })
      .withMessage('Take profit percentage must be between 0.01% and 1000%'),
    body('tp_amount')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('Take profit amount must be greater than 0.01'),
    body('initial_investment')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('Initial investment must be greater than 0.01')
  ],
  validateRequest,
  EquityMonitorController.validateSlTpSettings
);

module.exports = router;
