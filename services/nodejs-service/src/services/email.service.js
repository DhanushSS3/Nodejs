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
async function sendOTPEmail(email, otp) {
  const mailOptions = {
    from: process.env.EMAIL_FROM, // sender address
    to: email, // list of receivers
    subject: 'Your Verification Code for Trading App',
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2>Email Verification</h2>
        <p>Thank you for signing up. Please use the following One-Time Password (OTP) to verify your email address.</p>
        <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px;">${otp}</p>
        <p>This OTP is valid for 5 minutes.</p>
        <p>If you did not request this, please ignore this email.</p>
      </div>
    `,
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

module.exports = { sendOTPEmail };
