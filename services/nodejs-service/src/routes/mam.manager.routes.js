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
  '/clients/:client_id/closed-orders',
  authenticateJWT,
  requireMamManager,
  [
    param('client_id')
      .isInt({ min: 1 }).withMessage('client_id must be a positive integer'),
    query('page')
      .optional()
      .isInt({ min: 1 }).withMessage('page must be  1'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
    query('start_date')
      .optional()
      .isISO8601().withMessage('start_date must be a valid date'),
    query('end_date')
      .optional()
      .isISO8601().withMessage('end_date must be a valid date'),
    query('symbol')
      .optional()
      .isString().withMessage('symbol must be a string'),
    query('order_type')
      .optional()
      .isString().withMessage('order_type must be a string')
  ],
  validateRequest,
  mamManagerController.getClientClosedOrders
);

router.get(
  '/clients/closed-orders',
  authenticateJWT,
  requireMamManager,
  [
    query('client_id')
      .optional()
      .isInt({ min: 1 }).withMessage('client_id must be a positive integer'),
    query('page')
      .optional()
      .isInt({ min: 1 }).withMessage('page must be >= 1'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
    query('start_date')
      .optional()
      .isISO8601().withMessage('start_date must be a valid date'),
    query('end_date')
      .optional()
      .isISO8601().withMessage('end_date must be a valid date'),
    query('symbol')
      .optional()
      .isString().withMessage('symbol must be a string'),
    query('order_type')
      .optional()
      .isString().withMessage('order_type must be a string')
  ],
  validateRequest,
  mamManagerController.getClosedOrders
);

router.get(
  '/wallet-transactions',
  authenticateJWT,
  requireMamManager,
  [
    query('page')
      .optional()
      .isInt({ min: 1 }).withMessage('page must be >= 1'),
    query('page_size')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('page_size must be between 1 and 100'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
    query('offset')
      .optional()
      .isInt({ min: 0 }).withMessage('offset must be >= 0'),
    query('start_date')
      .optional()
      .isISO8601().withMessage('start_date must be a valid date'),
    query('end_date')
      .optional()
      .isISO8601().withMessage('end_date must be a valid date'),
  ],
  validateRequest,
  mamManagerController.getWalletTransactions
);

module.exports = router;
