const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Symbol = sequelize.define('Symbol', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  name: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  type: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  pips: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: false,
  },
  spread_pip: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: true,
  },
  market_price: {
    type: DataTypes.DECIMAL(18, 8),
    allowNull: false,
  },
  show_points: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  profit_currency: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
}, {
  tableName: 'symbols',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
});

module.exports = Symbol;
