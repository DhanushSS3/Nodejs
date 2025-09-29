'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Insert new permissions for admin order management
    await queryInterface.bulkInsert('permissions', [
      {
        name: 'orders:manage',
        description: 'Permission to manage user orders (place, close, modify)',
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        name: 'orders:place',
        description: 'Permission to place orders on behalf of users',
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        name: 'orders:close',
        description: 'Permission to close user orders',
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        name: 'orders:modify',
        description: 'Permission to modify pending orders',
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        name: 'orders:stoploss',
        description: 'Permission to manage stop loss orders',
        created_at: new Date(),
        updated_at: new Date()
      },
      {
        name: 'orders:takeprofit',
        description: 'Permission to manage take profit orders',
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);

    // Get the superadmin role (assuming it exists with name 'superadmin')
    const [superadminRole] = await queryInterface.sequelize.query(
      "SELECT id FROM roles WHERE name = 'superadmin' LIMIT 1",
      { type: Sequelize.QueryTypes.SELECT }
    );

    // Get all the new permissions
    const newPermissions = await queryInterface.sequelize.query(
      "SELECT id, name FROM permissions WHERE name IN ('orders:manage', 'orders:place', 'orders:close', 'orders:modify', 'orders:stoploss', 'orders:takeprofit')",
      { type: Sequelize.QueryTypes.SELECT }
    );

    // Assign all new permissions to superadmin role if both exist
    if (superadminRole && newPermissions.length > 0) {
      const rolePermissions = newPermissions.map(permission => ({
        role_id: superadminRole.id,
        permission_id: permission.id,
        created_at: new Date(),
        updated_at: new Date()
      }));

      await queryInterface.bulkInsert('role_permissions', rolePermissions);
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Remove the role_permission associations first
    await queryInterface.sequelize.query(
      "DELETE rp FROM role_permissions rp " +
      "INNER JOIN permissions p ON rp.permission_id = p.id " +
      "WHERE p.name IN ('orders:manage', 'orders:place', 'orders:close', 'orders:modify', 'orders:stoploss', 'orders:takeprofit')"
    );

    // Remove the permissions
    await queryInterface.bulkDelete('permissions', {
      name: {
        [Sequelize.Op.in]: ['orders:manage', 'orders:place', 'orders:close', 'orders:modify', 'orders:stoploss', 'orders:takeprofit']
      }
    });
  }
};
