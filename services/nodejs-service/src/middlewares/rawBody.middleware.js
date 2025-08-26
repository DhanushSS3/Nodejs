/**
 * Raw Body Middleware for Webhook Processing
 * This middleware captures the raw body of incoming requests,
 * which is useful for webhook signature verification
 */

const rawBodyMiddleware = (req, res, next) => {
  // Check if body is already parsed by Express
  if (req.body !== undefined) {
    req.rawBody = JSON.stringify(req.body);
    return next();
  }
  
  let data = '';
  
  req.setEncoding('utf8');
  
  req.on('data', (chunk) => {
    data += chunk;
  });
  
  req.on('end', () => {
    req.rawBody = data;
    
    // Parse JSON if content-type is application/json
    if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
      try {
        req.body = JSON.parse(data);
      } catch (error) {
        req.body = {};
      }
    }
    
    next();
  });
  
  req.on('error', (error) => {
    next(error);
  });
  
  // Add timeout to prevent hanging
  setTimeout(() => {
    if (!req.rawBody) {
      req.rawBody = '';
      req.body = {};
      next();
    }
  }, 5000); // 5 second timeout
};

module.exports = rawBodyMiddleware;
