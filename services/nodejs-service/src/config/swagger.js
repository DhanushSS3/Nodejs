const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'LiveFXHub API',
      version: '1.0.0',
      description: 'API documentation for LiveFXHub Backend',
    },
    servers: [
      {
        url: 'http://localhost:3000',
        description: 'Development server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        LiveUserSignup: {
          type: 'object',
          required: [
            'name', 'phone_number', 'email', 'password', 'city', 'state', 
            'country', 'pincode', 'group', 'bank_ifsc_code', 'bank_account_number',
            'bank_holder_name', 'bank_branch_name', 'security_question', 
            'security_answer', 'address_proof', 'is_self_trading'
          ],
          properties: {
            name: { type: 'string', example: 'John Doe' },
            phone_number: { type: 'string', example: '+1234567890' },
            email: { type: 'string', format: 'email', example: 'john@example.com' },
            password: { type: 'string', minLength: 6, example: 'password123' },
            city: { type: 'string', example: 'New York' },
            state: { type: 'string', example: 'NY' },
            country: { type: 'string', example: 'USA' },
            pincode: { type: 'string', example: '10001' },
            group: { type: 'string', example: 'Premium' },
            bank_ifsc_code: { type: 'string', example: 'ABCD0001234' },
            bank_account_number: { type: 'string', example: '1234567890' },
            bank_holder_name: { type: 'string', example: 'John Doe' },
            bank_branch_name: { type: 'string', example: 'Main Branch' },
            security_question: { type: 'string', example: 'What is your mother\'s maiden name?' },
            security_answer: { type: 'string', example: 'Smith' },
            address_proof: { type: 'string', example: 'Utility Bill' },
            is_self_trading: { type: 'string', example: '1' },
            address_proof_image: { type: 'string', format: 'binary' },
            id_proof: { type: 'string', example: 'Aadhar Card' },
            id_proof_image: { type: 'string', format: 'binary' },
            is_active: { type: 'integer', example: 1 }

          }
        },
        DemoUserSignup: {
          type: 'object',
          required: [
            'name', 'phone_number', 'email', 'password', 'city', 'state',
            'country', 'pincode', 'security_question', 'security_answer'
          ],
          properties: {
            name: { type: 'string', example: 'Jane Doe' },
            phone_number: { type: 'string', example: '+1234567890' },
            email: { type: 'string', format: 'email', example: 'jane@example.com' },
            password: { type: 'string', minLength: 6, example: 'password123' },
            city: { type: 'string', example: 'Los Angeles' },
            state: { type: 'string', example: 'CA' },
            country: { type: 'string', example: 'USA' },
            pincode: { type: 'string', example: '90210' },
            security_question: { type: 'string', example: 'What is your favorite color?' },
            security_answer: { type: 'string', example: 'Blue' },
            is_active: { type: 'integer', example: 1 }
          }
        },
        Error: {
          type: 'object',
          properties: {
            message: { type: 'string', example: 'Error message' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  message: { type: 'string' }
                }
              }
            }
          }
        },
        SuccessResponse: {
          type: 'object',
          properties: {
            message: { type: 'string', example: 'Signup successful' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'integer', example: 1 },
                account_number: { type: 'string', example: 'LIVE-A3F82J' },
                email: { type: 'string', example: 'john@example.com' },
                referral_code: { type: 'string', example: 'ABC123' }
              }
            }
          }
        }
      }
    }
  },
  apis: ['./src/routes/*.js'], // Path to the API docs
};

const specs = swaggerJsdoc(options);

module.exports = specs; 