const { CryptoPayment } = require('./services/nodejs-service/src/models');

async function checkPaymentRecord() {
  try {
    console.log('=== CHECKING PAYMENT RECORDS ===');
    
    // Check for the specific merchantOrderId from logs
    const merchantOrderId = 'livefx_4af07a6496ed430fa01057dc25b42c67';
    const orderId = '977a0233-9d2d-11f0-9b9d-42010a2801c2';
    
    console.log('Searching for:');
    console.log('merchantOrderId:', merchantOrderId);
    console.log('orderId:', orderId);
    console.log();
    
    // Try to find by merchantOrderId
    const paymentByMerchant = await CryptoPayment.findOne({
      where: { merchantOrderId }
    });
    
    console.log('Found by merchantOrderId:', !!paymentByMerchant);
    if (paymentByMerchant) {
      console.log('Payment details:', {
        id: paymentByMerchant.id,
        userId: paymentByMerchant.userId,
        merchantOrderId: paymentByMerchant.merchantOrderId,
        orderId: paymentByMerchant.orderId,
        status: paymentByMerchant.status,
        baseAmount: paymentByMerchant.baseAmount,
        baseAmountReceived: paymentByMerchant.baseAmountReceived
      });
    }
    
    // Try to find by orderId
    const paymentByOrder = await CryptoPayment.findOne({
      where: { orderId }
    });
    
    console.log('Found by orderId:', !!paymentByOrder);
    if (paymentByOrder) {
      console.log('Payment details:', {
        id: paymentByOrder.id,
        userId: paymentByOrder.userId,
        merchantOrderId: paymentByOrder.merchantOrderId,
        orderId: paymentByOrder.orderId,
        status: paymentByOrder.status,
        baseAmount: paymentByOrder.baseAmount,
        baseAmountReceived: paymentByOrder.baseAmountReceived
      });
    }
    
    // Check recent payments for user 63
    const recentPayments = await CryptoPayment.findAll({
      where: { userId: 63 },
      order: [['created_at', 'DESC']],
      limit: 5
    });
    
    console.log('\nRecent payments for user 63:');
    recentPayments.forEach(payment => {
      console.log({
        id: payment.id,
        merchantOrderId: payment.merchantOrderId,
        orderId: payment.orderId,
        status: payment.status,
        baseAmount: payment.baseAmount,
        baseAmountReceived: payment.baseAmountReceived,
        created_at: payment.created_at
      });
    });
    
    // Check if merchantOrderId is truncated
    const truncatedMerchantId = 'livefx_4af07a6496ed430fa01057dc25b42';
    const paymentByTruncated = await CryptoPayment.findOne({
      where: { merchantOrderId: truncatedMerchantId }
    });
    
    console.log('\nFound by truncated merchantOrderId:', !!paymentByTruncated);
    if (paymentByTruncated) {
      console.log('Truncated payment details:', {
        id: paymentByTruncated.id,
        merchantOrderId: paymentByTruncated.merchantOrderId,
        orderId: paymentByTruncated.orderId
      });
    }
    
  } catch (error) {
    console.error('Error checking payment records:', error.message);
  }
}

checkPaymentRecord();
