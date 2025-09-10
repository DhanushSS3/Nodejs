const express = require('express');
const router = express.Router();
const { lookupOrderByAnyId } = require('../controllers/internal.provider.lookup.controller');
const { lookupGroupConfig } = require('../controllers/internal.groups.lookup.controller');
const internalAuth = require('../middlewares/internalAuth.middleware');

// Internal route for provider fallback lookup (live only)
router.use(internalAuth);
// GET /api/internal/provider/orders/lookup/:id
router.get('/orders/lookup/:id', lookupOrderByAnyId);
router.get('/groups/:group/:symbol', lookupGroupConfig);

module.exports = router;
