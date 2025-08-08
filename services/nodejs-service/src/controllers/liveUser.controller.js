const LiveUser = require('../models/liveUser.model');
const { generateAccountNumber } = require('../services/accountNumber.service');
const { hashPassword } = require('../services/password.service');
const { generateReferralCode } = require('../services/referralCode.service');
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const TransactionService = require('../services/transaction.service');
const logger = require('../services/logger.service');
const { IdempotencyService } = require('../services/idempotency.service');
const jwt = require('jsonwebtoken');
const { comparePassword } = require('../services/password.service');

/**
 * Live User Signup with transaction handling and deadlock prevention
 */
async function signup(req, res) {
  const operationId = `live_signup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const {
      name, phone_number, email, password, city, state, country, pincode, group,
      bank_ifsc_code, bank_account_number, bank_holder_name, bank_branch_name,
      security_question, security_answer, address_proof, is_self_trading, is_active, 
      id_proof, address_proof_image, id_proof_image, 
      ...optionalFields
    } = req.body;

    // Generate idempotency key
    const idempotencyKey = IdempotencyService.generateKey(req, 'live_signup');
    const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

    if (isExisting) {
      if (record.status === 'completed') {
        logger.info('Returning cached response for duplicate live signup', { 
          idempotencyKey, 
          operationId 
        });
        return res.status(201).json(record.response);
      } else if (record.status === 'processing') {
        return res.status(409).json({ 
          success: false, 
          message: 'Request is already being processed' 
        });
      }
    }

    logger.transactionStart('live_user_signup', { 
      operationId, 
      email, 
      phone_number 
    });

    // Execute signup within transaction
    const result = await TransactionService.executeWithRetry(async (transaction) => {
      // Check uniqueness within transaction
      const existing = await LiveUser.findOne({
        where: { [Op.or]: [{ email }, { phone_number }] },
        transaction
      });

      if (existing) {
        throw new Error('Email or phone number already exists');
      }

      // Generate unique account number
      let account_number;
      let unique = false;
      let attempts = 0;
      const maxAttempts = 10;

      while (!unique && attempts < maxAttempts) {
        account_number = generateAccountNumber('LIVE');
        const exists = await LiveUser.findOne({ 
          where: { account_number },
          transaction
        });
        if (!exists) {
          unique = true;
        }
        attempts++;
      }

      if (!unique) {
        throw new Error('Unable to generate unique account number after maximum attempts');
      }

      // Hash password
      const hashedPassword = await hashPassword(password);

      // Handle file uploads
      let address_proof_image = req.files && req.files.address_proof_image 
        ? `/uploads/${req.files.address_proof_image[0].filename}` 
        : null;
      let id_proof_image = req.files && req.files.id_proof_image 
        ? `/uploads/${req.files.id_proof_image[0].filename}` 
        : null;

      // Create user
      const user = await LiveUser.create({
        name, 
        phone_number, 
        email, 
        password: hashedPassword, 
        city, 
        state, 
        country, 
        pincode, 
        group,
        bank_ifsc_code, 
        bank_account_number, 
        bank_holder_name, 
        bank_branch_name,
        security_question, 
        security_answer, 
        address_proof, 
        address_proof_image,
        id_proof,
        id_proof_image, 
        is_self_trading, 
        is_active,
        account_number,
        user_type: 'live',
        ...optionalFields
      }, { transaction });

      // Generate unique referral code
      let referral_code;
      let referralUnique = false;
      let referralAttempts = 0;

      while (!referralUnique && referralAttempts < maxAttempts) {
        referral_code = generateReferralCode();
        const exists = await LiveUser.findOne({ 
          where: { referral_code },
          transaction
        });
        if (!exists) {
          referralUnique = true;
        }
        referralAttempts++;
      }

      if (!referralUnique) {
        throw new Error('Unable to generate unique referral code after maximum attempts');
      }

      // Update user with referral code
      await user.update({ referral_code }, { transaction });

      logger.financial('live_user_created', {
        operationId,
        userId: user.id,
        account_number: user.account_number,
        email: user.email,
        bank_account_number: user.bank_account_number,
        group: user.group
      });

      return {
        success: true,
        message: 'Live user signup successful',
        user: {
          id: user.id,
          account_number: user.account_number,
          email: user.email,
          referral_code: user.referral_code,
          name: user.name,
          is_active: user.is_active,
          group: user.group
        }
      };
    });

    // Mark idempotency as completed
    await IdempotencyService.markCompleted(idempotencyKey, result);

    logger.transactionSuccess('live_user_signup', { 
      operationId, 
      userId: result.user.id 
    });

    return res.status(201).json(result);

  } catch (error) {
    logger.transactionFailure('live_user_signup', error, { 
      operationId, 
      email: req.body.email 
    });

    // Mark idempotency as failed if we have the key
    try {
      const idempotencyKey = IdempotencyService.generateKey(req, 'live_signup');
      await IdempotencyService.markFailed(idempotencyKey, error);
    } catch (idempotencyError) {
      logger.error('Failed to mark idempotency as failed', { 
        error: idempotencyError.message 
      });
    }

    // Handle specific error types
    if (error.message === 'Email or phone number already exists') {
      return res.status(409).json({ 
        success: false, 
        message: error.message 
      });
    }

    if (error.message.includes('Unable to generate unique')) {
      return res.status(500).json({ 
        success: false, 
        message: 'System temporarily unavailable. Please try again.' 
      });
    }

    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      operationId 
    });
  }
}

/**
 * Live User Login - returns JWT on success
 */
async function login(req, res) {
  const { email, password } = req.body;
  try {
    const user = await LiveUser.findOne({ where: { email } });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const valid = await comparePassword(password, user.password);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
    const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
    const jwtPayload = {
      user_type: user.user_type,
      mam_status: user.mam_status,
      pam_status: user.pam_status,
      sending_orders: user.sending_orders,
      group: user.group,
      account_number: user.account_number
    };
    const token = jwt.sign(jwtPayload, JWT_SECRET, { expiresIn: '15m' });

    // Log successful login for live users
    const { logLiveUserLogin } = require('../services/loginLogger');
    logLiveUserLogin({
      email: user.email,
      account_number: user.account_number,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      timestamp: new Date().toISOString()
    });

    return res.status(200).json({
      success: true,
      message: 'Login successful',
      token
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}


module.exports = { signup, login };