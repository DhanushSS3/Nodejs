const { Op } = require('sequelize');
const logger = require('../services/logger.service');
const UserTransaction = require('../models/userTransaction.model');

function getAuthUser(req) {
  const user = req.user || {};
  const userId = user.sub || user.user_id || user.id;
  const userType = (user.user_type || user.account_type || 'live').toString().toLowerCase();
  const isActive = !!user.is_active;
  return { userId, userType, isActive };
}

function parsePaging(query) {
  let limit = Number.parseInt(query.limit, 10);
  let offset = Number.parseInt(query.offset, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 100) limit = 100;
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

async function getUserTransactions(req, res) {
  const operationId = `user_txn_get_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { userId, userType, isActive } = getAuthUser(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }

    const { limit, offset } = parsePaging(req.query || {});

    // Only allow withdraw and deposit types
    const allowedTypes = ['deposit', 'withdraw'];
    const typeParam = (req.query?.type || '').toString().toLowerCase().trim();
    let typeFilter;
    if (typeParam) {
      if (!allowedTypes.includes(typeParam)) {
        return res.status(400).json({ success: false, message: 'Invalid type. Allowed: deposit, withdraw' });
      }
      typeFilter = typeParam;
    } else {
      typeFilter = { [Op.in]: allowedTypes };
    }

    logger.transactionStart('user_transactions_get', { operationId, userId, userType, limit, offset, type: typeParam || 'both' });

    const { rows, count } = await UserTransaction.findAndCountAll({
      where: {
        user_id: userId,
        user_type: userType,
        type: typeFilter,
      },
      order: [['created_at', 'DESC']],
      attributes: ['transaction_id', 'type', 'amount', 'status', 'reference_id', 'notes', 'created_at'],
      limit,
      offset,
    });

    const transactions = rows.map(r => ({
      transaction_id: r.transaction_id,
      type: r.type,
      amount: r.amount,
      status: r.status,
      reference_id: r.reference_id,
      notes: r.notes,
      created_at: r.created_at,
    }));

    const hasMore = offset + transactions.length < count;

    logger.transactionSuccess('user_transactions_get', { operationId, userId, count: transactions.length, total: count });

    // Minimal response similar to favorites simplification
    return res.status(200).json({ transactions, total: count, limit, offset, hasMore });
  } catch (error) {
    logger.transactionFailure('user_transactions_get', error, {});
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { getUserTransactions };
