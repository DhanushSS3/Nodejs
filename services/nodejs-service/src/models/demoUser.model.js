const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const DemoUser = sequelize.define('DemoUser', {
  country_id: { type: DataTypes.INTEGER, allowNull: true },
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  name: DataTypes.STRING,
  email: { type: DataTypes.STRING, unique: true },
  phone_number: { type: DataTypes.STRING, unique: true },
  password: DataTypes.STRING,
  user_type: DataTypes.STRING,
  wallet_balance: { type: DataTypes.DECIMAL, defaultValue: 0 },
  leverage: DataTypes.INTEGER,
  margin: { type: DataTypes.DECIMAL, defaultValue: 0 },
  net_profit: { type: DataTypes.DECIMAL, defaultValue: 0 },
  account_number: { type: DataTypes.STRING, unique: true },
  group: DataTypes.STRING,
  security_question: DataTypes.STRING,
  security_answer: DataTypes.STRING,
  city: DataTypes.STRING,
  state: DataTypes.STRING,
  pincode: DataTypes.STRING,
  country: DataTypes.STRING,
  status: { type: DataTypes.INTEGER, defaultValue: 1 },
  is_active: { type: DataTypes.INTEGER, defaultValue: 1 },
}, {
  tableName: 'demo_users',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  indexes: [
    { fields: ['email'] },
    { fields: ['phone_number'] },
    { fields: ['account_number'] }
  ],
  scopes: {
    countryScoped(countryId) {
      return {
        where: { country_id: countryId }
      };
    }
  }
});

module.exports = DemoUser;
