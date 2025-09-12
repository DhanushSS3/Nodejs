'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Live users
    await queryInterface.changeColumn('live_users', 'wallet_balance', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.changeColumn('live_users', 'margin', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.changeColumn('live_users', 'net_profit', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0,
    });

    // Demo users
    await queryInterface.changeColumn('demo_users', 'wallet_balance', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.changeColumn('demo_users', 'margin', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.changeColumn('demo_users', 'net_profit', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: false,
      defaultValue: 0,
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('live_users', 'wallet_balance', {
      type: Sequelize.DECIMAL(10, 0),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.changeColumn('live_users', 'margin', {
      type: Sequelize.DECIMAL(10, 0),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.changeColumn('live_users', 'net_profit', {
      type: Sequelize.DECIMAL(10, 0),
      allowNull: false,
      defaultValue: 0,
    });

    await queryInterface.changeColumn('demo_users', 'wallet_balance', {
      type: Sequelize.DECIMAL(10, 0),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.changeColumn('demo_users', 'margin', {
      type: Sequelize.DECIMAL(10, 0),
      allowNull: false,
      defaultValue: 0,
    });
    await queryInterface.changeColumn('demo_users', 'net_profit', {
      type: Sequelize.DECIMAL(10, 0),
      allowNull: false,
      defaultValue: 0,
    });
  }
};
