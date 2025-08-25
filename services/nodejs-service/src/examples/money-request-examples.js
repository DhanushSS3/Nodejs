/**
 * Money Request System Usage Examples
 * Demonstrates the complete flow from user request to admin approval/rejection
 */

const moneyRequestService = require('../services/moneyRequest.service');
const walletService = require('../services/wallet.service');

async function demonstrateMoneyRequestFlow() {
  console.log('=== Money Request System Demo ===\n');

  try {
    // Example user ID (assuming user exists)
    const userId = 1;
    const adminId = 1;

    console.log('1. Creating deposit request...');
    
    // User creates a deposit request
    const depositRequest = await moneyRequestService.createRequest({
      userId: userId,
      type: 'deposit',
      amount: 1000.00,
      currency: 'USD'
    });
    
    console.log('Deposit request created:', {
      id: depositRequest.id,
      request_id: depositRequest.request_id,
      type: depositRequest.type,
      amount: depositRequest.amount,
      status: depositRequest.status
    });

    console.log('\n2. Creating withdrawal request...');
    
    // User creates a withdrawal request
    const withdrawRequest = await moneyRequestService.createRequest({
      userId: userId,
      type: 'withdraw',
      amount: 500.00,
      currency: 'USD'
    });
    
    console.log('Withdrawal request created:', {
      id: withdrawRequest.id,
      request_id: withdrawRequest.request_id,
      type: withdrawRequest.type,
      amount: withdrawRequest.amount,
      status: withdrawRequest.status
    });

    console.log('\n3. Admin reviewing pending requests...');
    
    // Admin gets pending requests
    const pendingRequests = await moneyRequestService.getPendingRequests({
      limit: 10,
      offset: 0
    });
    
    console.log(`Found ${pendingRequests.total} pending requests:`);
    pendingRequests.requests.forEach(req => {
      console.log(`- ${req.request_id}: ${req.type} $${req.amount} by ${req.user.first_name} ${req.user.last_name}`);
    });

    console.log('\n4. Admin approving deposit request...');
    
    // Admin approves the deposit
    const approvedDeposit = await moneyRequestService.approveRequest(
      depositRequest.id,
      adminId,
      'Deposit approved - bank transfer verified'
    );
    
    console.log('Deposit approved:', {
      request_id: approvedDeposit.request_id,
      status: approvedDeposit.status,
      transaction_id: approvedDeposit.transaction_id,
      approved_at: approvedDeposit.approved_at
    });

    console.log('\n5. Admin rejecting withdrawal request...');
    
    // Admin rejects the withdrawal
    const rejectedWithdraw = await moneyRequestService.rejectRequest(
      withdrawRequest.id,
      adminId,
      'Insufficient documentation provided'
    );
    
    console.log('Withdrawal rejected:', {
      request_id: rejectedWithdraw.request_id,
      status: rejectedWithdraw.status,
      notes: rejectedWithdraw.notes,
      approved_at: rejectedWithdraw.approved_at
    });

    console.log('\n6. Checking user balance after approved deposit...');
    
    // Check user's current balance
    const currentBalance = await walletService.getCurrentBalance(userId, 'live');
    console.log(`User's current balance: $${currentBalance}`);

    console.log("\n7. Getting user's request history...");
    
    // Get user's request history
    const userHistory = await moneyRequestService.getUserRequests(userId, {
      limit: 10,
      offset: 0
    });
    
    console.log(`User has ${userHistory.length} requests in history:`);
    userHistory.forEach(req => {
      console.log(`- ${req.request_id}: ${req.type} $${req.amount} - ${req.status} (${req.created_at})`);
    });

    console.log('\n8. Getting request statistics...');
    
    // Get statistics
    const stats = await moneyRequestService.getRequestStatistics({
      startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // Last 30 days
      endDate: new Date()
    });
    
    console.log('Request statistics (last 30 days):');
    stats.forEach(stat => {
      console.log(`- ${stat.type} ${stat.status}: ${stat.count} requests, $${stat.total_amount || 0} total`);
    });

  } catch (error) {
    console.error('Demo error:', error.message);
  }
}

async function demonstrateErrorHandling() {
  console.log('\n=== Error Handling Examples ===\n');

  try {
    console.log('1. Testing insufficient balance withdrawal...');
    
    // Try to create withdrawal request with insufficient balance
    await moneyRequestService.createRequest({
      userId: 999, // Assuming this user has low/no balance
      type: 'withdraw',
      amount: 10000.00, // Large amount
      currency: 'USD'
    });
    
  } catch (error) {
    console.log('Expected error caught:', error.message);
  }

  try {
    console.log('\n2. Testing invalid user...');
    
    // Try to create request for non-existent user
    await moneyRequestService.createRequest({
      userId: 99999, // Non-existent user
      type: 'deposit',
      amount: 100.00,
      currency: 'USD'
    });
    
  } catch (error) {
    console.log('Expected error caught:', error.message);
  }

  try {
    console.log('\n3. Testing invalid amount...');
    
    // Try to create request with invalid amount
    await moneyRequestService.createRequest({
      userId: 1,
      type: 'deposit',
      amount: -100.00, // Negative amount
      currency: 'USD'
    });
    
  } catch (error) {
    console.log('Expected error caught:', error.message);
  }
}

async function demonstrateWorkflowScenarios() {
  console.log('\n=== Workflow Scenarios ===\n');

  const userId = 1;
  const adminId = 1;

  try {
    console.log('Scenario 1: Bulk deposit processing...');
    
    // Create multiple deposit requests
    const depositRequests = [];
    for (let i = 0; i < 3; i++) {
      const request = await moneyRequestService.createRequest({
        userId: userId,
        type: 'deposit',
        amount: 100 * (i + 1), // $100, $200, $300
        currency: 'USD'
      });
      depositRequests.push(request);
      console.log(`Created deposit request: ${request.request_id} for $${request.amount}`);
    }

    console.log('\nProcessing deposits in batch...');
    
    // Admin processes all deposits
    for (const request of depositRequests) {
      const approved = await moneyRequestService.approveRequest(
        request.id,
        adminId,
        `Batch deposit ${request.request_id} approved`
      );
      console.log(`Approved: ${approved.request_id} -> Transaction: ${approved.transaction_id}`);
    }

    console.log('\nScenario 2: Mixed request processing...');
    
    // Create mixed requests
    const mixedRequests = [
      { type: 'deposit', amount: 500 },
      { type: 'withdraw', amount: 200 },
      { type: 'deposit', amount: 300 }
    ];

    for (const reqData of mixedRequests) {
      const request = await moneyRequestService.createRequest({
        userId: userId,
        type: reqData.type,
        amount: reqData.amount,
        currency: 'USD'
      });
      
      // Randomly approve or reject
      const shouldApprove = Math.random() > 0.3; // 70% approval rate
      
      if (shouldApprove) {
        await moneyRequestService.approveRequest(
          request.id,
          adminId,
          `${reqData.type} approved via workflow`
        );
        console.log(`✅ ${request.request_id}: ${reqData.type} $${reqData.amount} - APPROVED`);
      } else {
        await moneyRequestService.rejectRequest(
          request.id,
          adminId,
          'Random rejection for demo purposes'
        );
        console.log(`❌ ${request.request_id}: ${reqData.type} $${reqData.amount} - REJECTED`);
      }
    }

  } catch (error) {
    console.error('Workflow scenario error:', error.message);
  }
}

// Performance testing
async function performanceTest() {
  console.log('\n=== Performance Test ===\n');

  const startTime = Date.now();
  const userId = 1;
  const adminId = 1;
  const requestCount = 10;

  try {
    console.log(`Creating ${requestCount} requests...`);
    
    const requests = [];
    for (let i = 0; i < requestCount; i++) {
      const request = await moneyRequestService.createRequest({
        userId: userId,
        type: i % 2 === 0 ? 'deposit' : 'withdraw',
        amount: Math.floor(Math.random() * 1000) + 100, // $100-$1100
        currency: 'USD'
      });
      requests.push(request);
    }

    console.log(`Processing ${requestCount} requests...`);
    
    for (const request of requests) {
      await moneyRequestService.approveRequest(
        request.id,
        adminId,
        'Performance test approval'
      );
    }

    const endTime = Date.now();
    const duration = endTime - startTime;
    
    console.log(`Performance test completed:`);
    console.log(`- ${requestCount} requests processed`);
    console.log(`- Total time: ${duration}ms`);
    console.log(`- Average time per request: ${(duration / requestCount).toFixed(2)}ms`);

  } catch (error) {
    console.error('Performance test error:', error.message);
  }
}

// Run examples
async function runExamples() {
  await demonstrateMoneyRequestFlow();
  await demonstrateErrorHandling();
  await demonstrateWorkflowScenarios();
  await performanceTest();
}

// Export for use in other files
module.exports = {
  demonstrateMoneyRequestFlow,
  demonstrateErrorHandling,
  demonstrateWorkflowScenarios,
  performanceTest,
  runExamples
};

// Run if called directly
if (require.main === module) {
  runExamples().catch(console.error);
}
