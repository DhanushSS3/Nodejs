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

// Legacy JWT authentication (for backward compatibility)
function authenticateJWT(req, res, next) {
  const logger = require('../utils/logger');
  
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn(`Authentication failed - Missing or invalid Authorization header for ${req.method} ${req.url}`);
    return res.status(401).json({ success: false, message: 'Missing or invalid Authorization header' });
  }
  
  const token = authHeader.split(' ')[1];
  const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
  
  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) {
      logger.warn(`Authentication failed - Invalid or expired token for ${req.method} ${req.url}: ${err.message}`);
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    
    // Check user is_active status from JWT payload
    if (!user.is_active) {
      logger.warn(`Authentication failed - User ${user.sub || user.user_id || user.id} is inactive for ${req.method} ${req.url}`);
      return res.status(401).json({ success: false, message: 'User account is inactive' });
    }
    
    logger.info(`Authentication successful for user ${user.sub || user.user_id || user.id} on ${req.method} ${req.url}`);
    req.user = user;
    next();
  });
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
