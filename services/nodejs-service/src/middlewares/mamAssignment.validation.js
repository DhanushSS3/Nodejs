const { body, param, query } = require('express-validator');
const { ASSIGNMENT_STATUS } = require('../constants/mamAssignment.constants');

const createAdminAssignmentValidation = [
  body('mam_account_id')
    .isInt({ min: 1 }).withMessage('mam_account_id must be a positive integer'),
  body('client_live_user_id')
    .isInt({ min: 1 }).withMessage('client_live_user_id must be a positive integer'),
  body('initiated_reason')
    .optional()
    .isString().withMessage('initiated_reason must be text')
    .isLength({ max: 1000 }).withMessage('initiated_reason must be less than 1000 characters')
];

const listAssignmentsValidation = [
  query('status')
    .optional()
    .isIn(Object.values(ASSIGNMENT_STATUS)).withMessage('status filter is invalid'),
  query('mam_account_id')
    .optional()
    .isInt({ min: 1 }).withMessage('mam_account_id must be a positive integer'),
  query('client_id')
    .optional()
    .isInt({ min: 1 }).withMessage('client_id must be a positive integer'),
  query('page')
    .optional()
    .isInt({ min: 1 }).withMessage('page must be at least 1'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100')
];

const createClientAssignmentValidation = [
  body('mam_account_id')
    .isInt({ min: 1 }).withMessage('mam_account_id must be a positive integer')
];

const acceptAssignmentValidation = [
  param('id')
    .isInt({ min: 1 }).withMessage('Assignment id must be a positive integer')
];

const assignmentIdParamValidation = [
  param('id')
    .isInt({ min: 1 }).withMessage('Assignment id must be a positive integer')
];

const declineAssignmentValidation = [
  param('id')
    .isInt({ min: 1 }).withMessage('Assignment id must be a positive integer'),
  body('reason')
    .optional()
    .isString().withMessage('reason must be text')
    .isLength({ max: 500 }).withMessage('reason cannot exceed 500 characters')
];

module.exports = {
  createAdminAssignmentValidation,
  listAssignmentsValidation,
  createClientAssignmentValidation,
  acceptAssignmentValidation,
  assignmentIdParamValidation,
  declineAssignmentValidation
};
