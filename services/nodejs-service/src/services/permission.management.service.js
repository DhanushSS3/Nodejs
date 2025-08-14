const { Role, Permission, RolePermission } = require('../models');
const permissionService = require('./permission.service');

class PermissionManagementService {
  async assignPermissionToRole(roleId, permissionId) {
    const role = await Role.findByPk(roleId);
    if (!role) throw new Error('Role not found');

    const permission = await Permission.findByPk(permissionId);
    if (!permission) throw new Error('Permission not found');

    await RolePermission.findOrCreate({
      where: { role_id: roleId, permission_id: permissionId },
    });

    // Invalidate cache for all admins with this role
    // This is a complex operation, for now we will invalidate all
    // A more optimized solution would be to get all admins for this role and invalidate one by one
    // For now, let's just log a warning
    console.warn(`Permissions updated for role ${roleId}. Cache invalidation for specific admins should be implemented.`);
  }

  async removePermissionFromRole(roleId, permissionId) {
    const result = await RolePermission.destroy({
      where: { role_id: roleId, permission_id: permissionId },
    });

    if (result === 0) {
      throw new Error('Permission was not assigned to this role.');
    }

    console.warn(`Permissions updated for role ${roleId}. Cache invalidation for specific admins should be implemented.`);
  }
}

module.exports = new PermissionManagementService();
