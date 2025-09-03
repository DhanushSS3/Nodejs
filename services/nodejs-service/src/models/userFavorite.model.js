const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Symbol = require('./symbol.model');

const UserFavorite = sequelize.define('UserFavorite', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  symbol_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: Symbol,
      key: 'id',
    },
  },
  user_type: {
    type: DataTypes.STRING(10),
    allowNull: false,
  },
}, {
  tableName: 'user_favorites',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: false,

  indexes: [
    {
      name: 'idx_user_id',
      fields: ['user_id'],
    },
    {
      name: 'idx_symbol_id',
      fields: ['symbol_id'],
    },
    {
      name: 'unique_user_symbol',
      unique: true,
      fields: ['user_id', 'symbol_id', 'user_type'],
    },
  ],
});

// Associations
UserFavorite.belongsTo(Symbol, { foreignKey: 'symbol_id', as: 'symbol' });
Symbol.hasMany(UserFavorite, { foreignKey: 'symbol_id', as: 'favorites' });

module.exports = UserFavorite;
