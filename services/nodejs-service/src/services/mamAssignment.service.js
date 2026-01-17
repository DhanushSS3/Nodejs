const { Op } = require('sequelize');
const sequelize = require('../config/db');
const MAMAssignment = require('../models/mamAssignment.model');
const MAMAccount = require('../models/mamAccount.model');
const LiveUser = require('../models/liveUser.model');
const {
  ASSIGNMENT_STATUS,
  ASSIGNMENT_INITIATORS,
  ASSIGNMENT_UNSUBSCRIBE_ACTORS,
  ELIGIBILITY_FAILURES
} = require('../constants/mamAssignment.constants');
const eligibilityService = require('./mamAssignmentEligibility.service');
const portfolioEvents = require('./events/portfolio.events');

class MAMAssignmentService {
  async createAssignment({ mamAccountId, clientId, initiatedBy = ASSIGNMENT_INITIATORS.CLIENT, initiatedByAdminId, initiatedReason }) {
    const eligibility = await eligibilityService.checkEligibility({ mamAccountId, clientId });
    if (!eligibility.valid) {
      throw this._buildEligibilityError(eligibility);
    }

    const isAdminInitiated = initiatedBy === ASSIGNMENT_INITIATORS.ADMIN;
    const initialStatus = isAdminInitiated
      ? ASSIGNMENT_STATUS.ADMIN_APPROVED
      : ASSIGNMENT_STATUS.CLIENT_REQUESTED;
    const reviewTimestamp = isAdminInitiated ? new Date() : null;

    const payload = {
      mam_account_id: mamAccountId,
      client_live_user_id: clientId,
      initiated_by: initiatedBy,
      initiated_by_admin_id: initiatedBy === ASSIGNMENT_INITIATORS.ADMIN ? initiatedByAdminId : null,
      initiated_reason: initiatedReason || null,
      status: initialStatus,
      admin_reviewed_by_admin_id: isAdminInitiated ? (initiatedByAdminId || null) : null,
      admin_reviewed_at: reviewTimestamp,
      admin_review_notes: isAdminInitiated ? initiatedReason || null : null
    };

    const assignment = await MAMAssignment.create(payload);
    this._emitClientAssignmentUpdate(clientId, {
      assignment_id: assignment.id,
      status: assignment.status,
      action: 'created'
    });
    return assignment;
  }

  async listAssignments({ status, mamAccountId, clientId, page = 1, limit = 20 }) {
    const parsedPage = Math.max(parseInt(page, 10) || 1, 1);
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
    const offset = (parsedPage - 1) * parsedLimit;

    const where = {};
    if (status) {
      where.status = status;
    }
    if (mamAccountId) {
      where.mam_account_id = mamAccountId;
    }
    if (clientId) {
      where.client_live_user_id = clientId;
    }

    const { rows, count } = await MAMAssignment.findAndCountAll({
      where,
      include: [
        {
          model: MAMAccount,
          as: 'mamAccount'
        },
        {
          model: LiveUser,
          as: 'client',
          attributes: ['id', 'name', 'email', 'account_number', 'wallet_balance', 'is_self_trading']
        }
      ],
      order: [['created_at', 'DESC']],
      offset,
      limit: parsedLimit
    });

    return {
      items: rows,
      total: count,
      page: parsedPage,
      limit: parsedLimit,
      totalPages: Math.ceil(count / parsedLimit) || 1
    };
  }

  async getAssignmentById(id) {
    const assignment = await MAMAssignment.findByPk(id, {
      include: [
        { model: MAMAccount, as: 'mamAccount' },
        { model: LiveUser, as: 'client', attributes: ['id', 'name', 'email', 'account_number', 'wallet_balance', 'is_self_trading'] }
      ]
    });
    if (!assignment) {
      const error = new Error('MAM assignment not found');
      error.statusCode = 404;
      throw error;
    }
    return assignment;
  }

  async listAssignmentsForClient(clientId, query = {}) {
    return this.listAssignments({
      status: query.status,
      clientId,
      page: query.page,
      limit: query.limit
    });
  }

  async getAssignmentForClient(clientId, assignmentId) {
    const assignment = await this.getAssignmentById(assignmentId);
    if (assignment.client_live_user_id !== clientId) {
      const error = new Error('Assignment does not belong to this client');
      error.statusCode = 403;
      throw error;
    }
    return assignment;
  }

  async createClientAssignment({ mamAccountId, clientId }) {
    return this.createAssignment({
      mamAccountId,
      clientId,
      initiatedBy: ASSIGNMENT_INITIATORS.CLIENT
    });
  }

  async cancelAssignment({ assignmentId, actor }) {
    const assignment = await this.getAssignmentById(assignmentId);
    const cancellableStatuses = [
      ASSIGNMENT_STATUS.CLIENT_REQUESTED,
      ASSIGNMENT_STATUS.ADMIN_APPROVED
    ];
    if (!cancellableStatuses.includes(assignment.status)) {
      const error = new Error('Only pending assignments can be cancelled');
      error.statusCode = 400;
      throw error;
    }

    assignment.status = ASSIGNMENT_STATUS.CANCELLED;
    assignment.deactivated_at = new Date();
    assignment.unsubscribed_by = actor || null;

    await assignment.save();
    this._emitClientAssignmentUpdate(assignment.client_live_user_id, {
      assignment_id: assignment.id,
      status: assignment.status,
      action: 'cancelled'
    });
    return assignment;
  }

  async acceptAssignment({ assignmentId, clientId, acceptedIp }) {
    return sequelize.transaction(async (transaction) => {
      const assignment = await MAMAssignment.findByPk(assignmentId, {
        lock: transaction.LOCK.UPDATE,
        transaction
      });
      if (!assignment) {
        const error = new Error('MAM assignment not found');
        error.statusCode = 404;
        throw error;
      }
      if (assignment.client_live_user_id !== clientId) {
        const error = new Error('Assignment does not belong to this client');
        error.statusCode = 403;
        throw error;
      }
      if (assignment.status !== ASSIGNMENT_STATUS.ADMIN_APPROVED) {
        const error = new Error('Assignment is not pending client acceptance');
        error.statusCode = 400;
        throw error;
      }

      const eligibility = await eligibilityService.checkEligibility({
        mamAccountId: assignment.mam_account_id,
        clientId,
        ignoreAssignmentId: assignment.id
      });
      if (!eligibility.valid) {
        throw this._buildEligibilityError(eligibility);
      }

      const timestamp = new Date();
      assignment.status = ASSIGNMENT_STATUS.ACTIVE;
      assignment.accepted_at = timestamp;
      assignment.accepted_ip = acceptedIp || null;
      assignment.activated_at = timestamp;
      assignment.eligibility_fail_reason = null;

      await assignment.save({ transaction });

      await MAMAccount.increment(
        { total_investors: 1 },
        { where: { id: assignment.mam_account_id }, transaction }
      );

      await LiveUser.update(
        {
          mam_id: assignment.mam_account_id,
          mam_status: 1,
          mam_alloted_time: timestamp,
          is_self_trading: 0,
          copytrading_status: 0,
          copytrader_id: null
        },
        { where: { id: clientId }, transaction }
      );

      await assignment.reload({
        include: [
          { model: MAMAccount, as: 'mamAccount' },
          {
            model: LiveUser,
            as: 'client',
            attributes: ['id', 'name', 'email', 'account_number', 'wallet_balance', 'is_self_trading']
          }
        ],
        transaction
      });

      this._emitClientAssignmentUpdate(clientId, {
        assignment_id: assignment.id,
        status: assignment.status,
        action: 'accepted'
      });

      return assignment;
    });
  }

  async adminApproveAssignment({ assignmentId, adminId, notes }) {
    return sequelize.transaction(async (transaction) => {
      const assignment = await MAMAssignment.findByPk(assignmentId, {
        lock: transaction.LOCK.UPDATE,
        transaction
      });
      if (!assignment) {
        const error = new Error('MAM assignment not found');
        error.statusCode = 404;
        throw error;
      }
      if (assignment.status !== ASSIGNMENT_STATUS.CLIENT_REQUESTED) {
        const error = new Error('Only client requested assignments can be approved');
        error.statusCode = 400;
        throw error;
      }

      assignment.status = ASSIGNMENT_STATUS.ADMIN_APPROVED;
      assignment.admin_reviewed_by_admin_id = adminId || null;
      assignment.admin_reviewed_at = new Date();
      assignment.admin_review_notes = notes || null;
      assignment.rejected_by = null;
      assignment.rejected_at = null;
      assignment.rejected_ip = null;
      assignment.rejected_reason = null;

      await assignment.save({ transaction });

      await assignment.reload({
        include: [
          { model: MAMAccount, as: 'mamAccount' },
          {
            model: LiveUser,
            as: 'client',
            attributes: ['id', 'name', 'email', 'account_number', 'wallet_balance', 'is_self_trading']
          }
        ],
        transaction
      });

      this._emitClientAssignmentUpdate(assignment.client_live_user_id, {
        assignment_id: assignment.id,
        status: assignment.status,
        action: 'admin_approved'
      });

      return assignment;
    });
  }

  async adminRejectAssignment({ assignmentId, adminId, reason }) {
    return sequelize.transaction(async (transaction) => {
      const assignment = await MAMAssignment.findByPk(assignmentId, {
        lock: transaction.LOCK.UPDATE,
        transaction
      });
      if (!assignment) {
        const error = new Error('MAM assignment not found');
        error.statusCode = 404;
        throw error;
      }
      if (![ASSIGNMENT_STATUS.CLIENT_REQUESTED, ASSIGNMENT_STATUS.ADMIN_APPROVED].includes(assignment.status)) {
        const error = new Error('Assignment cannot be rejected in its current state');
        error.statusCode = 400;
        throw error;
      }

      const timestamp = new Date();
      assignment.status = ASSIGNMENT_STATUS.REJECTED;
      assignment.admin_reviewed_by_admin_id = adminId || null;
      assignment.admin_reviewed_at = timestamp;
      assignment.admin_review_notes = reason || null;
      assignment.rejected_by = 'admin';
      assignment.rejected_at = timestamp;
      assignment.rejected_ip = null;
      assignment.rejected_reason = reason || null;

      await assignment.save({ transaction });

      await assignment.reload({
        include: [
          { model: MAMAccount, as: 'mamAccount' },
          {
            model: LiveUser,
            as: 'client',
            attributes: ['id', 'name', 'email', 'account_number', 'wallet_balance', 'is_self_trading']
          }
        ],
        transaction
      });

      this._emitClientAssignmentUpdate(assignment.client_live_user_id, {
        assignment_id: assignment.id,
        status: assignment.status,
        action: 'admin_rejected'
      });

      return assignment;
    });
  }

  async unsubscribeAssignment({ assignmentId, clientId, reason, requestIp }) {
    return sequelize.transaction(async (transaction) => {
      const assignment = await MAMAssignment.findByPk(assignmentId, {
        lock: transaction.LOCK.UPDATE,
        transaction
      });
      if (!assignment) {
        const error = new Error('MAM assignment not found');
        error.statusCode = 404;
        throw error;
      }
      if (assignment.client_live_user_id !== clientId) {
        const error = new Error('Assignment does not belong to this client');
        error.statusCode = 403;
        throw error;
      }
      if (assignment.status !== ASSIGNMENT_STATUS.ACTIVE) {
        const error = new Error('Only active assignments can be unsubscribed');
        error.statusCode = 400;
        throw error;
      }

      const timestamp = new Date();
      assignment.status = ASSIGNMENT_STATUS.UNSUBSCRIBED;
      assignment.deactivated_at = timestamp;
      assignment.unsubscribe_reason = reason || null;
      assignment.unsubscribed_by = ASSIGNMENT_UNSUBSCRIBE_ACTORS.CLIENT;
      assignment.metadata = {
        ...(assignment.metadata || {}),
        last_unsubscribe_ip: requestIp || null,
        last_unsubscribe_at: timestamp
      };
      assignment.eligibility_fail_reason = null;

      await assignment.save({ transaction });

      await MAMAccount.decrement(
        { total_investors: 1 },
        {
          where: {
            id: assignment.mam_account_id,
            total_investors: { [Op.gt]: 0 }
          },
          transaction
        }
      );

      await LiveUser.update(
        {
          mam_id: null,
          mam_status: 0,
          mam_alloted_time: null,
          is_self_trading: 1,
          copytrading_status: 0,
          copytrader_id: null
        },
        { where: { id: clientId }, transaction }
      );

      await assignment.reload({
        include: [
          { model: MAMAccount, as: 'mamAccount' },
          {
            model: LiveUser,
            as: 'client',
            attributes: ['id', 'name', 'email', 'account_number', 'wallet_balance', 'is_self_trading']
          }
        ],
        transaction
      });

      this._emitClientAssignmentUpdate(clientId, {
        assignment_id: assignment.id,
        status: assignment.status,
        action: 'unsubscribed'
      });

      return assignment;
    });
  }

  async declineAssignment({ assignmentId, clientId, declinedIp, reason }) {
    return sequelize.transaction(async (transaction) => {
      const assignment = await MAMAssignment.findByPk(assignmentId, {
        lock: transaction.LOCK.UPDATE,
        transaction
      });
      if (!assignment) {
        const error = new Error('MAM assignment not found');
        error.statusCode = 404;
        throw error;
      }
      if (assignment.client_live_user_id !== clientId) {
        const error = new Error('Assignment does not belong to this client');
        error.statusCode = 403;
        throw error;
      }
      if (assignment.status !== ASSIGNMENT_STATUS.ADMIN_APPROVED) {
        const error = new Error('Assignment is not pending acceptance');
        error.statusCode = 400;
        throw error;
      }

      const timestamp = new Date();
      assignment.status = ASSIGNMENT_STATUS.REJECTED;
      assignment.rejected_at = timestamp;
      assignment.rejected_ip = declinedIp || null;
      assignment.rejected_reason = reason || null;
      assignment.rejected_by = 'client';

      await assignment.save({ transaction });

      await assignment.reload({
        include: [
          { model: MAMAccount, as: 'mamAccount' },
          {
            model: LiveUser,
            as: 'client',
            attributes: ['id', 'name', 'email', 'account_number', 'wallet_balance', 'is_self_trading']
          }
        ],
        transaction
      });

      this._emitClientAssignmentUpdate(clientId, {
        assignment_id: assignment.id,
        status: assignment.status,
        action: 'declined'
      });

      return assignment;
    });
  }

  _buildEligibilityError(eligibility) {
    const error = new Error(eligibility.message || 'Assignment eligibility failed');
    error.statusCode = 400;
    error.code = eligibility.code || ELIGIBILITY_FAILURES.MAM_NOT_FOUND;
    return error;
  }

  _emitClientAssignmentUpdate(clientId, payload = {}) {
    if (!clientId) return;
    portfolioEvents.emitUserUpdate('live', clientId, {
      type: 'mam_assignment_update',
      ...payload
    });
  }
}

module.exports = new MAMAssignmentService();
