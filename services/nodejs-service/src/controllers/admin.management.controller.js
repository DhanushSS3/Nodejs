const adminManagementService = require('../services/admin.management.service');
const adminAuditService = require('../services/admin.audit.service');

class AdminManagementController {
  async createAdmin(req, res, next) {
    const { id: adminId } = req.admin;
    const ipAddress = req.ip;

    try {
      const newAdmin = await adminManagementService.createAdmin(req.body);
      await adminAuditService.logAction({
        adminId,
        action: 'CREATE_ADMIN',
        ipAddress,
        requestBody: req.body,
        status: 'SUCCESS',
      });
      res.status(201).json(newAdmin);
    } catch (error) {
      await adminAuditService.logAction({
        adminId,
        action: 'CREATE_ADMIN',
        ipAddress,
        requestBody: req.body,
        status: 'FAILURE',
        errorMessage: error.message,
      });
      if (error.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ message: 'Email or username already exists.' });
      }
      res.status(400).json({ message: error.message });
    }
  }

  async listAdmins(req, res, next) {
    try {
      const admins = await adminManagementService.listAdmins();
      res.status(200).json(admins);
    } catch (error) {
      res.status(500).json({ message: 'Failed to retrieve admins', error: error.message });
    }
  }

  async getAdminById(req, res, next) {
    try {
      const { id } = req.params;
      const admin = await adminManagementService.getAdminById(id);
      res.status(200).json(admin);
    } catch (error) {
      if (error.message === 'Admin not found') {
        return res.status(404).json({ message: error.message });
      }
      res.status(500).json({ message: 'Failed to retrieve admin', error: error.message });
    }
  }

  async updateAdmin(req, res, next) {
    const { id: adminId } = req.admin;
    const { id: targetAdminId } = req.params;
    const ipAddress = req.ip;

    try {
      const updatedAdmin = await adminManagementService.updateAdmin(targetAdminId, req.body);
      await adminAuditService.logAction({
        adminId,
        action: 'UPDATE_ADMIN',
        ipAddress,
        requestBody: req.body,
        status: 'SUCCESS',
      });
      res.status(200).json(updatedAdmin);
    } catch (error) {
      await adminAuditService.logAction({
        adminId,
        action: 'UPDATE_ADMIN',
        ipAddress,
        requestBody: req.body,
        status: 'FAILURE',
        errorMessage: error.message,
      });
      if (error.message === 'Admin not found') {
        return res.status(404).json({ message: error.message });
      }
      if (error.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).json({ message: 'Email or username already exists.' });
      }
      res.status(400).json({ message: error.message });
    }
  }

  async deleteAdmin(req, res, next) {
    const { id: adminId } = req.admin;
    const { id: targetAdminId } = req.params;
    const ipAddress = req.ip;

    try {
      await adminManagementService.deleteAdmin(targetAdminId);
      await adminAuditService.logAction({
        adminId,
        action: 'DELETE_ADMIN',
        ipAddress,
        requestBody: { targetAdminId },
        status: 'SUCCESS',
      });
      res.status(204).send();
    } catch (error) {
      await adminAuditService.logAction({
        adminId,
        action: 'DELETE_ADMIN',
        ipAddress,
        requestBody: { targetAdminId },
        status: 'FAILURE',
        errorMessage: error.message,
      });
      if (error.message === 'Admin not found') {
        return res.status(404).json({ message: error.message });
      }
      res.status(400).json({ message: error.message });
    }
  }
}

module.exports = new AdminManagementController();
