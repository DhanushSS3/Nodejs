'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('groups', 'swap_type', {
      type: Sequelize.STRING(50),
      allowNull: true,
      after: 'profit' // Add after profit column
    });

    await queryInterface.addColumn('groups', 'bonus', {
      type: Sequelize.DECIMAL(10, 4),
      allowNull: true,
      after: 'swap_type' // Add after swap_type column
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('groups', 'bonus');
    await queryInterface.removeColumn('groups', 'swap_type');
  }
};
