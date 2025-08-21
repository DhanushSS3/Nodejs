const { Admin, Role, Permission, RolePermission } = require('../models');
const bcrypt = require('bcryptjs');
const adminAuthService = require('./admin.auth.service');

class SuperadminService {
  // Create a new admin (only superadmin can do this)
  async createAdmin(adminData, createdBy) {
    const { username, email, password, role_id, country_id } = adminData;

    // Validate role exists
    const role = await Role.findByPk(role_id);
    if (!role) {
      throw new Error('Invalid role specified');
    }

    // Validate country_id requirements based on role
    if (role.name === 'superadmin' && country_id !== null) {
      throw new Error('Superadmin cannot have a country assignment');
    }
    
    if ((role.name === 'admin' || role.name === 'accountant') && !country_id) {
      throw new Error(`${role.name} role requires a country assignment`);
    }

    // Check if admin already exists
    const existingAdmin = await Admin.findOne({
      where: {
        $or: [{ email }, { username }]
      }
    });

    if (existingAdmin) {
      throw new Error('Admin with this email or username already exists');
    }

    // Create the admin
    const newAdmin = await Admin.create({
      username,
      email,
      password, // Will be hashed by the model hook
      role_id,
      country_id: role.name === 'superadmin' ? null : country_id,
      is_active: true
    });

    // Invalidate permissions cache for the new admin
    await adminAuthService.invalidatePermissionsCache(newAdmin.id);

    return {
      id: newAdmin.id,
      username: newAdmin.username,
      email: newAdmin.email,
      role_id: newAdmin.role_id,
      country_id: newAdmin.country_id,
      is_active: newAdmin.is_active,
      created_at: newAdmin.created_at
    };
  }

  // Update admin details
  async updateAdmin(adminId, updateData, updatedBy) {
    const admin = await Admin.findByPk(adminId);
    if (!admin) {
      throw new Error('Admin not found');
    }

    const { username, email, role_id, country_id, is_active } = updateData;

    // If role is being changed, validate the new role
    if (role_id && role_id !== admin.role_id) {
      const role = await Role.findByPk(role_id);
      if (!role) {
        throw new Error('Invalid role specified');
      }

      // Validate country_id requirements for new role
      if (role.name === 'superadmin' && country_id !== null) {
        throw new Error('Superadmin cannot have a country assignment');
      }
      
      if ((role.name === 'admin' || role.name === 'accountant') && !country_id) {
        throw new Error(`${role.name} role requires a country assignment`);
      }
    }

    // Update admin
    await admin.update({
      username: username || admin.username,
      email: email || admin.email,
      role_id: role_id || admin.role_id,
      country_id: role_id ? (await Role.findByPk(role_id)).name === 'superadmin' ? null : country_id : admin.country_id,
      is_active: is_active !== undefined ? is_active : admin.is_active
    });

    // Invalidate permissions cache for the updated admin
    await adminAuthService.invalidatePermissionsCache(adminId);

    return admin;
  }

  // Assign specific permissions to an admin (beyond their role's default permissions)
  async assignPermissionToAdmin(adminId, permissionId) {
    // This would require a new AdminPermission model for individual permissions
    // For now, we'll focus on role-based permissions
    throw new Error('Individual permission assignment not implemented. Use role-based permissions.');
  }

  // Get all admins with their roles and permissions
  async getAllAdmins(filters = {}) {
    const { country_id, role_id, is_active } = filters;
    
    const whereClause = {};
    if (country_id !== undefined) whereClause.country_id = country_id;
    if (role_id) whereClause.role_id = role_id;
    if (is_active !== undefined) whereClause.is_active = is_active;

    const admins = await Admin.findAll({
      where: whereClause,
      include: {
        model: Role,
        include: {
          model: Permission,
          through: { attributes: [] }
        }
      },
      attributes: { exclude: ['password'] }
    });

    return admins;
  }

  // Deactivate admin account
  async deactivateAdmin(adminId, deactivatedBy) {
    const admin = await Admin.findByPk(adminId);
    if (!admin) {
      throw new Error('Admin not found');
    }

    await admin.update({ is_active: false });
    
    // Invalidate all tokens for this admin
    await adminAuthService.invalidatePermissionsCache(adminId);

    return admin;
  }

  // Reset admin password
  async resetAdminPassword(adminId, newPassword, resetBy) {
    const admin = await Admin.findByPk(adminId);
    if (!admin) {
      throw new Error('Admin not found');
    }

    await admin.update({ password: newPassword }); // Will be hashed by model hook
    
    // Invalidate all tokens for this admin
    await adminAuthService.invalidatePermissionsCache(adminId);

    return { message: 'Password reset successfully' };
  }

  // Role and Permission Management
  async createRole(roleData) {
    const { name, description, permission_ids = [] } = roleData;
    
    const existingRole = await Role.findOne({ where: { name } });
    if (existingRole) {
      throw new Error('Role with this name already exists');
    }

    // Validate permission IDs if provided
    if (permission_ids.length > 0) {
      const validPermissions = await Permission.findAll({
        where: { id: permission_ids }
      });
      
      if (validPermissions.length !== permission_ids.length) {
        const validIds = validPermissions.map(p => p.id);
        const invalidIds = permission_ids.filter(id => !validIds.includes(id));
        throw new Error(`Invalid permission IDs: ${invalidIds.join(', ')}`);
      }
    }

    // Create role and assign permissions atomically
    const role = await Role.create({ name, description });
    
    // Bulk assign permissions if provided
    if (permission_ids.length > 0) {
      const rolePermissions = permission_ids.map(permissionId => ({
        role_id: role.id,
        permission_id: permissionId
      }));
      
      await RolePermission.bulkCreate(rolePermissions);
    }
    
    // Invalidate all permissions caches since roles changed
    await adminAuthService.invalidatePermissionsCache();
    
    // Return role with permissions
    const roleWithPermissions = await Role.findByPk(role.id, {
      include: {
        model: Permission,
        through: { attributes: [] }
      }
    });
    
    return roleWithPermissions;
  }

  async createPermission(permissionData) {
    const { name, description } = permissionData;
    
    const existingPermission = await Permission.findOne({ where: { name } });
    if (existingPermission) {
      throw new Error('Permission with this name already exists');
    }

    const permission = await Permission.create({ name, description });
    
    return permission;
  }

  async assignPermissionToRole(roleId, permissionId) {
    const role = await Role.findByPk(roleId);
    const permission = await Permission.findByPk(permissionId);
    
    if (!role || !permission) {
      throw new Error('Role or Permission not found');
    }

    const existingAssignment = await RolePermission.findOne({
      where: { role_id: roleId, permission_id: permissionId }
    });

    if (existingAssignment) {
      throw new Error('Permission already assigned to this role');
    }

    await RolePermission.create({ role_id: roleId, permission_id: permissionId });
    
    // Invalidate all permissions caches since role permissions changed
    await adminAuthService.invalidatePermissionsCache();
    
    return { message: 'Permission assigned to role successfully' };
  }

  async removePermissionFromRole(roleId, permissionId) {
    const deleted = await RolePermission.destroy({
      where: { role_id: roleId, permission_id: permissionId }
    });

    if (!deleted) {
      throw new Error('Permission assignment not found');
    }

    // Invalidate all permissions caches since role permissions changed
    await adminAuthService.invalidatePermissionsCache();
    
    return { message: 'Permission removed from role successfully' };
  }

  async getRolesWithPermissions() {
    const roles = await Role.findAll({
      include: {
        model: Permission,
        through: { attributes: [] }
      }
    });

    return roles;
  }

  async getAllPermissions() {
    return await Permission.findAll();
  }

  // Get permissions grouped by category for dropdown UI
  async getPermissionsForDropdown() {
    const permissions = await Permission.findAll({
      order: [['name', 'ASC']]
    });

    // Group permissions by category (extract from permission name prefix)
    const grouped = permissions.reduce((acc, permission) => {
      const parts = permission.name.split(':');
      const category = parts.length > 1 ? parts[0] : 'general';
      const displayName = parts.length > 1 ? parts[1] : permission.name;
      
      if (!acc[category]) {
        acc[category] = [];
      }
      
      acc[category].push({
        id: permission.id,
        name: permission.name,
        displayName: displayName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
        description: permission.description
      });
      
      return acc;
    }, {});

    return grouped;
  }
}

module.exports = new SuperadminService();
