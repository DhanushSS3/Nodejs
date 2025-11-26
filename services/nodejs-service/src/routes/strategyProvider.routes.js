const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const strategyProviderController = require('../controllers/strategyProvider.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');

// Configure multer for profile picture uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../../uploads/strategy-profiles/'));
  },
  filename: function (req, file, cb) {
    // Generate unique filename: SP_userId_timestamp.ext
    const userId = req.user?.sub || req.user?.user_id || req.user?.id;
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `SP_${userId}_${timestamp}${ext}`);
  }
});

// File filter for images only
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  
  if (mimetype && extname) {
    return cb(null, true);
  } else {
    cb(new Error('Only image files (JPEG, JPG, PNG, GIF, WebP) are allowed'));
  }
};

// Configure multer upload
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 15 * 1024 * 1024, // 15MB limit
  },
  fileFilter: fileFilter
});

/**
 * @swagger
 * components:
 *   schemas:
 *     CreateStrategyProviderRequest:
 *       type: object
 *       required:
 *         - strategy_name
 *       properties:
 *         strategy_name:
 *           type: string
 *           minLength: 10
 *           maxLength: 100
 *           description: Unique strategy name (minimum 10 characters)
 *           example: "EURUSD Scalping Pro Strategy"
 *         description:
 *           type: string
 *           description: Strategy description
 *           example: "Professional EURUSD scalping strategy with 80% win rate"
 *         visibility:
 *           type: string
 *           enum: [public, private]
 *           default: public
 *           description: Strategy visibility
 *         performance_fee:
 *           type: number
 *           minimum: 5.00
 *           maximum: 50.00
 *           default: 20.00
 *           description: Performance fee percentage (5-50%)
 *           example: 25.00
 *         leverage:
 *           type: integer
 *           enum: [50, 100, 200]
 *           default: 100
 *           description: Account leverage
 *         max_leverage:
 *           type: integer
 *           enum: [50, 100, 200]
 *           description: Maximum leverage for followers
 *         min_investment:
 *           type: number
 *           minimum: 100.00
 *           default: 100.00
 *           description: Minimum investment amount in USD
 *           example: 500.00
 *         max_total_investment:
 *           type: number
 *           maximum: 500000.00
 *           default: 500000.00
 *           description: Maximum total investment amount in USD
 *         max_followers:
 *           type: integer
 *           default: 1000
 *           description: Maximum number of followers
 *         auto_cutoff_level:
 *           type: number
 *           minimum: 10.00
 *           maximum: 90.00
 *           default: 50.00
 *           description: Auto-cutoff level percentage
 *         group:
 *           type: string
 *           description: Trading group
 *           example: "Standard"
 *         strategy_password:
 *           type: string
 *           minLength: 8
 *           description: Password for private strategies (required if visibility is private)
 *     
 *     StrategyProviderResponse:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Strategy provider account ID
 *         user_id:
 *           type: integer
 *           description: Owner user ID
 *         strategy_name:
 *           type: string
 *           description: Strategy name
 *         description:
 *           type: string
 *           description: Strategy description
 *         account_number:
 *           type: string
 *           description: Unique account number
 *         wallet_balance:
 *           type: number
 *           description: Current wallet balance
 *         leverage:
 *           type: integer
 *           description: Account leverage
 *         margin:
 *           type: number
 *           description: Used margin
 *         net_profit:
 *           type: number
 *           description: Net profit/loss
 *         equity:
 *           type: number
 *           description: Account equity
 *         group:
 *           type: string
 *           description: Trading group
 *         visibility:
 *           type: string
 *           enum: [public, private]
 *           description: Strategy visibility
 *         access_link:
 *           type: string
 *           description: Access link for private strategies
 *         performance_fee:
 *           type: number
 *           description: Performance fee percentage
 *         min_investment:
 *           type: number
 *           description: Minimum investment amount
 *         max_total_investment:
 *           type: number
 *           description: Maximum total investment
 *         max_followers:
 *           type: integer
 *           description: Maximum followers
 *         status:
 *           type: integer
 *           description: Account status (1=active, 0=inactive)
 *         is_active:
 *           type: integer
 *           description: Active flag
 *         is_catalog_eligible:
 *           type: boolean
 *           description: Catalog eligibility
 *         is_trustworthy:
 *           type: boolean
 *           description: Trustworthy status
 *         total_followers:
 *           type: integer
 *           description: Current follower count
 *         total_investment:
 *           type: number
 *           description: Total investment amount
 *         total_trades:
 *           type: integer
 *           description: Total trades executed
 *         win_rate:
 *           type: number
 *           description: Win rate percentage
 *         profile_image_url:
 *           type: string
 *           nullable: true
 *           description: Profile image URL
 *           example: "/uploads/strategy-profiles/SP_123_1704567890123.jpg"
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Last update timestamp
 */

/**
 * @swagger
 * /api/strategy-providers:
 *   post:
 *     summary: Create a new strategy provider account
 *     description: Create a new strategy provider account for authenticated live user following Exness requirements
 *     tags: [Strategy Providers]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - strategy_name
 *             properties:
 *               strategy_name:
 *                 type: string
 *                 minLength: 10
 *                 maxLength: 100
 *                 description: Strategy name (10-100 characters)
 *                 example: "EURUSD Scalping Pro Strategy"
 *               description:
 *                 type: string
 *                 maxLength: 1000
 *                 description: Strategy description
 *                 example: "Professional EURUSD scalping strategy with consistent profits"
 *               visibility:
 *                 type: string
 *                 enum: [public, private]
 *                 default: public
 *                 description: Strategy visibility
 *               strategy_password:
 *                 type: string
 *                 description: Password for private strategies (required if visibility is private)
 *                 example: "SecurePass123"
 *               performance_fee:
 *                 type: number
 *                 minimum: 5.00
 *                 maximum: 50.00
 *                 default: 20.00
 *                 description: Performance fee percentage (5-50%)
 *               leverage:
 *                 type: integer
 *                 enum: [50, 100, 200]
 *                 default: 100
 *                 description: Leverage (50, 100, or 200)
 *               min_investment:
 *                 type: number
 *                 minimum: 100.00
 *                 default: 100.00
 *                 description: Minimum investment amount
 *               max_total_investment:
 *                 type: number
 *                 minimum: 1000.00
 *                 maximum: 500000.00
 *                 default: 500000.00
 *                 description: Maximum total investment
 *               max_followers:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 1000
 *                 default: 1000
 *                 description: Maximum followers
 *               auto_cutoff_level:
 *                 type: number
 *                 minimum: 10.00
 *                 maximum: 90.00
 *                 default: 50.00
 *                 description: Auto cutoff level percentage (10-90%)
 *               profile_image:
 *                 type: string
 *                 format: binary
 *                 description: Profile image file (optional, max 15MB, JPEG/PNG/GIF/WebP)
 *     responses:
 *       201:
 *         description: Strategy provider account created successfully
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
 *                   example: "Strategy provider account created successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_provider:
 *                       $ref: '#/components/schemas/StrategyProviderResponse'
 *       400:
 *         description: Validation error or maximum accounts reached
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 message:
 *                   type: string
 *                   example: "Validation failed: Strategy name must be at least 10 characters long"
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       403:
 *         description: Forbidden - Only live users can create strategy provider accounts
 *       409:
 *         description: Conflict - Strategy name already exists
 *       500:
 *         description: Internal server error
 *   get:
 *     summary: Get all strategy provider accounts for authenticated user
 *     description: Retrieve all strategy provider accounts owned by the authenticated user
 *     tags: [Strategy Providers]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Strategy provider accounts retrieved successfully
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
 *                   example: "Strategy provider accounts retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_providers:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/StrategyProviderResponse'
 *                     total:
 *                       type: integer
 *                       example: 2
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/strategy-providers/{id}:
 *   get:
 *     summary: Get strategy provider account by ID
 *     description: Retrieve a specific strategy provider account owned by the authenticated user
 *     tags: [Strategy Providers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Strategy provider account ID
 *         example: 1
 *     responses:
 *       200:
 *         description: Strategy provider account retrieved successfully
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
 *                   example: "Strategy provider account retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_provider:
 *                       $ref: '#/components/schemas/StrategyProviderResponse'
 *       400:
 *         description: Invalid strategy provider ID
 *       401:
 *         description: Unauthorized - Invalid or missing JWT token
 *       404:
 *         description: Strategy provider account not found
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/strategy-providers/private/{accessLink}:
 *   get:
 *     summary: Get private strategy by access link (authenticated live users only)
 *     description: Get full private strategy details using access link. Requires authentication and live user account.
 *     tags: [Strategy Providers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: accessLink
 *         required: true
 *         schema:
 *           type: string
 *         description: Unique access link for private strategy
 *         example: "a1b2c3d4e5f6g7h8"
 *     responses:
 *       200:
 *         description: Private strategy retrieved successfully
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
 *                   example: "Private strategy retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_provider:
 *                       allOf:
 *                         - $ref: '#/components/schemas/StrategyProviderResponse'
 *                         - type: object
 *                           properties:
 *                             is_private:
 *                               type: boolean
 *                               example: true
 *                             can_follow:
 *                               type: boolean
 *                               example: true
 *                             requirements_met:
 *                               type: object
 *                               properties:
 *                                 eligible:
 *                                   type: boolean
 *                                 requirements:
 *                                   type: object
 *                                   properties:
 *                                     min_equity:
 *                                       type: number
 *                                     current_equity:
 *                                       type: number
 *       400:
 *         description: Strategy does not meet requirements or invalid access link
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Only live users can access private strategies or cannot follow own strategy
 *       404:
 *         description: Private strategy not found or inactive
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/strategy-providers/catalog:
 *   get:
 *     summary: Get catalog eligible strategy providers
 *     description: Get paginated list of strategy providers that meet catalog eligibility requirements for authenticated live users
 *     tags: [Strategy Providers]
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
 *         description: Items per page (max 100)
 *         example: 20
 *       - in: query
 *         name: min_return
 *         schema:
 *           type: number
 *         description: Minimum return percentage filter
 *         example: 10.5
 *       - in: query
 *         name: max_return
 *         schema:
 *           type: number
 *         description: Maximum return percentage filter
 *         example: 50.0
 *       - in: query
 *         name: min_followers
 *         schema:
 *           type: integer
 *           minimum: 0
 *         description: Minimum followers filter
 *         example: 10
 *       - in: query
 *         name: performance_fee
 *         schema:
 *           type: number
 *           minimum: 0
 *           maximum: 50
 *         description: Maximum performance fee filter
 *         example: 25.0
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by strategy name
 *         example: "EURUSD"
 *       - in: query
 *         name: max_drawdown
 *         schema:
 *           type: number
 *           minimum: 0
 *         description: Maximum drawdown filter (for moderate risk strategies)
 *         example: 15.0
 *       - in: query
 *         name: min_three_month_return
 *         schema:
 *           type: number
 *         description: Minimum 3-month return percentage filter
 *         example: 5.0
 *       - in: query
 *         name: sort_by
 *         schema:
 *           type: string
 *           enum: [performance, followers, newest, performance_fee, three_month_return, drawdown]
 *           default: performance
 *         description: Sort criteria
 *         example: "performance"
 *     responses:
 *       200:
 *         description: Strategy catalog retrieved successfully
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
 *                   example: "Strategy catalog retrieved successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategies:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                             example: 1
 *                           strategy_name:
 *                             type: string
 *                             example: "EURUSD Scalping Pro Strategy"
 *                           total_return_percentage:
 *                             type: number
 *                             example: 25.75
 *                           total_followers:
 *                             type: integer
 *                             example: 150
 *                           profile_image_url:
 *                             type: string
 *                             nullable: true
 *                             example: "/uploads/strategy-profiles/SP_123_1704567890123.jpg"
 *                           performance_fee:
 *                             type: number
 *                             example: 20.0
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
 *                       description: Applied filters
 *       400:
 *         description: Invalid query parameters
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Only live users can access strategy catalog
 *       500:
 *         description: Internal server error
 */

/**
 * @swagger
 * /api/strategy-providers/{id}/catalog-eligibility:
 *   get:
 *     summary: Check catalog eligibility for strategy provider
 *     description: Check if a strategy provider meets catalog eligibility requirements
 *     tags: [Strategy Providers]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Strategy provider ID
 *         example: 1
 *     responses:
 *       200:
 *         description: Catalog eligibility checked successfully
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
 *                   example: "Catalog eligibility checked successfully"
 *                 data:
 *                   type: object
 *                   properties:
 *                     strategy_provider_id:
 *                       type: integer
 *                       example: 1
 *                     eligibility:
 *                       type: object
 *                       properties:
 *                         eligible:
 *                           type: boolean
 *                           example: true
 *                         reason:
 *                           type: string
 *                           example: "All catalog requirements met"
 *                         requirements:
 *                           type: object
 *                           properties:
 *                             min_closed_trades:
 *                               type: integer
 *                               example: 10
 *                             min_days_since_first_trade:
 *                               type: integer
 *                               example: 30
 *                             max_days_since_last_trade:
 *                               type: integer
 *                               example: 7
 *                             min_return_percentage:
 *                               type: number
 *                               example: 0
 *                         current:
 *                           type: object
 *                           properties:
 *                             closed_trades:
 *                               type: integer
 *                               example: 25
 *                             total_trades:
 *                               type: integer
 *                               example: 30
 *                             first_trade_date:
 *                               type: string
 *                               format: date-time
 *                               nullable: true
 *                             last_trade_date:
 *                               type: string
 *                               format: date-time
 *                               nullable: true
 *                             days_since_first_trade:
 *                               type: integer
 *                               example: 45
 *                             days_since_last_trade:
 *                               type: integer
 *                               example: 2
 *                             total_return_percentage:
 *                               type: number
 *                               example: 15.75
 *                             status:
 *                               type: integer
 *                               example: 1
 *                             is_active:
 *                               type: integer
 *                               example: 1
 *       400:
 *         description: Invalid strategy provider ID
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Only live users can check catalog eligibility
 *       404:
 *         description: Strategy provider not found
 *       500:
 *         description: Internal server error
 */


// Public catalog route (no authentication required)
router.get('/catalog', strategyProviderController.getCatalogStrategies);

// Apply JWT authentication to all routes below this point
router.use(authenticateJWT);

// Private strategy routes (requires authentication)
router.get('/private/:accessLink', strategyProviderController.getPrivateStrategyByLink);

// Strategy Provider Account Routes (requires authentication)
router.post('/', (req, res, next) => {
  upload.single('profile_image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'Profile image file size too large. Maximum size is 15MB.'
        });
      }
      if (err.message.includes('Only image files')) {
        return res.status(400).json({
          success: false,
          message: 'Invalid file type. Only JPEG, JPG, PNG, GIF, and WebP files are allowed.'
        });
      }
      return res.status(400).json({
        success: false,
        message: 'File upload error: ' + err.message
      });
    }
    next();
  });
}, strategyProviderController.createStrategyProviderAccount);
router.get('/', strategyProviderController.getUserStrategyProviderAccounts);
router.get('/performance-fee-earnings', strategyProviderController.getPerformanceFeeEarnings);
router.get('/copy-follower-investments', strategyProviderController.getCopyFollowerInvestments);
router.post('/:id/archive', strategyProviderController.archiveStrategyProviderAccount);
router.get('/:id', strategyProviderController.getStrategyProviderAccount);
router.get('/:id/catalog-eligibility', strategyProviderController.checkCatalogEligibility);

// Account switching routes (requires authentication)
router.post('/:id/switch', authenticateJWT, strategyProviderController.switchToStrategyProvider);
router.post('/switch-back', authenticateJWT, strategyProviderController.switchBackToLiveUser);

// Token management routes
router.post('/refresh-token', strategyProviderController.refreshStrategyProviderToken);
router.post('/logout', authenticateJWT, strategyProviderController.logoutStrategyProvider);

module.exports = router;
