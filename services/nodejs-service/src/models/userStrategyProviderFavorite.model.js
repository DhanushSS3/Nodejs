const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const StrategyProviderAccount = require('./strategyProviderAccount.model');

const UserStrategyProviderFavorite = sequelize.define('UserStrategyProviderFavorite', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true,
  },
  user_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'ID of the live user who favorited the strategy provider'
  },
  strategy_provider_id: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: StrategyProviderAccount,
      key: 'id',
    },
    comment: 'ID of the strategy provider account being favorited'
  },
  user_type: {
    type: DataTypes.STRING(10),
    allowNull: false,
    defaultValue: 'live',
    comment: 'Type of user (live, demo) - typically live for favorites'
  },
}, {
  tableName: 'user_strategy_provider_favorites',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',

  indexes: [
    {
      name: 'idx_user_id',
      fields: ['user_id'],
    },
    {
      name: 'idx_strategy_provider_id',
      fields: ['strategy_provider_id'],
    },
    {
      name: 'idx_user_type',
      fields: ['user_type'],
    },
    {
      name: 'unique_user_strategy_provider',
      unique: true,
      fields: ['user_id', 'strategy_provider_id', 'user_type'],
    },
    {
      name: 'idx_user_created',
      fields: ['user_id', 'created_at'],
    },
  ],
});

// Associations
UserStrategyProviderFavorite.belongsTo(StrategyProviderAccount, { 
  foreignKey: 'strategy_provider_id', 
  as: 'strategyProvider' 
});

StrategyProviderAccount.hasMany(UserStrategyProviderFavorite, { 
  foreignKey: 'strategy_provider_id', 
  as: 'favorites' 
});

module.exports = UserStrategyProviderFavorite;
