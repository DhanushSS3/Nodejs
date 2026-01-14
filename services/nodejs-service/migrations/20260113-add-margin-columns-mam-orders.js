'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('mam_orders', 'margin', {
      type: Sequelize.DECIMAL(18, 8),
      allowNull: true
    });

    await queryInterface.addColumn('mam_orders', 'total_aggregated_margin', {
      type: Sequelize.DECIMAL(18, 8),
      allowNull: true
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('mam_orders', 'total_aggregated_margin');
    await queryInterface.removeColumn('mam_orders', 'margin');
  }
};
