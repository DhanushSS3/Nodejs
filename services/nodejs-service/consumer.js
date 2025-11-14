const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

const { ScalableOrdersConsumer } = require('./src/services/rabbitmq/scalable.orders.consumer');
const { startOrdersDbConsumer } = require('./src/services/rabbitmq/orders.db.consumer');

/**
 * Dedicated RabbitMQ Consumer Service
 * This runs separately from the main web application
 * to avoid port conflicts and enable true horizontal scaling
 */
(async () => {
  try {
    console.log("🚀 Starting dedicated RabbitMQ Consumer Service...");
    
    // Check if scaling is enabled
    const consumerInstances = parseInt(process.env.RABBITMQ_CONSUMER_INSTANCES) || 1;
    
    if (consumerInstances > 1) {
      console.log(`🔥 Starting ${consumerInstances} consumer instances with clustering...`);
      await ScalableOrdersConsumer.startMaster();
      console.log("✅ Scalable Orders DB consumer cluster started");
    } else {
      console.log("📦 Starting single consumer instance...");
      await startOrdersDbConsumer();
      console.log("✅ Single Orders DB consumer started");
    }
    
    // Keep the process alive
    process.on('SIGTERM', () => {
      console.log('🛑 Consumer service shutting down...');
      process.exit(0);
    });
    
    process.on('SIGINT', () => {
      console.log('🛑 Consumer service shutting down...');
      process.exit(0);
    });
    
    console.log("🎯 RabbitMQ Consumer Service is running...");
    
  } catch (error) {
    console.error("❌ Failed to start RabbitMQ Consumer Service:", error);
    process.exit(1);
  }
})();
