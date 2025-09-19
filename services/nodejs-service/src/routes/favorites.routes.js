const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/auth.middleware');
const favoritesController = require('../controllers/favorites.controller');

// All routes require user authentication (active only)
router.post('/add', authenticateJWT, favoritesController.addFavorite);
router.post('/remove', authenticateJWT, favoritesController.removeFavorite);
router.get('/', authenticateJWT, favoritesController.getFavorites);

module.exports = router;
