const express = require('express');
const router = express.Router();
const { lookupOrderByAnyId } = require('../controllers/internal.provider.lookup.controller');

// Internal route for provider fallback lookup (live only)
// GET /api/internal/provider/orders/lookup/:id
router.get('/orders/lookup/:id', lookupOrderByAnyId);

module.exports = router;
