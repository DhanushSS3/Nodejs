/**
 * Test Script: Order Lifecycle Service
 * Purpose: Test the complete lifecycle ID management system
 */

const orderLifecycleService = require('../src/services/orderLifecycle.service');
const idGenerator = require('../src/services/idGenerator.service');

class LifecycleServiceTest {
  constructor() {
    this.testResults = [];
    this.testOrder = null;
  }

  /**
   * Log test result
   */
  logTest(testName, passed, message = '') {
    const result = { testName, passed, message, timestamp: new Date().toISOString() };
    this.testResults.push(result);
    
    const status = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${status} ${testName}${message ? ': ' + message : ''}`);
    
    return passed;
  }

  /**
   * Test 1: Basic ID storage and retrieval
   */
  async testBasicIdStorage() {
    try {
      // Generate test order
      const order_id = await idGenerator.generateOrderId();
      this.testOrder = order_id;
      
      // Store order_id
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'order_id', 
        order_id, 
        'Test order creation'
      );
      
      // Retrieve it
      const retrievedId = await orderLifecycleService.getActiveLifecycleId(order_id, 'order_id');
      
      return this.logTest(
        'Basic ID Storage', 
        retrievedId === order_id,
        `Expected: ${order_id}, Got: ${retrievedId}`
      );
      
    } catch (error) {
      return this.logTest('Basic ID Storage', false, error.message);
    }
  }

  /**
   * Test 2: ID replacement logic
   */
  async testIdReplacement() {
    try {
      const order_id = this.testOrder;
      
      // Add first stoploss
      const stoploss_id_1 = await idGenerator.generateStopLossId();
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'stoploss_id', 
        stoploss_id_1, 
        'First stoploss'
      );
      
      // Add second stoploss (should replace first)
      const stoploss_id_2 = await idGenerator.generateStopLossId();
      await orderLifecycleService.addLifecycleId(
        order_id, 
        'stoploss_id', 
        stoploss_id_2, 
        'Second stoploss'
      );
      
      // Check active ID is the second one
      const activeId = await orderLifecycleService.getActiveLifecycleId(order_id, 'stoploss_id');
      
      // Check first ID was marked as replaced
      const history = await orderLifecycleService.getLifecycleHistory(order_id);
      const firstStoploss = history.records.find(r => r.lifecycle_id === stoploss_id_1);
      
      const activeCorrect = activeId === stoploss_id_2;
      const replacedCorrect = firstStoploss && firstStoploss.status === 'replaced';
      
      return this.logTest(
        'ID Replacement Logic', 
        activeCorrect && replacedCorrect,
        `Active: ${activeCorrect}, Replaced: ${replacedCorrect}`
      );
      
    } catch (error) {
      return this.logTest('ID Replacement Logic', false, error.message);
    }
  }

  /**
   * Test 3: Status updates
   */
  async testStatusUpdates() {
    try {
      const order_id = this.testOrder;
      
      // Get current active stoploss
      const activeStoplossId = await orderLifecycleService.getActiveLifecycleId(order_id, 'stoploss_id');
      
      // Mark it as executed
      await orderLifecycleService.updateLifecycleStatus(
        activeStoplossId, 
        'executed', 
        'Executed by provider'
      );
      
      // Verify status was updated
      const history = await orderLifecycleService.getLifecycleHistory(order_id);
      const executedStoploss = history.records.find(r => r.lifecycle_id === activeStoplossId);
      
      return this.logTest(
        'Status Updates', 
        executedStoploss && executedStoploss.status === 'executed',
        `Status: ${executedStoploss?.status}`
      );
      
    } catch (error) {
      return this.logTest('Status Updates', false, error.message);
    }
  }

  /**
   * Test 4: ID resolution (find order by lifecycle ID)
   */
  async testIdResolution() {
    try {
      const order_id = this.testOrder;
      
      // Get all lifecycle IDs for this order
      const history = await orderLifecycleService.getLifecycleHistory(order_id);
      
      let allResolved = true;
      let testedIds = 0;
      
      // Test that each lifecycle ID resolves back to the correct order
      for (const record of history.records) {
        const resolvedOrderId = await orderLifecycleService.findOrderByLifecycleId(record.lifecycle_id);
        if (resolvedOrderId !== order_id) {
          allResolved = false;
          break;
        }
        testedIds++;
      }
      
      return this.logTest(
        'ID Resolution', 
        allResolved && testedIds > 0,
        `Tested ${testedIds} IDs, All resolved: ${allResolved}`
      );
      
    } catch (error) {
      return this.logTest('ID Resolution', false, error.message);
    }
  }

  /**
   * Test 5: Complete lifecycle simulation
   */
  async testCompleteLifecycle() {
    try {
      // Create new test order
      const order_id = await idGenerator.generateOrderId();
      
      // 1. Place order
      await orderLifecycleService.addLifecycleId(order_id, 'order_id', order_id, 'Order placed');
      
      // 2. Add stoploss
      const stoploss_id_1 = await idGenerator.generateStopLossId();
      await orderLifecycleService.addLifecycleId(order_id, 'stoploss_id', stoploss_id_1, 'Stoploss added');
      
      // 3. Cancel stoploss
      const stoploss_cancel_id = await idGenerator.generateStopLossCancelId();
      await orderLifecycleService.addLifecycleId(order_id, 'stoploss_cancel_id', stoploss_cancel_id, 'Stoploss cancelled');
      await orderLifecycleService.updateLifecycleStatus(stoploss_id_1, 'cancelled', 'User cancelled');
      
      // 4. Add stoploss again
      const stoploss_id_2 = await idGenerator.generateStopLossId();
      await orderLifecycleService.addLifecycleId(order_id, 'stoploss_id', stoploss_id_2, 'Stoploss re-added');
      
      // 5. Add takeprofit
      const takeprofit_id = await idGenerator.generateTakeProfitId();
      await orderLifecycleService.addLifecycleId(order_id, 'takeprofit_id', takeprofit_id, 'Takeprofit added');
      
      // 6. Close order
      const close_id = await idGenerator.generateCloseOrderId();
      await orderLifecycleService.addLifecycleId(order_id, 'close_id', close_id, 'Order closed');
      
      // Verify complete history
      const history = await orderLifecycleService.getLifecycleHistory(order_id);
      
      const expectedTypes = ['order_id', 'stoploss_id', 'stoploss_cancel_id', 'stoploss_id', 'takeprofit_id', 'close_id'];
      const actualTypes = history.records.map(r => r.id_type);
      
      // Check we have all expected types
      const hasAllTypes = expectedTypes.every(type => actualTypes.includes(type));
      
      // Check we have the right number of records (6 total)
      const correctCount = history.records.length === 6;
      
      // Check active IDs are correct
      const activeStoploss = await orderLifecycleService.getActiveLifecycleId(order_id, 'stoploss_id');
      const activeTakeprofit = await orderLifecycleService.getActiveLifecycleId(order_id, 'takeprofit_id');
      const activeClose = await orderLifecycleService.getActiveLifecycleId(order_id, 'close_id');
      
      const activeIdsCorrect = (activeStoploss === stoploss_id_2) && 
                              (activeTakeprofit === takeprofit_id) && 
                              (activeClose === close_id);
      
      return this.logTest(
        'Complete Lifecycle Simulation', 
        hasAllTypes && correctCount && activeIdsCorrect,
        `Types: ${hasAllTypes}, Count: ${correctCount}, Active: ${activeIdsCorrect}`
      );
      
    } catch (error) {
      return this.logTest('Complete Lifecycle Simulation', false, error.message);
    }
  }

  /**
   * Test 6: Performance test
   */
  async testPerformance() {
    try {
      const startTime = Date.now();
      const testOrders = 10;
      const idsPerOrder = 5;
      
      // Create multiple orders with multiple IDs each
      for (let i = 0; i < testOrders; i++) {
        const order_id = await idGenerator.generateOrderId();
        
        // Add multiple lifecycle IDs
        await orderLifecycleService.addLifecycleId(order_id, 'order_id', order_id, 'Performance test order');
        await orderLifecycleService.addLifecycleId(order_id, 'stoploss_id', await idGenerator.generateStopLossId(), 'Performance test SL');
        await orderLifecycleService.addLifecycleId(order_id, 'takeprofit_id', await idGenerator.generateTakeProfitId(), 'Performance test TP');
        await orderLifecycleService.addLifecycleId(order_id, 'close_id', await idGenerator.generateCloseOrderId(), 'Performance test close');
        
        // Test retrieval
        await orderLifecycleService.getLifecycleHistory(order_id);
      }
      
      const duration = Date.now() - startTime;
      const totalOperations = testOrders * (idsPerOrder + 1); // +1 for history retrieval
      const opsPerSecond = (totalOperations / duration) * 1000;
      
      return this.logTest(
        'Performance Test', 
        duration < 5000, // Should complete in under 5 seconds
        `${testOrders} orders, ${totalOperations} ops in ${duration}ms (${opsPerSecond.toFixed(2)} ops/sec)`
      );
      
    } catch (error) {
      return this.logTest('Performance Test', false, error.message);
    }
  }

  /**
   * Run all tests
   */
  async runAllTests() {
    console.log('🧪 Starting Order Lifecycle Service Tests...\n');
    
    const tests = [
      () => this.testBasicIdStorage(),
      () => this.testIdReplacement(),
      () => this.testStatusUpdates(),
      () => this.testIdResolution(),
      () => this.testCompleteLifecycle(),
      () => this.testPerformance()
    ];
    
    let passed = 0;
    let failed = 0;
    
    for (const test of tests) {
      try {
        const result = await test();
        if (result) passed++;
        else failed++;
      } catch (error) {
        console.log(`❌ FAIL Test execution error: ${error.message}`);
        failed++;
      }
    }
    
    // Print summary
    console.log('\n📊 Test Results Summary:');
    console.log('========================');
    console.log(`Total Tests: ${passed + failed}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
    
    if (failed === 0) {
      console.log('\n🎉 All tests passed! Lifecycle service is working correctly.');
    } else {
      console.log(`\n⚠️  ${failed} test(s) failed. Please review the implementation.`);
    }
    
    return failed === 0;
  }
}

// Run tests if called directly
if (require.main === module) {
  const tester = new LifecycleServiceTest();
  
  tester.runAllTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((error) => {
      console.error('💥 Test execution failed:', error);
      process.exit(1);
    });
}

module.exports = LifecycleServiceTest;
