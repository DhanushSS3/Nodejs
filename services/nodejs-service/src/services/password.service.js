const bcrypt = require('bcrypt');
const crypto = require('crypto');

const SALT_ROUNDS = 10;

async function hashPassword(password) {
  return await bcrypt.hash(password, SALT_ROUNDS);
}

async function comparePassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

/**
 * Generate a secure random view password
 * @param {number} length - Length of the password (default: 14)
 * @returns {string} - Random alphanumeric password
 */
function generateViewPassword(length = 14) {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let password = '';
  
  // Use crypto.randomBytes for cryptographically secure random generation
  const randomBytes = crypto.randomBytes(length);
  
  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length];
  }
  
  return password;
}

/**
 * Hash view password using bcrypt
 * @param {string} viewPassword - Plain text view password
 * @returns {Promise<string>} - Hashed view password
 */
async function hashViewPassword(viewPassword) {
  return await bcrypt.hash(viewPassword, SALT_ROUNDS);
}

/**
 * Compare view password with hash
 * @param {string} viewPassword - Plain text view password
 * @param {string} hash - Hashed view password
 * @returns {Promise<boolean>} - True if passwords match
 */
async function compareViewPassword(viewPassword, hash) {
  return await bcrypt.compare(viewPassword, hash);
}

module.exports = { 
  hashPassword, 
  comparePassword, 
  generateViewPassword, 
  hashViewPassword, 
  compareViewPassword 
};