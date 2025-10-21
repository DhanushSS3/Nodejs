const { DataTypes, Op } = require('sequelize');
const sequelize = require('../config/db');

const CopyFollowerOrder = sequelize.define('CopyFollowerOrder', {
  id: { 
    type: DataTypes.INTEGER, 
    autoIncrement: true, 
    primaryKey: true 
  },
  order_id: { 
    type: DataTypes.STRING(64), 
    allowNull: false, 
    unique: true 
  },
  order_user_id: { 
    type: DataTypes.INTEGER, 
    allowNull: false,
    references: {
      model: 'copy_follower_accounts',
      key: 'id'
    }
  },
  symbol: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  order_type: { 
    type: DataTypes.STRING(20), 
    allowNull: false 
  },
  order_status: { 
    type: DataTypes.STRING(20), 
    allowNull: false 
  },
  order_price: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: false 
  },
  order_quantity: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: false 
  },
  contract_value: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true 
  },
  margin: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true 
  },
  stop_loss: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true 
  },
  take_profit: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true 
  },
  close_price: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true 
  },
  net_profit: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true 
  },
  swap: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true 
  },
  commission: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true 
  },
  cancel_message: { 
    type: DataTypes.STRING(255), 
    allowNull: true 
  },
  close_message: { 
    type: DataTypes.STRING(255), 
    allowNull: true 
  },
  cancel_id: { 
    type: DataTypes.STRING(64), 
    allowNull: true, 
    unique: true 
  },
  close_id: { 
    type: DataTypes.STRING(64), 
    allowNull: true, 
    unique: true 
  },
  modify_id: { 
    type: DataTypes.STRING(64), 
    allowNull: true, 
    unique: true 
  },
  stoploss_id: { 
    type: DataTypes.STRING(64), 
    allowNull: true, 
    unique: true 
  },
  takeprofit_id: { 
    type: DataTypes.STRING(64), 
    allowNull: true, 
    unique: true 
  },
  stoploss_cancel_id: { 
    type: DataTypes.STRING(64), 
    allowNull: true, 
    unique: true 
  },
  takeprofit_cancel_id: { 
    type: DataTypes.STRING(64), 
    allowNull: true, 
    unique: true 
  },
  status: { 
    type: DataTypes.STRING(30), 
    allowNull: true 
  },
  placed_by: { 
    type: DataTypes.STRING(30), 
    allowNull: true,
    defaultValue: 'copy_trading'
  },
  
  // Copy Trading Specific Fields
  master_order_id: { 
    type: DataTypes.STRING(64), 
    allowNull: false, // Reference to strategy provider's order
    references: {
      model: 'strategy_provider_orders',
      key: 'order_id'
    }
  },
  strategy_provider_id: { 
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'strategy_provider_accounts',
      key: 'id'
    }
  },
  copy_follower_account_id: { 
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: 'copy_follower_accounts',
      key: 'id'
    }
  },
  
  // Lot Calculation Details (For audit and transparency)
  master_lot_size: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: false // Original lot size from master
  },
  follower_investment_at_copy: { 
    type: DataTypes.DECIMAL(18, 6), 
    allowNull: false // Snapshot of follower's investment
  },
  master_equity_at_copy: { 
    type: DataTypes.DECIMAL(18, 6), 
    allowNull: false // Snapshot of master's equity
  },
  lot_ratio: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: false // follower_investment / master_equity
  },
  calculated_lot_size: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: false // master_lot * lot_ratio
  },
  final_lot_size: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: false // After applying max_lot_size limits
  },
  
  // Copy Status & Timing
  copy_status: { 
    type: DataTypes.ENUM('pending', 'copied', 'failed', 'cancelled', 'rejected'), 
    defaultValue: 'pending' 
  },
  copy_timestamp: { 
    type: DataTypes.DATE,
    allowNull: true
  },
  copy_delay_ms: { 
    type: DataTypes.INTEGER,
    allowNull: true // Time between master order and copy
  },
  failure_reason: { 
    type: DataTypes.STRING(500),
    allowNull: true
  },
  
  // SL/TP Modifications (Exness allows followers to modify SL/TP)
  original_stop_loss: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true // SL from master order
  },
  original_take_profit: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true // TP from master order
  },
  modified_by_follower: { 
    type: DataTypes.BOOLEAN, 
    defaultValue: false // If follower modified SL/TP
  },
  sl_modification_type: { 
    type: DataTypes.ENUM('percentage', 'amount', 'none'),
    allowNull: true
  },
  tp_modification_type: { 
    type: DataTypes.ENUM('percentage', 'amount', 'none'),
    allowNull: true
  },
  
  // Performance Fee Tracking
  performance_fee_percentage: { 
    type: DataTypes.DECIMAL(5, 2),
    allowNull: true // Snapshot from strategy provider
  },
  gross_profit: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true // Profit before fees
  },
  performance_fee_amount: { 
    type: DataTypes.DECIMAL(18, 6), 
    defaultValue: 0 
  },
  net_profit_after_fees: { 
    type: DataTypes.DECIMAL(18, 8), 
    allowNull: true // Final profit after performance fees
  },
  fee_status: { 
    type: DataTypes.ENUM('pending', 'calculated', 'paid'), 
    defaultValue: 'pending' 
  },
  fee_calculation_date: { 
    type: DataTypes.DATE,
    allowNull: true
  },
  fee_payment_date: { 
    type: DataTypes.DATE,
    allowNull: true
  }
  
}, {
  tableName: 'copy_follower_orders',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['order_id'] },
    { fields: ['order_user_id'] },
    { fields: ['master_order_id'] },
    { fields: ['strategy_provider_id'] },
    { fields: ['copy_follower_account_id'] },
    { fields: ['order_status'] },
    { fields: ['order_type'] },
    { fields: ['symbol'] },
    { fields: ['copy_status'] },
    { fields: ['created_at'] },
    { fields: ['copy_timestamp'] },
    { fields: ['fee_status'] },
    // Composite indexes for performance
    { fields: ['master_order_id', 'copy_status'] },
    { fields: ['strategy_provider_id', 'order_status', 'created_at'] },
    { fields: ['copy_follower_account_id', 'order_status'] },
    { fields: ['copy_status', 'copy_timestamp'] },
    { fields: ['fee_status', 'order_status'] },
    { fields: ['placed_by', 'copy_status'] }
  ],
  scopes: {
    copied: {
      where: { 
        copy_status: 'copied' 
      }
    },
    pending: {
      where: { 
        copy_status: 'pending' 
      }
    },
    failed: {
      where: { 
        copy_status: 'failed' 
      }
    },
    byMasterOrder(masterOrderId) {
      return {
        where: { 
          master_order_id: masterOrderId 
        }
      };
    },
    byStrategy(strategyProviderId) {
      return {
        where: { 
          strategy_provider_id: strategyProviderId 
        }
      };
    },
    byFollower(followerAccountId) {
      return {
        where: { 
          copy_follower_account_id: followerAccountId 
        }
      };
    },
    pendingFees: {
      where: { 
        fee_status: 'pending',
        order_status: 'CLOSED',
        gross_profit: { [Op.gt]: 0 }
      }
    }
  },
  hooks: {
    beforeCreate: (order) => {
      // Set copy timestamp
      if (order.copy_status === 'copied' && !order.copy_timestamp) {
        order.copy_timestamp = new Date();
      }
      
      // Ensure final_lot_size is set
      if (!order.final_lot_size && order.calculated_lot_size) {
        order.final_lot_size = order.calculated_lot_size;
      }
    },
    afterUpdate: async (order) => {
      // Calculate performance fees when order is closed with profit
      if (order.changed('order_status') && order.order_status === 'CLOSED') {
        if (order.net_profit > 0 && order.performance_fee_percentage > 0) {
          order.gross_profit = order.net_profit;
          order.performance_fee_amount = (order.net_profit * order.performance_fee_percentage) / 100;
          order.net_profit_after_fees = order.net_profit - order.performance_fee_amount;
          order.fee_status = 'calculated';
          order.fee_calculation_date = new Date();
          await order.save({ hooks: false });
        }
      }
    }
  }
});

module.exports = CopyFollowerOrder;
