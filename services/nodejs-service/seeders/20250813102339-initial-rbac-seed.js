'use strict';
const bcrypt = require('bcryptjs');

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // 1. Seed Roles
      const roles = [
        { name: 'superadmin', description: 'Full global access.', created_at: new Date(), updated_at: new Date() },
        { name: 'admin', description: 'Limited access based on country.', created_at: new Date(), updated_at: new Date() },
        { name: 'accountant', description: 'Read-only financial access.', created_at: new Date(), updated_at: new Date() },
      ];
      await queryInterface.bulkInsert('roles', roles, { transaction });

      // 2. Seed Permissions
      const permissions = [
        { name: 'admin:create', description: 'Can create new admins', created_at: new Date(), updated_at: new Date() },
        { name: 'admin:assign_roles', description: 'Can assign roles to admins', created_at: new Date(), updated_at: new Date() },
        { name: 'admin:manage_permissions', description: 'Can manage role permissions', created_at: new Date(), updated_at: new Date() },
        { name: 'user:create', description: 'Can create new users', created_at: new Date(), updated_at: new Date() },
        { name: 'user:update', description: 'Can update existing users', created_at: new Date(), updated_at: new Date() },
        { name: 'user:view', description: 'Can view user details', created_at: new Date(), updated_at: new Date() },
        { name: 'order:place', description: 'Can place new orders', created_at: new Date(), updated_at: new Date() },
        { name: 'order:close', description: 'Can close existing orders', created_at: new Date(), updated_at: new Date() },
        { name: 'order:cancel_pending', description: 'Can cancel pending orders', created_at: new Date(), updated_at: new Date() },
        { name: 'order:update_sl_tp', description: 'Can add/remove SL/TP from orders', created_at: new Date(), updated_at: new Date() },
        { name: 'order:view', description: 'Can view all orders', created_at: new Date(), updated_at: new Date() },
        { name: 'money_request:approve', description: 'Can approve money requests', created_at: new Date(), updated_at: new Date() },
        { name: 'transaction:view', description: 'Can view financial transactions', created_at: new Date(), updated_at: new Date() },
        { name: 'report:view_financial', description: 'Can view financial reports', created_at: new Date(), updated_at: new Date() },
        { name: 'group:manage', description: 'Can create and update groups', created_at: new Date(), updated_at: new Date() },
      ];
      await queryInterface.bulkInsert('permissions', permissions, { transaction });

      const insertedRoles = await queryInterface.sequelize.query('SELECT id, name FROM roles', { type: Sequelize.QueryTypes.SELECT, transaction });
      const insertedPermissions = await queryInterface.sequelize.query('SELECT id, name FROM permissions', { type: Sequelize.QueryTypes.SELECT, transaction });

      const roleMap = insertedRoles.reduce((acc, role) => ({ ...acc, [role.name]: role.id }), {});
      const permissionMap = insertedPermissions.reduce((acc, perm) => ({ ...acc, [perm.name]: perm.id }), {});

      // 3. Map Permissions to Roles
      const superAdminPermissions = insertedPermissions.map(p => p.id);
      const adminPermissions = [
        'user:create', 'user:update', 'user:view',
        'order:place', 'order:close', 'order:cancel_pending', 'order:update_sl_tp', 'order:view',
        'money_request:approve', 'transaction:view', 'report:view_financial',
        'group:manage'
      ].map(pName => permissionMap[pName]);
      const accountantPermissions = ['transaction:view', 'order:view', 'report:view_financial'].map(pName => permissionMap[pName]);

      const rolePermissions = [
        ...superAdminPermissions.map(pid => ({ role_id: roleMap.superadmin, permission_id: pid })),
        ...adminPermissions.map(pid => ({ role_id: roleMap.admin, permission_id: pid })),
        ...accountantPermissions.map(pid => ({ role_id: roleMap.accountant, permission_id: pid }))
      ];
      await queryInterface.bulkInsert('role_permissions', rolePermissions, { transaction });

      // 4. Create Superadmin User
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash('Password@123', salt);
      await queryInterface.bulkInsert('admins', [{
        username: 'superadmin',
        email: 'superadmin@example.com',
        password: hashedPassword,
        role_id: roleMap.superadmin,
        country_id: null,
        is_active: true,
        created_at: new Date(),
        updated_at: new Date(),
      }], { transaction });

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      console.error('Seeding failed:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.bulkDelete('admins', null, { transaction });
      await queryInterface.bulkDelete('role_permissions', null, { transaction });
      await queryInterface.bulkDelete('permissions', null, { transaction });
      await queryInterface.bulkDelete('roles', null, { transaction });
      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      console.error('Reverting seed failed:', error);
      throw error;
    }
  },
};
