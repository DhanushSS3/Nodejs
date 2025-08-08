const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const app = require('./src/app');
const sequelize = require('./src/config/db');
const { redisCluster, redisReadyPromise } = require('./config/redis');

const PORT = process.env.PORT || 3000;

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

    // 3. Start server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
})();