/* eslint-disable no-unused-vars */
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('mam_assignments', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true
      },
      mam_account_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'mam_accounts',
          key: 'id'
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      client_live_user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: {
          model: 'live_users',
          key: 'id'
        },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE'
      },
      initiated_by: {
        type: Sequelize.ENUM('admin', 'client'),
        allowNull: false
      },
      initiated_by_admin_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: {
          model: 'admins',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      },
      initiated_reason: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      status: {
        type: Sequelize.ENUM(
          'pending_client_accept',
          'active',
          'rejected',
          'cancelled',
          'unsubscribed',
          'suspended'
        ),
        allowNull: false,
        defaultValue: 'pending_client_accept'
      },
      eligibility_fail_reason: {
        type: Sequelize.STRING(64),
        allowNull: true
      },
      accepted_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      accepted_ip: {
        type: Sequelize.STRING(64),
        allowNull: true
      },
      activated_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      deactivated_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      unsubscribe_reason: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      unsubscribed_by: {
        type: Sequelize.ENUM('client', 'admin', 'system'),
        allowNull: true
      },
      metadata: {
        type: Sequelize.JSON,
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
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('mam_assignments', ['mam_account_id', 'status']);
    await queryInterface.addIndex('mam_assignments', ['client_live_user_id', 'status']);
    await queryInterface.addIndex('mam_assignments', ['status']);
    await queryInterface.addIndex('mam_assignments', ['initiated_by']);
    await queryInterface.addConstraint('mam_assignments', {
      fields: ['mam_account_id', 'client_live_user_id', 'status'],
      type: 'unique',
      name: 'uniq_assignment_per_status'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeConstraint('mam_assignments', 'uniq_assignment_per_status');
    await queryInterface.removeIndex('mam_assignments', ['initiated_by']);
    await queryInterface.removeIndex('mam_assignments', ['status']);
    await queryInterface.removeIndex('mam_assignments', ['client_live_user_id', 'status']);
    await queryInterface.removeIndex('mam_assignments', ['mam_account_id', 'status']);
    await queryInterface.dropTable('mam_assignments');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_mam_assignments_status";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_mam_assignments_initiated_by";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_mam_assignments_unsubscribed_by";');
  }
};
