// const DemoUser = require('../models/demoUser.model');
// const { generateAccountNumber } = require('../services/accountNumber.service');
// const { hashPassword } = require('../services/password.service');
// const { generateReferralCode } = require('../services/referralCode.service');
// const { validationResult } = require('express-validator');
// const { Op } = require('sequelize');
// const TransactionService = require('../services/transaction.service');
// const logger = require('../services/logger.service');
// const { IdempotencyService } = require('../services/idempotency.service');

// /**
//  * Demo User Signup with transaction handling and deadlock prevention
//  */
// async function signup(req, res) {
//   const operationId = `demo_signup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
//   try {
//     // Validate request
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({ 
//         success: false, 
//         errors: errors.array() 
//       });
//     }

//     const {
//       name, phone_number, email, password, city, state, country, pincode,
//       security_question, security_answer, is_active, ...optionalFields
//     } = req.body;

//     // Generate idempotency key
//     const idempotencyKey = IdempotencyService.generateKey(req, 'demo_signup');
//     const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

//     if (isExisting) {
//       if (record.status === 'completed') {
//         logger.info('Returning cached response for duplicate demo signup', { 
//           idempotencyKey, 
//           operationId 
//         });
//         return res.status(201).json(record.response);
//       } else if (record.status === 'processing') {
//         return res.status(409).json({ 
//           success: false, 
//           message: 'Request is already being processed' 
//         });
//       }
//     }

//     logger.transactionStart('demo_user_signup', { 
//       operationId, 
//       email, 
//       phone_number 
//     });

//     // Execute signup within transaction
//     const result = await TransactionService.executeWithRetry(async (transaction) => {
//       // Check uniqueness within transaction
//       const existing = await DemoUser.findOne({
//         where: { [Op.or]: [{ email }, { phone_number }] },
//         transaction
//       });

//       if (existing) {
//         throw new Error('Email or phone number already exists');
//       }

//       // Generate unique account number
//       let account_number;
//       let unique = false;
//       let attempts = 0;
//       const maxAttempts = 10;

//       while (!unique && attempts < maxAttempts) {
//         account_number = generateAccountNumber('DEMO');
//         const exists = await DemoUser.findOne({ 
//           where: { account_number },
//           transaction
//         });
//         if (!exists) {
//           unique = true;
//         }
//         attempts++;
//       }

//       if (!unique) {
//         throw new Error('Unable to generate unique account number after maximum attempts');
//       }

//       // Hash password
//       const hashedPassword = await hashPassword(password);

//       // Handle file uploads
//       let address_proof_image = req.files && req.files.address_proof_image 
//         ? `/uploads/${req.files.address_proof_image[0].filename}` 
//         : null;
//       let id_proof_image = req.files && req.files.id_proof_image 
//         ? `/uploads/${req.files.id_proof_image[0].filename}` 
//         : null;

//       // Create user
//       const user = await DemoUser.create({
//         name, 
//         phone_number, 
//         email, 
//         password: hashedPassword, 
//         city, 
//         state, 
//         country, 
//         pincode,
//         security_question, 
//         security_answer, 
//         is_active, 
//         account_number,
//         address_proof_image, 
//         id_proof_image,
//         ...optionalFields
//       }, { transaction });

//       // Generate unique referral code
//       let referral_code;
//       let referralUnique = false;
//       let referralAttempts = 0;

//       while (!referralUnique && referralAttempts < maxAttempts) {
//         referral_code = generateReferralCode();
//         const exists = await DemoUser.findOne({ 
//           where: { referral_code },
//           transaction
//         });
//         if (!exists) {
//           referralUnique = true;
//         }
//         referralAttempts++;
//       }

//       if (!referralUnique) {
//         throw new Error('Unable to generate unique referral code after maximum attempts');
//       }

//       // Update user with referral code
//       await user.update({ referral_code }, { transaction });

//       logger.financial('demo_user_created', {
//         operationId,
//         userId: user.id,
//         account_number: user.account_number,
//         email: user.email
//       });

//       return {
//         success: true,
//         message: 'Demo user signup successful',
//         user: {
//           id: user.id,
//           account_number: user.account_number,
//           email: user.email,
//           referral_code: user.referral_code,
//           name: user.name,
//           is_active: user.is_active
//         }
//       };
//     });

//     // Mark idempotency as completed
//     await IdempotencyService.markCompleted(idempotencyKey, result);

//     logger.transactionSuccess('demo_user_signup', { 
//       operationId, 
//       userId: result.user.id 
//     });

//     return res.status(201).json(result);

//   } catch (error) {
//     logger.transactionFailure('demo_user_signup', error, { 
//       operationId, 
//       email: req.body.email 
//     });

//     // Mark idempotency as failed if we have the key
//     try {
//       const idempotencyKey = IdempotencyService.generateKey(req, 'demo_signup');
//       await IdempotencyService.markFailed(idempotencyKey, error);
//     } catch (idempotencyError) {
//       logger.error('Failed to mark idempotency as failed', { 
//         error: idempotencyError.message 
//       });
//     }

//     // Handle specific error types
//     if (error.message === 'Email or phone number already exists') {
//       return res.status(409).json({ 
//         success: false, 
//         message: error.message 
//       });
//     }

//     if (error.message.includes('Unable to generate unique')) {
//       return res.status(500).json({ 
//         success: false, 
//         message: 'System temporarily unavailable. Please try again.' 
//       });
//     }

//     return res.status(500).json({ 
//       success: false, 
//       message: 'Internal server error',
//       operationId 
//     });
//   }
// }

// module.exports = { signup };

const DemoUser = require('../models/demoUser.model');
const { generateAccountNumber } = require('../services/accountNumber.service');
const { hashPassword } = require('../services/password.service');
// const { generateReferralCode } = require('../services/referralCode.service'); // Removed as referral codes are not for demo users
const { validationResult } = require('express-validator');
const { Op } = require('sequelize');
const TransactionService = require('../services/transaction.service');
const logger = require('../services/logger.service');
const { IdempotencyService } = require('../services/idempotency.service');

/**
 * Demo User Signup with transaction handling and deadlock prevention
 */
async function signup(req, res) {
  const operationId = `demo_signup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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
      name, phone_number, email, password, city, state, country, pincode,
      security_question, security_answer, is_active,
      // Removed address_proof_image and id_proof_image from destructuring as they are not for demo users
      // address_proof_image, id_proof_image,
      ...optionalFields
    } = req.body;

    // Generate idempotency key
    const idempotencyKey = IdempotencyService.generateKey(req, 'demo_signup');
    const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

    if (isExisting) {
      if (record.status === 'completed') {
        logger.info('Returning cached response for duplicate demo signup', {
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

    logger.transactionStart('demo_user_signup', {
      operationId,
      email,
      phone_number
    });

    // Execute signup within transaction
    const result = await TransactionService.executeWithRetry(async (transaction) => {
      // Check uniqueness within transaction
      const existing = await DemoUser.findOne({
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
        account_number = generateAccountNumber('DEMO');
        const exists = await DemoUser.findOne({
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

      // Removed file upload handling for address_proof_image and id_proof_image
      // let address_proof_image = req.files && req.files.address_proof_image
      //   ? `/uploads/${req.files.address_proof_image[0].filename}`
      //   : null;
      // let id_proof_image = req.files && req.files.id_proof_image
      //   ? `/uploads/${req.files.id_proof_image[0].filename}`
      //   : null;

      // Create user
      const user = await DemoUser.create({
        name,
        phone_number,
        email,
        password: hashedPassword,
        city,
        state,
        country,
        pincode,
        security_question,
        security_answer,
        is_active,
        account_number,
        user_type: 'demo',
        // Removed address_proof_image and id_proof_image from user creation
        // address_proof_image,
        // id_proof_image,
        ...optionalFields
      }, { transaction });

      logger.financial('demo_user_created', {
        operationId,
        userId: user.id,
        account_number: user.account_number,
        email: user.email
      });

      return {
        success: true,
        message: 'Demo user signup successful',
        user: {
          id: user.id,
          account_number: user.account_number,
          email: user.email,
          name: user.name,
          is_active: user.is_active
        }
      };
    });

    // Mark idempotency as completed
    await IdempotencyService.markCompleted(idempotencyKey, result);

    logger.transactionSuccess('demo_user_signup', {
      operationId,
      userId: result.user.id
    });

    return res.status(201).json(result);

  } catch (error) {
    logger.transactionFailure('demo_user_signup', error, {
      operationId,
      email: req.body.email
    });

    // Mark idempotency as failed if we have the key
    try {
      const idempotencyKey = IdempotencyService.generateKey(req, 'demo_signup');
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

module.exports = { signup };

