const express = require('express');
const stripePaymentController = require('../controllers/stripe.payment.controller');
const currencyConfigController = require('../controllers/currencyConfig.controller');
const { authenticateJWT } = require('../middlewares/auth.middleware');

const router = express.Router();

const allowAllOrigins = (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
};

router.options('/deposit', allowAllOrigins);
router.post('/deposit', allowAllOrigins, authenticateJWT, stripePaymentController.createDeposit);
router.get('/methods', stripePaymentController.getMethods);
router.get('/currencies', currencyConfigController.getSupportedCurrencies);
router.post('/webhook', stripePaymentController.handleWebhook);
router.get('/:merchantReferenceId', stripePaymentController.getPaymentByMerchantReferenceId);

module.exports = router;
