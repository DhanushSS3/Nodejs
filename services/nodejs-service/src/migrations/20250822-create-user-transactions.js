'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('user_transactions', {
      id: {
        type: Sequelize.BIGINT,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false
      },
      transaction_id: {
        type: Sequelize.STRING(20),
        allowNull: false,
        unique: true,
        comment: 'Unique transaction ID with prefix (e.g., TXN1234567890)'
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        comment: 'Reference to user (live_users or demo_users)'
      },
      user_type: {
        type: Sequelize.ENUM('live', 'demo'),
        allowNull: false,
        comment: 'Type of user account'
      },
      order_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        comment: 'Reference to order if transaction is order-related'
      },
      type: {
        type: Sequelize.ENUM(
          'deposit',
          'withdraw', 
          'profit',
          'loss',
          'commission',
          'swap',
          'adjustment'
        ),
        allowNull: false,
        comment: 'Type of transaction'
      },
      amount: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: false,
        comment: 'Transaction amount (positive for credits, negative for debits)'
      },
      balance_before: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: false,
        comment: 'User balance before this transaction'
      },
      balance_after: {
        type: Sequelize.DECIMAL(18, 6),
        allowNull: false,
        comment: 'User balance after this transaction'
      },
      status: {
        type: Sequelize.ENUM('pending', 'completed', 'failed', 'cancelled'),
        allowNull: false,
        defaultValue: 'completed',
        comment: 'Transaction status'
      },
      reference_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'External reference ID (payment gateway, bank reference, etc.)'
      },
      admin_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        comment: 'Admin who approved/processed the transaction'
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Additional notes or description'
      },
      metadata: {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Additional flexible data (JSON format)'
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

    // Add indexes for performance
    await queryInterface.addIndex('user_transactions', ['user_id'], {
      name: 'idx_user_transactions_user_id'
    });

    await queryInterface.addIndex('user_transactions', ['user_type'], {
      name: 'idx_user_transactions_user_type'
    });

    await queryInterface.addIndex('user_transactions', ['type'], {
      name: 'idx_user_transactions_type'
    });

    await queryInterface.addIndex('user_transactions', ['status'], {
      name: 'idx_user_transactions_status'
    });

    await queryInterface.addIndex('user_transactions', ['created_at'], {
      name: 'idx_user_transactions_created_at'
    });

    await queryInterface.addIndex('user_transactions', ['transaction_id'], {
      name: 'idx_user_transactions_transaction_id'
    });

    await queryInterface.addIndex('user_transactions', ['order_id'], {
      name: 'idx_user_transactions_order_id'
    });

    await queryInterface.addIndex('user_transactions', ['user_type', 'user_id'], {
      name: 'idx_user_transactions_user_type_user_id'
    });

    await queryInterface.addIndex('user_transactions', ['user_id', 'created_at'], {
      name: 'idx_user_transactions_user_created'
    });

    // Add unique constraint for transaction_id
    await queryInterface.addConstraint('user_transactions', {
      fields: ['transaction_id'],
      type: 'unique',
      name: 'idx_user_transactions_transaction_id_unique'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('user_transactions');
  }
};
