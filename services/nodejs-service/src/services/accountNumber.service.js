const crypto = require('crypto');

function generateAccountNumber(prefix = 'LIVE') {
  // Generate a random 6-character uppercase alphanumeric string
  const random = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${random}`;
}

module.exports = { generateAccountNumber }; 