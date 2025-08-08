const crypto = require('crypto');

function generateReferralCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = { generateReferralCode }; 