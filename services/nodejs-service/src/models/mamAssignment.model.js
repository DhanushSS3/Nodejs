const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const {
  ASSIGNMENT_STATUS,
  ASSIGNMENT_INITIATORS,
  ASSIGNMENT_UNSUBSCRIBE_ACTORS
} = require('../constants/mamAssignment.constants');

const assignmentStatuses = Object.values(ASSIGNMENT_STATUS);
const initiators = Object.values(ASSIGNMENT_INITIATORS);
const unsubscribeActors = Object.values(ASSIGNMENT_UNSUBSCRIBE_ACTORS);
const rejectionActors = ['client', 'admin'];

const MAMAssignment = sequelize.define('MAMAssignment', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  mam_account_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'mam_accounts',
      key: 'id'
    },
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  },
  client_live_user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'live_users',
      key: 'id'
    },
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE'
  },
  initiated_by: {
    type: DataTypes.ENUM(...initiators),
    allowNull: false
  },
  initiated_by_admin_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'admins',
      key: 'id'
    },
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE'
  },
  initiated_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  admin_reviewed_by_admin_id: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'admins',
      key: 'id'
    },
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE'
  },
  admin_reviewed_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  admin_review_notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  status: {
    type: DataTypes.ENUM(...assignmentStatuses),
    allowNull: false,
    defaultValue: ASSIGNMENT_STATUS.CLIENT_REQUESTED
  },
  eligibility_fail_reason: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  rejected_by: {
    type: DataTypes.ENUM(...rejectionActors),
    allowNull: true
  },
  rejected_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  rejected_ip: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  rejected_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  accepted_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  accepted_ip: {
    type: DataTypes.STRING(64),
    allowNull: true
  },
  activated_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  deactivated_at: {
    type: DataTypes.DATE,
    allowNull: true
  },
  unsubscribe_reason: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  unsubscribed_by: {
    type: DataTypes.ENUM(...unsubscribeActors),
    allowNull: true
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'mam_assignments',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['mam_account_id', 'status'] },
    { fields: ['client_live_user_id', 'status'] },
    { fields: ['status'] },
    {
      unique: true,
      fields: ['mam_account_id', 'client_live_user_id', 'status'],
      name: 'uniq_assignment_per_status'
    }
  ]
});

module.exports = MAMAssignment;
