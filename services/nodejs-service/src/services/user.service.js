const bcrypt = require('bcrypt');
const LiveUser = require('../models/liveUser.model');
const DemoUser = require('../models/demoUser.model');

const SALT_ROUNDS = 10;

/**
 * Returns the appropriate user model based on userType.
 * @param {string} userType - 'live' or 'demo'.
 * @returns {Model}
 */
function getUserModel(userType) {
  if (userType === 'live') {
    return LiveUser;
  }
  if (userType === 'demo') {
    return DemoUser;
  }
  throw new Error('Invalid user type specified.');
}

/**
 * Finds a user by email for a given user type.
 * @param {string} email - The user's email.
 * @param {string} userType - 'live' or 'demo'.
 * @returns {Promise<User|null>}
 */
async function findUserByEmail(email, userType) {
  const User = getUserModel(userType);
  return User.findOne({ where: { email: email.toLowerCase() } });
}

/**
 * Updates a user's password.
 * @param {string} email - The user's email.
 * @param {string} userType - 'live' or 'demo'.
 * @param {string} newPassword - The new password.
 * @returns {Promise<void>}
 */
async function updateUserPassword(email, userType, newPassword) {
  const User = getUserModel(userType);
  const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);
  
  await User.update(
    { password: hashedPassword },
    { where: { email: email.toLowerCase() } }
  );
}

module.exports = {
  findUserByEmail,
  updateUserPassword,
};
