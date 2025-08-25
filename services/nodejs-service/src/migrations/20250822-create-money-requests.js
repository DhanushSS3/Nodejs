'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('money_requests', {
      id: {
        type: Sequelize.BIGINT,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
        comment: 'Primary key'
      },
      request_id: {
        type: Sequelize.STRING(20),
        allowNull: false,
        unique: true,
        comment: 'External reference ID (e.g. REQ20250001)'
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        comment: 'Reference to live_users.id'
      },
      type: {
        type: Sequelize.ENUM('deposit', 'withdraw'),
        allowNull: false,
        comment: 'Request type'
      },
      amount: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: false,
        comment: 'Requested amount'
      },
      currency: {
        type: Sequelize.STRING(10),
        allowNull: false,
        defaultValue: 'USD',
        comment: 'Currency code (expandable for future)'
      },
      status: {
        type: Sequelize.ENUM('pending', 'approved', 'rejected'),
        allowNull: false,
        defaultValue: 'pending',
        comment: 'Review state'
      },
      admin_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        comment: 'Admin who handled the request'
      },
      approved_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'When the request was approved/rejected'
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Admin remarks or additional information'
      },
      transaction_id: {
        type: Sequelize.STRING(20),
        allowNull: true,
        comment: 'Link to user_transactions.transaction_id if approved'
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: 'Record creation timestamp'
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP'),
        onUpdate: Sequelize.literal('CURRENT_TIMESTAMP'),
        comment: 'Record last update timestamp'
      }
    });

    // Add indexes for performance
    await queryInterface.addIndex('money_requests', ['request_id'], {
      name: 'idx_money_requests_request_id',
      unique: true
    });

    await queryInterface.addIndex('money_requests', ['user_id'], {
      name: 'idx_money_requests_user_id'
    });

    await queryInterface.addIndex('money_requests', ['status'], {
      name: 'idx_money_requests_status'
    });

    await queryInterface.addIndex('money_requests', ['type'], {
      name: 'idx_money_requests_type'
    });

    await queryInterface.addIndex('money_requests', ['admin_id'], {
      name: 'idx_money_requests_admin_id'
    });

    await queryInterface.addIndex('money_requests', ['transaction_id'], {
      name: 'idx_money_requests_transaction_id'
    });

    await queryInterface.addIndex('money_requests', ['created_at'], {
      name: 'idx_money_requests_created_at'
    });

    await queryInterface.addIndex('money_requests', ['user_id', 'status'], {
      name: 'idx_money_requests_user_status'
    });

    await queryInterface.addIndex('money_requests', ['status', 'created_at'], {
      name: 'idx_money_requests_status_created'
    });

    // Add foreign key constraints (assuming tables exist)
    await queryInterface.addConstraint('money_requests', {
      fields: ['user_id'],
      type: 'foreign key',
      name: 'fk_money_requests_user_id',
      references: {
        table: 'live_users',
        field: 'id'
      },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE'
    });

    await queryInterface.addConstraint('money_requests', {
      fields: ['admin_id'],
      type: 'foreign key',
      name: 'fk_money_requests_admin_id',
      references: {
        table: 'admins',
        field: 'id'
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    });
  },

  async down(queryInterface, Sequelize) {
    // Drop foreign key constraints first
    await queryInterface.removeConstraint('money_requests', 'fk_money_requests_admin_id');
    await queryInterface.removeConstraint('money_requests', 'fk_money_requests_user_id');
    
    // Drop indexes
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_status_created');
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_user_status');
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_created_at');
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_transaction_id');
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_admin_id');
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_type');
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_status');
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_user_id');
    await queryInterface.removeIndex('money_requests', 'idx_money_requests_request_id');
    
    // Drop table
    await queryInterface.dropTable('money_requests');
  }
};
