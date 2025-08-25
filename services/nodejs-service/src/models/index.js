const DemoUser = require('./demoUser.model');
const LiveUser = require('./liveUser.model');
const Admin = require('./admin.model');
const Role = require('./role.model');
const Permission = require('./permission.model');
const RolePermission = require('./rolePermission.model');
const AdminAuditLog = require('./adminAuditLog.model');
const Country = require('./country.model');

module.exports = {
  DemoUser,
  LiveUser,
  Admin,
  Role,
  Permission,
  RolePermission,
  AdminAuditLog,
  Country,
};
