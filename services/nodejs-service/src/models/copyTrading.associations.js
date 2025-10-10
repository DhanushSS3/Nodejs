// Copy Trading Model Associations
const LiveUser = require('./liveUser.model');
const StrategyProviderAccount = require('./strategyProviderAccount.model');
const CopyFollowerAccount = require('./copyFollowerAccount.model');
const StrategyProviderOrder = require('./strategyProviderOrder.model');
const CopyFollowerOrder = require('./copyFollowerOrder.model');

// LiveUser Associations
LiveUser.hasMany(StrategyProviderAccount, {
  foreignKey: 'user_id',
  as: 'strategyProviderAccounts',
  onDelete: 'CASCADE'
});

LiveUser.hasMany(CopyFollowerAccount, {
  foreignKey: 'user_id',
  as: 'copyFollowerAccounts',
  onDelete: 'CASCADE'
});

// StrategyProviderAccount Associations
StrategyProviderAccount.belongsTo(LiveUser, {
  foreignKey: 'user_id',
  as: 'owner'
});

StrategyProviderAccount.hasMany(CopyFollowerAccount, {
  foreignKey: 'strategy_provider_id',
  as: 'followers',
  onDelete: 'CASCADE'
});

StrategyProviderAccount.hasMany(StrategyProviderOrder, {
  foreignKey: 'order_user_id',
  as: 'orders',
  onDelete: 'CASCADE'
});

// CopyFollowerAccount Associations
CopyFollowerAccount.belongsTo(LiveUser, {
  foreignKey: 'user_id',
  as: 'owner'
});

CopyFollowerAccount.belongsTo(StrategyProviderAccount, {
  foreignKey: 'strategy_provider_id',
  as: 'strategyProvider'
});

CopyFollowerAccount.hasMany(CopyFollowerOrder, {
  foreignKey: 'order_user_id',
  as: 'orders',
  onDelete: 'CASCADE'
});

CopyFollowerAccount.hasMany(CopyFollowerOrder, {
  foreignKey: 'copy_follower_account_id',
  as: 'copyOrders',
  onDelete: 'CASCADE'
});

// StrategyProviderOrder Associations
StrategyProviderOrder.belongsTo(StrategyProviderAccount, {
  foreignKey: 'order_user_id',
  as: 'strategyAccount'
});

StrategyProviderOrder.hasMany(CopyFollowerOrder, {
  foreignKey: 'master_order_id',
  sourceKey: 'order_id',
  as: 'copiedOrders',
  onDelete: 'CASCADE'
});

// CopyFollowerOrder Associations
CopyFollowerOrder.belongsTo(CopyFollowerAccount, {
  foreignKey: 'order_user_id',
  as: 'followerAccount'
});

CopyFollowerOrder.belongsTo(CopyFollowerAccount, {
  foreignKey: 'copy_follower_account_id',
  as: 'copyAccount'
});

CopyFollowerOrder.belongsTo(StrategyProviderOrder, {
  foreignKey: 'master_order_id',
  targetKey: 'order_id',
  as: 'masterOrder'
});

CopyFollowerOrder.belongsTo(StrategyProviderAccount, {
  foreignKey: 'strategy_provider_id',
  as: 'strategyProvider'
});

// Export associations for use in other files
module.exports = {
  LiveUser,
  StrategyProviderAccount,
  CopyFollowerAccount,
  StrategyProviderOrder,
  CopyFollowerOrder
};
