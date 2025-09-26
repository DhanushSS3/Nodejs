'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('order_rejections', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      canonical_order_id: {
        type: Sequelize.STRING(255),
        allowNull: false,
        comment: 'Internal canonical order ID'
      },
      provider_order_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Provider order ID from execution report'
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        comment: 'User ID who owns the order'
      },
      user_type: {
        type: Sequelize.ENUM('live', 'demo'),
        allowNull: false,
        comment: 'Type of user account'
      },
      symbol: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'Trading symbol (e.g., EURUSD)'
      },
      rejection_type: {
        type: Sequelize.ENUM(
          'ORDER_PLACEMENT',      // Order placement rejected (status=OPEN)
          'ORDER_CLOSE',          // Order close rejected (status=CLOSED)
          'PENDING_PLACEMENT',    // Pending order placement rejected (status=PENDING)
          'PENDING_MODIFY',       // Pending order modify rejected (status=MODIFY)
          'PENDING_CANCEL',       // Pending order cancel rejected (status=CANCELLED)
          'STOPLOSS_ADD',         // Stop loss adding rejected (status=STOPLOSS)
          'STOPLOSS_REMOVE',      // Stop loss removal rejected (status=STOPLOSS-CANCEL)
          'TAKEPROFIT_ADD',       // Take profit adding rejected (status=TAKEPROFIT)
          'TAKEPROFIT_REMOVE'     // Take profit removal rejected (status=TAKEPROFIT-CANCEL)
        ),
        allowNull: false,
        comment: 'Type of operation that was rejected'
      },
      redis_status: {
        type: Sequelize.STRING(50),
        allowNull: false,
        comment: 'Redis status field when rejection occurred'
      },
      provider_ord_status: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Provider ord_status from execution report'
      },
      reason: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Rejection reason from provider'
      },
      provider_exec_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Provider execution ID'
      },
      provider_raw_data: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Raw provider execution report data'
      },
      order_type: {
        type: Sequelize.STRING(20),
        allowNull: true,
        comment: 'Order type (BUY, SELL, etc.)'
      },
      order_price: {
        type: Sequelize.DECIMAL(15, 5),
        allowNull: true,
        comment: 'Order price when rejected'
      },
      order_quantity: {
        type: Sequelize.DECIMAL(15, 5),
        allowNull: true,
        comment: 'Order quantity when rejected'
      },
      margin_released: {
        type: Sequelize.DECIMAL(15, 2),
        allowNull: true,
        comment: 'Margin amount released due to rejection'
      },
      created_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updated_at: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP')
      }
    });

    // Add indexes for performance
    await queryInterface.addIndex('order_rejections', ['canonical_order_id'], {
      name: 'idx_order_rejections_canonical_id'
    });

    await queryInterface.addIndex('order_rejections', ['user_id', 'user_type'], {
      name: 'idx_order_rejections_user'
    });

    await queryInterface.addIndex('order_rejections', ['symbol'], {
      name: 'idx_order_rejections_symbol'
    });

    await queryInterface.addIndex('order_rejections', ['rejection_type'], {
      name: 'idx_order_rejections_type'
    });

    await queryInterface.addIndex('order_rejections', ['created_at'], {
      name: 'idx_order_rejections_created_at'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('order_rejections');
  }
};
