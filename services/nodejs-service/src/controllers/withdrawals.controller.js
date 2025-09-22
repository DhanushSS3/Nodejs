const moneyRequestService = require('../services/moneyRequest.service');
const logger = require('../services/logger.service');

function getAuthUser(req) {
  const user = req.user || {};
  const userId = user.sub || user.user_id || user.id;
  const accountType = (user.account_type || user.user_type || 'live').toString().toLowerCase();
  const isActive = !!user.is_active;
  const accountNumber = user.account_number || null;
  return { userId, accountType, isActive, accountNumber };
}

// POST /api/withdrawals
async function createWithdrawalRequest(req, res) {
  const operationId = `withdraw_request_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { userId, accountType, isActive, accountNumber } = getAuthUser(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }
    if (accountType !== 'live') {
      return res.status(403).json({ success: false, message: 'Withdrawals are only available for live users' });
    }

    const { amount, currency = 'USD', method_type, method_details } = req.body || {};

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }

    const allowedMethods = ['BANK', 'UPI', 'SWIFT', 'IBAN', 'PAYPAL', 'CRYPTO', 'OTHER'];
    if (!method_type || !allowedMethods.includes(method_type)) {
      return res.status(400).json({ success: false, message: `Invalid method_type. Allowed: ${allowedMethods.join(', ')}` });
    }

    // method_details is free-form JSON; ensure it's an object if provided
    if (method_details && typeof method_details !== 'object') {
      return res.status(400).json({ success: false, message: 'method_details must be a JSON object' });
    }

    logger.info('Creating withdrawal money request', { operationId, userId, amount, currency, method_type });

    const created = await moneyRequestService.createRequest({
      userId,
      type: 'withdraw',
      amount: Number(amount),
      currency,
      methodType: method_type,
      methodDetails: method_details || null,
      accountNumber: accountNumber || undefined,
    });

    return res.status(201).json({
      success: true,
      message: 'Withdrawal request submitted successfully',
      data: {
        id: created.id,
        request_id: created.request_id,
        status: created.status,
        amount: created.amount,
        currency: created.currency,
        method_type: created.method_type,
        created_at: created.created_at,
      },
    });
  } catch (error) {
    logger.error('Failed to create withdrawal request', { operationId, error: error.message });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

// GET /api/withdrawals/my-requests
async function getMyWithdrawalRequests(req, res) {
  const operationId = `withdraw_list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { userId, accountType, isActive } = getAuthUser(req);
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }
    if (accountType !== 'live') {
      return res.status(403).json({ success: false, message: 'Withdrawals are only available for live users' });
    }

    const { status, limit = 50, offset = 0 } = req.query || {};

    const list = await moneyRequestService.getUserRequests(userId, {
      type: 'withdraw',
      status: status || undefined,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });

    const response = list.map((r) => ({
      id: r.id,
      request_id: r.request_id,
      status: r.status,
      amount: r.amount,
      currency: r.currency,
      created_at: r.created_at,
      approved_at: r.approved_at,
      admin: r.admin ? { id: r.admin.id, username: r.admin.username } : null,
    }));

    return res.status(200).json(response);
  } catch (error) {
    logger.error('Failed to fetch my withdrawal requests', { operationId, error: error.message });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}

module.exports = { createWithdrawalRequest, getMyWithdrawalRequests };
