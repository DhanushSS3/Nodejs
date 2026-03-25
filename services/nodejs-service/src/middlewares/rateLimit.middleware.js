const rateLimit = require('express-rate-limit');

// Strict rate limiter specifically designed to mitigate anonymous spam 
// on critical order endpoints like order placement/closure.
const orderActionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 60, // limit each IP to 60 requests per windowMs (1 req/sec avg)
  standardHeaders: true, 
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many order requests from this IP, please try again in a minute',
      error_code: 'RATE_LIMIT_EXCEEDED'
    });
  }
});

// A more relaxed global rate limiter if needed
const globalApiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 300, 
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many requests from this IP, please try again later',
      error_code: 'GLOBAL_RATE_LIMIT_EXCEEDED'
    });
  }
});

module.exports = {
  orderActionLimiter,
  globalApiLimiter
};
