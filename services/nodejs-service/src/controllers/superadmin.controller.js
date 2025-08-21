const superadminService = require('../services/superadmin.service');
const { createAuditLog } = require('../middlewares/audit.middleware');

class SuperadminController {
  // Create a new admin
  async createAdmin(req, res) {
    try {
      const { username, email, password, role_id, country_id } = req.body;
      const { admin } = req;

      const newAdmin = await superadminService.createAdmin({
        username,
        email,
        password,
        role_id,
        country_id
      }, admin.id);

      // Create audit log
      await createAuditLog(
        admin.id,
        'ADMIN_CREATE',
        req.ip,
        { target_admin_id: newAdmin.id, username, email, role_id, country_id },
        'SUCCESS'
      );

      res.status(201).json({
        success: true,
        message: 'Admin created successfully',
        data: newAdmin
      });
    } catch (error) {
      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'ADMIN_CREATE',
        req.ip,
        req.body,
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  // Update admin details
  async updateAdmin(req, res) {
    try {
      const { adminId } = req.params;
      const updateData = req.body;
      const { admin } = req;

      const updatedAdmin = await superadminService.updateAdmin(adminId, updateData, admin.id);

      // Create audit log
      await createAuditLog(
        admin.id,
        'ADMIN_UPDATE',
        req.ip,
        { target_admin_id: adminId, ...updateData },
        'SUCCESS'
      );

      res.status(200).json({
        success: true,
        message: 'Admin updated successfully',
        data: updatedAdmin
      });
    } catch (error) {
      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'ADMIN_UPDATE',
        req.ip,
        { target_admin_id: req.params.adminId, ...req.body },
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get all admins
  async getAllAdmins(req, res) {
    try {
      const { country_id, role_id, is_active } = req.query;
      const filters = {};

      if (country_id) filters.country_id = country_id;
      if (role_id) filters.role_id = role_id;
      if (is_active !== undefined) filters.is_active = is_active === 'true';

      const admins = await superadminService.getAllAdmins(filters);

      res.status(200).json({
        success: true,
        message: 'Admins retrieved successfully',
        data: admins
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Deactivate admin
  async deactivateAdmin(req, res) {
    try {
      const { adminId } = req.params;
      const { admin } = req;

      const deactivatedAdmin = await superadminService.deactivateAdmin(adminId, admin.id);

      // Create audit log
      await createAuditLog(
        admin.id,
        'ADMIN_DEACTIVATE',
        req.ip,
        { target_admin_id: adminId },
        'SUCCESS'
      );

      res.status(200).json({
        success: true,
        message: 'Admin deactivated successfully',
        data: deactivatedAdmin
      });
    } catch (error) {
      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'ADMIN_DEACTIVATE',
        req.ip,
        { target_admin_id: req.params.adminId },
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  // Reset admin password
  async resetAdminPassword(req, res) {
    try {
      const { adminId } = req.params;
      const { newPassword } = req.body;
      const { admin } = req;

      const result = await superadminService.resetAdminPassword(adminId, newPassword, admin.id);

      // Create audit log (don't log the password)
      await createAuditLog(
        admin.id,
        'ADMIN_PASSWORD_RESET',
        req.ip,
        { target_admin_id: adminId },
        'SUCCESS'
      );

      res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'ADMIN_PASSWORD_RESET',
        req.ip,
        { target_admin_id: req.params.adminId },
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  // Role Management
  async createRole(req, res) {
    try {
      const { name, description, permission_ids } = req.body;
      const { admin } = req;

      const role = await superadminService.createRole({ name, description, permission_ids });

      // Create audit log
      await createAuditLog(
        admin.id,
        'ROLE_CREATE',
        req.ip,
        { role_name: name, description, permission_count: permission_ids?.length || 0 },
        'SUCCESS'
      );

      res.status(201).json({
        success: true,
        message: 'Role created successfully with permissions',
        data: role
      });
    } catch (error) {
      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'ROLE_CREATE',
        req.ip,
        req.body,
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  async createPermission(req, res) {
    try {
      const { name, description } = req.body;
      const { admin } = req;

      const permission = await superadminService.createPermission({ name, description });

      // Create audit log
      await createAuditLog(
        admin.id,
        'PERMISSION_CREATE',
        req.ip,
        { permission_name: name, description },
        'SUCCESS'
      );

      res.status(201).json({
        success: true,
        message: 'Permission created successfully',
        data: permission
      });
    } catch (error) {
      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'PERMISSION_CREATE',
        req.ip,
        req.body,
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  async assignPermissionToRole(req, res) {
    try {
      const { roleId, permissionId } = req.params;
      const { admin } = req;

      const result = await superadminService.assignPermissionToRole(roleId, permissionId);

      // Create audit log
      await createAuditLog(
        admin.id,
        'PERMISSION_ASSIGN',
        req.ip,
        { role_id: roleId, permission_id: permissionId },
        'SUCCESS'
      );

      res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'PERMISSION_ASSIGN',
        req.ip,
        { role_id: req.params.roleId, permission_id: req.params.permissionId },
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  async removePermissionFromRole(req, res) {
    try {
      const { roleId, permissionId } = req.params;
      const { admin } = req;

      const result = await superadminService.removePermissionFromRole(roleId, permissionId);

      // Create audit log
      await createAuditLog(
        admin.id,
        'PERMISSION_REMOVE',
        req.ip,
        { role_id: roleId, permission_id: permissionId },
        'SUCCESS'
      );

      res.status(200).json({
        success: true,
        message: result.message
      });
    } catch (error) {
      // Create audit log for failure
      await createAuditLog(
        req.admin?.id,
        'PERMISSION_REMOVE',
        req.ip,
        { role_id: req.params.roleId, permission_id: req.params.permissionId },
        'FAILED',
        error.message
      );

      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  async getRolesWithPermissions(req, res) {
    try {
      const roles = await superadminService.getRolesWithPermissions();

      res.status(200).json({
        success: true,
        message: 'Roles retrieved successfully',
        data: roles
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  async getAllPermissions(req, res) {
    try {
      const permissions = await superadminService.getAllPermissions();

      res.status(200).json({
        success: true,
        message: 'Permissions retrieved successfully',
        data: permissions
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get permissions grouped for dropdown UI
  async getPermissionsForDropdown(req, res) {
    try {
      const groupedPermissions = await superadminService.getPermissionsForDropdown();

      res.status(200).json({
        success: true,
        message: 'Permissions for dropdown retrieved successfully',
        data: groupedPermissions
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
}

module.exports = new SuperadminController();
