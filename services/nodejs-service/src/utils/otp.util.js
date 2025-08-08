const crypto = require('crypto');

/**
 * Generates a secure 6-digit numeric OTP.
 * @returns {string} The 6-digit OTP.
 */
function generateOTP() {
  // Generate a random number between 100000 and 999999
  const otp = crypto.randomInt(100000, 1000000);
  return otp.toString();
}

module.exports = { generateOTP };
