const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');
const Role = require('./role.model');
const Permission = require('./permission.model');

const RolePermission = sequelize.define('RolePermission', {
  role_id: {
    type: DataTypes.INTEGER,
    references: {
      model: Role,
      key: 'id',
    },
    primaryKey: true,
  },
  permission_id: {
    type: DataTypes.INTEGER,
    references: {
      model: Permission,
      key: 'id',
    },
    primaryKey: true,
  },
}, {
  tableName: 'role_permissions',
  timestamps: false, // This is a join table, timestamps are not necessary
});

Role.belongsToMany(Permission, { through: RolePermission, foreignKey: 'role_id' });
Permission.belongsToMany(Role, { through: RolePermission, foreignKey: 'permission_id' });

module.exports = RolePermission;
