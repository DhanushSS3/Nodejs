const { Op } = require('sequelize');
const sequelize = require('../config/db');
const MAMAssignment = require('../models/mamAssignment.model');
const MAMAccount = require('../models/mamAccount.model');
const LiveUser = require('../models/liveUser.model');
const {
  ASSIGNMENT_STATUS,
  ASSIGNMENT_INITIATORS,
  ELIGIBILITY_FAILURES
} = require('../constants/mamAssignment.constants');
const eligibilityService = require('./mamAssignmentEligibility.service');
const portfolioEvents = require('./events/portfolio.events');

class MAMAssignmentService {
  async createAssignment({ mamAccountId, clientId, initiatedBy, initiatedByAdminId, initiatedReason }) {
    const eligibility = await eligibilityService.checkEligibility({ mamAccountId, clientId });
    if (!eligibility.valid) {
      throw this._buildEligibilityError(eligibility);
    }

    const payload = {
      mam_account_id: mamAccountId,
      client_live_user_id: clientId,
      initiated_by: initiatedBy,
      initiated_by_admin_id: initiatedBy === ASSIGNMENT_INITIATORS.ADMIN ? initiatedByAdminId : null,
      initiated_reason: initiatedReason || null,
      status: ASSIGNMENT_STATUS.PENDING_CLIENT_ACCEPT
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
    if (assignment.status !== ASSIGNMENT_STATUS.PENDING_CLIENT_ACCEPT) {
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
      if (assignment.status !== ASSIGNMENT_STATUS.PENDING_CLIENT_ACCEPT) {
        const error = new Error('Assignment is not pending acceptance');
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
      if (assignment.status !== ASSIGNMENT_STATUS.PENDING_CLIENT_ACCEPT) {
        const error = new Error('Assignment is not pending acceptance');
        error.statusCode = 400;
        throw error;
      }

      assignment.status = ASSIGNMENT_STATUS.REJECTED;
      assignment.rejected_at = new Date();
      assignment.rejected_ip = declinedIp || null;
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
