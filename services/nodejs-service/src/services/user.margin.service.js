const { Transaction } = require('sequelize');
const sequelize = require('../config/db');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');
const StrategyProviderAccount = require('../models/strategyProviderAccount.model');
const CopyFollowerAccount = require('../models/copyFollowerAccount.model');
const logger = require('./logger.service');

function getUserModel(userType) {
  switch (userType) {
    case 'live':
      return LiveUser;
    case 'demo':
      return DemoUser;
    case 'strategy_provider':
      return StrategyProviderAccount;
    case 'copy_follower':
      return CopyFollowerAccount;
    default:
      return LiveUser; // Default fallback
  }
}

/**
 * Update a user's overall used margin in SQL with row-level locking.
 * - Locks only the target user row (SELECT ... FOR UPDATE)
 * - Keeps the transaction scope minimal to reduce lock time and avoid deadlocks
 * - Supports live, demo, strategy_provider, and copy_follower users based on userType
 *
 * @param {Object} params
 * @param {'live'|'demo'|'strategy_provider'|'copy_follower'} params.userType
 * @param {number} params.userId
 * @param {number|string} params.usedMargin - total used margin to persist
 * @returns {Promise<string>} persisted margin as string
 */
function isRetryableLockError(err) {
  const msg = (err?.message || '').toLowerCase();
  // MySQL codes: ER_LOCK_DEADLOCK=1213, ER_LOCK_WAIT_TIMEOUT=1205
  const code = err?.original?.code || err?.parent?.code;
  return (
    code === 'ER_LOCK_DEADLOCK' ||
    code === 'ER_LOCK_WAIT_TIMEOUT' ||
    msg.includes('deadlock') ||
    msg.includes('lock wait timeout')
  );
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function updateUserUsedMargin({ userType, userId, usedMargin }) {
  const Model = getUserModel(userType);
  // Normalize and round to 2 decimals to preserve reporting consistency in SQL
  const num = Number(usedMargin);
  if (!Number.isFinite(num)) {
    throw new Error(`Invalid usedMargin: ${usedMargin}`);
  }
  const marginStr = num.toFixed(2);

  const maxAttempts = 3;
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED },
        async (t) => {
          // Lock the user row for update
          // All user types now use primary key (account ID) to avoid ambiguity
          // when users have multiple accounts of the same type
          const user = await Model.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
          
          if (!user) {
            throw new Error(`${userType} user not found: ${userId}`);
          }

          // Avoid unnecessary writes if value unchanged
          const current = (user.margin ?? '0').toString();
          if (current === marginStr) {
            return current;
          }

          await user.update({ margin: marginStr }, { transaction: t });
          return marginStr;
        }
      );
    } catch (err) {
      lastErr = err;
      if (isRetryableLockError(err) && attempt < maxAttempts) {
        // Exponential backoff: 25ms, 75ms
        const backoff = 25 * attempt * attempt;
        logger.warn('Retrying user margin update after lock error', { attempt, userId, userType, backoff, error: err.message });
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

module.exports = { updateUserUsedMargin };
