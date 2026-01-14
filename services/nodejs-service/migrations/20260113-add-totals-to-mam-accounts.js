'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('mam_accounts', 'total_balance', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0
    });

    await queryInterface.addColumn('mam_accounts', 'total_used_margin', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('mam_accounts', 'total_used_margin');
    await queryInterface.removeColumn('mam_accounts', 'total_balance');
  }
};
