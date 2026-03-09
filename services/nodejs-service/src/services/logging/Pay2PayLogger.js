const winston = require('winston');
const BaseLogger = require('./BaseLogger');
const LoggerFactory = require('./LoggerFactory');

class Pay2PayLogger extends BaseLogger {
    constructor() {
        // Generate a logger that writes exclusively to pay2pay.log
        const logger = LoggerFactory.getLogger('pay2pay', {
            filename: 'pay2pay.log',
            // Store payloads explicitly
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf((info) => {
                    let messageStr = '';
                    if (typeof info.message === 'string') {
                        messageStr = info.message;
                    } else {
                        try {
                            messageStr = JSON.stringify(info.message);
                        } catch (err) {
                            messageStr = String(info.message);
                        }
                    }

                    let metaStr = '';
                    const meta = { ...info };
                    delete meta.level;
                    delete meta.message;
                    delete meta.timestamp;

                    if (Object.keys(meta).length > 0) {
                        try {
                            metaStr = ` | META: ${JSON.stringify(meta)}`;
                        } catch (e) {
                            // Ignore
                        }
                    }

                    return `[${info.timestamp}] ${info.level.toUpperCase()}: ${messageStr}${metaStr}`;
                })
            )
        });

        super(logger);
    }

    /**
     * Log outgoing requests to Pay2Pay
     * @param {string} endpoint - API endpoint or flow
     * @param {Object} payload - Data sent
     */
    logRequest(endpoint, payload) {
        this.logger.info(`[OUTGOING_REQUEST] ${endpoint}`, { payload });
    }

    /**
     * Log incoming responses from Pay2Pay
     * @param {string} endpoint - API endpoint or flow
     * @param {Object} response - Data received
     */
    logResponse(endpoint, response) {
        this.logger.info(`[INCOMING_RESPONSE] ${endpoint}`, { response });
    }

    /**
     * Log errors related to Pay2Pay
     * @param {string} context - Where the error happened
     * @param {Error|Object} error - The error details
     */
    logError(context, error) {
        this.logger.error(`[ERROR] ${context}`, {
            error: error.message || error,
            stack: error.stack
        });
    }

    /**
     * Log incoming IPN Webhooks
     * @param {Object} headers - Raw headers
     * @param {Object|string} body - Raw body
     */
    logIPN(headers, body) {
        this.logger.info(`[INCOMING_IPN_WEBHOOK]`, { headers, body });
    }
}

module.exports = new Pay2PayLogger();
