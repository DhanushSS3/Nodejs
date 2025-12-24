const express = require('express');
const { listDemoUsersAdminSecret } = require('../controllers/demoUser.controller');
const groupsController = require('../controllers/groups.controller');
const { requireAdminSecret } = require('../utils/adminSecret.util');

const router = express.Router();

/**
 * Lightweight admin endpoint secured by ADMIN_LIVE_USERS_SECRET for demo users listing
 * Mirrors /api/admin/users/demo-users but uses shared secret instead of JWT
 */
router.get('/demo-users', requireAdminSecret, listDemoUsersAdminSecret);
router.get(
  '/groups/dropdown',
  requireAdminSecret,
  groupsController.getGroupsDropdownAdminSecret.bind(groupsController)
);
router.get(
  '/groups',
  requireAdminSecret,
  groupsController.searchGroupsAdminSecret.bind(groupsController)
);
router.get(
  '/groups/:groupName/:symbol',
  requireAdminSecret,
  groupsController.getGroupBySymbolAdminSecret.bind(groupsController)
);
router.get(
  '/groups/:groupName',
  requireAdminSecret,
  groupsController.getGroupByNameAdminSecret.bind(groupsController)
);
router.post(
  '/groups/copy',
  requireAdminSecret,
  groupsController.copyGroupInstrumentsAdminSecret.bind(groupsController)
);

module.exports = router;
