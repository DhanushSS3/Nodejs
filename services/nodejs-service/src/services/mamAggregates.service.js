const { Op } = require('sequelize');
const LiveUser = require('../models/liveUser.model');
const LiveUserOrder = require('../models/liveUserOrder.model');
const MAMAccount = require('../models/mamAccount.model');

const OPEN_CHILD_STATUSES = ['OPEN', 'QUEUED', 'PENDING', 'PENDING-QUEUED', 'MODIFY'];

async function refreshMamAccountAggregates(mamAccountId, { transaction } = {}) {
  if (!mamAccountId) return null;

  const liveUsers = await LiveUser.findAll({
    where: { mam_id: mamAccountId },
    attributes: ['id', 'wallet_balance'],
    transaction
  });

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
    mam_balance: normalizedBalance,
    total_used_margin: normalizedMargin,
    total_investors: liveUsers.length
  }, {
    where: { id: mamAccountId },
    transaction
  });

  return {
    totalBalance: normalizedBalance,
    totalUsedMargin: normalizedMargin,
    totalInvestors: liveUsers.length
  };
}

module.exports = {
  refreshMamAccountAggregates,
  OPEN_CHILD_STATUSES
};
