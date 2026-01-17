const express = require('express');
const { query, param } = require('express-validator');

const router = express.Router();

const { authenticateJWT } = require('../middlewares/auth.middleware');
const { validateRequest } = require('../middlewares/validation.middleware');
const { requireMamManager } = require('../middlewares/mamManager.middleware');
const mamManagerController = require('../controllers/mam.manager.controller');
const { ASSIGNMENT_STATUS } = require('../constants/mamAssignment.constants');

const assignmentStatuses = Object.values(ASSIGNMENT_STATUS);

router.get(
  '/clients',
  authenticateJWT,
  requireMamManager,
  [
    query('status')
      .optional()
      .isIn(assignmentStatuses).withMessage('status filter is invalid'),
    query('page')
      .optional()
      .isInt({ min: 1 }).withMessage('page must be >= 1'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
    query('search')
      .optional()
      .isString().withMessage('search must be a string')
  ],
  validateRequest,
  mamManagerController.getAssignedClients
);

router.get(
  '/clients/:client_id/orders',
  authenticateJWT,
  requireMamManager,
  [
    param('client_id')
      .isInt({ min: 1 }).withMessage('client_id must be a positive integer'),
    query('page')
      .optional()
      .isInt({ min: 1 }).withMessage('page must be >= 1'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
    query('status')
      .optional()
      .isString().withMessage('status must be a string'),
    query('symbol')
      .optional()
      .isString().withMessage('symbol must be a string'),
    query('order_type')
      .optional()
      .isString().withMessage('order_type must be a string')
  ],
  validateRequest,
  mamManagerController.getClientOrders
);

module.exports = router;
