'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Update live_users table defaults
    await queryInterface.changeColumn('live_users', 'leverage', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: 100
    });

    await queryInterface.changeColumn('live_users', 'sending_orders', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: 'barclays'
    });

    // Update demo_users table defaults
    await queryInterface.changeColumn('demo_users', 'wallet_balance', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: true,
      defaultValue: 10000
    });

    await queryInterface.changeColumn('demo_users', 'leverage', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: 100
    });

    // Update existing live users with null leverage to default value
    await queryInterface.sequelize.query(`
      UPDATE live_users 
      SET leverage = 100 
      WHERE leverage IS NULL
    `);

    // Update existing live users with null sending_orders to default value
    await queryInterface.sequelize.query(`
      UPDATE live_users 
      SET sending_orders = 'barclays' 
      WHERE sending_orders IS NULL OR sending_orders = ''
    `);

    // Update existing demo users with zero wallet_balance to default value
    await queryInterface.sequelize.query(`
      UPDATE demo_users 
      SET wallet_balance = 10000 
      WHERE wallet_balance = 0 OR wallet_balance IS NULL
    `);

    // Update existing demo users with null leverage to default value
    await queryInterface.sequelize.query(`
      UPDATE demo_users 
      SET leverage = 100 
      WHERE leverage IS NULL
    `);
  },

  async down(queryInterface, Sequelize) {
    // Revert live_users table defaults
    await queryInterface.changeColumn('live_users', 'leverage', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null
    });

    await queryInterface.changeColumn('live_users', 'sending_orders', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null
    });

    // Revert demo_users table defaults
    await queryInterface.changeColumn('demo_users', 'wallet_balance', {
      type: Sequelize.DECIMAL(18, 6),
      allowNull: true,
      defaultValue: 0
    });

    await queryInterface.changeColumn('demo_users', 'leverage', {
      type: Sequelize.INTEGER,
      allowNull: true,
      defaultValue: null
    });
  }
};
