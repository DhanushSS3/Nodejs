const express = require('express');
const router = express.Router();

const mamAuthController = require('../controllers/mam.auth.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { validateRequest } = require('../middlewares/validation.middleware');
const {
  mamLoginValidation,
  mamRefreshValidation,
  mamLogoutValidation
} = require('../middlewares/mamAuth.validation');

router.post(
  '/login',
  mamLoginValidation,
  validateRequest,
  mamAuthController.login
);

router.post(
  '/refresh',
  mamRefreshValidation,
  validateRequest,
  mamAuthController.refreshToken
);

router.post(
  '/logout',
  authenticateJWT,
  mamLogoutValidation,
  validateRequest,
  mamAuthController.logout
);

module.exports = router;
