const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { handleValidationErrors } = require('../middlewares/error.middleware');
const favoritesController = require('../controllers/favorites.controller');

// ==================== SYMBOL FAVORITES (EXISTING) ====================
// All routes require user authentication (active only)
router.post('/add', authenticateJWT, favoritesController.addFavorite);
router.post('/remove', authenticateJWT, favoritesController.removeFavorite);
router.get('/', authenticateJWT, favoritesController.getFavorites);

// ==================== STRATEGY PROVIDER FAVORITES (NEW) ====================

/**
 * @swagger
 * /api/favorites/strategy-providers:
 *   post:
 *     summary: Add a strategy provider to favorites
 *     tags: [Favorites]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - strategy_provider_id
 *             properties:
 *               strategy_provider_id:
 *                 type: integer
 *                 minimum: 1
 *                 description: ID of the strategy provider to add to favorites
 *     responses:
 *       201:
 *         description: Strategy provider added to favorites
 *       200:
 *         description: Strategy provider already in favorites
 *       400:
 *         description: Invalid request data
 *       401:
 *         description: Unauthorized or inactive user
 *       404:
 *         description: Strategy provider not found
 *       500:
 *         description: Internal server error
 */
router.post('/strategy-providers',
  authenticateJWT,
  [
    body('strategy_provider_id')
      .isInt({ min: 1 })
      .withMessage('strategy_provider_id must be a positive integer')
  ],
  handleValidationErrors,
  favoritesController.addStrategyProviderFavorite
);

/**
 * @swagger
 * /api/favorites/strategy-providers:
 *   delete:
 *     summary: Remove a strategy provider from favorites
 *     tags: [Favorites]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - strategy_provider_id
 *             properties:
 *               strategy_provider_id:
 *                 type: integer
 *                 minimum: 1
 *                 description: ID of the strategy provider to remove from favorites
 *     responses:
 *       200:
 *         description: Strategy provider removed from favorites or not found in favorites
 *       400:
 *         description: Invalid request data
 *       401:
 *         description: Unauthorized or inactive user
 *       500:
 *         description: Internal server error
 */
router.delete('/strategy-providers',
  authenticateJWT,
  [
    body('strategy_provider_id')
      .isInt({ min: 1 })
      .withMessage('strategy_provider_id must be a positive integer')
  ],
  handleValidationErrors,
  favoritesController.removeStrategyProviderFavorite
);

/**
 * @swagger
 * /api/favorites/strategy-providers:
 *   get:
 *     summary: Get user's favorite strategy providers
 *     tags: [Favorites]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of favorite strategy providers
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
 *                       favorite_id:
 *                         type: integer
 *                       favorited_at:
 *                         type: string
 *                         format: date-time
 *                       strategy_provider:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: integer
 *                           strategy_name:
 *                             type: string
 *                           description:
 *                             type: string
 *                           performance_fee:
 *                             type: number
 *                           total_followers:
 *                             type: integer
 *                           total_return_percentage:
 *                             type: number
 *                           win_rate:
 *                             type: number
 *                 count:
 *                   type: integer
 *       401:
 *         description: Unauthorized or inactive user
 *       500:
 *         description: Internal server error
 */
router.get('/strategy-providers',
  authenticateJWT,
  favoritesController.getStrategyProviderFavorites
);

module.exports = router;
