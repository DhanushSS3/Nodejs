const express = require('express');
const { body } = require('express-validator');
const router = express.Router();

const mamOrdersController = require('../controllers/mam.orders.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');
const { validateRequest } = require('../middlewares/validation.middleware');

function requireMamManager(req, res, next) {
  if (!req.user || req.user.account_type !== 'mam_manager') {
    return res.status(403).json({ success: false, message: 'MAM manager authentication required' });
  }
  if (!req.user.is_active) {
    return res.status(403).json({ success: false, message: 'MAM manager account inactive' });
  }
  if (!req.user.mam_account_id) {
    return res.status(403).json({ success: false, message: 'MAM manager does not have an active account' });
  }
  return next();
}

router.post(
  '/instant',
  authenticateJWT,
  requireMamManager,
  [
    body('symbol')
      .trim()
      .notEmpty().withMessage('symbol is required')
      .isLength({ max: 20 }).withMessage('symbol must be <= 20 characters'),
    body('order_type')
      .trim()
      .notEmpty().withMessage('order_type is required')
      .isIn(['BUY', 'SELL', 'buy', 'sell']).withMessage('order_type must be BUY or SELL'),
    body('order_price')
      .exists().withMessage('order_price is required')
      .isFloat({ gt: 0 }).withMessage('order_price must be greater than 0'),
    body('volume')
      .optional()
      .isFloat({ gt: 0 }).withMessage('volume must be greater than 0 when provided'),
    body('order_quantity')
      .optional()
      .isFloat({ gt: 0 }).withMessage('order_quantity must be greater than 0 when provided'),
    body()
      .custom((value) => {
        const volume = Number(value.volume);
        const qty = Number(value.order_quantity);
        if ((volume > 0 && Number.isFinite(volume)) || (qty > 0 && Number.isFinite(qty))) {
          return true;
        }
        throw new Error('volume or order_quantity must be provided and greater than 0');
      }),
    body('stop_loss')
      .optional()
      .isFloat().withMessage('stop_loss must be numeric'),
    body('take_profit')
      .optional()
      .isFloat().withMessage('take_profit must be numeric')
  ],
  validateRequest,
  mamOrdersController.placeInstantOrder
);

router.post(
  '/pending',
  authenticateJWT,
  requireMamManager,
  [
    body('symbol')
      .trim()
      .notEmpty().withMessage('symbol is required')
      .isLength({ max: 20 }).withMessage('symbol must be <= 20 characters'),
    body('order_type')
      .trim()
      .notEmpty().withMessage('order_type is required')
      .isIn(['BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop'])
      .withMessage('order_type must be a pending order type'),
    body('order_price')
      .exists().withMessage('order_price is required')
      .isFloat({ gt: 0 }).withMessage('order_price must be greater than 0'),
    body('volume')
      .optional()
      .isFloat({ gt: 0 }).withMessage('volume must be greater than 0 when provided'),
    body('order_quantity')
      .optional()
      .isFloat({ gt: 0 }).withMessage('order_quantity must be greater than 0 when provided'),
    body()
      .custom((value) => {
        const volume = Number(value.volume);
        const qty = Number(value.order_quantity);
        if ((volume > 0 && Number.isFinite(volume)) || (qty > 0 && Number.isFinite(qty))) {
          return true;
        }
        throw new Error('volume or order_quantity must be provided and greater than 0');
      })
  ],
  validateRequest,
  mamOrdersController.placePendingOrder
);

router.post(
  '/pending/cancel',
  authenticateJWT,
  requireMamManager,
  [
    body('order_id')
      .exists().withMessage('order_id is required')
      .isInt({ gt: 0 }).withMessage('order_id must be a positive integer'),
    body('cancel_message')
      .optional()
      .isString().withMessage('cancel_message must be a string')
      .isLength({ max: 255 }).withMessage('cancel_message must be <= 255 characters'),
    body('status')
      .optional()
      .isString().withMessage('status must be a string')
      .isLength({ max: 20 }).withMessage('status must be <= 20 characters')
  ],
  validateRequest,
  mamOrdersController.cancelPendingOrder
);

router.post(
  '/close',
  authenticateJWT,
  requireMamManager,
  [
    body('order_id')
      .trim()
      .notEmpty().withMessage('order_id is required'),
    body('symbol')
      .trim()
      .notEmpty().withMessage('symbol is required')
      .isLength({ max: 50 }).withMessage('symbol must be <= 50 characters'),
    body('order_type')
      .trim()
      .notEmpty().withMessage('order_type is required')
      .isIn(['BUY', 'SELL', 'buy', 'sell', 'BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP']).withMessage('order_type is invalid'),
    body('status')
      .optional()
      .isString().withMessage('status must be a string')
      .isLength({ max: 20 }).withMessage('status must be <= 20 characters'),
    body('order_status')
      .optional()
      .isString().withMessage('order_status must be a string')
      .isLength({ max: 20 }).withMessage('order_status must be <= 20 characters'),
    body('close_price')
      .optional()
      .isFloat({ gt: 0 }).withMessage('close_price must be greater than 0 when provided')
  ],
  validateRequest,
  mamOrdersController.closeMamOrder
);

module.exports = router;
