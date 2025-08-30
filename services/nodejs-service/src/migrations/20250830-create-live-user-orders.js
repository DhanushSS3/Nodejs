'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('live_user_orders', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false
      },
      order_id: {
        type: Sequelize.STRING(64),
        allowNull: false,
        unique: true
      },
      order_user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'live_users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      order_company_name: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      order_type: {
        type: Sequelize.STRING(20),
        allowNull: false
      },
      order_status: {
        type: Sequelize.STRING(20),
        allowNull: false
      },
      order_price: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: false
      },
      order_quantity: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: false
      },
      contract_value: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      margin: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      stop_loss: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      take_profit: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      close_price: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      net_profit: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      swap: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      commission: {
        type: Sequelize.DECIMAL(18, 8),
        allowNull: true
      },
      cancel_message: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      close_message: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      cancel_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      close_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      modify_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      stoploss_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      takeprofit_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      stoploss_cancel_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      takeprofit_cancel_id: {
        type: Sequelize.STRING(64),
        allowNull: true,
        unique: true
      },
      status: {
        type: Sequelize.STRING(30),
        allowNull: true
      },
      placed_by: {
        type: Sequelize.STRING(30),
        allowNull: true
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
      }
    });

    // Add indexes for performance optimization
    await queryInterface.addIndex('live_user_orders', ['order_id']);
    await queryInterface.addIndex('live_user_orders', ['order_user_id']);
    await queryInterface.addIndex('live_user_orders', ['order_status']);
    await queryInterface.addIndex('live_user_orders', ['order_type']);
    await queryInterface.addIndex('live_user_orders', ['order_company_name']);
    await queryInterface.addIndex('live_user_orders', ['created_at']);
    await queryInterface.addIndex('live_user_orders', ['cancel_id']);
    await queryInterface.addIndex('live_user_orders', ['close_id']);
    await queryInterface.addIndex('live_user_orders', ['modify_id']);
    await queryInterface.addIndex('live_user_orders', ['stoploss_id']);
    await queryInterface.addIndex('live_user_orders', ['takeprofit_id']);
    await queryInterface.addIndex('live_user_orders', ['stoploss_cancel_id']);
    await queryInterface.addIndex('live_user_orders', ['takeprofit_cancel_id']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('live_user_orders');
  }
};
