const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const OrderRejection = sequelize.define('OrderRejection', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
    allowNull: false
  },
  canonical_order_id: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: 'Internal canonical order ID'
  },
  provider_order_id: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Provider order ID from execution report'
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'User ID who owns the order'
  },
  user_type: {
    type: DataTypes.ENUM('live', 'demo', 'strategy_provider', 'copy_follower'),
    allowNull: false,
    comment: 'Type of user account'
  },
  symbol: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Trading symbol (e.g., EURUSD)'
  },
  rejection_type: {
    type: DataTypes.ENUM(
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
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'Redis status field when rejection occurred'
  },
  provider_ord_status: {
    type: DataTypes.STRING(50),
    allowNull: true,
    comment: 'Provider ord_status from execution report'
  },
  reason: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'Rejection reason from provider'
  },
  provider_exec_id: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Provider execution ID'
  },
  provider_raw_data: {
    type: DataTypes.JSON,
    allowNull: true,
    comment: 'Raw provider execution report data'
  },
  order_type: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'Order type (BUY, SELL, etc.)'
  },
  order_price: {
    type: DataTypes.DECIMAL(15, 5),
    allowNull: true,
    comment: 'Order price when rejected'
  },
  order_quantity: {
    type: DataTypes.DECIMAL(15, 5),
    allowNull: true,
    comment: 'Order quantity when rejected'
  },
  margin_released: {
    type: DataTypes.DECIMAL(15, 2),
    allowNull: true,
    comment: 'Margin amount released due to rejection'
  }
}, {
  tableName: 'order_rejections',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    {
      name: 'idx_order_rejections_canonical_id',
      fields: ['canonical_order_id']
    },
    {
      name: 'idx_order_rejections_user',
      fields: ['user_id', 'user_type']
    },
    {
      name: 'idx_order_rejections_symbol',
      fields: ['symbol']
    },
    {
      name: 'idx_order_rejections_type',
      fields: ['rejection_type']
    },
    {
      name: 'idx_order_rejections_created_at',
      fields: ['created_at']
    }
  ]
});

// Static method to determine rejection type from Redis status
OrderRejection.determineRejectionType = function(redisStatus) {
  const status = String(redisStatus || '').toUpperCase().trim();
  
  switch (status) {
    case 'OPEN':
      return 'ORDER_PLACEMENT';
    case 'CLOSED':
      return 'ORDER_CLOSE';
    case 'PENDING':
      return 'PENDING_PLACEMENT';
    case 'MODIFY':
      return 'PENDING_MODIFY';
    case 'CANCELLED':
      return 'PENDING_CANCEL';
    case 'STOPLOSS':
      return 'STOPLOSS_ADD';
    case 'STOPLOSS-CANCEL':
      return 'STOPLOSS_REMOVE';
    case 'TAKEPROFIT':
      return 'TAKEPROFIT_ADD';
    case 'TAKEPROFIT-CANCEL':
      return 'TAKEPROFIT_REMOVE';
    default:
      return 'ORDER_PLACEMENT'; // Default fallback
  }
};

module.exports = OrderRejection;
