const winston = require('winston');
const BaseLogger = require('./BaseLogger');
const LoggerFactory = require('./LoggerFactory');

class StripeWebhookRawLogger extends BaseLogger {
  constructor() {
    const logger = LoggerFactory.getLogger('stripeWebhookRaw', {
      filename: 'stripeWebhookRaw.log',
      format: winston.format.printf(({ message }) => {
        if (typeof message === 'string') {
          return message;
        }
        try {
          return JSON.stringify(message);
        } catch (err) {
          return String(message);
        }
      }),
    });

    super(logger);
  }

  logRawPayload(rawBody) {
    const payload = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    this.logger.info(payload);
  }
}

module.exports = StripeWebhookRawLogger;
