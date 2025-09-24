/**
 * Test script for Node.js error logging functionality
 * Run with: node test_error_logging.js
 */

const Logger = require('./services/nodejs-service/src/services/logger.service');
const ErrorResponse = require('./services/nodejs-service/src/utils/errorResponse.util');

// Mock request and response objects for testing
function createMockReq(data = {}) {
  return {
    method: 'POST',
    originalUrl: '/api/test/endpoint',
    ip: '127.0.0.1',
    user: { sub: 'test_user_123', user_type: 'live' },
    params: {},
    query: {},
    body: { password: 'secret123', email: 'test@example.com', ...data },
    get: (header) => header === 'User-Agent' ? 'Test-Agent/1.0' : null
  };
}

function createMockRes() {
  const res = {
    status: function(code) { 
      this.statusCode = code; 
      return this; 
    },
    json: function(data) { 
      this.responseData = data; 
      console.log(`Response [${this.statusCode}]:`, JSON.stringify(data, null, 2));
      return this; 
    }
  };
  return res;
}

async function testErrorLogging() {
  console.log('🧪 Testing Node.js Error Logging System\n');

  // Test 1: Basic error logging
  console.log('1️⃣ Testing basic error logging...');
  const testError = new Error('Test database connection failed');
  testError.name = 'SequelizeConnectionError';
  
  Logger.logErrorToFile(testError, {
    endpoint: 'POST /api/test',
    method: 'POST',
    userId: 'test_user_123',
    userType: 'live',
    requestData: { email: 'test@example.com', password: 'secret123' },
    additionalContext: { operation: 'test_operation' }
  });
  console.log('✅ Error logged to file\n');

  // Test 2: Generic error response generation
  console.log('2️⃣ Testing generic error response generation...');
  const genericResponse = Logger.getGenericErrorResponse(testError, 'database operation');
  console.log('Generic response:', JSON.stringify(genericResponse, null, 2));
  console.log('✅ Generic response generated\n');

  // Test 3: Full API error handling
  console.log('3️⃣ Testing full API error handling...');
  const req = createMockReq();
  const res = createMockRes();
  
  Logger.handleApiError(testError, req, res, 'test operation', 500);
  console.log('✅ API error handled with logging and generic response\n');

  // Test 4: Validation error
  console.log('4️⃣ Testing validation error handling...');
  const req2 = createMockReq();
  const res2 = createMockRes();
  
  ErrorResponse.validationError(req2, res2, [
    { msg: 'Email is required' },
    { msg: 'Password must be at least 8 characters' }
  ], 'user registration');
  console.log('✅ Validation error handled\n');

  // Test 5: Authentication error
  console.log('5️⃣ Testing authentication error...');
  const req3 = createMockReq();
  const res3 = createMockRes();
  
  ErrorResponse.authenticationError(req3, res3);
  console.log('✅ Authentication error handled\n');

  // Test 6: Service unavailable error
  console.log('6️⃣ Testing service unavailable error...');
  const req4 = createMockReq();
  const res4 = createMockRes();
  
  ErrorResponse.serviceUnavailableError(req4, res4, 'Redis Cache');
  console.log('✅ Service unavailable error handled\n');

  // Test 7: Data sanitization
  console.log('7️⃣ Testing data sanitization...');
  const sensitiveData = {
    email: 'user@example.com',
    password: 'secret123',
    api_key: 'sk-1234567890',
    card_number: '4111111111111111',
    normal_field: 'safe_data'
  };
  
  const sanitized = Logger.sanitizeRequestBody(sensitiveData);
  console.log('Original data:', JSON.stringify(sensitiveData, null, 2));
  console.log('Sanitized data:', JSON.stringify(sanitized, null, 2));
  console.log('✅ Data sanitization working\n');

  console.log('🎉 All tests completed! Check the logs directory for generated log files.');
  console.log('📁 Log files should be created in: services/nodejs-service/logs/');
  console.log('   - errors-YYYY-MM-DD.log (error logs)');
  console.log('   - application-YYYY-MM-DD.log (application logs)');
}

// Run tests
testErrorLogging().catch(console.error);
