const moneyRequestService = require('../services/moneyRequest.service');
const logger = require('../services/logger.service');
const { LiveUser, StrategyProviderAccount, CopyFollowerAccount } = require('../models');

const SUPPORTED_WITHDRAW_ACCOUNT_TYPES = ['live', 'strategy_provider', 'copy_follower'];
const SUPPORTED_METHODS = ['BANK', 'UPI', 'SWIFT', 'IBAN', 'PAYPAL', 'CRYPTO', 'OTHER'];

class WithdrawalValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function getAuthContext(req) {
  const user = req.user || {};
  const rawUserId = user.sub || user.user_id || user.id;
  const strategyProviderId = user.strategy_provider_id;
  return {
    authUserId: rawUserId ? parseInt(rawUserId, 10) : null,
    authAccountType: (user.account_type || user.user_type || 'live').toString().toLowerCase(),
    isActive: user.is_active === undefined ? true : !!user.is_active,
    strategyProviderId: strategyProviderId ? parseInt(strategyProviderId, 10) : null,
  };
}

async function fetchAccountByType(userType, userId) {
  const parsedId = parseInt(userId, 10);
  if (Number.isNaN(parsedId) || parsedId <= 0) {
    throw new WithdrawalValidationError('user_id must be a positive integer');
  }

  switch (userType) {
    case 'live': {
      const account = await LiveUser.findByPk(parsedId, { attributes: ['id', 'account_number', 'user_type'] });
      if (!account) {
        throw new WithdrawalValidationError('Live user account not found', 404);
      }
      return account;
    }
    case 'strategy_provider': {
      const account = await StrategyProviderAccount.findByPk(parsedId, {
        attributes: ['id', 'user_id', 'account_number']
      });
      if (!account) {
        throw new WithdrawalValidationError('Strategy provider account not found', 404);
      }
      return account;
    }
    case 'copy_follower': {
      const account = await CopyFollowerAccount.findByPk(parsedId, {
        attributes: ['id', 'user_id', 'account_number']
      });
      if (!account) {
        throw new WithdrawalValidationError('Copy follower account not found', 404);
      }
      return account;
    }
    default:
      throw new WithdrawalValidationError('Unsupported user_type. Allowed: live, strategy_provider, copy_follower');
  }
}

async function resolveWithdrawalTarget(requestedUserId, requestedUserType, authContext) {
  const normalizedType = (requestedUserType || 'live').toString().toLowerCase();
  if (!SUPPORTED_WITHDRAW_ACCOUNT_TYPES.includes(normalizedType)) {
    throw new WithdrawalValidationError('Invalid user_type. Allowed: live, strategy_provider, copy_follower');
  }

  switch (normalizedType) {
    case 'live': {
      const targetId = requestedUserId ? parseInt(requestedUserId, 10) : authContext.authUserId;
      if (!targetId) {
        throw new WithdrawalValidationError('user_id is required for live accounts');
      }

      if (authContext.authAccountType !== 'live' || authContext.authUserId !== targetId) {
        throw new WithdrawalValidationError('You can only withdraw from your own live account', 403);
      }

      const account = await fetchAccountByType('live', targetId);
      return {
        targetAccountId: targetId,
        targetAccountType: 'live',
        targetAccountNumber: account.account_number,
        initiatorUserId: authContext.authUserId,
        initiatorAccountType: 'live',
      };
    }
    case 'strategy_provider': {
      const targetId = parseInt(requestedUserId, 10);
      if (Number.isNaN(targetId) || targetId <= 0) {
        throw new WithdrawalValidationError('user_id must be a positive integer');
      }

      const strategyAccount = await fetchAccountByType('strategy_provider', targetId);
      const ownsAsProvider = authContext.authAccountType === 'strategy_provider'
        && authContext.strategyProviderId === strategyAccount.id;
      const ownsAsLiveUser = authContext.authAccountType === 'live'
        && authContext.authUserId === strategyAccount.user_id;

      if (!ownsAsProvider && !ownsAsLiveUser) {
        throw new WithdrawalValidationError('You are not authorized to withdraw from this strategy provider account', 403);
      }

      return {
        targetAccountId: strategyAccount.id,
        targetAccountType: 'strategy_provider',
        targetAccountNumber: strategyAccount.account_number,
        initiatorUserId: authContext.authUserId,
        initiatorAccountType: authContext.authAccountType,
      };
    }
    case 'copy_follower': {
      const targetId = parseInt(requestedUserId, 10);
      if (Number.isNaN(targetId) || targetId <= 0) {
        throw new WithdrawalValidationError('user_id must be a positive integer');
      }

      const followerAccount = await fetchAccountByType('copy_follower', targetId);
      const ownsAsLiveUser = authContext.authAccountType === 'live'
        && authContext.authUserId === followerAccount.user_id;

      if (!ownsAsLiveUser) {
        throw new WithdrawalValidationError('You are not authorized to withdraw from this copy follower account', 403);
      }

      return {
        targetAccountId: followerAccount.id,
        targetAccountType: 'copy_follower',
        targetAccountNumber: followerAccount.account_number,
        initiatorUserId: authContext.authUserId,
        initiatorAccountType: 'live',
      };
    }
    default:
      throw new WithdrawalValidationError('Unsupported user_type');
  }
}

// POST /api/withdrawals
async function createWithdrawalRequest(req, res) {
  const operationId = `withdraw_request_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const authContext = getAuthContext(req);
    if (!authContext.authUserId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!authContext.isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }
    if (authContext.authAccountType !== 'live') {
      return res.status(403).json({ success: false, message: 'Withdrawals are only available for live users' });
    }

    const {
      amount,
      currency = 'USD',
      method_type,
      method_details,
      user_id,
      user_type
    } = req.body || {};

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ success: false, message: 'Amount must be a positive number' });
    }

    if (!method_type || !SUPPORTED_METHODS.includes(method_type)) {
      return res.status(400).json({ success: false, message: `Invalid method_type. Allowed: ${SUPPORTED_METHODS.join(', ')}` });
    }

    // method_details is free-form JSON; ensure it's an object if provided
    if (method_details && typeof method_details !== 'object') {
      return res.status(400).json({ success: false, message: 'method_details must be a JSON object' });
    }

    const normalizedUserType = (user_type || 'live').toString().toLowerCase();
    const normalizedUserId = user_id || authContext.authUserId;

    const ownership = await resolveWithdrawalTarget(normalizedUserId, normalizedUserType, authContext);

    logger.info('Creating withdrawal money request', {
      operationId,
      initiatorUserId: ownership.initiatorUserId,
      targetAccountId: ownership.targetAccountId,
      targetAccountType: ownership.targetAccountType,
      amount,
      currency,
      method_type
    });

    const created = await moneyRequestService.createRequest({
      userId: ownership.initiatorUserId,
      initiatorAccountType: ownership.initiatorAccountType,
      targetAccountId: ownership.targetAccountId,
      targetAccountType: ownership.targetAccountType,
      type: 'withdraw',
      amount: Number(amount),
      currency,
      methodType: method_type,
      methodDetails: method_details || null,
      accountNumber: ownership.targetAccountNumber || null,
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
    const statusCode = error instanceof WithdrawalValidationError ? (error.statusCode || 400) : (error.statusCode || 500);
    logger.error('Failed to create withdrawal request', { operationId, error: error.message });
    return res.status(statusCode).json({ success: false, message: error.message || 'Internal server error' });
  }
}

// GET /api/withdrawals/my-requests
async function getMyWithdrawalRequests(req, res) {
  const operationId = `withdraw_list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const authContext = getAuthContext(req);
    if (!authContext.authUserId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }
    if (!authContext.isActive) {
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }
    if (authContext.authAccountType !== 'live') {
      return res.status(403).json({ success: false, message: 'Withdrawals are only available for live users' });
    }

    const { status, limit = 50, offset = 0 } = req.query || {};

    const list = await moneyRequestService.getUserRequests(authContext.authUserId, {
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
      target_account_type: r.target_account_type,
      target_account_id: r.target_account_id,
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
