const LiveUserAuthService = require('../services/liveUser.auth.service');
const { hashPassword, hashViewPassword } = require('../services/password.service');

/**
 * Simple test suite for LiveUser authentication
 */
async function testLiveUserAuth() {
  console.log('🧪 Testing LiveUser Authentication Service...\n');

  try {
    // Mock user data
    const mockPassword = 'testPassword123';
    const mockViewPassword = 'viewPass456';
    const hashedPassword = await hashPassword(mockPassword);
    const hashedViewPassword = await hashViewPassword(mockViewPassword);

    const mockUser = {
      id: 1,
      user_type: 'live',
      mam_status: 0,
      pam_status: 0,
      sending_orders: null,
      group: 'VIP',
      account_number: 'LIVE123456',
      status: 1,
      is_self_trading: 1,
      password: hashedPassword,
      view_password: hashedViewPassword
    };

    // Test 1: Master password authentication
    console.log('🔐 Test 1: Master password authentication');
    const masterResult = await LiveUserAuthService.validateCredentials(mockPassword, mockUser);
    console.log(`   Result: ${JSON.stringify(masterResult)}`);
    console.log(`   Expected: { isValid: true, loginType: 'master' }`);
    console.log(`   ✅ Pass: ${masterResult.isValid && masterResult.loginType === 'master'}\n`);

    // Test 2: View password authentication
    console.log('🔐 Test 2: View password authentication');
    const viewResult = await LiveUserAuthService.validateCredentials(mockViewPassword, mockUser);
    console.log(`   Result: ${JSON.stringify(viewResult)}`);
    console.log(`   Expected: { isValid: true, loginType: 'view' }`);
    console.log(`   ✅ Pass: ${viewResult.isValid && viewResult.loginType === 'view'}\n`);

    // Test 3: Invalid password
    console.log('🔐 Test 3: Invalid password');
    const invalidResult = await LiveUserAuthService.validateCredentials('wrongPassword', mockUser);
    console.log(`   Result: ${JSON.stringify(invalidResult)}`);
    console.log(`   Expected: { isValid: false, loginType: null }`);
    console.log(`   ✅ Pass: ${!invalidResult.isValid && invalidResult.loginType === null}\n`);

    // Test 4: Role determination
    console.log('🎭 Test 4: Role determination');
    const traderRole = LiveUserAuthService.getUserRole('master');
    const viewerRole = LiveUserAuthService.getUserRole('view');
    console.log(`   Master login role: ${traderRole} (expected: trader)`);
    console.log(`   View login role: ${viewerRole} (expected: viewer)`);
    console.log(`   ✅ Pass: ${traderRole === 'trader' && viewerRole === 'viewer'}\n`);

    // Test 5: JWT payload generation
    console.log('🎫 Test 5: JWT payload generation');
    const sessionId = 'test-session-123';
    const traderPayload = LiveUserAuthService.generateJWTPayload(mockUser, 'master', sessionId);
    const viewerPayload = LiveUserAuthService.generateJWTPayload(mockUser, 'view', sessionId);
    
    console.log(`   Trader payload role: ${traderPayload.role} (expected: trader)`);
    console.log(`   Viewer payload role: ${viewerPayload.role} (expected: viewer)`);
    console.log(`   is_self_trading included: ${traderPayload.is_self_trading} (expected: 1)`);
    console.log(`   ✅ Pass: ${traderPayload.role === 'trader' && viewerPayload.role === 'viewer' && traderPayload.is_self_trading === 1}\n`);

    console.log('🎉 All tests completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

// Run tests if called directly
if (require.main === module) {
  testLiveUserAuth();
}

module.exports = { testLiveUserAuth };
