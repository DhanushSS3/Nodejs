const express = require('express');
const router = express.Router();

const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');
const { validateRequest } = require('../middlewares/validation.middleware');
const {
  createMAMAccountValidation,
  updateMAMAccountValidation,
  listMAMAccountsValidation
} = require('../middlewares/mam.validation');

const mamController = require('../controllers/superadmin.mam.controller');

router.use(authenticateAdmin, requireRole(['superadmin']));

router.post(
  '/mam/accounts',
  createMAMAccountValidation,
  validateRequest,
  mamController.createMAMAccount
);

router.get(
  '/mam/accounts',
  listMAMAccountsValidation,
  validateRequest,
  mamController.listMAMAccounts
);

router.get(
  '/mam/accounts/:id',
  mamController.getMAMAccount
);

router.put(
  '/mam/accounts/:id',
  updateMAMAccountValidation,
  validateRequest,
  mamController.updateMAMAccount
);

module.exports = router;
