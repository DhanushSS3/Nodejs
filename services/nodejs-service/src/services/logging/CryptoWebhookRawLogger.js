const winston = require('winston');
const BaseLogger = require('./BaseLogger');
const LoggerFactory = require('./LoggerFactory');

class CryptoWebhookRawLogger extends BaseLogger {
  constructor() {
    const logger = LoggerFactory.getLogger('cryptoWebhookRaw', {
      filename: 'cryptoWebhookRaw.log',
      // Store raw payload exactly as received (no JSON envelope)
      format: winston.format.printf(({ message }) => {
        if (typeof message === 'string') {
          return message;
        }
        try {
          return JSON.stringify(message);
        } catch (err) {
          return String(message);
        }
      })
    });

    super(logger);
  }

  /**
   * Persist the exact webhook payload as received from Tylt
   * @param {string} rawBody - Raw request body string
   */
  logRawPayload(rawBody) {
    const payload = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    this.logger.info(payload);
  }
}

module.exports = CryptoWebhookRawLogger;
