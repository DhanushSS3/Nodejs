/**
 * Wallet Service Usage Examples
 * Demonstrates how to use the wallet service for various transaction types
 */

const walletService = require('../services/wallet.service');
const idGenerator = require('../services/idGenerator.service');

// Example usage functions
async function exampleUsage() {
  
  // 1. ID Generation Examples
  console.log('=== ID Generation Examples ===');
  console.log('Order ID:', idGenerator.generateOrderId());
  console.log('Transaction ID:', idGenerator.generateTransactionId());
  console.log('Stop Loss ID:', idGenerator.generateStopLossId());
  console.log('Take Profit ID:', idGenerator.generateTakeProfitId());
  console.log('Cancel Order ID:', idGenerator.generateCancelOrderId());
  console.log('Close Order ID:', idGenerator.generateCloseOrderId());
  
  // Generate with different digit lengths
  console.log('16-digit Order ID:', idGenerator.generateOrderId(16));
  console.log('8-digit Transaction ID:', idGenerator.generateTransactionId(8));

  // 2. Wallet Transaction Examples
  console.log('\n=== Wallet Transaction Examples ===');
  
  try {
    const userId = 1;
    const userType = 'live';
    
    // Deposit example
    const deposit = await walletService.deposit(
      userId, 
      userType, 
      1000.00, 
      'PAY_REF_123456', 
      1, // admin ID
      'Initial deposit via bank transfer'
    );
    console.log('Deposit transaction:', deposit.transaction_id);

    // Trading profit example
    const profit = await walletService.addProfit(
      userId,
      userType,
      150.75,
      12345, // order ID
      { 
        symbol: 'EURUSD',
        lots: 0.1,
        open_price: 1.0850,
        close_price: 1.0865
      }
    );
    console.log('Profit transaction:', profit.transaction_id);

    // Commission deduction example
    const commission = await walletService.deductCommission(
      userId,
      userType,
      5.00,
      12345, // same order ID
      {
        commission_rate: 0.05,
        symbol: 'EURUSD'
      }
    );
    console.log('Commission transaction:', commission.transaction_id);

    // Swap example (overnight fee)
    const swap = await walletService.addSwap(
      userId,
      userType,
      -2.50, // negative swap (charge)
      12345,
      {
        swap_rate: -0.25,
        days: 1
      }
    );
    console.log('Swap transaction:', swap.transaction_id);

    // Manual adjustment example
    const adjustment = await walletService.makeAdjustment(
      userId,
      userType,
      50.00,
      1, // admin ID
      'Compensation for system downtime',
      {
        reason: 'system_compensation',
        downtime_duration: '2 hours'
      }
    );
    console.log('Adjustment transaction:', adjustment.transaction_id);

    // Get transaction history
    const history = await walletService.getTransactionHistory(userId, userType, {
      page: 1,
      limit: 10,
      type: 'profit'
    });
    console.log('Transaction history:', history.pagination);

    // Get balance summary
    const summary = await walletService.getBalanceSummary(userId, userType);
    console.log('Balance summary:', summary);

  } catch (error) {
    console.error('Transaction error:', error.message);
  }
}

// Batch ID generation example
function batchIdExample() {
  console.log('\n=== Batch ID Generation ===');
  
  const orderIds = idGenerator.generateBatch('ORD', 5);
  console.log('5 Order IDs:', orderIds);
  
  const transactionIds = idGenerator.generateBatch('TXN', 3, 12);
  console.log('3 Transaction IDs (12 digits):', transactionIds);
}

// ID validation examples
function validationExamples() {
  console.log('\n=== ID Validation Examples ===');
  
  const orderId = idGenerator.generateOrderId();
  console.log('Generated Order ID:', orderId);
  console.log('Is valid Order ID:', idGenerator.validateId(orderId, 'ORD'));
  console.log('Is valid Transaction ID:', idGenerator.validateId(orderId, 'TXN'));
  
  // Extract timestamp
  const timestamp = idGenerator.extractTimestamp(orderId, 'ORD');
  if (timestamp) {
    console.log('Extracted timestamp:', new Date(timestamp));
  }
}

// Performance test
async function performanceTest() {
  console.log('\n=== Performance Test ===');
  
  const startTime = Date.now();
  const ids = [];
  
  // Generate 1000 IDs
  for (let i = 0; i < 1000; i++) {
    ids.push(idGenerator.generateTransactionId());
  }
  
  const endTime = Date.now();
  const uniqueIds = new Set(ids);
  
  console.log(`Generated ${ids.length} IDs in ${endTime - startTime}ms`);
  console.log(`Unique IDs: ${uniqueIds.size}`);
  console.log(`Collision rate: ${((ids.length - uniqueIds.size) / ids.length * 100).toFixed(4)}%`);
}

// Export examples for testing
module.exports = {
  exampleUsage,
  batchIdExample,
  validationExamples,
  performanceTest
};

// Run examples if called directly
if (require.main === module) {
  (async () => {
    await exampleUsage();
    batchIdExample();
    validationExamples();
    await performanceTest();
  })();
}
