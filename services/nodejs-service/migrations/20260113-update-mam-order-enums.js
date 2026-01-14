'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('mam_orders', 'order_type', {
      type: Sequelize.ENUM('BUY', 'SELL', 'BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'),
      allowNull: false
    });

    await queryInterface.changeColumn('mam_orders', 'order_status', {
      type: Sequelize.ENUM('PENDING', 'PENDING-QUEUED', 'QUEUED', 'OPEN', 'MODIFY', 'CLOSED', 'REJECTED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'PENDING'
    });

    await queryInterface.changeColumn('mam_orders', 'requested_volume', {
      type: Sequelize.DECIMAL(18, 8),
      allowNull: false
    });

    await queryInterface.changeColumn('mam_orders', 'executed_volume', {
      type: Sequelize.DECIMAL(18, 8),
      allowNull: false,
      defaultValue: 0
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('mam_orders', 'order_type', {
      type: Sequelize.ENUM('buy', 'sell'),
      allowNull: false
    });

    await queryInterface.changeColumn('mam_orders', 'order_status', {
      type: Sequelize.ENUM('pending', 'open', 'closed', 'rejected', 'cancelled'),
      allowNull: false,
      defaultValue: 'pending'
    });

    await queryInterface.changeColumn('mam_orders', 'requested_volume', {
      type: Sequelize.DECIMAL(18, 8),
      allowNull: false
    });

    await queryInterface.changeColumn('mam_orders', 'executed_volume', {
      type: Sequelize.DECIMAL(18, 8),
      allowNull: false,
      defaultValue: 0
    });
  }
};
