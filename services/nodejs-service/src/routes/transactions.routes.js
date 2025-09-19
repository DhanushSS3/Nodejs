const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middlewares/auth.middleware');
const transactionsController = require('../controllers/transactions.controller');

// GET /api/transactions?type=deposit|withdraw&limit=50&offset=0
router.get('/', authenticateJWT, transactionsController.getUserTransactions);

module.exports = router;
