const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const app = require('./src/app');
const sequelize = require('./src/config/db');
const { redisCluster, redisReadyPromise } = require('./config/redis');
const startupCacheService = require('./src/services/startup.cache.service');
const { startOrdersDbConsumer, shutdownOrdersDbConsumer } = require('./src/services/rabbitmq/orders.db.consumer');
const swapSchedulerService = require('./src/services/swap.scheduler.service');
const CatalogEligibilityCronService = require('./src/services/cron/catalogEligibility.cron.service');
const copyFollowerEquityMonitorWorker = require('./src/services/copyFollowerEquityMonitor.worker');

const PORT = process.env.PORT || 3000;
const { createPortfolioWSServer } = require('./src/services/ws/portfolio.ws');
const { createAdminOrdersWSServer } = require('./src/services/ws/admin.orders.ws');

// Global references for graceful shutdown
let server = null;
let rabbitConnection = null;
let wssPortfolio = null;
let wssAdmin = null;

(async () => {
  try {
    // 1. Connect to DB
    await sequelize.authenticate();
    console.log('✅ Database connected.');

    // 2. Wait for Redis to be ready and then test it
    const redis = await redisReadyPromise;
    try {
      console.log("Attempting Redis 'set' command...");
      await redis.set("test:key", "hello");
      console.log("✅ Redis 'set' command succeeded.");

      console.log("Attempting Redis 'get' command...");
      const value = await redis.get("test:key");
      console.log("✅ Redis 'get' command succeeded.");
      console.log("✅ Redis set/get success:", value);
    } catch (redisErr) {
      console.error("❌ Redis Cluster command error:", redisErr);
    }

    // 3. Initialize cache services
    try {
      console.log("Initializing cache services...");
      await startupCacheService.initialize();
      console.log("✅ Cache services initialized successfully");
    } catch (cacheErr) {
      console.error("❌ Cache initialization failed:", cacheErr);
      // Continue startup even if cache fails - it can be initialized later
    }

    // 3b. Start RabbitMQ consumer for order DB updates (from Python workers)
    try {
      console.log("Starting Orders DB consumer...");
      startOrdersDbConsumer();
      console.log("✅ Orders DB consumer started");
    } catch (mqErr) {
      console.error("❌ Failed to start Orders DB consumer:", mqErr);
    }

    app.use((err, req, res, next) => {
      console.error('GLOBAL ERROR HANDLER:', err);
      res.status(err.status || 500).json({ message: err.message });
    });

    // 4. Start server
    server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

    // 5. Start WebSocket servers
    try {
      const url = require('url');

      // Create WS servers (headless - noServer: true)
      wssPortfolio = createPortfolioWSServer();
      wssAdmin = createAdminOrdersWSServer();

      console.log('✅ WebSocket servers created (Headless Mode)');

      // Handle Upgrade Manually
      server.on('upgrade', (request, socket, head) => {
        const pathname = url.parse(request.url).pathname;

        if (pathname === '/ws/portfolio') {
          wssPortfolio.handleUpgrade(request, socket, head, (ws) => {
            wssPortfolio.emit('connection', ws, request);
          });
        } else if (pathname === '/ws/admin/orders') {
          wssAdmin.handleUpgrade(request, socket, head, (ws) => {
            wssAdmin.emit('connection', ws, request);
          });
        } else {
          socket.destroy();
        }
      });
      console.log('✅ WebSocket upgrade handler attached');

    } catch (wsErr) {
      console.error('❌ Failed to start WebSocket servers', wsErr);
    }

    // 6. Start swap scheduler
    try {
      swapSchedulerService.start();
      console.log('✅ Swap scheduler started');
    } catch (swapErr) {
      console.error('❌ Failed to start swap scheduler', swapErr);
    }

    // 7. Initialize catalog eligibility cron job
    try {
      CatalogEligibilityCronService.initializeCronJobs();
      console.log('✅ Catalog eligibility cron job initialized');
    } catch (cronErr) {
      console.error('❌ Failed to initialize catalog eligibility cron job', cronErr);
    }

    // 8. Start copy follower equity monitor worker
    try {
      copyFollowerEquityMonitorWorker.start();
      console.log('✅ Copy follower equity monitor worker started');
    } catch (equityErr) {
      console.error('❌ Failed to start copy follower equity monitor worker', equityErr);
    }

  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
})();

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    console.error('❌ Graceful shutdown timeout. Force exiting...');
    process.exit(1);
  }, 10000); // 10 second timeout

  try {
    // 1. Stop accepting new connections
    if (server) {
      console.log('🔄 Closing HTTP server...');
      await new Promise((resolve) => {
        server.close(resolve);
      });
      console.log('✅ HTTP server closed');
    }

    // 2. Stop WebSocket servers
    console.log('🔄 Closing WebSocket servers...');
    if (wssPortfolio) {
      try { wssPortfolio.close(); } catch (_) { }
    }
    if (wssAdmin) {
      try { wssAdmin.close(); } catch (_) { }
    }
    console.log('✅ WebSocket servers closed');

    // 3. Stop RabbitMQ consumer
    try {
      console.log('🔄 Closing RabbitMQ connections...');
      await shutdownOrdersDbConsumer();
      console.log('✅ RabbitMQ connections closed');
    } catch (mqErr) {
      console.error('❌ Error closing RabbitMQ:', mqErr.message);
    }

    // 4. Stop cron jobs and workers
    try {
      console.log('🔄 Stopping scheduled services...');

      // Stop swap scheduler
      if (swapSchedulerService && swapSchedulerService.stop) {
        swapSchedulerService.stop();
      }

      // Stop copy follower equity monitor
      if (copyFollowerEquityMonitorWorker && copyFollowerEquityMonitorWorker.stop) {
        copyFollowerEquityMonitorWorker.stop();
      }

      console.log('✅ Scheduled services stopped');
    } catch (cronErr) {
      console.error('❌ Error stopping scheduled services:', cronErr.message);
    }

    // 5. Close Redis connections
    try {
      console.log('🔄 Closing Redis connections...');
      if (redisCluster && redisCluster.disconnect) {
        await redisCluster.disconnect();
      }
      console.log('✅ Redis connections closed');
    } catch (redisErr) {
      console.error('❌ Error closing Redis:', redisErr.message);
    }

    // 6. Close database connections
    try {
      console.log('🔄 Closing database connections...');
      await sequelize.close();
      console.log('✅ Database connections closed');
    } catch (dbErr) {
      console.error('❌ Error closing database:', dbErr.message);
    }

    clearTimeout(shutdownTimeout);
    console.log('✅ Graceful shutdown completed successfully');
    process.exit(0);

  } catch (err) {
    console.error('❌ Error during graceful shutdown:', err);
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

// Register shutdown handlers
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2')); // For nodemon

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('unhandledRejection');
});