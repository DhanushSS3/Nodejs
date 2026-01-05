

const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const MAMOrder = sequelize.define('MAMOrder', {
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
    }
  },
  master_order_id: {
    type: DataTypes.STRING(64),
    allowNull: false,
    references: {
      model: 'live_user_orders',
      key: 'order_id'
    }
  },
  master_user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'live_users',
      key: 'id'
    }
  },
  symbol: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  order_type: {
    type: DataTypes.ENUM('buy', 'sell'),
    allowNull: false
  },
  order_status: {
    type: DataTypes.ENUM('pending', 'open', 'closed', 'rejected', 'cancelled'),
    allowNull: false,
    defaultValue: 'pending'
  },
  allocation_method: {
    type: DataTypes.ENUM('balance', 'free_margin'),
    allowNull: false,
    defaultValue: 'balance'
  },
  total_balance_snapshot: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: true
  },
  total_free_margin_snapshot: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: true
  },
  total_allocated_volume: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: false,
    defaultValue: 0
  },
  executed_volume: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: false,
    defaultValue: 0
  },
  remaining_volume: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: false,
    defaultValue: 0
  },
  average_entry_price: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: true
  },
  average_exit_price: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: true
  },
  gross_profit: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: true
  },
  net_profit_after_fees: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: true
  },
  slippage_bps: {
    type: DataTypes.DECIMAL(10, 4),
    allowNull: true
  },
  allocation_snapshot: {
    type: DataTypes.JSON,
    allowNull: true
  },
  rounding_strategy: {
    type: DataTypes.ENUM('symbol_step', 'floor', 'ceil'),
    allowNull: false,
    defaultValue: 'symbol_step'
  },
  rejected_investors_count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0
  },
  rejected_volume: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: false,
    defaultValue: 0
  },
  metadata: {
    type: DataTypes.JSON,
    allowNull: true
  }
}, {
  tableName: 'mam_orders',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['mam_account_id'] },
    { fields: ['master_order_id'] },
    { fields: ['symbol'] },
    { fields: ['created_at'] }
  ]
});

module.exports = MAMOrder;
