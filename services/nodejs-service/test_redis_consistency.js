const axios = require('axios');

/**
 * Redis Consistency Test Script
 * Tests the Redis sync functionality after admin operations
 */
class RedisConsistencyTester {
  constructor(baseUrl = 'http://localhost:3000', adminToken = null) {
    this.baseUrl = baseUrl;
    this.adminToken = adminToken;
    this.testResults = [];
  }

  /**
   * Log test result
   */
  logResult(testName, passed, details = {}) {
    const result = {
      test: testName,
      passed,
      timestamp: new Date().toISOString(),
      details
    };
    
    this.testResults.push(result);
    
    const status = passed ? '✅ PASS' : '❌ FAIL';
    console.log(`${status} - ${testName}`);
    
    if (!passed || Object.keys(details).length > 0) {
      console.log('   Details:', JSON.stringify(details, null, 2));
    }
  }

  /**
   * Check if Redis keys are consistent with database
   */
  async checkRedisConsistency(userId, userType, expectedBalance) {
    try {
      // Check user config cache
      const userConfigKey = `user:{${userType}:${userId}}:config`;
      const redisConfig = await redisCluster.hgetall(userConfigKey);
      
      // Check balance cache
      const balanceCacheKey = `user_balance:${userType}:${userId}`;
      const redisBalance = await redisCluster.get(balanceCacheKey);
      
      const configBalance = parseFloat(redisConfig.wallet_balance) || 0;
      const cacheBalance = parseFloat(redisBalance) || 0;
      
      const configMatches = Math.abs(configBalance - expectedBalance) < 0.01;
      const cacheMatches = Math.abs(cacheBalance - expectedBalance) < 0.01;
      
      return {
        config_exists: Object.keys(redisConfig).length > 0,
        cache_exists: redisBalance !== null,
        config_balance: configBalance,
        cache_balance: cacheBalance,
        expected_balance: expectedBalance,
        config_matches: configMatches,
        cache_matches: cacheMatches,
        all_consistent: configMatches && cacheMatches,
        last_updated: redisConfig.last_updated || 'not set'
      };
      
    } catch (error) {
      return {
        error: error.message,
        all_consistent: false
      };
    }
  }

  /**
   * Test superadmin deposit operation
   */
  async testSuperadminDeposit() {
    if (!this.adminToken) {
      this.logResult('Superadmin Deposit', false, { error: 'Admin token required' });
      return;
    }

    try {
      const userId = 1; // Test with user ID 1
      const userType = 'live';
      const depositAmount = 100.00;
      
      // Get initial balance
      const initialResponse = await axios.get(
        `${this.baseUrl}/api/superadmin/users/${userId}/balance?userType=${userType}`,
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      const initialBalance = initialResponse.data.data.balance;
      
      // Perform deposit
      const depositResponse = await axios.post(
        `${this.baseUrl}/api/superadmin/users/${userId}/deposit`,
        {
          userType,
          amount: depositAmount,
          notes: 'Redis consistency test deposit'
        },
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      const expectedBalance = initialBalance + depositAmount;
      
      // Wait a moment for Redis sync
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check Redis consistency
      const consistency = await this.checkRedisConsistency(userId, userType, expectedBalance);
      
      this.logResult('Superadmin Deposit', consistency.all_consistent, {
        initial_balance: initialBalance,
        deposit_amount: depositAmount,
        expected_balance: expectedBalance,
        redis_consistency: consistency
      });
      
    } catch (error) {
      this.logResult('Superadmin Deposit', false, { error: error.message });
    }
  }

  /**
   * Test superadmin withdrawal operation
   */
  async testSuperadminWithdrawal() {
    if (!this.adminToken) {
      this.logResult('Superadmin Withdrawal', false, { error: 'Admin token required' });
      return;
    }

    try {
      const userId = 1; // Test with user ID 1
      const userType = 'live';
      const withdrawalAmount = 50.00;
      
      // Get initial balance
      const initialResponse = await axios.get(
        `${this.baseUrl}/api/superadmin/users/${userId}/balance?userType=${userType}`,
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      const initialBalance = initialResponse.data.data.balance;
      
      if (initialBalance < withdrawalAmount) {
        this.logResult('Superadmin Withdrawal', false, { 
          error: 'Insufficient balance for test withdrawal',
          initial_balance: initialBalance,
          withdrawal_amount: withdrawalAmount
        });
        return;
      }
      
      // Perform withdrawal
      const withdrawalResponse = await axios.post(
        `${this.baseUrl}/api/superadmin/users/${userId}/withdraw`,
        {
          userType,
          amount: withdrawalAmount,
          notes: 'Redis consistency test withdrawal'
        },
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      const expectedBalance = initialBalance - withdrawalAmount;
      
      // Wait a moment for Redis sync
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check Redis consistency
      const consistency = await this.checkRedisConsistency(userId, userType, expectedBalance);
      
      this.logResult('Superadmin Withdrawal', consistency.all_consistent, {
        initial_balance: initialBalance,
        withdrawal_amount: withdrawalAmount,
        expected_balance: expectedBalance,
        redis_consistency: consistency
      });
      
    } catch (error) {
      this.logResult('Superadmin Withdrawal', false, { error: error.message });
    }
  }

  /**
   * Test Redis health endpoints
   */
  async testRedisHealthEndpoints() {
    if (!this.adminToken) {
      this.logResult('Redis Health Endpoints', false, { error: 'Admin token required' });
      return;
    }

    try {
      // Test health status endpoint
      const healthResponse = await axios.get(
        `${this.baseUrl}/api/redis-health/status`,
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      const isHealthy = healthResponse.data.success && 
                       healthResponse.data.data.status === 'healthy';
      
      // Test cluster info endpoint
      const clusterResponse = await axios.get(
        `${this.baseUrl}/api/redis-health/cluster-info`,
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      const hasClusterInfo = clusterResponse.data.success && 
                            clusterResponse.data.data.nodes.length > 0;
      
      this.logResult('Redis Health Endpoints', isHealthy && hasClusterInfo, {
        health_status: healthResponse.data.data.status,
        cluster_nodes: clusterResponse.data.data.nodes.length,
        total_keys: clusterResponse.data.data.total_keys
      });
      
    } catch (error) {
      this.logResult('Redis Health Endpoints', false, { error: error.message });
    }
  }

  /**
   * Test user consistency check endpoint
   */
  async testUserConsistencyCheck() {
    if (!this.adminToken) {
      this.logResult('User Consistency Check', false, { error: 'Admin token required' });
      return;
    }

    try {
      const userId = 1;
      const userType = 'live';
      
      const response = await axios.get(
        `${this.baseUrl}/api/redis-health/user/${userId}/consistency?userType=${userType}`,
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      const isConsistent = response.data.success && 
                          response.data.data.is_consistent;
      
      this.logResult('User Consistency Check', isConsistent, {
        user_id: userId,
        user_type: userType,
        consistency_result: response.data.data.consistency_check
      });
      
    } catch (error) {
      this.logResult('User Consistency Check', false, { error: error.message });
    }
  }

  /**
   * Test admin user update (especially group changes)
   */
  async testAdminUserUpdate() {
    if (!this.adminToken) {
      this.logResult('Admin User Update', false, { error: 'Admin token required' });
      return;
    }

    try {
      const userId = 1;
      const userType = 'live';
      
      // Get initial user data
      const initialResponse = await axios.get(
        `${this.baseUrl}/api/redis-health/user/${userId}/consistency?userType=${userType}`,
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      const initialGroup = initialResponse.data.data.database.group;
      const newGroup = initialGroup === 'VIP' ? 'Standard' : 'VIP'; // Toggle group
      
      // Perform admin user update (change group)
      const updateResponse = await axios.put(
        `${this.baseUrl}/api/admin/users/live-users/${userId}`,
        {
          group: newGroup,
          leverage: 200 // Also change leverage
        },
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      // Wait a moment for Redis sync
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Check Redis consistency after update
      const consistency = await this.checkRedisConsistency(userId, userType, null);
      
      // Check if group was updated in Redis via API
      const redisCheckResponse = await axios.get(
        `${this.baseUrl}/api/redis-health/user/${userId}/consistency?userType=${userType}`,
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      const redisConfig = redisCheckResponse.data.data.redis_config;
      const redisGroup = redisConfig.group;
      const redisLeverage = parseInt(redisConfig.leverage) || 0;
      
      const groupUpdated = redisGroup === newGroup;
      const leverageUpdated = redisLeverage === 200;
      
      this.logResult('Admin User Update', groupUpdated && leverageUpdated, {
        initial_group: initialGroup,
        new_group: newGroup,
        redis_group: redisGroup,
        group_updated: groupUpdated,
        leverage_updated: leverageUpdated,
        redis_consistency: consistency
      });
      
    } catch (error) {
      this.logResult('Admin User Update', false, { error: error.message });
    }
  }

  /**
   * Test force refresh functionality
   */
  async testForceRefresh() {
    if (!this.adminToken) {
      this.logResult('Force Refresh User', false, { error: 'Admin token required' });
      return;
    }

    try {
      const userId = 1;
      const userType = 'live';
      
      const response = await axios.post(
        `${this.baseUrl}/api/redis-health/user/${userId}/force-refresh?userType=${userType}`,
        {},
        { headers: { Authorization: `Bearer ${this.adminToken}` } }
      );
      
      const refreshSuccessful = response.data.success;
      
      this.logResult('Force Refresh User', refreshSuccessful, {
        user_id: userId,
        user_type: userType,
        refreshed_fields: Object.keys(response.data.data.refreshed_fields || {})
      });
      
    } catch (error) {
      this.logResult('Force Refresh User', false, { error: error.message });
    }
  }

  /**
   * Run all tests
   */
  async runAllTests() {
    console.log('🧪 Starting Redis Consistency Tests...\n');
    
    // Test Redis health endpoints first
    await this.testRedisHealthEndpoints();
    await this.testUserConsistencyCheck();
    
    // Test admin operations
    await this.testSuperadminDeposit();
    await this.testSuperadminWithdrawal();
    
    // Test admin user updates
    await this.testAdminUserUpdate();
    
    // Test force refresh
    await this.testForceRefresh();
    
    // Print summary
    this.printSummary();
  }

  /**
   * Print test summary
   */
  printSummary() {
    console.log('\n📊 Test Summary:');
    console.log('================');
    
    const passed = this.testResults.filter(r => r.passed).length;
    const total = this.testResults.length;
    const failed = total - passed;
    
    console.log(`Total Tests: ${total}`);
    console.log(`Passed: ${passed} ✅`);
    console.log(`Failed: ${failed} ❌`);
    console.log(`Success Rate: ${((passed / total) * 100).toFixed(1)}%`);
    
    if (failed > 0) {
      console.log('\n❌ Failed Tests:');
      this.testResults
        .filter(r => !r.passed)
        .forEach(r => {
          console.log(`  - ${r.test}: ${r.details.error || 'Unknown error'}`);
        });
    }
    
    console.log('\n🔍 Full Results:');
    console.log(JSON.stringify(this.testResults, null, 2));
  }
}

// Export for use in other scripts
module.exports = RedisConsistencyTester;

// Run tests if this script is executed directly
if (require.main === module) {
  const adminToken = process.env.ADMIN_TOKEN || process.argv[2];
  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
  
  if (!adminToken) {
    console.error('❌ Admin token required. Usage:');
    console.error('   node test_redis_consistency.js <ADMIN_TOKEN>');
    console.error('   or set ADMIN_TOKEN environment variable');
    process.exit(1);
  }
  
  const tester = new RedisConsistencyTester(baseUrl, adminToken);
  
  tester.runAllTests()
    .then(() => {
      const failed = tester.testResults.filter(r => !r.passed).length;
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch(error => {
      console.error('❌ Test execution failed:', error);
      process.exit(1);
    });
}
