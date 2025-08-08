const { generateOTP } = require('../utils/otp.util');
const { sendOTPEmail } = require('../services/email.service');
const {
  storeOTP,
  getOTP,
  incrementOTPTries,
  deleteOTP,
  checkOTPRateLimit,
  OTP_MAX_TRIES
} = require('../utils/redisSession.util');
const logger = require('../services/logger.service');

async function requestEmailOTP(req, res) {
  const { email, userType } = req.body;

  if (!['live', 'demo'].includes(userType)) {
    return res.status(400).json({ success: false, message: 'Invalid user type specified.' });
  }

  try {
    const isRateLimited = await checkOTPRateLimit(email, userType);
    if (isRateLimited) {
      return res.status(429).json({ success: false, message: 'Too many OTP requests. Please try again later.' });
    }

    const otp = generateOTP();
    await storeOTP(email, otp, userType);
    await sendOTPEmail(email, otp);

    return res.status(200).json({ success: true, message: 'An OTP has been sent to your email address.' });

  } catch (error) {
    logger.error('Failed to request email OTP', { email, userType, error: error.message });
    return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
  }
}

async function verifyEmailOTP(req, res) {
  const { email, otp, userType } = req.body;

  if (!['live', 'demo'].includes(userType)) {
    return res.status(400).json({ success: false, message: 'Invalid user type specified.' });
  }

  try {
    const otpData = await getOTP(email, userType);

    if (!otpData || !otpData.otp) {
      return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    }

    const tries = parseInt(otpData.tries || '0', 10);
    if (tries >= OTP_MAX_TRIES) {
      await deleteOTP(email, userType);
      return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    }

    if (otpData.otp !== otp) {
      await incrementOTPTries(email, userType);
      return res.status(400).json({ success: false, message: 'Invalid OTP.' });
    }

    await deleteOTP(email, userType);

    return res.status(200).json({ success: true, message: 'Email verified successfully.' });

  } catch (error) {
    logger.error('Failed to verify email OTP', { email, userType, error: error.message });
    return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
  }
}

module.exports = { requestEmailOTP, verifyEmailOTP };
