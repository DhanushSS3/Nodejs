const express = require('express');
const { query } = require('express-validator');
const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');
const { handleValidationErrors } = require('../middlewares/error.middleware');
const PythonHealthController = require('../controllers/python.health.controller');

const router = express.Router();

/**
 * @swagger
 * /api/python-health/status:
 *   get:
 *     summary: Get Python market service comprehensive health status
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Python market service health status
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
 *                   example: "Python market service health retrieved"
 *                 data:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       enum: [healthy, degraded, unhealthy]
 *                     timestamp:
 *                       type: integer
 *                     components:
 *                       type: object
 *                       properties:
 *                         redis_cluster:
 *                           type: object
 *                         redis_pubsub:
 *                           type: object
 *                         market_data:
 *                           type: object
 *                         websocket_listener:
 *                           type: object
 *                         execution_prices:
 *                           type: object
 *                     issues:
 *                       type: array
 *                       items:
 *                         type: string
 *       503:
 *         description: Python market service is unhealthy or unreachable
 */
router.get('/status',
  authenticateAdmin,
  PythonHealthController.getHealthStatus
);

/**
 * @swagger
 * /api/python-health/market-data:
 *   get:
 *     summary: Get detailed market data health check
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Market data health status
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
 *                     status:
 *                       type: string
 *                     timestamp:
 *                       type: integer
 *                     total_symbols:
 *                       type: integer
 *                     stale_symbols_count:
 *                       type: integer
 *                     stale_symbols:
 *                       type: array
 *                     inconsistent_symbols_count:
 *                       type: integer
 *                     inconsistent_symbols:
 *                       type: array
 *                     missing_data_symbols_count:
 *                       type: integer
 *                     staleness_threshold_ms:
 *                       type: integer
 */
router.get('/market-data',
  authenticateAdmin,
  PythonHealthController.getMarketDataHealth
);

/**
 * @swagger
 * /api/python-health/execution-prices:
 *   get:
 *     summary: Get execution price calculation health check
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Execution price health status
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
 *                     status:
 *                       type: string
 *                     timestamp:
 *                       type: integer
 *                     tested_symbols:
 *                       type: integer
 *                     tested_groups:
 *                       type: integer
 *                     successful_tests:
 *                       type: integer
 *                     total_tests:
 *                       type: integer
 *                     success_rate_percent:
 *                       type: number
 *                     failed_symbols:
 *                       type: array
 */
router.get('/execution-prices',
  authenticateAdmin,
  PythonHealthController.getExecutionPriceHealth
);

/**
 * @swagger
 * /api/python-health/cleanup/status:
 *   get:
 *     summary: Get market data cleanup service status
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Cleanup service status
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
 *                     is_running:
 *                       type: boolean
 *                     staleness_threshold_seconds:
 *                       type: integer
 *                     cleanup_interval_seconds:
 *                       type: integer
 *                     statistics:
 *                       type: object
 */
router.get('/cleanup/status',
  authenticateAdmin,
  requireRole(['superadmin']),
  PythonHealthController.getCleanupStatus
);

/**
 * @swagger
 * /api/python-health/cleanup/force:
 *   post:
 *     summary: Force immediate market data cleanup (Superadmin only)
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Cleanup completed successfully
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
 *                     symbols_scanned:
 *                       type: integer
 *                     stale_removed:
 *                       type: integer
 *                     inconsistent_fixed:
 *                       type: integer
 *                     duration_ms:
 *                       type: number
 */
router.post('/cleanup/force',
  authenticateAdmin,
  requireRole(['superadmin']),
  PythonHealthController.forceCleanup
);

/**
 * @swagger
 * /api/python-health/websocket/status:
 *   get:
 *     summary: Get WebSocket listener status and performance metrics
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: WebSocket listener status
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
 *                     is_running:
 *                       type: boolean
 *                     current_ws_url:
 *                       type: string
 *                     protocol:
 *                       type: string
 *                     queued_messages:
 *                       type: integer
 *                     batch_size:
 *                       type: integer
 *                     performance:
 *                       type: object
 */
router.get('/websocket/status',
  authenticateAdmin,
  PythonHealthController.getWebSocketStatus
);

/**
 * @swagger
 * /api/python-health/logs/execution-price-issues:
 *   get:
 *     summary: Get recent execution price issues from debug logs (Superadmin only)
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *           minimum: 1
 *           maximum: 500
 *         description: Number of recent log entries to retrieve
 *       - in: query
 *         name: severity
 *         schema:
 *           type: string
 *           enum: [all, critical, high, medium]
 *           default: all
 *         description: Filter by issue severity
 *       - in: query
 *         name: user_type
 *         schema:
 *           type: string
 *           enum: [all, rock, demo, live]
 *           default: all
 *         description: Filter by user type
 *     responses:
 *       200:
 *         description: Recent execution price issues
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
 *                     total_issues:
 *                       type: integer
 *                     issues_by_type:
 *                       type: object
 *                     recent_issues:
 *                       type: array
 *                     log_files_checked:
 *                       type: array
 */
router.get('/logs/execution-price-issues',
  authenticateAdmin,
  requireRole(['superadmin']),
  [
    query('limit').optional().isInt({ min: 1, max: 500 }).withMessage('Limit must be between 1 and 500'),
    query('severity').optional().isIn(['all', 'critical', 'high', 'medium']).withMessage('Invalid severity filter'),
    query('user_type').optional().isIn(['all', 'rock', 'demo', 'live']).withMessage('Invalid user type filter')
  ],
  handleValidationErrors,
  PythonHealthController.getExecutionPriceIssues
);

/**
 * @swagger
 * /api/python-health/protobuf/switch:
 *   post:
 *     summary: Switch to protobuf binary WebSocket listener (Superadmin only)
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               enable:
 *                 type: boolean
 *                 description: Enable (true) or disable (false) protobuf listener
 *             required:
 *               - enable
 *     responses:
 *       200:
 *         description: WebSocket listener switched successfully
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
 *                     previous_listener:
 *                       type: string
 *                     current_listener:
 *                       type: string
 *                     switch_time:
 *                       type: string
 */
router.post('/protobuf/switch',
  authenticateAdmin,
  requireRole(['superadmin']),
  PythonHealthController.switchProtobufListener
);

/**
 * @swagger
 * /api/python-health/debug/comprehensive:
 *   get:
 *     summary: Get comprehensive debug information for production troubleshooting
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Comprehensive debug information
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
 *                     timestamp:
 *                       type: integer
 *                     system_info:
 *                       type: object
 *                     redis_diagnostics:
 *                       type: object
 *                     websocket_diagnostics:
 *                       type: object
 *                     market_data_diagnostics:
 *                       type: object
 *                     performance_metrics:
 *                       type: object
 */
router.get('/debug/comprehensive',
  authenticateAdmin,
  requireRole(['superadmin']),
  PythonHealthController.getComprehensiveDebug
);

/**
 * @swagger
 * /api/python-health/debug/redis-cluster:
 *   get:
 *     summary: Get detailed Redis cluster diagnostics including connection pool analysis
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: Redis cluster diagnostics
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
 *                     cluster_health:
 *                       type: object
 *                     individual_nodes:
 *                       type: object
 *                     connection_pool:
 *                       type: object
 *                       properties:
 *                         active_connections:
 *                           type: integer
 *                         utilization_percent:
 *                           type: number
 *                         connection_success_rate:
 *                           type: number
 *                         avg_response_time_ms:
 *                           type: number
 */
router.get('/debug/redis-cluster',
  authenticateAdmin,
  requireRole(['superadmin']),
  PythonHealthController.getRedisClusterDebug
);

/**
 * @swagger
 * /api/python-health/debug/websocket-to-redis:
 *   get:
 *     summary: Debug WebSocket to Redis data flow to identify connection issues
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: WebSocket to Redis flow analysis
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
 *                     websocket_status:
 *                       type: object
 *                     redis_write_test:
 *                       type: object
 *                     market_service_status:
 *                       type: object
 *                     data_flow_analysis:
 *                       type: object
 *                     potential_issues:
 *                       type: array
 */
router.get('/debug/websocket-to-redis',
  authenticateAdmin,
  requireRole(['superadmin']),
  PythonHealthController.getWebSocketToRedisDebug
);

/**
 * @swagger
 * /api/python-health/listener-status:
 *   get:
 *     summary: Get WebSocket listener configuration and performance comparison
 *     tags: [Python Health]
 *     security:
 *       - adminAuth: []
 *     responses:
 *       200:
 *         description: WebSocket listener status and configuration
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
 *                     current_listener:
 *                       type: string
 *                       enum: [binary, json]
 *                     recommendation:
 *                       type: string
 *                     configuration:
 *                       type: object
 *                     performance_comparison:
 *                       type: object
 *                     bottleneck_analysis:
 *                       type: object
 */
router.get('/listener-status',
  authenticateAdmin,
  requireRole(['superadmin']),
  PythonHealthController.getListenerStatus
);

module.exports = router;
