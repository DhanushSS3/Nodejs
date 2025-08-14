const permissionManagementService = require('../services/permission.management.service');
const adminAuditService = require('../services/admin.audit.service');

class PermissionManagementController {
  async assignPermissionToRole(req, res, next) {
    const { id: adminId } = req.admin;
    const ipAddress = req.ip;
    const { roleId, permissionId } = req.body;

    try {
      await permissionManagementService.assignPermissionToRole(roleId, permissionId);
      await adminAuditService.logAction({
        adminId,
        action: 'ASSIGN_PERMISSION',
        ipAddress,
        requestBody: req.body,
        status: 'SUCCESS',
      });
      res.status(200).json({ message: 'Permission assigned successfully.' });
    } catch (error) {
      await adminAuditService.logAction({
        adminId,
        action: 'ASSIGN_PERMISSION',
        ipAddress,
        requestBody: req.body,
        status: 'FAILURE',
        errorMessage: error.message,
      });
      res.status(400).json({ message: error.message });
    }
  }

  async removePermissionFromRole(req, res, next) {
    const { id: adminId } = req.admin;
    const ipAddress = req.ip;
    const { roleId, permissionId } = req.body;

    try {
      await permissionManagementService.removePermissionFromRole(roleId, permissionId);
      await adminAuditService.logAction({
        adminId,
        action: 'REMOVE_PERMISSION',
        ipAddress,
        requestBody: req.body,
        status: 'SUCCESS',
      });
      res.status(200).json({ message: 'Permission removed successfully.' });
    } catch (error) {
      await adminAuditService.logAction({
        adminId,
        action: 'REMOVE_PERMISSION',
        ipAddress,
        requestBody: req.body,
        status: 'FAILURE',
        errorMessage: error.message,
      });
      res.status(400).json({ message: error.message });
    }
  }
}

module.exports = new PermissionManagementController();
