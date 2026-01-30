const express = require('express');
const stripePaymentController = require('../controllers/stripe.payment.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');

const router = express.Router();

router.post('/deposit', authenticateJWT, stripePaymentController.createDeposit);
router.get('/methods', stripePaymentController.getMethods);
router.post('/webhook', stripePaymentController.handleWebhook);
router.get('/:merchantReferenceId', stripePaymentController.getPaymentByMerchantReferenceId);

module.exports = router;
