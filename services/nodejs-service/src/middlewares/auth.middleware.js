const jwt = require('jsonwebtoken');
const { redisCluster } = require('../../config/redis');

// Enhanced authentication middleware for admin JWT tokens
async function authenticateAdmin(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Missing or invalid Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
    
    // Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET);
    const { sub, role, permissions, country_id, jti } = decoded;

    // Check if token is revoked (JTI check in Redis)
    const jtiKey = `jti:${sub}:${jti}`;
    const isValid = await redisCluster.get(jtiKey);
    
    if (!isValid) {
      return res.status(401).json({ success: false, message: 'Token has been revoked' });
    }

    // Check admin is_active status from JWT payload
    if (!decoded.is_active) {
      return res.status(401).json({ success: false, message: 'Admin account is inactive' });
    }

    // Attach admin info to request
    req.admin = {
      id: sub,
      role,
      permissions,
      country_id,
      is_active: decoded.is_active,
      jti
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token has expired' });
    }
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

// JWT authentication with Redis session validation
async function authenticateJWT(req, res, next) {
  const logger = require('../utils/logger');
  
  console.log('=== AUTH MIDDLEWARE CALLED ===');
  console.log('URL:', req.originalUrl || req.url);
  console.log('Method:', req.method);
  
  try {
    const authHeader = req.headers['authorization'];
    console.log('Auth header:', authHeader);
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('AUTH FAILED: Missing or invalid Authorization header');
      logger.warn(`Authentication failed - Missing or invalid Authorization header for ${req.method} ${req.url}`);
      return res.status(401).json({ success: false, message: 'Missing or invalid Authorization header' });
    }
    
    const token = authHeader.split(' ')[1];
    const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
    
    // Verify JWT token
    const user = jwt.verify(token, JWT_SECRET);
    console.log('JWT decoded user:', { 
      id: user.sub || user.user_id || user.id, 
      role: user.role, 
      is_active: user.is_active,
      sessionId: user.sessionId,
      user_type: user.user_type
    });
    
    // Check user is_active status from JWT payload
    if (!user.is_active) {
      console.log('AUTH FAILED: User is inactive');
      logger.warn(`Authentication failed - User ${user.sub || user.user_id || user.id} is inactive for ${req.method} ${req.url}`);
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }
    
    // Check if session is still valid in Redis (for logout functionality)
    if (user.sessionId && user.user_type) {
      console.log('Checking session in Redis...');
      const userId = user.sub || user.user_id || user.id;
      const sessionKey = `session:${user.user_type}:${userId}:${user.sessionId}`;
      console.log('Session key:', sessionKey);
      
      try {
        const sessionExists = await redisCluster.exists(sessionKey);
        console.log('Session exists:', sessionExists);
        if (!sessionExists) {
          console.log('AUTH FAILED: Session invalidated');
          logger.warn(`Authentication failed - Session invalidated for user ${userId} (${user.user_type}) on ${req.method} ${req.url}`);
          return res.status(401).json({ success: false, message: 'Session has been invalidated' });
        }
      } catch (redisError) {
        console.log('Redis session check failed:', redisError.message);
        logger.error(`Redis session check failed for user ${userId}: ${redisError.message}`);
        // Continue without Redis check if Redis is down (graceful degradation)
      }
    } else {
      console.log('No session validation needed (no sessionId or user_type)');
    }
    
    console.log('AUTH SUCCESS: Calling next()');
    logger.info(`Authentication successful for user ${user.sub || user.user_id || user.id} on ${req.method} ${req.url}`);
    req.user = user;
    next();
    
  } catch (err) {
    console.log('AUTH ERROR:', err.name, err.message);
    if (err.name === 'TokenExpiredError') {
      console.log('AUTH FAILED: Token expired');
      logger.warn(`Authentication failed - Token expired for ${req.method} ${req.url}`);
      return res.status(401).json({ success: false, message: 'Token has expired' });
    }
    console.log('AUTH FAILED: Invalid token');
    logger.warn(`Authentication failed - Invalid token for ${req.method} ${req.url}: ${err.message}`);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

// Permission-based authorization middleware
function requirePermission(requiredPermission) {
  return (req, res, next) => {
    const { admin } = req;
    
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Superadmin has all permissions
    if (admin.role === 'superadmin') {
      return next();
    }

    // Check if admin has the required permission
    if (!admin.permissions || !admin.permissions.includes(requiredPermission)) {
      return res.status(403).json({ 
        success: false, 
        message: `Insufficient permissions. Required: ${requiredPermission}` 
      });
    }

    next();
  };
}

// Multiple permissions check (admin must have ALL specified permissions)
function requirePermissions(requiredPermissions) {
  return (req, res, next) => {
    const { admin } = req;
    
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    // Superadmin has all permissions
    if (admin.role === 'superadmin') {
      return next();
    }

    // Check if admin has all required permissions
    const hasAllPermissions = requiredPermissions.every(permission => 
      admin.permissions && admin.permissions.includes(permission)
    );

    if (!hasAllPermissions) {
      return res.status(403).json({ 
        success: false, 
        message: `Insufficient permissions. Required: ${requiredPermissions.join(', ')}` 
      });
    }

    next();
  };
}

// Role-based authorization middleware
function requireRole(allowedRoles) {
  return (req, res, next) => {
    const { admin } = req;
    
    if (!admin) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }

    const rolesArray = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    
    if (!rolesArray.includes(admin.role)) {
      return res.status(403).json({ 
        success: false, 
        message: `Insufficient role. Required: ${rolesArray.join(' or ')}` 
      });
    }

    next();
  };
}

module.exports = {
  authenticateAdmin,
  authenticateJWT, // Legacy support
  requirePermission,
  requirePermissions,
  requireRole
};
