const TransactionService = require('../services/transaction.service');
const FinancialService = require('../services/financial.service');
const logger = require('../services/logger.service');
const { IdempotencyService } = require('../services/idempotency.service');
const { validationResult } = require('express-validator');

/**
 * EXAMPLE: Order placement controller with proper transaction handling
 * This demonstrates the pattern for all financial operations
 */

/**
 * Place a new trade order
 */
async function placeOrder(req, res) {
  const operationId = `place_order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }

    const { userId, symbol, orderType, volume, price, stopLoss, takeProfit, userType } = req.body;

    // Generate idempotency key
    const idempotencyKey = IdempotencyService.generateKey(req, 'place_order');
    const { isExisting, record } = await IdempotencyService.checkIdempotency(idempotencyKey);

    if (isExisting && record.status === 'completed') {
      return res.status(200).json(record.response);
    }

    logger.transactionStart('place_order', { 
      operationId, 
      userId, 
      symbol, 
      orderType, 
      volume 
    });

    const result = await TransactionService.executeWithRetry(async (transaction) => {
      // Lock user for financial updates
      const userModel = userType === 'live' ? 
        require('../models/liveUser.model') : 
        require('../models/demoUser.model');
      
      const user = await userModel.findByPk(userId, {
        lock: transaction.LOCK.UPDATE,
        transaction
      });

      if (!user) {
        throw new Error('User not found');
      }

      // Calculate required margin
      const requiredMargin = calculateMargin(symbol, volume, price);
      
      if (parseFloat(user.wallet_balance) < requiredMargin) {
        throw new Error('Insufficient balance for this order');
      }

      // Create order record (assuming you have an Order model)
      // const order = await Order.create({
      //   userId,
      //   symbol,
      //   orderType,
      //   volume,
      //   price,
      //   stopLoss,
      //   takeProfit,
      //   status: 'pending',
      //   requiredMargin
      // }, { transaction });

      // Update user margin atomically
      const newMargin = parseFloat(user.margin) + requiredMargin;
      await user.update({ margin: newMargin }, { transaction });

      logger.financial('order_placed', {
        operationId,
        userId,
        // orderId: order.id,
        symbol,
        volume,
        requiredMargin,
        newMargin
      });

      return {
        success: true,
        message: 'Order placed successfully',
        // order: order.toJSON(),
        operationId
      };
    });

    await IdempotencyService.markCompleted(idempotencyKey, result);
    logger.transactionSuccess('place_order', { operationId });

    return res.status(201).json(result);

  } catch (error) {
    logger.transactionFailure('place_order', error, { operationId });
    
    try {
      const idempotencyKey = IdempotencyService.generateKey(req, 'place_order');
      await IdempotencyService.markFailed(idempotencyKey, error);
    } catch (idempotencyError) {
      logger.error('Failed to mark idempotency as failed', { 
        error: idempotencyError.message 
      });
    }

    if (error.message === 'User not found') {
      return res.status(404).json({ success: false, message: error.message });
    }

    if (error.message === 'Insufficient balance for this order') {
      return res.status(400).json({ success: false, message: error.message });
    }

    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      operationId 
    });
  }
}

/**
 * Close an existing order
 */
async function closeOrder(req, res) {
  const operationId = `close_order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    const { orderId, userId, userType } = req.body;

    logger.transactionStart('close_order', { operationId, orderId, userId });

    const result = await TransactionService.executeWithRetry(async (transaction) => {
      // Find and lock order
      // const order = await Order.findByPk(orderId, {
      //   lock: transaction.LOCK.UPDATE,
      //   transaction
      // });

      // if (!order || order.userId !== userId) {
      //   throw new Error('Order not found or access denied');
      // }

      // if (order.status !== 'open') {
      //   throw new Error('Order is not open');
      // }

      // Calculate profit/loss
      const currentPrice = await getCurrentPrice(req.body.symbol);
      const profitLoss = calculateProfitLoss(req.body.openPrice, currentPrice, req.body.volume, req.body.orderType);
      
      // Use FinancialService for atomic updates
      const financialResult = await FinancialService.performCombinedOperation(
        userId,
        {
          balance: profitLoss,
          margin: -req.body.requiredMargin, // Release margin
          profit: profitLoss
        },
        userType,
        'order_close',
        { orderId, currentPrice, profitLoss }
      );

      // Update order status
      // await order.update({
      //   status: 'closed',
      //   closePrice: currentPrice,
      //   profitLoss: profitLoss,
      //   closedAt: new Date()
      // }, { transaction });

      logger.financial('order_closed', {
        operationId,
        orderId,
        userId,
        profitLoss,
        currentPrice,
        financialResult
      });

      return {
        success: true,
        message: 'Order closed successfully',
        // order: order.toJSON(),
        profitLoss,
        operationId
      };
    });

    logger.transactionSuccess('close_order', { operationId });
    return res.status(200).json(result);

  } catch (error) {
    logger.transactionFailure('close_order', error, { operationId });

    if (error.message.includes('not found') || error.message.includes('access denied')) {
      return res.status(404).json({ success: false, message: error.message });
    }

    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error',
      operationId 
    });
  }
}

// Helper functions (implement based on your trading logic)
function calculateMargin(symbol, volume, price) {
  // Implement margin calculation logic
  return volume * price * 0.01; // Example: 1% margin
}

async function getCurrentPrice(symbol) {
  // Implement price fetching from your data provider
  return 1.2345; // Example price
}

function calculateProfitLoss(openPrice, closePrice, volume, orderType) {
  // Implement P&L calculation logic
  const priceDiff = orderType === 'buy' ? closePrice - openPrice : openPrice - closePrice;
  return priceDiff * volume;
}

module.exports = {
  placeOrder,
  closeOrder
};