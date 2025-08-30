const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const DemoUserOrder = sequelize.define('DemoUserOrder', {
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
      model: 'demo_users',
      key: 'id'
    }
  },
  order_company_name: { 
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
    allowNull: true 
  }
}, {
  tableName: 'demo_user_orders',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['order_id'] },
    { fields: ['order_user_id'] },
    { fields: ['order_status'] },
    { fields: ['order_type'] },
    { fields: ['order_company_name'] },
    { fields: ['created_at'] },
    { fields: ['cancel_id'] },
    { fields: ['close_id'] },
    { fields: ['modify_id'] },
    { fields: ['stoploss_id'] },
    { fields: ['takeprofit_id'] },
    { fields: ['stoploss_cancel_id'] },
    { fields: ['takeprofit_cancel_id'] }
  ]
});

module.exports = DemoUserOrder;
