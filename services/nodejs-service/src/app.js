const express = require('express');
const liveUserRoutes = require('./routes/liveUser.routes');
const demoUserRoutes = require('./routes/demoUser.routes');
const authRoutes = require('./routes/auth.routes');
const adminAuthRoutes = require('./routes/admin.auth.routes');
const adminManagementRoutes = require('./routes/admin.management.routes');
const adminUserManagementRoutes = require('./routes/admin.user.management.routes');
const superadminRoutes = require('./routes/superadmin.routes');
const cacheRoutes = require('./routes/cache.routes');
const cryptoPaymentRoutes = require('./routes/crypto.payment.routes');
const groupsRoutes = require('./routes/groups.routes');
const favoritesRoutes = require('./routes/favorites.routes');
const groupsSuperadminRoutes = require('./routes/superadmin.groups.routes');
const transactionsRoutes = require('./routes/transactions.routes');
const path = require('path');
const ordersRoutes = require('./routes/orders.routes');
const swaggerUi = require('swagger-ui-express');
const swaggerSpecs = require('./config/swagger');
const { errorHandler, notFoundHandler, timeoutHandler } = require('./middlewares/error.middleware');
const logger = require('./services/logger.service');
const cors = require('cors');
const superadminOrdersRoutes = require('./routes/superadmin.orders.routes');
const internalProviderRoutes = require('./routes/internal.provider.lookup.routes');

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
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    // Allow all origins for now - you can restrict this later
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'X-Requested-With', 
    'Accept',
    'Origin',
    'Cache-Control',
    'X-File-Name'
  ],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

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
app.use('/api/superadmin', superadminRoutes);
app.use('/api/cache', cacheRoutes);
app.use('/api/crypto-payments', cryptoPaymentRoutes);
app.use('/api/groups', groupsRoutes);
app.use('/api/favorites', favoritesRoutes);
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use('/api/superadmin/groups', groupsSuperadminRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/superadmin/orders', superadminOrdersRoutes);
app.use('/api/internal/provider', internalProviderRoutes);
app.use('/api/transactions', transactionsRoutes);

// 404 handler
app.use(notFoundHandler);

// Global error handler
app.use(errorHandler);

module.exports = app; 