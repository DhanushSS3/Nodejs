/**
 * Centralized Logging Service Export
 * Following Dependency Inversion Principle - provides single entry point for all loggers
 */

const LoggerFactory = require('./LoggerFactory');
const CryptoPaymentLogger = require('./CryptoPaymentLogger');
const CryptoWebhookRawLogger = require('./CryptoWebhookRawLogger');
const UserAuthLogger = require('./UserAuthLogger');
const ApplicationLogger = require('./ApplicationLogger');
const StripePaymentLogger = require('./StripePaymentLogger');
const StripeWebhookRawLogger = require('./StripeWebhookRawLogger');

// Create singleton instances
const cryptoPaymentLogger = new CryptoPaymentLogger();
const cryptoWebhookRawLogger = new CryptoWebhookRawLogger();
const userAuthLogger = new UserAuthLogger();
const applicationLogger = new ApplicationLogger();
const stripePaymentLogger = new StripePaymentLogger();
const stripeWebhookRawLogger = new StripeWebhookRawLogger();

module.exports = {
  // Factory for creating custom loggers
  LoggerFactory,
  
  // Pre-configured singleton instances (recommended)
  cryptoPaymentLogger,
  cryptoWebhookRawLogger,
  stripePaymentLogger,
  stripeWebhookRawLogger,
  userAuthLogger,
  applicationLogger,
  
  // Class constructors for custom instances
  CryptoPaymentLogger,
  CryptoWebhookRawLogger,
  StripePaymentLogger,
  StripeWebhookRawLogger,
  UserAuthLogger,
  ApplicationLogger,
  
  // Convenience method for quick logger creation
  createLogger: (name, options) => LoggerFactory.getLogger(name, options)
};
