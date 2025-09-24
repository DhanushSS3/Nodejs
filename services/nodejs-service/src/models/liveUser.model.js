const { DataTypes } = require('sequelize');
const sequelize = require('../config/db');

const LiveUser = sequelize.define('LiveUser', {
  country_id: { type: DataTypes.INTEGER, allowNull: true },
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  name: DataTypes.STRING,
  email: { type: DataTypes.STRING, unique: true },
  phone_number: { type: DataTypes.STRING, unique: true },
  password: DataTypes.STRING,
  user_type: DataTypes.STRING,
  wallet_balance: { type: DataTypes.DECIMAL(18, 6), defaultValue: 0 },
  leverage: { type: DataTypes.INTEGER, defaultValue: 100 },
  margin: { type: DataTypes.DECIMAL(18, 6), defaultValue: 0 },
  net_profit: { type: DataTypes.DECIMAL(18, 6), defaultValue: 0 },
  account_number: { type: DataTypes.STRING, unique: true },
  group: DataTypes.STRING,
  security_question: DataTypes.STRING,
  security_answer: DataTypes.STRING,
  city: DataTypes.STRING,
  state: DataTypes.STRING,
  country: DataTypes.STRING,
  pincode: DataTypes.STRING,
  status: { type: DataTypes.INTEGER, defaultValue: 1 },
  is_active: { type: DataTypes.INTEGER, defaultValue: 1 },
  fund_manager: DataTypes.STRING,
  is_self_trading: { type: DataTypes.INTEGER, defaultValue: 1 },
  id_proof: DataTypes.STRING,
  id_proof_image: DataTypes.STRING,
  address_proof: DataTypes.STRING,
  address_proof_image: DataTypes.STRING,
  bank_ifsc_code: DataTypes.STRING,
  bank_holder_name: DataTypes.STRING,
  bank_account_number: DataTypes.STRING,
  referred_by_id: DataTypes.INTEGER,
  referred_code: DataTypes.STRING,
  referral_code: { type: DataTypes.STRING, unique: true },
  mam_id: DataTypes.INTEGER,
  mam_status: { type: DataTypes.INTEGER, defaultValue: 0 },
  mam_alloted_time: DataTypes.DATE,
  pam_id: DataTypes.INTEGER,
  pam_status: { type: DataTypes.INTEGER, defaultValue: 0 },
  pam_alloted_time: DataTypes.DATE,
  copy_trading_wallet: { type: DataTypes.DECIMAL, defaultValue: 0 },
  copytrader_id: DataTypes.INTEGER,
  copytrading_status: { type: DataTypes.INTEGER, defaultValue: 0 },
  copytrading_alloted_time: DataTypes.DATE,
  sending_orders: { type: DataTypes.STRING, allowNull: true, defaultValue: 'barclays' },
  view_password: { type: DataTypes.STRING, allowNull: true },
  book: { type: DataTypes.STRING(5), allowNull: true },
}, {
  tableName: 'live_users',
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

module.exports = LiveUser;
