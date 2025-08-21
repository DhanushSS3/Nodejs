const { Admin, Role } = require('../models');

class AdminManagementService {
  async createAdmin(adminData) {
    const { email, username, password, role_id, country_id } = adminData;

    // Ensure the role exists and is not 'superadmin'
    const role = await Role.findByPk(role_id);
    if (!role) {
      throw new Error('Invalid role ID');
    }
    if (role.name === 'superadmin') {
      throw new Error('Cannot create another superadmin');
    }

    // For non-superadmin roles, country_id is required
    if (role.name !== 'superadmin' && !country_id) {
      throw new Error('Country ID is required for this role');
    }

    const newAdmin = await Admin.create({
      email,
      username,
      password,
      role_id,
      country_id: role.name === 'superadmin' ? null : country_id, // Ensure superadmin has null country
      is_active: true,
    });

    // Exclude password from the returned object
    const adminObject = newAdmin.get({ plain: true });
    delete adminObject.password;

    return adminObject;
  }

  async listAdmins() {
    const admins = await Admin.findAll({
      attributes: { exclude: ['password'] }, // Exclude password from the result
      include: {
        model: Role,
        as: 'role', // Must match the alias in the association
        attributes: ['id', 'name'], // Only include role's id and name
      },
      order: [['created_at', 'DESC']],
    });
    return admins;
  }

  async getAdminById(adminId) {
    const admin = await Admin.findByPk(adminId, {
      attributes: { exclude: ['password'] },
      include: {
        model: Role,
        as: 'role', // Must match the alias in the association
        attributes: ['id', 'name'],
      },
    });

    if (!admin) {
      throw new Error('Admin not found');
    }

    return admin;
  }

  async updateAdmin(adminId, updateData) {
    const admin = await Admin.findByPk(adminId);
    if (!admin) {
      throw new Error('Admin not found');
    }

    // Security check: Prevent modification of the original superadmin (assuming ID 1)
    if (admin.id === 1) {
        throw new Error('The primary superadmin account cannot be modified.');
    }

    const { email, username, password, role_id, country_id, is_active } = updateData;

    // Prevent promotion to superadmin
    if (role_id) {
        const targetRole = await Role.findByPk(role_id);
        if (targetRole && targetRole.name === 'superadmin') {
            throw new Error('Cannot promote an admin to superadmin.');
        }
        admin.role_id = role_id;
    }

    if (email) admin.email = email;
    if (username) admin.username = username;
    if (password) admin.password = password; // Hook will hash it
    if (country_id !== undefined) admin.country_id = country_id;
    if (is_active !== undefined) admin.is_active = is_active;

    await admin.save();

    const updatedAdmin = admin.get({ plain: true });
    delete updatedAdmin.password;

    return updatedAdmin;
  }

  async deleteAdmin(adminId) {
    const admin = await Admin.findByPk(adminId);
    if (!admin) {
      throw new Error('Admin not found');
    }

    // Critical security check: Prevent deletion of the primary superadmin
    if (admin.id === 1) {
      throw new Error('The primary superadmin account cannot be deleted.');
    }

    await admin.destroy();
  }
}

module.exports = new AdminManagementService();
