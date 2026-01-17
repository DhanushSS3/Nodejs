const express = require('express');
const router = express.Router();

const { authenticateAdmin, requireRole } = require('../middlewares/auth.middleware');
const { validateRequest } = require('../middlewares/validation.middleware');
const mamController = require('../controllers/superadmin.mam.controller');
const mamAssignmentController = require('../controllers/superadmin.mam.assignment.controller');
const {
  createMAMAccountValidation,
  updateMAMAccountValidation,
  listMAMAccountsValidation
} = require('../middlewares/mam.validation');
const {
  createAdminAssignmentValidation,
  listAssignmentsValidation,
  assignmentIdParamValidation,
  adminApproveAssignmentValidation,
  adminRejectAssignmentValidation
} = require('../middlewares/mamAssignment.validation');

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

// Assignment routes
router.post(
  '/mam/assignments',
  createAdminAssignmentValidation,
  validateRequest,
  mamAssignmentController.createAssignment
);

router.get(
  '/mam/assignments',
  listAssignmentsValidation,
  validateRequest,
  mamAssignmentController.listAssignments
);

router.get(
  '/mam/assignments/:id',
  assignmentIdParamValidation,
  validateRequest,
  mamAssignmentController.getAssignment
);

router.post(
  '/mam/assignments/:id/cancel',
  assignmentIdParamValidation,
  validateRequest,
  mamAssignmentController.cancelAssignment
);

router.post(
  '/mam/assignments/:id/approve',
  adminApproveAssignmentValidation,
  validateRequest,
  mamAssignmentController.approveAssignment
);

router.post(
  '/mam/assignments/:id/reject',
  adminRejectAssignmentValidation,
  validateRequest,
  mamAssignmentController.rejectAssignment
);

module.exports = router;
