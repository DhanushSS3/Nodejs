const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Admin = require('./admin.model');

const AdminAuditLog = sequelize.define('AdminAuditLog', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true,
  },
  admin_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: Admin,
      key: 'id',
    },
  },
  action: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'The action performed (e.g., USER_CREATE, ORDER_CLOSE)',
  },
  ip_address: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  request_body: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'The request body associated with the action',
  },
  status: {
    type: DataTypes.STRING,
    allowNull: false,
    comment: 'Status of the action (e.g., SUCCESS, FAILED)',
  },
  error_message: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'admin_audit_logs',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false, // Audit logs are immutable
});

AdminAuditLog.belongsTo(Admin, { foreignKey: 'admin_id' });

module.exports = AdminAuditLog;
