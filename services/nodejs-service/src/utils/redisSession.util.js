const crypto = require('crypto');
const { redisCluster } = require('../../config/redis');

// --- RATE LIMITING ---
const RATE_LIMIT_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW = 900; // 15 min in seconds

function getEmailKey(email, userType) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  // Using email hash as the hash tag to ensure same slot for all user's keys
  return `{${hash}}:${userType}:login:attempts:email`;
}

function getIPKey(ip, userType) {
  // For IP-based rate limiting, we'll use a separate key without hash tag
  // since it needs to be checked independently
  return `${userType}:login:attempts:ip:${ip}`;
}

async function checkAndIncrementRateLimit({ email, ip, userType }) {
  const emailKey = getEmailKey(email, userType);
  const ipKey = getIPKey(ip, userType);
  
  // Execute email and IP rate limiting in separate pipelines since they need different hash slots
  try {
    // Check email rate limit
    const emailPipeline = redisCluster.pipeline();
    emailPipeline.incr(emailKey);
    emailPipeline.expire(emailKey, RATE_LIMIT_WINDOW);
    const emailResults = await emailPipeline.exec();
    
    // If email rate limit exceeded, return early
    if (emailResults[0][1] > RATE_LIMIT_ATTEMPTS) {
      return true;
    }
    
    // Check IP rate limit
    const ipPipeline = redisCluster.pipeline();
    ipPipeline.incr(ipKey);
    ipPipeline.expire(ipKey, RATE_LIMIT_WINDOW);
    const ipResults = await ipPipeline.exec();
    
    return ipResults[0][1] > RATE_LIMIT_ATTEMPTS;
  } catch (error) {
    console.error('Rate limit check failed:', error);
    // Fail open in production, closed in development
    return process.env.NODE_ENV === 'production' ? false : true;
  }
}

async function resetRateLimit({ email, ip, userType }) {
  const emailKey = getEmailKey(email, userType);
  const ipKey = getIPKey(ip, userType);
  
  try {
    // Execute deletes in parallel but separate operations
    await Promise.all([
      redisCluster.del(emailKey),
      redisCluster.del(ipKey)
    ]);
  } catch (error) {
    console.error('Failed to reset rate limits:', error);
    // Continue execution even if reset fails
  }
}

// --- SESSION MANAGEMENT ---
const SESSION_TTL = 900; // 15 min
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

function getSessionKey(userId, sessionId, userType) {
  // Using userId as hash tag to ensure all user sessions are in the same slot
  return `{user:${userType}:${userId}}:session:${sessionId}`;
}

function getRefreshTokenKey(refreshToken) {
  // Using the first part of the refresh token as hash tag
  const hashPart = refreshToken.split('.')[0];
  return `{${hashPart}}:refresh_token:${refreshToken}`;
}

async function storeSession(userId, sessionId, sessionData, userType, refreshToken = null) {
  const key = getSessionKey(userId, sessionId, userType);
  try {
    // Store session data first
    await redisCluster.set(key, JSON.stringify(sessionData), 'EX', SESSION_TTL);
    
    // If refresh token is provided, store it in a separate operation
    if (refreshToken) {
      const refreshKey = getRefreshTokenKey(refreshToken);
      await redisCluster.set(
        refreshKey, 
        JSON.stringify({
          userId,
          sessionId,
          userType, // Add userType to refresh token data
          createdAt: new Date().toISOString()
        }), 
        'EX', 
        REFRESH_TOKEN_TTL
      );
    }
    
    return true;
  } catch (error) {
    console.error('Failed to store session:', error);
    throw error; // Re-throw to be handled by the caller
  }
}

async function getSession(userId, sessionId, userType) {
  const key = getSessionKey(userId, sessionId, userType);
  try {
    const data = await redisCluster.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('Failed to get session:', error);
    return null; // Return null on error to allow the request to continue
  }
}

async function deleteSession(userId, sessionId, userType, refreshToken = null) {
  const key = getSessionKey(userId, sessionId, userType);
  try {
    // Delete session first
    await redisCluster.del(key);
    
    // If refresh token is provided, delete it as well
    if (refreshToken) {
      const refreshKey = getRefreshTokenKey(refreshToken);
      await redisCluster.del(refreshKey);
    }
    
    return true;
  } catch (error) {
    console.error('Failed to delete session:', error);
    throw error; // Re-throw to be handled by the caller
  }
}

async function validateRefreshToken(refreshToken) {
  try {
    const refreshKey = getRefreshTokenKey(refreshToken);
    const data = await redisCluster.get(refreshKey);
    if (!data) return null;
    
    const tokenData = JSON.parse(data);
    // Get the session to verify it exists
    const sessionKey = getSessionKey(tokenData.userId, tokenData.sessionId, tokenData.userType);
    const sessionExists = await redisCluster.exists(sessionKey);
    
    if (!sessionExists) {
      // Clean up expired refresh token
      await redisCluster.del(refreshKey);
      return null;
    }
    
    return tokenData;
  } catch (error) {
    console.error('Error validating refresh token:', error);
    return null;
  }
}

async function deleteRefreshToken(refreshToken) {
  try {
    const refreshKey = getRefreshTokenKey(refreshToken);
    await redisCluster.del(refreshKey);
  } catch (error) {
    console.error('Failed to delete refresh token:', error);
  }
}

module.exports = {
  checkAndIncrementRateLimit,
  resetRateLimit,
  storeSession,
  getSession,
  deleteSession,
  validateRefreshToken,
  deleteRefreshToken,
  getEmailKey,
  getIPKey,
  getSessionKey,
  getRefreshTokenKey
};
