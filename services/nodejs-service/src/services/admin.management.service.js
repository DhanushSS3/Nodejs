const { Admin, Role, Permission, RolePermission, Country } = require('../models');
const { Op } = require('sequelize');
const bcrypt = require('bcryptjs');
const logger = require('./logger.service');

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
      attributes: { exclude: [] }, // Include all fields including password
      include: [
        {
          model: Role,
          as: 'role',
          attributes: ['name'],
        },
        {
          model: Country,
          as: 'country',
          attributes: ['name'],
          required: false
        }
      ],
      order: [['created_at', 'DESC']],
    });

    // Format the response to replace IDs with names
    return admins.map(admin => {
      const adminData = admin.get({ plain: true });
      
      // Replace role_id with role_name
      adminData.role_name = adminData.role ? adminData.role.name : null;
      delete adminData.role_id;
      delete adminData.role;
      
      // Replace country_id with country_name
      adminData.country_name = adminData.country ? adminData.country.name : null;
      delete adminData.country_id;
      delete adminData.country;
      
      return adminData;
    });
  }

  async getAdminById(adminId) {
    const admin = await Admin.findByPk(adminId, {
      attributes: { exclude: [] }, // Include all fields including password
      include: [
        {
          model: Role,
          as: 'role',
          attributes: ['name'],
        },
        {
          model: Country,
          as: 'country',
          attributes: ['name'],
          required: false
        }
      ],
    });

    if (!admin) {
      throw new Error('Admin not found');
    }

    // Format the response to replace IDs with names
    const adminData = admin.get({ plain: true });
    
    // Replace role_id with role_name
    adminData.role_name = adminData.role ? adminData.role.name : null;
    delete adminData.role_id;
    delete adminData.role;
    
    // Replace country_id with country_name
    adminData.country_name = adminData.country ? adminData.country.name : null;
    delete adminData.country_id;
    delete adminData.country;
    
    return adminData;
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

  /**
   * Get dropdown data for admin creation/editing forms
   * Returns countries and roles with their IDs and names in a single API call
   */
  async getDropdownData() {
    try {
      // Get all countries
      const countries = await Country.findAll({
        attributes: ['id', 'name', 'iso_code'],
        order: [['name', 'ASC']]
      });

      // Get all roles except superadmin (since only superadmin can create other admins)
      const roles = await Role.findAll({
        attributes: ['id', 'name', 'description'],
        where: {
          name: { [Op.ne]: 'superadmin' }
        },
        order: [['name', 'ASC']]
      });

      // Format countries for dropdown
      const formattedCountries = countries.map(country => ({
        id: country.id,
        name: country.name,
        iso_code: country.iso_code,
        display_name: country.iso_code ? `${country.name} (${country.iso_code})` : country.name
      }));

      // Format roles for dropdown
      const formattedRoles = roles.map(role => ({
        id: role.id,
        name: role.name,
        description: role.description,
        display_name: role.name.charAt(0).toUpperCase() + role.name.slice(1),
        requires_country: role.name !== 'superadmin' // All roles except superadmin require country
      }));

      return {
        countries: formattedCountries,
        roles: formattedRoles,
        metadata: {
          total_countries: formattedCountries.length,
          total_roles: formattedRoles.length,
          generated_at: new Date().toISOString()
        }
      };
    } catch (error) {
      logger.error('Error fetching dropdown data:', error);
      throw new Error('Failed to fetch dropdown data');
    }
  }

  /**
   * Get countries only (for specific use cases)
   */
  async getCountriesDropdown() {
    try {
      const countries = await Country.findAll({
        attributes: ['id', 'name', 'iso_code'],
        order: [['name', 'ASC']]
      });

      return countries.map(country => ({
        id: country.id,
        name: country.name,
        iso_code: country.iso_code,
        display_name: country.iso_code ? `${country.name} (${country.iso_code})` : country.name
      }));
    } catch (error) {
      logger.error('Error fetching countries dropdown:', error);
      throw new Error('Failed to fetch countries');
    }
  }

  /**
   * Get roles only (for specific use cases)
   */
  async getRolesDropdown() {
    try {
      const roles = await Role.findAll({
        attributes: ['id', 'name', 'description'],
        where: {
          name: { [Op.ne]: 'superadmin' }
        },
        order: [['name', 'ASC']]
      });

      return roles.map(role => ({
        id: role.id,
        name: role.name,
        description: role.description,
        display_name: role.name.charAt(0).toUpperCase() + role.name.slice(1),
        requires_country: role.name !== 'superadmin'
      }));
    } catch (error) {
      logger.error('Error fetching roles dropdown:', error);
      throw new Error('Failed to fetch roles');
    }
  }
}

module.exports = new AdminManagementService();
