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
