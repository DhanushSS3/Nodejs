const { body, query } = require('express-validator');

const allocationMethods = ['balance', 'free_margin'];
const roundingStrategies = ['symbol_step', 'floor', 'ceil'];
const feeModels = ['performance', 'management', 'hybrid', 'none'];
const feeCycles = ['daily', 'weekly', 'monthly', 'quarterly', 'on_close'];
const statuses = ['draft', 'pending_approval', 'active', 'paused', 'closed', 'archived'];

const decimalField = (field, options = {}) =>
  body(field)
    .optional({ nullable: true })
    .custom((value) => {
      if (value === undefined || value === null || value === '') {
        return true;
      }
      const num = Number(value);
      if (Number.isNaN(num)) {
        throw new Error(`${field} must be a valid number`);
      }
      if (options.min !== undefined && num < options.min) {
        throw new Error(`${field} must be a valid number`);
      }
      if (options.max !== undefined && num > options.max) {
        throw new Error(`${field} must be a valid number`);
      }
      return true;
    })
    .toFloat();

const createMAMAccountValidation = [
  body('login_email')
    .isEmail().withMessage('login_email must be a valid email')
    .trim()
    .toLowerCase(),
  body('login_password')
    .isString().withMessage('login_password must be provided')
    .isLength({ min: 8 }).withMessage('login_password must be at least 8 characters'),
  body('mam_name')
    .isString().withMessage('mam_name must be a string')
    .trim()
    .isLength({ min: 3, max: 150 }).withMessage('mam_name must be between 3 and 150 characters'),
  body('group')
    .isString().withMessage('group must be a string')
    .trim()
    .notEmpty().withMessage('group is required'),
  body('allocation_method')
    .optional()
    .isIn(allocationMethods).withMessage('allocation_method is invalid'),
  decimalField('allocation_precision', { min: 0 }),
  decimalField('min_client_balance', { min: 0 }),
  decimalField('max_client_balance', { min: 0 }),
  body('max_investors')
    .optional()
    .isInt({ min: 1 }).withMessage('max_investors must be at least 1'),
  body('fee_model')
    .optional()
    .isIn(feeModels).withMessage('fee_model is invalid'),
  decimalField('performance_fee_percent', { min: 0, max: 100 }),
  decimalField('management_fee_percent', { min: 0, max: 100 }),
  decimalField('rebate_fee_percent', { min: 0, max: 100 }),
  body('fee_settlement_cycle')
    .optional()
    .isIn(feeCycles).withMessage('fee_settlement_cycle is invalid'),
  body('allow_partial_closures')
    .optional()
    .isBoolean().withMessage('allow_partial_closures must be boolean'),
  body('terms_and_conditions')
    .optional()
    .isString().withMessage('terms_and_conditions must be text'),
  body('metadata')
    .optional()
    .isObject().withMessage('metadata must be an object'),
  body()
    .custom((value) => {
      const disallowedFields = [
        'rounding_strategy',
        'fee_model',
        'fee_settlement_cycle',
        'allow_partial_closures'
      ];
      const attempted = disallowedFields.filter((field) => value[field] !== undefined);
      if (attempted.length) {
        throw new Error(`Cannot update fields: ${attempted.join(', ')}`);
      }

      const { min_client_balance, max_client_balance } = value;
      if (
        min_client_balance != null &&
        max_client_balance != null &&
        Number(min_client_balance) > Number(max_client_balance)
      ) {
        throw new Error('min_client_balance cannot be greater than max_client_balance');
      }
      return true;
    })
];

const updateMAMAccountValidation = [
  body('login_email')
    .optional()
    .isEmail().withMessage('login_email must be a valid email')
    .trim()
    .toLowerCase(),
  body('login_password')
    .optional()
    .isString().withMessage('login_password must be a string')
    .isLength({ min: 8 }).withMessage('login_password must be at least 8 characters when provided'),
  body('mam_name')
    .optional()
    .isString().withMessage('mam_name must be a string')
    .trim()
    .isLength({ min: 3, max: 150 }).withMessage('mam_name must be between 3 and 150 characters'),
  body('group')
    .optional()
    .isString().withMessage('group must be a string')
    .trim()
    .notEmpty().withMessage('group cannot be empty'),
  body('allocation_method')
    .optional()
    .isIn(allocationMethods).withMessage('allocation_method is invalid'),
  decimalField('allocation_precision', { min: 0 }),
  body('rounding_strategy')
    .optional()
    .isIn(roundingStrategies).withMessage('rounding_strategy is invalid'),
  decimalField('min_client_balance', { min: 0 }),
  decimalField('max_client_balance', { min: 0 }),
  body('max_investors')
    .optional()
    .isInt({ min: 1 }).withMessage('max_investors must be at least 1'),
  body('status')
    .optional()
    .isIn(statuses).withMessage('status is invalid'),
  decimalField('performance_fee_percent', { min: 0, max: 100 }),
  decimalField('management_fee_percent', { min: 0, max: 100 }),
  decimalField('rebate_fee_percent', { min: 0, max: 100 }),
  body('terms_and_conditions')
    .optional()
    .isString().withMessage('terms_and_conditions must be text'),
  body('metadata')
    .optional()
    .isObject().withMessage('metadata must be an object'),
  body()
    .custom((value) => {
      const { min_client_balance, max_client_balance } = value;
      if (
        min_client_balance != null &&
        max_client_balance != null &&
        Number(min_client_balance) > Number(max_client_balance)
      ) {
        throw new Error('min_client_balance cannot be greater than max_client_balance');
      }
      return true;
    })
];

const listMAMAccountsValidation = [
  query('status')
    .optional()
    .isIn(statuses).withMessage('status filter is invalid'),
  query('allocation_method')
    .optional()
    .isIn(allocationMethods).withMessage('allocation_method filter is invalid'),
  query('page')
    .optional()
    .isInt({ min: 1 }).withMessage('page must be at least 1'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
  query('search')
    .optional()
    .isString().withMessage('search must be a string')
];

module.exports = {
  createMAMAccountValidation,
  updateMAMAccountValidation,
  listMAMAccountsValidation
};
