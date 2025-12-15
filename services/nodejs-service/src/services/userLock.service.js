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

const DEFAULT_TTL_SECONDS = parseInt(process.env.USER_LOCK_TTL_SECONDS || '15', 10);

async function acquireUserLock(userType, userId, ttlSeconds = DEFAULT_TTL_SECONDS) {
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
    return { lockKey, token };
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
    await redisCluster.eval(RELEASE_LUA, 1, lock.lockKey, lock.token);
  } catch (error) {
    logger.warn('Failed to release user lock', { error: error.message, lockKey: lock.lockKey });
  }
}

module.exports = {
  acquireUserLock,
  releaseUserLock
};
