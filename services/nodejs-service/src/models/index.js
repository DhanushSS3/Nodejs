const DemoUser = require('./demoUser.model');
const LiveUser = require('./liveUser.model');
const LiveUserOrder = require('./liveUserOrder.model');
const DemoUserOrder = require('./demoUserOrder.model');
const Admin = require('./admin.model');
const Role = require('./role.model');
const Permission = require('./permission.model');
const RolePermission = require('./rolePermission.model');
const AdminAuditLog = require('./adminAuditLog.model');
const Country = require('./country.model');
const CryptoPayment = require('./cryptoPayment.model');
const UserTransaction = require('./userTransaction.model');
const Group = require('./group.model');
const MoneyRequest = require('./moneyRequest.model');
const StrategyProviderAccount = require('./strategyProviderAccount.model');
const CopyFollowerAccount = require('./copyFollowerAccount.model');
const StrategyProviderOrder = require('./strategyProviderOrder.model');
const CopyFollowerOrder = require('./copyFollowerOrder.model');
const UserStrategyProviderFavorite = require('./userStrategyProviderFavorite.model');
const MAMAccount = require('./mamAccount.model');
const MAMOrder = require('./mamOrder.model');
const MAMAssignment = require('./mamAssignment.model');
const { defineAssociations } = require('./associations');
require('./copyTrading.associations');

// Initialize associations once
try {
  defineAssociations();
} catch (e) {
  // No-op if associations already defined or if any optional models are missing
}

module.exports = {
  DemoUser,
  LiveUser,
  LiveUserOrder,
  DemoUserOrder,
  Admin,
  Role,
  Permission,
  RolePermission,
  AdminAuditLog,
  Country,
  CryptoPayment,
  UserTransaction,
  Group,
  MoneyRequest,
  StrategyProviderAccount,
  CopyFollowerAccount,
  StrategyProviderOrder,
  CopyFollowerOrder,
  UserStrategyProviderFavorite,
  MAMAccount,
  MAMOrder,
  MAMAssignment,
};
