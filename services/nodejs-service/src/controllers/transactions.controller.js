const { Op } = require('sequelize');
const logger = require('../services/logger.service');
const UserTransaction = require('../models/userTransaction.model');
const MoneyRequest = require('../models/moneyRequest.model');

function getAuthUser(req) {
  const user = req.user || {};
  const userId = user.sub || user.user_id || user.id;
  let userType = (user.user_type || user.account_type || 'live').toString().toLowerCase();
  
  // Handle strategy provider accounts
  if (user.account_type === 'strategy_provider' && user.strategy_provider_id) {
    userType = 'strategy_provider';
    // For strategy providers, use the strategy_provider_id as userId
    return {
      userId: user.strategy_provider_id,
      userType: 'strategy_provider',
      isActive: !!user.is_active,
      originalUserId: userId // Keep reference to original user ID
    };
  }
  
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

    // Only allow transfer, deposit, and withdraw types (focusing on wallet movements)
    const allowedTypes = ['transfer', 'deposit', 'withdraw'];
    const typeParam = (req.query?.type || '').toString().toLowerCase().trim();
    let typeFilter;
    if (typeParam) {
      if (!allowedTypes.includes(typeParam)) {
        return res.status(400).json({ success: false, message: 'Invalid type. Allowed: transfer, deposit, withdraw' });
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

    // Also include the user's money requests (withdraw/deposit) so that
    // pending, approved, rejected, and on-hold requests appear in the
    // wallet history alongside actual wallet movements.
    let requestTypeFilter;
    if (typeParam) {
      if (typeParam === 'withdraw' || typeParam === 'deposit') {
        requestTypeFilter = typeParam;
      } else {
        requestTypeFilter = null;
      }
    } else {
      requestTypeFilter = { [Op.in]: ['deposit', 'withdraw'] };
    }

    let requestEntries = [];
    if (requestTypeFilter) {
      const requestWhere = {
        user_id: userId,
        type: requestTypeFilter,
        status: { [Op.in]: ['pending', 'approved', 'rejected', 'on_hold'] },
      };

      const moneyRequests = await MoneyRequest.findAll({
        where: requestWhere,
        order: [['created_at', 'DESC']],
        limit,
      });

      requestEntries = moneyRequests.map((r) => ({
        transaction_id: r.request_id,
        type: r.type,
        amount: r.amount,
        status: r.status,
        reference_id: r.request_id,
        notes: r.notes,
        created_at: r.created_at,
        source: 'money_request',
      }));
    }

    const combined = [
      ...transactions.map((t) => ({ ...t, source: 'wallet_transaction' })),
      ...requestEntries,
    ].sort((a, b) => {
      const aTime = a.created_at instanceof Date ? a.created_at.getTime() : new Date(a.created_at).getTime();
      const bTime = b.created_at instanceof Date ? b.created_at.getTime() : new Date(b.created_at).getTime();
      return bTime - aTime;
    });

    logger.transactionSuccess('user_transactions_get', { operationId, userId, count: combined.length, total: count });

    return res.status(200).json(combined);
  } catch (error) {
    logger.transactionFailure('user_transactions_get', error, {});
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { getUserTransactions };
