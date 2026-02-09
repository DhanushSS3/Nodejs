const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const CurrencyConfig = sequelize.define('CurrencyConfig', {
  id: {
    type: DataTypes.BIGINT,
    autoIncrement: true,
    primaryKey: true,
  },
  currency: {
    type: DataTypes.CHAR(3),
    allowNull: false,
    unique: true,
  },
  minor_unit: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 2,
  },
  enabled: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  min_amount: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: false,
    defaultValue: 0,
  },
  max_amount: {
    type: DataTypes.DECIMAL(18, 6),
    allowNull: false,
    defaultValue: 0,
  },
  settlement_currency: {
    type: DataTypes.CHAR(3),
    allowNull: false,
    defaultValue: 'USD',
  },
}, {
  tableName: 'currency_config',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { name: 'idx_currency_config_currency', fields: ['currency'], unique: true },
    { name: 'idx_currency_config_enabled', fields: ['enabled'] },
  ],
});

module.exports = CurrencyConfig;
