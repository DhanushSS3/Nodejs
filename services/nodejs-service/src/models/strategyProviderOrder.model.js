const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const StrategyProviderOrder = sequelize.define('StrategyProviderOrder', {
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
      model: 'strategy_provider_accounts',
      key: 'id'
    }
  },
  symbol: {
    type: DataTypes.STRING(255),
    allowNull: false,
    field: 'order_company_name'
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
    defaultValue: 'strategy_provider'
  },
  
  // Copy Trading Specific Fields
  is_master_order: { 
    type: DataTypes.BOOLEAN, 
    defaultValue: true // All strategy provider orders are master orders
  },
  total_followers_copied: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0 // Number of followers who copied this order
  },
  copy_distribution_status: { 
    type: DataTypes.ENUM('pending', 'distributing', 'completed', 'failed'), 
    defaultValue: 'pending' 
  },
  copy_distribution_started_at: { 
    type: DataTypes.DATE,
    allowNull: true
  },
  copy_distribution_completed_at: { 
    type: DataTypes.DATE,
    allowNull: true
  },
  failed_copies_count: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0 
  },
  successful_copies_count: { 
    type: DataTypes.INTEGER, 
    defaultValue: 0 
  }
  
}, {
  tableName: 'strategy_provider_orders',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['order_id'] },
    { fields: ['order_user_id'] },
    { fields: ['order_status'] },
    { fields: ['order_type'] },
    { fields: ['symbol'] },
    { fields: ['created_at'] },
    { fields: ['cancel_id'] },
    { fields: ['close_id'] },
    { fields: ['modify_id'] },
    { fields: ['stoploss_id'] },
    { fields: ['takeprofit_id'] },
    { fields: ['stoploss_cancel_id'] },
    { fields: ['takeprofit_cancel_id'] },
    { fields: ['is_master_order'] },
    { fields: ['copy_distribution_status'] },
    // Composite indexes for copy trading queries
    { fields: ['order_user_id', 'order_status', 'is_master_order'] },
    { fields: ['copy_distribution_status', 'created_at'] },
    { fields: ['order_status', 'symbol', 'created_at'] }
  ],
  scopes: {
    masterOrders: {
      where: { 
        is_master_order: true 
      }
    },
    pendingDistribution: {
      where: { 
        copy_distribution_status: 'pending',
        is_master_order: true,
        order_status: ['OPEN', 'PENDING']
      }
    },
    byStrategy(strategyAccountId) {
      return {
        where: { 
          order_user_id: strategyAccountId 
        }
      };
    }
  },
  hooks: {
    afterCreate: async (order) => {
      // Trigger copy distribution for new orders
      if (order.is_master_order && ['OPEN', 'PENDING'].includes(order.order_status)) {
        // Queue for copy distribution (will be implemented in service layer)
        order.copy_distribution_status = 'pending';
        await order.save({ hooks: false });
      }
    },
    afterUpdate: async (order) => {
      // Update copy distribution when order status changes
      if (order.changed('order_status')) {
        if (['CLOSED', 'CANCELLED', 'REJECTED'].includes(order.order_status)) {
          // Mark distribution as completed when order is closed
          if (order.copy_distribution_status === 'distributing') {
            order.copy_distribution_status = 'completed';
            order.copy_distribution_completed_at = new Date();
            await order.save({ hooks: false });
          }
        }
      }
    }
  }
});

module.exports = StrategyProviderOrder;
