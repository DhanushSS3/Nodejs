

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
  symbol: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  order_type: {
    type: DataTypes.ENUM('BUY', 'SELL', 'BUY_LIMIT', 'SELL_LIMIT', 'BUY_STOP', 'SELL_STOP'),
    allowNull: false
  },
  order_status: {
    type: DataTypes.ENUM('PENDING', 'PENDING-QUEUED', 'QUEUED', 'OPEN', 'MODIFY', 'CLOSED', 'REJECTED', 'CANCELLED'),
    allowNull: false,
    defaultValue: 'PENDING'
  },
  requested_volume: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: false
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
  total_aggregated_margin: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: true
  },
  executed_volume: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: false,
    defaultValue: 0
  },
  stop_loss: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: true
  },
  take_profit: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: true
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
  close_message: {
    type: DataTypes.STRING(255),
    allowNull: true
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
    { fields: ['order_status'] },
    { fields: ['symbol'] },
    { fields: ['created_at'] }
  ]
});

module.exports = MAMOrder;
