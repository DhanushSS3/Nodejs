const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const Country = sequelize.define('Country', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING, allowNull: false, unique: true },
  iso_code: { type: DataTypes.STRING, allowNull: true },
  dial_code: { type: DataTypes.STRING, allowNull: true }
}, {
  tableName: 'countries',
  timestamps: false
});

module.exports = Country;
