const crypto = require('crypto');
const { generateOTP } = require('../utils/otp.util');
const { sendOTPEmail } = require('../services/email.service');
const userService = require('../services/user.service');
const {
  storeOTP,
  getOTP,
  incrementOTPTries,
  deleteOTP,
  checkOTPRateLimit,
  clearOTPRateLimit,
  OTP_MAX_TRIES,
  // Password Reset Utilities
  storePasswordResetOTP,
  getPasswordResetOTP,
  incrementPasswordResetOTPTries,
  deletePasswordResetOTP,
  checkPasswordResetOTPRateLimit,
  storeResetToken,
  getResetToken,
  deleteResetToken
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

async function requestPasswordReset(req, res) {
  const { email, userType } = req.body;

  // Always return a generic success message to prevent email enumeration
  const genericSuccessResponse = () => res.status(200).json({ success: true, message: 'If an account with that email exists, a password reset OTP has been sent.' });

  try {
    if (!['live', 'demo'].includes(userType)) {
      return res.status(400).json({ success: false, message: 'Invalid user type specified.' });
    }

    const isRateLimited = await checkPasswordResetOTPRateLimit(email, userType);
    if (isRateLimited) {
      return res.status(429).json({ success: false, message: 'Too many password reset requests. Please try again later.' });
    }

    const user = await userService.findUserByEmail(email, userType);
    if (user) {
      const otp = generateOTP();
      await storePasswordResetOTP(email, otp, userType);
      // Use a separate email template for password resets
      await sendOTPEmail(email, otp, 'Password Reset'); 
    }

    return genericSuccessResponse();

  } catch (error) {
    logger.error('Failed to request password reset', { email, userType, error: error.message });
    // Do not reveal internal errors to the client
    return genericSuccessResponse();
  }
}

async function verifyPasswordResetOTP(req, res) {
  const { email, otp, userType } = req.body;

  try {
    const otpData = await getPasswordResetOTP(email, userType);

    if (!otpData || !otpData.otp) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
    }

    const tries = parseInt(otpData.tries || '0', 10);
    if (tries >= OTP_MAX_TRIES) {
      await deletePasswordResetOTP(email, userType);
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
    }

    if (otpData.otp !== otp) {
      await incrementPasswordResetOTPTries(email, userType);
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP.' });
    }

    // OTP is correct, generate and store a secure reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    await storeResetToken(email, userType, resetToken);
    
    // Clean up the OTP from Redis
    await deletePasswordResetOTP(email, userType);

    return res.status(200).json({ success: true, message: 'OTP verified successfully.', resetToken });

  } catch (error) {
    logger.error('Failed to verify password reset OTP', { email, userType, error: error.message });
    return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
  }
}

async function resetPassword(req, res) {
  const { email, userType, resetToken, newPassword } = req.body;

  try {
    const storedToken = await getResetToken(email, userType);

    if (!storedToken || storedToken !== resetToken) {
      return res.status(400).json({ success: false, message: 'Invalid or expired reset token.' });
    }

    await userService.updateUserPassword(email, userType, newPassword);

    // Invalidate the token after use
    await deleteResetToken(email, userType);
    // Optional: Invalidate all refresh tokens for this user as well for added security
    // await deleteAllRefreshTokens(user.id, userType); 

    return res.status(200).json({ success: true, message: 'Password has been reset successfully.' });

  } catch (error) {
    logger.error('Failed to reset password', { email, userType, error: error.message });
    return res.status(500).json({ success: false, message: 'An unexpected error occurred. Please try again.' });
  }
}

async function clearOTPRateLimitForUser(req, res) {
  const { email, userType } = req.body;

  if (!['live', 'demo'].includes(userType)) {
    return res.status(400).json({ success: false, message: 'Invalid user type specified.' });
  }

  try {
    await clearOTPRateLimit(email, userType);
    return res.status(200).json({ 
      success: true, 
      message: `OTP rate limit cleared for ${email} (${userType})` 
    });
  } catch (error) {
    logger.error('Failed to clear OTP rate limit', { email, userType, error: error.message });
    return res.status(500).json({ 
      success: false, 
      message: 'An unexpected error occurred. Please try again.' 
    });
  }
}

module.exports = {
  requestEmailOTP,
  verifyEmailOTP,
  requestPasswordReset,
  verifyPasswordResetOTP,
  resetPassword,
  clearOTPRateLimitForUser,
};
