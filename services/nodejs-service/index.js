const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const app = require('./src/app');
const sequelize = require('./src/config/db');
const { redisCluster, redisReadyPromise } = require('./config/redis');
const startupCacheService = require('./src/services/startup.cache.service');
const { startOrdersDbConsumer } = require('./src/services/rabbitmq/orders.db.consumer');
const swapSchedulerService = require('./src/services/swap.scheduler.service');

const PORT = process.env.PORT || 3000;
const { startPortfolioWSServer } = require('./src/services/ws/portfolio.ws');

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
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

    // 5. Start WebSocket server for portfolio updates
    try {
      startPortfolioWSServer(server);
      console.log('✅ WebSocket server (/ws/portfolio) started');
    } catch (wsErr) {
      console.error('❌ Failed to start WebSocket server', wsErr);
    }

    // 6. Start swap scheduler
    try {
      swapSchedulerService.start();
      console.log('✅ Swap scheduler started');
    } catch (swapErr) {
      console.error('❌ Failed to start swap scheduler', swapErr);
    }

  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
})();