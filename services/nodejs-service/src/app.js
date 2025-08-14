const express = require('express');
const liveUserRoutes = require('./routes/liveUser.routes');
const demoUserRoutes = require('./routes/demoUser.routes');
const authRoutes = require('./routes/auth.routes');
const adminAuthRoutes = require('./routes/admin.auth.routes');
const adminManagementRoutes = require('./routes/admin.management.routes');
const adminUserManagementRoutes = require('./routes/admin.user.management.routes');
const path = require('path');
const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('./config/swagger');
const { errorHandler, notFoundHandler, timeoutHandler } = require('./middlewares/error.middleware');
const logger = require('./services/logger.service');
const cors = require('cors');

const app = express();

// Request timeout middleware (30 seconds)
app.use(timeoutHandler(30000));

// Request logging middleware
app.use((req, res, next) => {
  logger.info('Request received', {
    method: req.method,
    url: req.url,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  });
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Enable CORS for all origins
app.use(cors());

// Handle invalid JSON error from express.json()
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      message: 'Invalid JSON payload'
    });
  }
  next(err);
});

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpecs));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/live-users', liveUserRoutes);
app.use('/api/demo-users', demoUserRoutes);
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/management', adminManagementRoutes);
app.use('/api/admin/users', adminUserManagementRoutes);
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

module.exports = app; 