const express = require('express');
const { listDemoUsersAdminSecret } = require('../controllers/demoUser.controller');
const { requireAdminSecret } = require('../utils/adminSecret.util');

const router = express.Router();

/**
 * Lightweight admin endpoint secured by ADMIN_LIVE_USERS_SECRET for demo users listing
 * Mirrors /api/admin/users/demo-users but uses shared secret instead of JWT
 */
router.get('/demo-users', requireAdminSecret, listDemoUsersAdminSecret);

module.exports = router;
