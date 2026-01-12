const { Op } = require('sequelize');
const MAMAccount = require('../models/mamAccount.model');
const LiveUser = require('../models/liveUser.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const MAMAssignment = require('../models/mamAssignment.model');
const {
  BLOCKING_ASSIGNMENT_STATUSES,
  ELIGIBILITY_FAILURES
} = require('../constants/mamAssignment.constants');

const OPEN_STATUSES = ['OPEN', 'QUEUED'];
const PENDING_STATUSES = ['PENDING', 'PENDING-QUEUED', 'MODIFY'];

class MAMAssignmentEligibilityService {
  async checkEligibility({ mamAccountId, clientId, ignoreAssignmentId = null }) {
    const mamAccount = await MAMAccount.findByPk(mamAccountId);
    if (!mamAccount) {
      return this._fail(ELIGIBILITY_FAILURES.MAM_NOT_FOUND, 'Selected MAM account was not found.');
    }
    if (mamAccount.status !== 'active') {
      return this._fail(ELIGIBILITY_FAILURES.MAM_NOT_ACTIVE, 'Selected MAM account is not active.');
    }

    const client = await LiveUser.findByPk(clientId);
    if (!client) {
      return this._fail(ELIGIBILITY_FAILURES.CLIENT_NOT_FOUND, 'Client account was not found.');
    }
    if (Number(client.status) !== 1 || Number(client.is_active) !== 1) {
      return this._fail(ELIGIBILITY_FAILURES.CLIENT_INACTIVE, 'Client account is inactive.');
    }

    const assignmentWhere = {
      client_live_user_id: clientId,
      status: { [Op.in]: BLOCKING_ASSIGNMENT_STATUSES }
    };
    if (ignoreAssignmentId) {
      assignmentWhere.id = { [Op.ne]: ignoreAssignmentId };
    }

    const blockingAssignment = await MAMAssignment.findOne({
      where: assignmentWhere
    });
    if (blockingAssignment) {
      return this._fail(ELIGIBILITY_FAILURES.CLIENT_ALREADY_ASSIGNED, 'Client already has a pending or active MAM assignment.');
    }

    const openOrdersCount = await LiveUserOrder.count({
      where: {
        order_user_id: clientId,
        order_status: { [Op.in]: OPEN_STATUSES }
      }
    });
    if (openOrdersCount > 0) {
      return this._fail(ELIGIBILITY_FAILURES.CLIENT_HAS_OPEN_ORDERS, 'Client has open orders.');
    }

    const pendingOrdersCount = await LiveUserOrder.count({
      where: {
        order_user_id: clientId,
        order_status: { [Op.in]: PENDING_STATUSES }
      }
    });
    if (pendingOrdersCount > 0) {
      return this._fail(ELIGIBILITY_FAILURES.CLIENT_HAS_PENDING_ORDERS, 'Client has pending orders.');
    }

    const activeStrategy = await StrategyProviderAccount.findOne({
      where: {
        user_id: clientId,
        status: 1,
        is_active: 1
      }
    });
    if (activeStrategy) {
      return this._fail(ELIGIBILITY_FAILURES.CLIENT_IS_STRATEGY_PROVIDER, 'Client is an active strategy provider.');
    }

    const activeFollower = await CopyFollowerAccount.findOne({
      where: {
        user_id: clientId,
        status: 1,
        is_active: 1,
        copy_status: 'active'
      }
    });
    if (activeFollower) {
      return this._fail(ELIGIBILITY_FAILURES.CLIENT_IS_COPY_FOLLOWER, 'Client is actively copy trading.');
    }

    const balance = Number(client.wallet_balance || 0);
    if (mamAccount.min_client_balance && balance < Number(mamAccount.min_client_balance)) {
      return this._fail(ELIGIBILITY_FAILURES.BALANCE_BELOW_MINIMUM, `Client balance is below the minimum (${mamAccount.min_client_balance}).`);
    }
    if (mamAccount.max_client_balance && balance > Number(mamAccount.max_client_balance)) {
      return this._fail(ELIGIBILITY_FAILURES.BALANCE_ABOVE_MAXIMUM, `Client balance exceeds maximum (${mamAccount.max_client_balance}).`);
    }

    if (mamAccount.total_investors >= mamAccount.max_investors) {
      return this._fail(ELIGIBILITY_FAILURES.MAM_AT_CAPACITY, 'MAM account has reached its investor limit.');
    }

    return {
      valid: true,
      mamAccount,
      client
    };
  }

  _fail(code, message) {
    return {
      valid: false,
      code,
      message
    };
  }
}

module.exports = new MAMAssignmentEligibilityService();
