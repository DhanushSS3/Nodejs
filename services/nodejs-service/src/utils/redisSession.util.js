const crypto = require('crypto');
const { redisCluster } = require('../../config/redis');
const logger = require('../services/logger.service');

// Redis cluster connection pool increased to 1000 connections for high-volume operations

// --- SESSION LIMITS ---
const MAX_CONCURRENT_SESSIONS = 3; // Maximum concurrent sessions per user

// --- RATE LIMITING ---
const RATE_LIMIT_ATTEMPTS = 10;
const RATE_LIMIT_WINDOW = 900; // 15 min in seconds

function getEmailKey(email, userType) {
  if (!email) {
    // Handle cases where email is null or undefined
    const invalidEmailHash = crypto.createHash('sha256').update('invalid_email').digest('hex');
    return `{${invalidEmailHash}}:${userType}:login:attempts:email`;
  }
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
const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days
const REFRESH_TOKEN_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

// --- OTP MANAGEMENT ---
const OTP_EXPIRATION = 300; // 5 minutes in seconds
const OTP_MAX_TRIES = 5;
const OTP_RATE_LIMIT_WINDOW = 3600; // 1 hour in seconds
const OTP_RATE_LIMIT_MAX_REQUESTS = 5;
const RESET_TOKEN_EXPIRATION = 600; // 10 minutes in seconds

function getOTPKey(email, userType) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  return `{otp:${hash}}:${userType}:otp`;
}

function getOTPRateLimitKey(email, userType) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  return `{otp:${hash}}:${userType}:otp_limit`;
}

async function storeOTP(email, otp, userType) {
  const key = getOTPKey(email, userType);
  try {
    const pipeline = redisCluster.pipeline();
    pipeline.hset(key, 'otp', otp, 'tries', 0);
    pipeline.expire(key, OTP_EXPIRATION);
    await pipeline.exec();
    return true;
  } catch (error) {
    console.error('Failed to store OTP:', error);
    throw error;
  }
}

async function getOTP(email, userType) {
  const key = getOTPKey(email, userType);
  try {
    const data = await redisCluster.hgetall(key);
    return data;
  } catch (error) {
    console.error('Failed to get OTP:', error);
    return null;
  }
}

async function incrementOTPTries(email, userType) {
  const key = getOTPKey(email, userType);
  try {
    return await redisCluster.hincrby(key, 'tries', 1);
  } catch (error) {
    console.error('Failed to increment OTP tries:', error);
    return OTP_MAX_TRIES + 1; // Fail closed
  }
}

async function deleteOTP(email, userType) {
  const key = getOTPKey(email, userType);
  try {
    await redisCluster.del(key);
  } catch (error) {
    console.error('Failed to delete OTP:', error);
  }
}

async function checkOTPRateLimit(email, userType) {
  const key = getOTPRateLimitKey(email, userType);
  try {
    const pipeline = redisCluster.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, OTP_RATE_LIMIT_WINDOW, 'NX'); // Set expiry only if key is new
    const results = await pipeline.exec();
    const count = results[0][1];
    return count > OTP_RATE_LIMIT_MAX_REQUESTS;
  } catch (error) {
    console.error('OTP rate limit check failed:', error);
    return true; // Fail closed
  }
}

function getSessionKey(userId, sessionId, userType) {
  // Using userId as hash tag to ensure all user sessions are in the same slot
  return `{user:${userType}:${userId}}:session:${sessionId}`;
}

function getRefreshTokenKey(refreshToken) {
  // Using the first part of the refresh token as hash tag
  const hashPart = refreshToken.split('.')[0];
  return `{${hashPart}}:refresh_token:${refreshToken}`;
}

function getUserSessionsKey(userId, userType) {
  // Using userId as hash tag to ensure all user's sessions are in same slot
  return `{${userId}}:${userType}:sessions`;
}

async function getUserActiveSessions(userId, userType) {
  const key = getUserSessionsKey(userId, userType);
  try {
    const sessions = await redisCluster.zrange(key, 0, -1, 'WITHSCORES');
    const activeSessions = [];
    
    // Parse sessions with timestamps
    for (let i = 0; i < sessions.length; i += 2) {
      const sessionId = sessions[i];
      const timestamp = parseInt(sessions[i + 1]);
      activeSessions.push({ sessionId, timestamp });
    }
    
    return activeSessions.sort((a, b) => a.timestamp - b.timestamp); // Oldest first
  } catch (error) {
    console.error('Failed to get user active sessions:', error);
    return [];
  }
}

async function addUserSession(userId, sessionId, userType) {
  const key = getUserSessionsKey(userId, userType);
  const timestamp = Date.now();
  
  try {
    // Add new session with current timestamp
    await redisCluster.zadd(key, timestamp, sessionId);
    
    // Set expiration for the sessions set (7 days to match refresh token)
    await redisCluster.expire(key, REFRESH_TOKEN_TTL);
    
    return true;
  } catch (error) {
    console.error('Failed to add user session:', error);
    return false;
  }
}

async function removeUserSession(userId, sessionId, userType) {
  const key = getUserSessionsKey(userId, userType);
  
  try {
    await redisCluster.zrem(key, sessionId);
    return true;
  } catch (error) {
    console.error('Failed to remove user session:', error);
    return false;
  }
}

async function enforceSessionLimit(userId, userType) {
  const activeSessions = await getUserActiveSessions(userId, userType);
  logger.info('Session check before enforcement', {
    userId,
    userType,
    activeSessionsCount: activeSessions.length,
    activeSessionIds: activeSessions.map(session => session.sessionId)
  });
  
  if (activeSessions.length >= MAX_CONCURRENT_SESSIONS) {
    // Remove oldest sessions to make room for new one
    const sessionsToRemove = activeSessions.slice(0, activeSessions.length - MAX_CONCURRENT_SESSIONS + 1);
    logger.info('Session limit exceeded, revoking oldest sessions', {
      userId,
      userType,
      maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
      sessionsToRemove: sessionsToRemove.map(session => session.sessionId)
    });
    
    for (const session of sessionsToRemove) {
      // Delete the actual session data
      await deleteSession(userId, session.sessionId, userType);
      logger.info('Revoked session due to limit enforcement', {
        userId,
        userType,
        revokedSessionId: session.sessionId
      });
      
      // Remove from sessions tracking
      await removeUserSession(userId, session.sessionId, userType);
      
      console.log(`Revoked oldest session for user ${userId} (${userType}): ${session.sessionId}`);
    }
    
    return sessionsToRemove.map(s => s.sessionId);
  }
  
  return [];
}

async function storeSession(userId, sessionId, sessionData, userType, refreshToken = null) {
  const key = getSessionKey(userId, sessionId, userType);
  try {
    // Enforce session limit before storing new session
    const revokedSessions = await enforceSessionLimit(userId, userType);
    
    // Store session data first
    await redisCluster.set(key, JSON.stringify(sessionData), 'EX', SESSION_TTL);
    
    // Add session to user's active sessions tracking
    await addUserSession(userId, sessionId, userType);
    const updatedSessions = await getUserActiveSessions(userId, userType);
    logger.info('Stored session in Redis', {
      userId,
      userType,
      sessionId,
      activeSessionsCount: updatedSessions.length,
      activeSessionIds: updatedSessions.map(session => session.sessionId),
      revokedSessions
    });
    
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
    
    // Return info about revoked sessions if any
    return {
      success: true,
      revokedSessions: revokedSessions
    };
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
    logger.info('Deleted session key from Redis', {
      userId,
      userType,
      sessionId
    });
    
    // Remove session from user's active sessions tracking
    await removeUserSession(userId, sessionId, userType);
    
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

// --- Password Reset Functions ---

function getPasswordResetOTPKey(email, userType) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  return `{otp:reset:${hash}}:${userType}:otp`;
}

function getPasswordResetRateLimitKey(email, userType) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  return `{otp:reset:${hash}}:${userType}:otp_limit`;
}

async function storePasswordResetOTP(email, otp, userType) {
  const key = getPasswordResetOTPKey(email, userType);
  try {
    const pipeline = redisCluster.pipeline();
    pipeline.hset(key, 'otp', otp, 'tries', 0);
    pipeline.expire(key, OTP_EXPIRATION);
    await pipeline.exec();
  } catch (error) {
    console.error('Failed to store password reset OTP:', error);
    throw error; // Re-throw to be handled by the controller
  }
}

async function getPasswordResetOTP(email, userType) {
  const key = getPasswordResetOTPKey(email, userType);
  try {
    return await redisCluster.hgetall(key);
  } catch (error) {
    console.error('Failed to get password reset OTP:', error);
    return null; // Fail gracefully
  }
}

async function incrementPasswordResetOTPTries(email, userType) {
  const key = getPasswordResetOTPKey(email, userType);
  try {
    return await redisCluster.hincrby(key, 'tries', 1);
  } catch (error) {
    console.error('Failed to increment password reset OTP tries:', error);
    return OTP_MAX_TRIES + 1; // Fail closed
  }
}

async function deletePasswordResetOTP(email, userType) {
  const key = getPasswordResetOTPKey(email, userType);
  try {
    await redisCluster.del(key);
  } catch (error) {
    console.error('Failed to delete password reset OTP:', error);
    // Do not re-throw, continue execution
  }
}

async function checkPasswordResetOTPRateLimit(email, userType) {
  const key = getPasswordResetRateLimitKey(email, userType);
  try {
    const currentRequests = await redisCluster.incr(key);
    if (currentRequests === 1) {
      await redisCluster.expire(key, OTP_RATE_LIMIT_WINDOW);
    }
    return currentRequests > OTP_RATE_LIMIT_MAX_REQUESTS;
  } catch (error) {
    console.error('Failed to check password reset OTP rate limit:', error);
    return true; // Fail closed
  }
}

function getResetTokenKey(email, userType) {
  const hash = crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
  return `reset_token:${userType}:${hash}`;
}

async function storeResetToken(email, userType, token) {
  const key = getResetTokenKey(email, userType);
  try {
    await redisCluster.set(key, token, 'EX', RESET_TOKEN_EXPIRATION);
  } catch (error) {
    console.error('Failed to store reset token:', error);
    throw error;
  }
}

async function getResetToken(email, userType) {
  const key = getResetTokenKey(email, userType);
  try {
    return await redisCluster.get(key);
  } catch (error) {
    console.error('Failed to get reset token:', error);
    return null;
  }
}

async function deleteResetToken(email, userType) {
  const key = getResetTokenKey(email, userType);
  try {
    await redisCluster.del(key);
  } catch (error) {
    console.error('Failed to delete reset token:', error);
  }
}

async function clearOTPRateLimit(email, userType) {
  const key = getOTPRateLimitKey(email, userType);
  try {
    await redisCluster.del(key);
    console.log(`Cleared OTP rate limit for ${email} (${userType})`);
  } catch (error) {
    console.error('Failed to clear OTP rate limit:', error);
  }
}

module.exports = {
  // OTP Functions
  storeOTP,
  getOTP,
  incrementOTPTries,
  deleteOTP,
  checkOTPRateLimit,
  clearOTPRateLimit,
  OTP_MAX_TRIES,
  // Password Reset
  storePasswordResetOTP,
  getPasswordResetOTP,
  incrementPasswordResetOTPTries,
  deletePasswordResetOTP,
  checkPasswordResetOTPRateLimit,
  storeResetToken,
  getResetToken,
  deleteResetToken,
  checkAndIncrementRateLimit,
  resetRateLimit,
  storeSession,
  getSession,
  deleteSession,
  validateRefreshToken,
  deleteRefreshToken,
  // Session Management
  getUserActiveSessions,
  addUserSession,
  removeUserSession,
  enforceSessionLimit,
  MAX_CONCURRENT_SESSIONS,
  getEmailKey,
  getIPKey,
  getSessionKey,
  getRefreshTokenKey
};
