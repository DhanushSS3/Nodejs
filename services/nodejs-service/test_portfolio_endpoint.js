const axios = require('axios');

async function testPortfolioEndpoint() {
  try {
    console.log('Testing enhanced portfolio endpoint...');
    
    // Test basic portfolio fetch
    console.log('\n1. Testing basic portfolio fetch...');
    const basicResponse = await axios.get('http://localhost:3000/api/superadmin/orders/portfolio', {
      params: {
        user_type: 'demo',
        user_id: '2'
      },
      headers: {
        'Authorization': 'Bearer YOUR_SUPERADMIN_TOKEN' // Replace with actual token
      }
    });
    
    console.log('Basic portfolio response:', JSON.stringify(basicResponse.data, null, 2));
    
    // Test detailed portfolio fetch
    console.log('\n2. Testing detailed portfolio fetch...');
    const detailedResponse = await axios.get('http://localhost:3000/api/superadmin/orders/portfolio', {
      params: {
        user_type: 'demo',
        user_id: '2',
        detailed: true
      },
      headers: {
        'Authorization': 'Bearer YOUR_SUPERADMIN_TOKEN' // Replace with actual token
      }
    });
    
    console.log('Detailed portfolio response:', JSON.stringify(detailedResponse.data, null, 2));
    
  } catch (error) {
    console.error('Test failed:', error.response?.data || error.message);
  }
}

// Uncomment to run the test
// testPortfolioEndpoint();
