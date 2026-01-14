'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Remove legacy columns no longer used in the model
    await queryInterface.removeColumn('mam_accounts', 'leverage');
    await queryInterface.removeColumn('mam_accounts', 'total_allocated_balance');

    // Add mam_balance to track manager wallet for fees/credits
    await queryInterface.addColumn('mam_accounts', 'mam_balance', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('mam_accounts', 'mam_balance');

    await queryInterface.addColumn('mam_accounts', 'total_allocated_balance', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0
    });

    await queryInterface.addColumn('mam_accounts', 'leverage', {
      type: Sequelize.INTEGER,
      allowNull: true
    });
  }
};
