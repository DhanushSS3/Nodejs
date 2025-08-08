// index.js
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const app = require('./src/app');
const sequelize = require('./src/config/db');
const redis = require('./config/redis');

const PORT = process.env.PORT || 3000;
// const PORT = 3000;

(async () => {
  try {
    // 1. Connect to DB
    await sequelize.authenticate();
    console.log('✅ Database connected.');

    // 2. Start server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

    // 3. Test Redis connection after server starts
    // Use the 'ready' event for a one-time check
    redis.on('ready', async () => {
      try {
        await redis.set("test:key", "hello");
        const value = await redis.get("test:key");
        console.log("✅ Redis set/get success:", value);
      } catch (redisErr) {
        console.error("❌ Redis Cluster client error:", redisErr);
      }
    });

  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
})();