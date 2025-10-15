const express = require('express');
const router = express.Router();

const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');
const ctrl = require('../controllers/superadmin.orders.controller');

// All endpoints in this router require superadmin
router.use(authenticateAdmin);
router.use(requireRole(['superadmin']));

/**
 * @swagger
 * tags:
 *   name: Superadmin Orders
 *   description: Admin-only endpoints to repair/rebuild Redis order indices
 */

/**
 * @swagger
 * /api/superadmin/orders/rebuild/user:
 *   post:
 *     summary: Rebuild a user's order indices (and optionally backfill holdings from SQL)
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_type, user_id]
 *             properties:
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               user_id:
 *                 type: string
 *               include_queued:
 *                 type: boolean
 *                 description: If true, includes QUEUED orders when backfilling from SQL
 *               backfill:
 *                 type: boolean
 *                 description: If true, backfill user_holdings from SQL before rebuilding indices
  *               deep:
  *                 type: boolean
  *                 description: If true (default), also rebuild execution caches (pending, triggers, order_data)
  *               prune:
  *                 type: boolean
  *                 description: If true, prune Redis entries not present in SQL for this user
  *               prune_symbol_holders:
  *                 type: boolean
  *                 description: If true, also SREM user from symbol_holders when they have no other active orders on the symbol
 *     responses:
 *       200:
 *         description: Rebuild completed
 */
router.post('/rebuild/user', ctrl.rebuildUser);

/**
 * @swagger
 * /api/superadmin/orders/prune/user:
 *   post:
 *     summary: Prune a user's Redis entries that do not exist in SQL
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_type, user_id]
 *             properties:
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               user_id:
 *                 type: string
 *               deep:
 *                 type: boolean
 *                 description: If true (default), also remove order_data, pending, triggers, and global lookups for stale orders
 *               prune_symbol_holders:
 *                 type: boolean
 *                 description: If true, also SREM user from symbol_holders when they have no other active orders on that symbol
 *     responses:
 *       200:
 *         description: Prune completed
 */
router.post('/prune/user', ctrl.pruneUser);

/**
 * @swagger
 * /api/superadmin/orders/rebuild/symbol:
 *   post:
 *     summary: Rebuild symbol_holders for a symbol by inspecting user indices
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [symbol]
 *             properties:
 *               symbol:
 *                 type: string
 *               scope:
 *                 type: string
 *                 enum: [live, demo, both]
 *                 default: both
 *     responses:
 *       200:
 *         description: Rebuild completed
 */
router.post('/rebuild/symbol', ctrl.rebuildSymbol);

/**
 * @swagger
 * /api/superadmin/orders/ensure/holding:
 *   post:
 *     summary: Ensure a single holding exists in Redis for an OPEN order from SQL
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_type, user_id, order_id]
 *             properties:
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               user_id:
 *                 type: string
 *               order_id:
 *                 type: string
 */
router.post('/ensure/holding', ctrl.ensureHolding);

/**
 * @swagger
 * /api/superadmin/orders/ensure/symbol-holder:
 *   post:
 *     summary: Ensure a user appears in symbol_holders for a symbol
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_type, user_id, symbol]
 *             properties:
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               user_id:
 *                 type: string
 *               symbol:
 *                 type: string
 */
router.post('/ensure/symbol-holder', ctrl.ensureSymbolHolder);

/**
 * @swagger
 * /api/superadmin/orders/portfolio:
 *   get:
 *     summary: Fetch a user's comprehensive portfolio details from Redis
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: user_type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *         description: User account type
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to fetch the portfolio for
 *       - in: query
 *         name: detailed
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         description: If true, includes additional details like user config, order counts, and recent orders
 *     responses:
 *       200:
 *         description: Portfolio details fetched successfully
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
 *                     user_type:
 *                       type: string
 *                     user_id:
 *                       type: string
 *                     redis_key:
 *                       type: string
 *                     portfolio:
 *                       type: object
 *                       properties:
 *                         equity:
 *                           type: number
 *                         balance:
 *                           type: number
 *                         free_margin:
 *                           type: number
 *                         used_margin:
 *                           type: number
 *                         margin_level:
 *                           type: number
 *                         open_pnl:
 *                           type: number
 *                         total_pl:
 *                           type: number
 *                         ts:
 *                           type: number
 *                     analysis:
 *                       type: object
 *                       properties:
 *                         margin_utilization_percent:
 *                           type: string
 *                         risk_level:
 *                           type: string
 *                           enum: [LOW, MEDIUM, HIGH]
 *                         portfolio_performance:
 *                           type: string
 *                           enum: [POSITIVE, NEGATIVE]
 *                         last_updated:
 *                           type: string
 *                           format: date-time
 *                     detailed_info:
 *                       type: object
 *                       description: Only included when detailed=true
 *                       properties:
 *                         user_config:
 *                           type: object
 *                         active_orders_count:
 *                           type: number
 *                         pending_orders_count:
 *                           type: number
 *                         recent_orders:
 *                           type: array
 *                           items:
 *                             type: object
 *       404:
 *         description: Portfolio not found in Redis for the given user
 */
router.get('/portfolio', ctrl.getUserPortfolio);

/**
 * @swagger
 * /api/superadmin/orders/reject-queued:
 *   post:
 *     summary: Manually reject a queued order and release reserved margin
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order_id, user_type, user_id]
 *             properties:
 *               order_id:
 *                 type: string
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *               user_id:
 *                 type: string
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Order rejected and margin released
 */
router.post('/reject-queued', ctrl.rejectQueued);

/**
 * @swagger
 * /api/superadmin/orders/queued:
 *   get:
 *     summary: List all queued orders for a user
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: user_type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Queued orders retrieved
 */
router.get('/queued', ctrl.getQueuedOrders);

/**
 * @swagger
 * /api/superadmin/orders/margin-status:
 *   get:
 *     summary: Get executed vs total margin status for a user
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: user_type
 *         required: true
 *         schema:
 *           type: string
 *           enum: [live, demo]
 *       - in: query
 *         name: user_id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Margin status retrieved
 */
router.get('/margin-status', ctrl.getMarginStatus);

/**
 * @swagger
 * /api/superadmin/orders/rebuild/portfolio:
 *   post:
 *     summary: Rebuild user portfolio (balance, margin, equity) from database orders
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [user_type, user_id]
 *             properties:
 *               user_type:
 *                 type: string
 *                 enum: [live, demo]
 *                 description: User account type
 *               user_id:
 *                 type: string
 *                 description: User ID to rebuild portfolio for
 *               recalculate_margin:
 *                 type: boolean
 *                 default: true
 *                 description: If true, uses Python service for precise margin calculation
 *               update_redis_portfolio:
 *                 type: boolean
 *                 default: true
 *                 description: If true, updates Redis portfolio cache
 *               update_sql_margin:
 *                 type: boolean
 *                 default: true
 *                 description: If true, updates SQL margin field if changed
 *               force_refresh:
 *                 type: boolean
 *                 default: false
 *                 description: If true, forces fresh calculation from Python service
 *     responses:
 *       200:
 *         description: Portfolio rebuilt successfully
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
 *                     user_type:
 *                       type: string
 *                     user_id:
 *                       type: string
 *                     before:
 *                       type: object
 *                       properties:
 *                         balance:
 *                           type: number
 *                         margin:
 *                           type: number
 *                         orders_count:
 *                           type: number
 *                     after:
 *                       type: object
 *                       properties:
 *                         balance:
 *                           type: number
 *                         used_margin:
 *                           type: number
 *                         free_margin:
 *                           type: number
 *                         equity:
 *                           type: number
 *                         margin_level:
 *                           type: number
 *                         open_pnl:
 *                           type: number
 *                         total_pnl:
 *                           type: number
 *                         open_orders_count:
 *                           type: number
 *                         pending_orders_count:
 *                           type: number
 *                         closed_orders_count:
 *                           type: number
 *                         calculation_source:
 *                           type: string
 *                     updated:
 *                       type: object
 *                       properties:
 *                         redis_portfolio:
 *                           type: boolean
 *                         sql_margin:
 *                           type: boolean
 *                         python_triggered:
 *                           type: boolean
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Internal server error
 */
router.post('/rebuild/portfolio', ctrl.rebuildUserPortfolio);

/**
 * @swagger
 * /api/superadmin/orders/rebuild/portfolio/batch:
 *   post:
 *     summary: Rebuild multiple user portfolios in batch
 *     tags: [Superadmin Orders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [requests]
 *             properties:
 *               requests:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [user_type, user_id]
 *                   properties:
 *                     user_type:
 *                       type: string
 *                       enum: [live, demo]
 *                     user_id:
 *                       type: string
 *                     options:
 *                       type: object
 *                       properties:
 *                         recalculate_margin:
 *                           type: boolean
 *                         update_redis_portfolio:
 *                           type: boolean
 *                         update_sql_margin:
 *                           type: boolean
 *                         force_refresh:
 *                           type: boolean
 *               global_options:
 *                 type: object
 *                 description: Default options applied to all requests
 *                 properties:
 *                   recalculate_margin:
 *                     type: boolean
 *                     default: true
 *                   update_redis_portfolio:
 *                     type: boolean
 *                     default: true
 *                   update_sql_margin:
 *                     type: boolean
 *                     default: true
 *                   force_refresh:
 *                     type: boolean
 *                     default: false
 *     responses:
 *       200:
 *         description: Batch rebuild completed
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
 *                     success_count:
 *                       type: number
 *                     error_count:
 *                       type: number
 *                     results:
 *                       type: array
 *                       items:
 *                         type: object
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           user_type:
 *                             type: string
 *                           user_id:
 *                             type: string
 *                           error:
 *                             type: string
 */
router.post('/rebuild/portfolio/batch', ctrl.rebuildMultiplePortfolios);

module.exports = router;
