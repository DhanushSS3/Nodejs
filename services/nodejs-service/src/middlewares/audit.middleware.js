const AdminAuditLog = require('../models/adminAuditLog.model');

// Middleware to log admin actions for audit purposes
const auditLog = (action) => {
  return async (req, res, next) => {
    const { admin } = req;
    
    if (!admin) {
      return next();
    }

    const originalSend = res.send;
    const originalJson = res.json;
    
    let responseBody;
    let statusCode = res.statusCode;

    // Intercept response to capture status and response data
    res.send = function(data) {
      responseBody = data;
      statusCode = res.statusCode;
      return originalSend.call(this, data);
    };

    res.json = function(data) {
      responseBody = data;
      statusCode = res.statusCode;
      return originalJson.call(this, data);
    };

    // Continue with the request
    next();

    // Log the action after response is sent
    res.on('finish', async () => {
      try {
        const logData = {
          admin_id: admin.id,
          action,
          ip_address: req.ip || req.connection.remoteAddress,
          request_body: req.body && Object.keys(req.body).length > 0 ? req.body : null,
          status: statusCode >= 200 && statusCode < 300 ? 'SUCCESS' : 'FAILED',
          error_message: statusCode >= 400 ? (responseBody?.message || 'Unknown error') : null
        };

        await AdminAuditLog.create(logData);
      } catch (error) {
        console.error('Failed to create audit log:', error);
        // Don't throw error to avoid affecting the main request
      }
    });
  };
};

// Helper function to create audit logs programmatically
const createAuditLog = async (adminId, action, ipAddress, requestBody = null, status = 'SUCCESS', errorMessage = null) => {
  try {
    await AdminAuditLog.create({
      admin_id: adminId,
      action,
      ip_address: ipAddress,
      request_body: requestBody,
      status,
      error_message: errorMessage
    });
  } catch (error) {
    console.error('Failed to create audit log:', error);
  }
};

module.exports = {
  auditLog,
  createAuditLog
};
