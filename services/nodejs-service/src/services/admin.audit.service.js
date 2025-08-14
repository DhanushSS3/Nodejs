const { AdminAuditLog } = require('../models');

class AdminAuditService {
  /**
   * Logs an action performed by an admin.
   * @param {object} logData - The data to be logged.
   * @param {number} logData.adminId - The ID of the admin performing the action.
   * @param {string} logData.action - A description of the action (e.g., 'CREATE_ADMIN').
   * @param {string} logData.ipAddress - The IP address of the request.
   * @param {object} logData.requestBody - The body of the request.
   * @param {string} logData.status - The outcome of the action ('SUCCESS' or 'FAILURE').
   * @param {string} [logData.errorMessage] - The error message if the action failed.
   */
  async logAction(logData) {
    try {
      await AdminAuditLog.create({
        admin_id: logData.adminId,
        action: logData.action,
        ip_address: logData.ipAddress,
        request_body: logData.requestBody ? JSON.stringify(logData.requestBody) : null,
        status: logData.status,
        error_message: logData.errorMessage,
      });
    } catch (error) {
      console.error('Failed to write to audit log:', error);
      // In a production environment, you might want to send an alert here.
    }
  }
}

module.exports = new AdminAuditService();
