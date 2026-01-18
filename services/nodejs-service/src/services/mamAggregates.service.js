const { Op } = require('sequelize');
const LiveUser = require('../models/liveUser.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const MAMAccount = require('../models/mamAccount.model');
const MAMAssignment = require('../models/mamAssignment.model');
const { ASSIGNMENT_STATUS } = require('../constants/mamAssignment.constants');

const OPEN_CHILD_STATUSES = ['OPEN', 'QUEUED', 'PENDING', 'PENDING-QUEUED', 'MODIFY'];

async function refreshMamAccountAggregates(mamAccountId, { transaction } = {}) {
  if (!mamAccountId) return null;

  const assignments = await MAMAssignment.findAll({
    where: {
      mam_account_id: mamAccountId,
      status: ASSIGNMENT_STATUS.ACTIVE
    },
    include: [{ model: LiveUser, as: 'client', attributes: ['id', 'wallet_balance'] }],
    transaction
  });

  const liveUsers = assignments
    .map((assignment) => assignment.client)
    .filter(Boolean);

  const clientIds = liveUsers.map((user) => user.id);
  const totalBalance = liveUsers.reduce((sum, user) => sum + Number(user.wallet_balance || 0), 0);

  let totalUsedMargin = 0;
  if (clientIds.length) {
    totalUsedMargin = await LiveUserOrder.sum('margin', {
      where: {
        order_user_id: { [Op.in]: clientIds },
        order_status: { [Op.in]: OPEN_CHILD_STATUSES }
      },
      transaction
    }) || 0;
  }

  const normalizedBalance = Number(totalBalance.toFixed(6));
  const normalizedMargin = Number(Number(totalUsedMargin || 0).toFixed(6));

  await MAMAccount.update({
    total_balance: normalizedBalance,
    total_used_margin: normalizedMargin,
    total_investors: assignments.length
  }, {
    where: { id: mamAccountId },
    transaction
  });

  return {
    totalBalance: normalizedBalance,
    totalUsedMargin: normalizedMargin,
    totalInvestors: assignments.length
  };
}

module.exports = {
  refreshMamAccountAggregates,
  OPEN_CHILD_STATUSES
};
