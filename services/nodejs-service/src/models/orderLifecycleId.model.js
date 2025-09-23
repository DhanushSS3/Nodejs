const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const OrderLifecycleId = sequelize.define('OrderLifecycleId', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true
  },
  order_id: {
    type: DataTypes.STRING(64),
    allowNull: false,
    comment: 'Reference to the main order_id'
  },
  id_type: {
    type: DataTypes.ENUM(
      'order_id',
      'close_id',
      'cancel_id',
      'modify_id',
      'stoploss_id',
      'takeprofit_id',
      'stoploss_cancel_id',
      'takeprofit_cancel_id'
    ),
    allowNull: false,
    comment: 'Type of lifecycle ID'
  },
  lifecycle_id: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    comment: 'The actual generated ID (e.g., SL123456789)'
  },
  status: {
    type: DataTypes.ENUM('active', 'replaced', 'cancelled', 'executed'),
    defaultValue: 'active',
    comment: 'Current status of this lifecycle ID'
  },
  replaced_by: {
    type: DataTypes.STRING(64),
    allowNull: true,
    comment: 'Points to the new lifecycle_id that replaced this one'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Additional notes about this lifecycle ID'
  }
}, {
  tableName: 'order_lifecycle_ids',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      name: 'idx_order_id',
      fields: ['order_id']
    },
    {
      name: 'idx_lifecycle_id',
      fields: ['lifecycle_id']
    },
    {
      name: 'idx_id_type',
      fields: ['id_type']
    },
    {
      name: 'idx_status',
      fields: ['status']
    },
    {
      name: 'idx_order_type',
      fields: ['order_id', 'id_type']
    },
    {
      name: 'idx_active_ids',
      fields: ['order_id', 'id_type', 'status']
    },
    {
      name: 'idx_created_at',
      fields: ['created_at']
    }
  ],
  comment: 'Stores all lifecycle IDs for orders with complete history'
});

// Define associations
OrderLifecycleId.associate = function(models) {
  // Association with LiveUserOrder
  OrderLifecycleId.belongsTo(models.LiveUserOrder, {
    foreignKey: 'order_id',
    targetKey: 'order_id',
    as: 'liveOrder'
  });
  
  // Association with DemoUserOrder
  OrderLifecycleId.belongsTo(models.DemoUserOrder, {
    foreignKey: 'order_id',
    targetKey: 'order_id',
    as: 'demoOrder'
  });
};

module.exports = OrderLifecycleId;
