const TransactionService = require('../services/transaction.service');
const FinancialService = require('../services/financial.service');
const logger = require('../services/logger.service');
const { IdempotencyService } = require('../services/idempotency.service');
const DemoUser = require('../models/demoUser.model');
const LiveUser = require('../models/liveUser.model');

/**
 * EXAMPLE: Referral commission distribution controller
 * Demonstrates transaction patterns for commission calculations and payouts
 */

/**
 * Calculate and distribute referral commission
 */
async function distributeReferralCommission(req, res) {
  const operationId = `referral_commission_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { 
      referrerUserId, 
      referredUserId, 
      commissionAmount, 
      commissionType, 
      userType,
      triggerEvent 
    } = req.body;

    // Generate idempotency key
    const idempotencyKey = IdempotencyService.generateKey(req, 'referral_commission');
    const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

    if (isExisting && record.status === 'completed') {
      return res.status(200).json(record.response);
    }

    logger.transactionStart('referral_commission_distribution', { 
      operationId, 
      referrerUserId, 
      referredUserId, 
      commissionAmount,
      commissionType 
    });

    const result = await TransactionService.executeWithRetry(async (transaction) => {
      const userModel = userType === 'live' ? LiveUser : DemoUser;
      
      // Lock both referrer and referred users
      const referrer = await userModel.findByPk(referrerUserId, {
        lock: transaction.LOCK.UPDATE,
        transaction
      });

      const referred = await userModel.findByPk(referredUserId, {
        lock: transaction.LOCK.UPDATE,
        transaction
      });

      if (!referrer || !referred) {
        throw new Error('Referrer or referred user not found');
      }

      // Validate referral relationship
      if (referred.referred_by_id !== referrerUserId) {
        throw new Error('Invalid referral relationship');
      }

      // Calculate commission based on type
      let finalCommissionAmount;
      if (commissionType === 'percentage') {
        // Assume commissionAmount is percentage (e.g., 10 for 10%)
        const referredBalance = parseFloat(referred.wallet_balance) || 0;
        finalCommissionAmount = (referredBalance * commissionAmount) / 100;
      } else {
        finalCommissionAmount = parseFloat(commissionAmount);
      }

      // Update referrer's commission balance
      const referrerResult = await FinancialService.updateWalletBalance(
        referrerUserId,
        finalCommissionAmount,
        userType,
        'referral_commission',
        { 
          referredUserId, 
          commissionType, 
          triggerEvent,
          operationId 
        }
      );

      // Create commission record
      // await ReferralCommission.create({
      //   referrerUserId,
      //   referredUserId,
      //   amount: finalCommissionAmount,
      //   commissionType,
      //   triggerEvent,
      //   status: 'completed',
      //   operationId
      // }, { transaction });

      logger.financial('referral_commission_distributed', {
        operationId,
        referrerUserId,
        referredUserId,
        commissionAmount: finalCommissionAmount,
        commissionType,
        triggerEvent,
        referrerNewBalance: referrerResult.newBalance
      });

      return {
        success: true,
        message: 'Referral commission distributed successfully',
        commission: {
          amount: finalCommissionAmount,
          referrerUserId,
          referredUserId,
          newReferrerBalance: referrerResult.newBalance,
          operationId
        }
      };
    });

    await IdempotencyService.markCompleted(idempotencyKey, result);
    logger.transactionSuccess('referral_commission_distribution', { operationId });

    return res.status(200).json(result);

  } catch (error) {
    logger.transactionFailure('referral_commission_distribution', error, { operationId });
    
    try {
      const idempotencyKey = IdempotencyService.generateKey(req, 'referral_commission');
      await IdempotencyService.markFailed(idempotencyKey, error);
    } catch (idempotencyError) {
      logger.error('Failed to mark idempotency as failed', { 
        error: idempotencyError.message 
      });
    }

    if (error.message.includes('not found') || error.message.includes('Invalid referral')) {
      return res.status(400).json({ 
        success: false, 
        message: error.message,
        operationId 
      });
    }

    return res.status(500).json({ 
      success: false, 
      message: 'Commission distribution failed',
      operationId 
    });
  }
}

/**
 * Process referral bonus for new user signup
 */
async function processSignupBonus(req, res) {
  const operationId = `signup_bonus_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { referredUserId, referralCode, userType } = req.body;

    logger.transactionStart('referral_signup_bonus', { 
      operationId, 
      referredUserId, 
      referralCode 
    });

    const result = await TransactionService.executeWithRetry(async (transaction) => {
      const userModel = userType === 'live' ? LiveUser : DemoUser;
      
      // Find referrer by referral code
      const referrer = await userModel.findOne({
        where: { referral_code: referralCode },
        lock: transaction.LOCK.UPDATE,
        transaction
      });

      if (!referrer) {
        throw new Error('Invalid referral code');
      }

      // Find referred user
      const referred = await userModel.findByPk(referredUserId, {
        lock: transaction.LOCK.UPDATE,
        transaction
      });

      if (!referred) {
        throw new Error('Referred user not found');
      }

      // Check if bonus already processed
      if (referred.signup_bonus_processed) {
        throw new Error('Signup bonus already processed');
      }

      // Define bonus amounts
      const REFERRER_BONUS = 50.00; // $50 for referrer
      const REFERRED_BONUS = 25.00; // $25 for referred user

      // Give bonus to referrer
      const referrerResult = await FinancialService.updateWalletBalance(
        referrer.id,
        REFERRER_BONUS,
        userType,
        'referral_signup_bonus',
        { 
          referredUserId, 
          bonusType: 'referrer',
          operationId 
        }
      );

      // Give bonus to referred user
      const referredResult = await FinancialService.updateWalletBalance(
        referredUserId,
        REFERRED_BONUS,
        userType,
        'signup_welcome_bonus',
        { 
          referrerUserId: referrer.id, 
          bonusType: 'referred',
          operationId 
        }
      );

      // Mark signup bonus as processed
      await referred.update({ 
        signup_bonus_processed: true,
        referred_by_id: referrer.id 
      }, { transaction });

      // Create bonus records
      // await ReferralBonus.bulkCreate([
      //   {
      //     userId: referrer.id,
      //     amount: REFERRER_BONUS,
      //     bonusType: 'referrer_signup',
      //     referredUserId,
      //     operationId
      //   },
      //   {
      //     userId: referredUserId,
      //     amount: REFERRED_BONUS,
      //     bonusType: 'referred_signup',
      //     referrerUserId: referrer.id,
      //     operationId
      //   }
      // ], { transaction });

      logger.financial('signup_bonuses_processed', {
        operationId,
        referrerUserId: referrer.id,
        referredUserId,
        referrerBonus: REFERRER_BONUS,
        referredBonus: REFERRED_BONUS,
        referrerNewBalance: referrerResult.newBalance,
        referredNewBalance: referredResult.newBalance
      });

      return {
        success: true,
        message: 'Signup bonuses processed successfully',
        bonuses: {
          referrer: {
            userId: referrer.id,
            amount: REFERRER_BONUS,
            newBalance: referrerResult.newBalance
          },
          referred: {
            userId: referredUserId,
            amount: REFERRED_BONUS,
            newBalance: referredResult.newBalance
          },
          operationId
        }
      };
    });

    logger.transactionSuccess('referral_signup_bonus', { operationId });
    return res.status(200).json(result);

  } catch (error) {
    logger.transactionFailure('referral_signup_bonus', error, { operationId });

    if (error.message.includes('Invalid referral') || 
        error.message.includes('not found') ||
        error.message.includes('already processed')) {
      return res.status(400).json({ 
        success: false, 
        message: error.message,
        operationId 
      });
    }

    return res.status(500).json({ 
      success: false, 
      message: 'Signup bonus processing failed',
      operationId 
    });
  }
}

/**
 * Get referral statistics for a user
 */
async function getReferralStats(req, res) {
  try {
    const { userId, userType } = req.params;

    const result = await TransactionService.executeWithRetry(async (transaction) => {
      const userModel = userType === 'live' ? LiveUser : DemoUser;
      
      // Get user's referral information
      const user = await userModel.findByPk(userId, {
        transaction,
        attributes: ['id', 'referral_code', 'referred_by_id']
      });

      if (!user) {
        throw new Error('User not found');
      }

      // Count total referrals
      const totalReferrals = await userModel.count({
        where: { referred_by_id: userId },
        transaction
      });

      // Calculate total commission earned (you would have a separate commission table)
      // const totalCommission = await ReferralCommission.sum('amount', {
      //   where: { referrerUserId: userId },
      //   transaction
      // });

      return {
        success: true,
        referralStats: {
          userId,
          referralCode: user.referral_code,
          totalReferrals,
          // totalCommissionEarned: totalCommission || 0,
          referredBy: user.referred_by_id
        }
      };
    });

    return res.status(200).json(result);

  } catch (error) {
    logger.error('Failed to fetch referral stats', { 
      error: error.message, 
      userId 
    });

    if (error.message === 'User not found') {
      return res.status(404).json({ 
        success: false, 
        message: error.message 
      });
    }

    return res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch referral statistics' 
    });
  }
}

module.exports = {
  distributeReferralCommission,
  processSignupBonus,
  getReferralStats
};