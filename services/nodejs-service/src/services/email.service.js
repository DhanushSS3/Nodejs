const nodemailer = require('nodemailer');
const logger = require('./logger.service');

// Create a reusable transporter object using the default SMTP transport
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: process.env.EMAIL_PORT == 465, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER, // your email address
    pass: process.env.EMAIL_PASS, // your email password or app password
  },
});

/**
 * Sends an OTP to the user's email address using Nodemailer.
 * 
 * @param {string} email The recipient's email address.
 * @param {string} otp The 6-digit OTP to send.
 * @returns {Promise<void>}
 */
async function sendOTPEmail(email, otp, subject = 'Your Verification Code') {
  const mailOptions = {
    from: process.env.EMAIL_FROM, // sender address
    to: email, // list of receivers
    subject: subject,
    html: getEmailHTML(subject, otp),
  };

  try {
    await transporter.sendMail(mailOptions);
    logger.info(`OTP email sent to ${email}`);
  } catch (error) {
    logger.error('Failed to send OTP email', { email, error: error.message });
    // In a production environment, you might want to have a more robust error handling
    // or a fallback mechanism. For now, we'll throw to indicate failure.
    throw new Error('Could not send verification email.');
  }
}

function getEmailHTML(subject, otp) {
  if (subject.toLowerCase().includes('password reset')) {
    return `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2>Password Reset Request</h2>
        <p>We received a request to reset your password. Use the One-Time Password (OTP) below to proceed.</p>
        <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #007bff;">${otp}</p>
        <p>This OTP is valid for 5 minutes. If you did not request a password reset, please ignore this email or contact our support if you have concerns.</p>
        <hr>
        <p style="font-size: 0.9em; color: #666;">Thank you for using our service.</p>
      </div>
    `;
  }

  if (subject.toLowerCase().includes('admin login')) {
    return `
      <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h2 style="color: #2c3e50; margin-bottom: 10px;">🔐 Admin Login Verification</h2>
          <p style="color: #7f8c8d; font-size: 16px;">Two-Factor Authentication Required</p>
        </div>
        
        <div style="background-color: #f8f9fa; padding: 20px; border-radius: 6px; margin-bottom: 20px;">
          <p style="margin: 0 0 15px 0; font-size: 16px;">A login attempt was made to your admin account. Please use the verification code below to complete your authentication:</p>
          
          <div style="text-align: center; margin: 25px 0;">
            <div style="display: inline-block; background-color: #fff; padding: 15px 25px; border: 2px solid #3498db; border-radius: 8px;">
              <span style="font-size: 28px; font-weight: bold; letter-spacing: 3px; color: #2980b9; font-family: 'Courier New', monospace;">${otp}</span>
            </div>
          </div>
        </div>
        
        <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 6px; padding: 15px; margin-bottom: 20px;">
          <p style="margin: 0; font-size: 14px; color: #856404;">
            <strong>⚠️ Security Notice:</strong> This verification code expires in <strong>5 minutes</strong>. 
            If you did not attempt to log in, please secure your account immediately and contact your system administrator.
          </p>
        </div>
        
        <div style="border-top: 1px solid #e0e0e0; padding-top: 20px; text-align: center;">
          <p style="font-size: 12px; color: #95a5a6; margin: 0;">
            This is an automated security message for admin account access.<br>
            Please do not reply to this email.
          </p>
        </div>
      </div>
    `;
  }

  // Default to email verification template
  return `
    <div style="font-family: Arial, sans-serif; color: #333;">
      <h2>Email Verification</h2>
      <p>Thank you for signing up. Please use the One-Time Password (OTP) below to verify your email address.</p>
      <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #007bff;">${otp}</p>
      <p>This OTP is valid for 5 minutes. If you did not sign up for our service, please disregard this email.</p>
      <hr>
      <p style="font-size: 0.9em; color: #666;">Thank you for using our service.</p>
    </div>
  `;
}

module.exports = { sendOTPEmail };
