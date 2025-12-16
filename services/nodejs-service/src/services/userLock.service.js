const crypto = require('crypto');
const logger = require('./logger.service');
const { redisCluster } = require('../../config/redis');

const RELEASE_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

const DEFAULT_TTL_SECONDS = parseInt(process.env.USER_LOCK_TTL_SECONDS || '2', 10);

async function acquireUserLock(userType, userId, ttlSeconds = DEFAULT_TTL_SECONDS, context = {}) {
  if (!userType || !userId) {
    return null;
  }

  const lockKey = `lock:node_user_ops:${userType}:${userId}`;
  const token = crypto.randomUUID();

  try {
    const acquired = await redisCluster.set(lockKey, token, 'NX', 'EX', ttlSeconds);
    if (!acquired) {
      return null;
    }
    return { lockKey, token, userType, userId, context };
  } catch (error) {
    logger.error('Failed to acquire user lock', { error: error.message, lockKey });
    return null;
  }
}

async function releaseUserLock(lock) {
  if (!lock?.lockKey || !lock?.token) {
    return;
  }

  try {
    const released = await redisCluster.eval(RELEASE_LUA, 1, lock.lockKey, lock.token);
    if (released !== 1) {
      const currentToken = await redisCluster.get(lock.lockKey);
      if (currentToken === null) {
        logger.debug('User lock already expired before release', { lockKey: lock.lockKey, userType: lock.userType, userId: lock.userId });
        return;
      }
      if (currentToken === lock.token) {
        await redisCluster.del(lock.lockKey);
        logger.warn('User lock release script returned 0 but token matched - forced delete', {
          lockKey: lock.lockKey,
          userType: lock.userType,
          userId: lock.userId
        });
        return;
      }
      logger.warn('User lock token mismatch on release', {
        lockKey: lock.lockKey,
        userType: lock.userType,
        userId: lock.userId,
        expected: lock.token,
        found: currentToken
      });
    }
  } catch (error) {
    logger.warn('Failed to release user lock', { error: error.message, lockKey: lock.lockKey, userType: lock.userType, userId: lock.userId });
    try {
      const currentToken = await redisCluster.get(lock.lockKey);
      if (currentToken === lock.token) {
        await redisCluster.del(lock.lockKey);
        logger.warn('Fallback deleted user lock after release error', { lockKey: lock.lockKey, userType: lock.userType, userId: lock.userId });
      }
    } catch (fallbackErr) {
      logger.error('Failed to cleanup user lock after release error', {
        error: fallbackErr.message,
        lockKey: lock.lockKey,
        userType: lock.userType,
        userId: lock.userId
      });
    }
  }
}

module.exports = {
  acquireUserLock,
  releaseUserLock
};
