const TransactionService = require('../services/transaction.service');
const FinancialService = require('../services/financial.service');
const logger = require('../services/logger.service');
const { IdempotencyService } = require('../services/idempotency.service');
const { validationResult } = require('express-validator');

/**
 * EXAMPLE: Wallet operations controller
 * Demonstrates transaction patterns for balance updates, deposits, withdrawals
 */

/**
 * Deposit funds to user wallet
 */
async function deposit(req, res) {
  const operationId = `deposit_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { userId, amount, paymentMethod, transactionRef, userType } = req.body;

    // Generate idempotency key
    const idempotencyKey = IdempotencyService.generateKey(req, 'deposit');
    const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

    if (isExisting && record.status === 'completed') {
      return res.status(200).json(record.response);
    }

    logger.transactionStart('wallet_deposit', { 
      operationId, 
      userId, 
      amount, 
      paymentMethod 
    });

    const result = await FinancialService.updateWalletBalance(
      userId,
      parseFloat(amount),
      userType,
      'deposit',
      { 
        paymentMethod, 
        transactionRef, 
        operationId 
      }
    );

    // Create transaction record (assuming you have a Transaction model)
    await TransactionService.executeWithRetry(async (transaction) => {
      // await Transaction.create({
      //   userId,
      //   type: 'deposit',
      //   amount: parseFloat(amount),
      //   status: 'completed',
      //   paymentMethod,
      //   transactionRef,
      //   operationId
      // }, { transaction });
    });

    const response = {
      success: true,
      message: 'Deposit successful',
      transaction: {
        operationId,
        amount: parseFloat(amount),
        newBalance: result.newBalance,
        timestamp: new Date().toISOString()
      }
    };

    await IdempotencyService.markCompleted(idempotencyKey, response);
    logger.transactionSuccess('wallet_deposit', { operationId });

    return res.status(200).json(response);

  } catch (error) {
    logger.transactionFailure('wallet_deposit', error, { operationId });
    
    try {
      const idempotencyKey = IdempotencyService.generateKey(req, 'deposit');
      await IdempotencyService.markFailed(idempotencyKey, error);
    } catch (idempotencyError) {
      logger.error('Failed to mark idempotency as failed', { 
        error: idempotencyError.message 
      });
    }

    return res.status(500).json({ 
      success: false, 
      message: 'Deposit failed',
      operationId 
    });
  }
}

/**
 * Withdraw funds from user wallet
 */
async function withdraw(req, res) {
  const operationId = `withdraw_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { userId, amount, withdrawalMethod, bankDetails, userType } = req.body;

    // Generate idempotency key
    const idempotencyKey = IdempotencyService.generateKey(req, 'withdraw');
    const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

    if (isExisting && record.status === 'completed') {
      return res.status(200).json(record.response);
    }

    logger.transactionStart('wallet_withdraw', { 
      operationId, 
      userId, 
      amount, 
      withdrawalMethod 
    });

    // Validate withdrawal amount is negative for debit
    const withdrawalAmount = -Math.abs(parseFloat(amount));

    const result = await FinancialService.updateWalletBalance(
      userId,
      withdrawalAmount,
      userType,
      'withdrawal',
      { 
        withdrawalMethod, 
        bankDetails, 
        operationId 
      }
    );

    // Create withdrawal request record
    await TransactionService.executeWithRetry(async (transaction) => {
      // await WithdrawalRequest.create({
      //   userId,
      //   amount: Math.abs(withdrawalAmount),
      //   status: 'pending',
      //   withdrawalMethod,
      //   bankDetails,
      //   operationId
      // }, { transaction });
    });

    const response = {
      success: true,
      message: 'Withdrawal request submitted',
      transaction: {
        operationId,
        amount: Math.abs(withdrawalAmount),
        newBalance: result.newBalance,
        status: 'pending_approval',
        timestamp: new Date().toISOString()
      }
    };

    await IdempotencyService.markCompleted(idempotencyKey, response);
    logger.transactionSuccess('wallet_withdraw', { operationId });

    return res.status(200).json(response);

  } catch (error) {
    logger.transactionFailure('wallet_withdraw', error, { operationId });
    
    try {
      const idempotencyKey = IdempotencyService.generateKey(req, 'withdraw');
      await IdempotencyService.markFailed(idempotencyKey, error);
    } catch (idempotencyError) {
      logger.error('Failed to mark idempotency as failed', { 
        error: idempotencyError.message 
      });
    }

    if (error.message.includes('Insufficient balance')) {
      return res.status(400).json({ 
        success: false, 
        message: error.message,
        operationId 
      });
    }

    return res.status(500).json({ 
      success: false, 
      message: 'Withdrawal failed',
      operationId 
    });
  }
}

/**
 * Transfer funds between users (internal transfer)
 */
async function transfer(req, res) {
  const operationId = `transfer_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { fromUserId, toUserId, amount, userType, description } = req.body;

    // Generate idempotency key
    const idempotencyKey = IdempotencyService.generateKey(req, 'transfer');
    const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

    if (isExisting && record.status === 'completed') {
      return res.status(200).json(record.response);
    }

    logger.transactionStart('wallet_transfer', { 
      operationId, 
      fromUserId, 
      toUserId, 
      amount 
    });

    const transferAmount = parseFloat(amount);

    const result = await TransactionService.executeWithRetry(async (transaction) => {
      // Debit from sender
      const senderResult = await FinancialService.updateWalletBalance(
        fromUserId,
        -transferAmount,
        userType,
        'transfer_out',
        { toUserId, operationId, description }
      );

      // Credit to receiver
      const receiverResult = await FinancialService.updateWalletBalance(
        toUserId,
        transferAmount,
        userType,
        'transfer_in',
        { fromUserId, operationId, description }
      );

      // Create transfer record
      // await Transfer.create({
      //   fromUserId,
      //   toUserId,
      //   amount: transferAmount,
      //   status: 'completed',
      //   description,
      //   operationId
      // }, { transaction });

      return {
        sender: senderResult,
        receiver: receiverResult
      };
    });

    const response = {
      success: true,
      message: 'Transfer completed successfully',
      transaction: {
        operationId,
        amount: transferAmount,
        senderNewBalance: result.sender.newBalance,
        receiverNewBalance: result.receiver.newBalance,
        timestamp: new Date().toISOString()
      }
    };

    await IdempotencyService.markCompleted(idempotencyKey, response);
    logger.transactionSuccess('wallet_transfer', { operationId });

    return res.status(200).json(response);

  } catch (error) {
    logger.transactionFailure('wallet_transfer', error, { operationId });
    
    try {
      const idempotencyKey = IdempotencyService.generateKey(req, 'transfer');
      await IdempotencyService.markFailed(idempotencyKey, error);
    } catch (idempotencyError) {
      logger.error('Failed to mark idempotency as failed', { 
        error: idempotencyError.message 
      });
    }

    if (error.message.includes('Insufficient balance')) {
      return res.status(400).json({ 
        success: false, 
        message: error.message,
        operationId 
      });
    }

    return res.status(500).json({ 
      success: false, 
      message: 'Transfer failed',
      operationId 
    });
  }
}

module.exports = {
  deposit,
  withdraw,
  transfer
};