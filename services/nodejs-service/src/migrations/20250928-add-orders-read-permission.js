'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Insert the new permission for reading user orders
    await queryInterface.bulkInsert('permissions', [
      {
        name: 'orders:read',
        description: 'Permission to read and view user orders in admin panel',
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);

    // Get the superadmin role (assuming it exists with name 'superadmin')
    const [superadminRole] = await queryInterface.sequelize.query(
      "SELECT id FROM roles WHERE name = 'superadmin' LIMIT 1",
      { type: Sequelize.QueryTypes.SELECT }
    );

    // Get the new permission
    const [ordersReadPermission] = await queryInterface.sequelize.query(
      "SELECT id FROM permissions WHERE name = 'orders:read' LIMIT 1",
      { type: Sequelize.QueryTypes.SELECT }
    );

    // Assign the new permission to superadmin role if both exist
    if (superadminRole && ordersReadPermission) {
      await queryInterface.bulkInsert('role_permissions', [
        {
          role_id: superadminRole.id,
          permission_id: ordersReadPermission.id,
          created_at: new Date(),
          updated_at: new Date()
        }
      ]);
    }
  },

  down: async (queryInterface, Sequelize) => {
    // Remove the role_permission association first
    await queryInterface.sequelize.query(
      "DELETE rp FROM role_permissions rp " +
      "INNER JOIN permissions p ON rp.permission_id = p.id " +
      "WHERE p.name = 'orders:read'"
    );

    // Remove the permission
    await queryInterface.bulkDelete('permissions', {
      name: 'orders:read'
    });
  }
};
