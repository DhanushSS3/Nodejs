const cluster = require('cluster');
const os = require('os');
const amqp = require('amqplib');
const logger = require('../logger.service');

// Import individual handler functions to avoid circular dependencies
// We'll define these locally to avoid importing the entire consumer module

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1/';
const ORDER_DB_UPDATE_QUEUE = process.env.ORDER_DB_UPDATE_QUEUE || 'order_db_update_queue';

// Scaling configuration
const CONSUMER_INSTANCES = parseInt(process.env.RABBITMQ_CONSUMER_INSTANCES) || Math.min(os.cpus().length, 8);
const PREFETCH_COUNT = parseInt(process.env.RABBITMQ_PREFETCH_COUNT) || 50;
const QUEUE_PARTITIONS = parseInt(process.env.RABBITMQ_QUEUE_PARTITIONS) || 4;

/**
 * Scalable RabbitMQ Consumer Architecture
 * Supports 1000+ orders/min with proper atomicity and transaction handling
 */
class ScalableOrdersConsumer {
  
  /**
   * Start master process that spawns worker consumers
   */
  static async startMaster() {
    if (cluster.isMaster) {
      logger.info(`Starting ${CONSUMER_INSTANCES} RabbitMQ consumer instances`, {
        cpuCount: os.cpus().length,
        consumerInstances: CONSUMER_INSTANCES,
        prefetchCount: PREFETCH_COUNT,
        queuePartitions: QUEUE_PARTITIONS
      });

      // Fork worker processes
      for (let i = 0; i < CONSUMER_INSTANCES; i++) {
        const worker = cluster.fork({
          WORKER_ID: i,
          QUEUE_PARTITION: i % QUEUE_PARTITIONS
        });
        
        worker.on('message', (msg) => {
          if (msg.type === 'metrics') {
            logger.info(`Worker ${i} metrics`, msg.data);
          }
        });
      }

      // Handle worker crashes
      cluster.on('exit', (worker, code, signal) => {
        logger.error(`Worker ${worker.process.pid} died`, { code, signal });
        logger.info('Starting new worker...');
        cluster.fork();
      });

      // Graceful shutdown
      process.on('SIGTERM', () => {
        logger.info('Master received SIGTERM, shutting down workers...');
        for (const id in cluster.workers) {
          cluster.workers[id].kill();
        }
      });

    } else {
      // Worker process
      await this.startWorker();
    }
  }

  /**
   * Start individual worker consumer (ONLY RabbitMQ consumer, no web server)
   */
  static async startWorker() {
    const workerId = process.env.WORKER_ID;
    const queuePartition = process.env.QUEUE_PARTITION;
    
    // Initialize database connection for this worker
    const sequelize = require('../../config/db');
    await sequelize.authenticate();
    console.log(`Worker ${workerId}: Database connected`);
    
    // Initialize Redis connection for this worker
    const { redisCluster } = require('../../../config/redis');
    await redisCluster.ping();
    console.log(`Worker ${workerId}: Redis connected`);
    
    try {
      const conn = await amqp.connect(RABBITMQ_URL);
      const ch = await conn.createChannel();
      
      // Use partitioned queue for better distribution
      const queueName = `${ORDER_DB_UPDATE_QUEUE}_partition_${queuePartition}`;
      await ch.assertQueue(queueName, { 
        durable: true,
        arguments: {
          'x-max-priority': 10 // Priority queue for urgent orders
        }
      });
      
      // Higher prefetch for better throughput
      await ch.prefetch(PREFETCH_COUNT);

      logger.info(`Worker ${workerId} connected to partition ${queuePartition}`, {
        workerId,
        queueName,
        prefetchCount: PREFETCH_COUNT
      });

      // Metrics tracking
      let processedCount = 0;
      let errorCount = 0;
      const startTime = Date.now();

      // Send metrics every minute
      setInterval(() => {
        const uptime = Date.now() - startTime;
        const throughput = (processedCount / (uptime / 1000 / 60)).toFixed(2); // orders/min
        
        process.send({
          type: 'metrics',
          data: {
            workerId,
            queuePartition,
            processedCount,
            errorCount,
            throughput: `${throughput} orders/min`,
            uptime: `${(uptime / 1000 / 60).toFixed(1)} min`
          }
        });
      }, 60000);

      ch.consume(queueName, async (msg) => {
        if (!msg) return;
        
        const messageStartTime = Date.now();
        let payload = null;
        
        try {
          payload = JSON.parse(msg.content.toString('utf8'));
          
          // Route message to appropriate handler
          await this.routeMessage(payload);
          
          ch.ack(msg);
          processedCount++;
          
          const processingTime = Date.now() - messageStartTime;
          if (processingTime > 5000) { // Log slow messages
            logger.warn(`Slow message processing`, {
              workerId,
              orderId: payload.order_id,
              processingTime,
              messageType: payload.type
            });
          }
          
        } catch (error) {
          errorCount++;
          logger.error(`Worker ${workerId} message processing failed`, {
            error: error.message,
            payload: payload ? {
              type: payload.type,
              order_id: payload.order_id,
              user_id: payload.user_id
            } : 'invalid_json',
            processingTime: Date.now() - messageStartTime
          });
          
          // Requeue with delay for transient errors
          if (this.isTransientError(error)) {
            setTimeout(() => ch.nack(msg, false, true), 5000);
          } else {
            ch.nack(msg, false, false); // Dead letter queue
          }
        }
      });

      // Graceful shutdown
      process.on('SIGTERM', async () => {
        logger.info(`Worker ${workerId} shutting down...`);
        await ch.close();
        await conn.close();
        process.exit(0);
      });

    } catch (error) {
      logger.error(`Worker ${workerId} failed to start`, { error: error.message });
      process.exit(1);
    }
  }

  /**
   * Route message to appropriate handler based on type
   */
  static async routeMessage(payload) {
    const { type } = payload;
    
    // Import handlers dynamically to avoid circular dependencies
    const { applyDbUpdate, handleOrderRejectionRecord, handleCloseIdUpdate } = require('./orders.db.consumer');
    
    switch (type) {
      case 'ORDER_REJECTION_RECORD':
        await handleOrderRejectionRecord(payload);
        break;
      case 'ORDER_CLOSE_ID_UPDATE':
        await handleCloseIdUpdate(payload);
        break;
      default:
        await applyDbUpdate(payload);
        break;
    }
  }

  /**
   * Determine if error is transient and should be retried
   */
  static isTransientError(error) {
    const transientErrors = [
      'ECONNRESET',
      'ETIMEDOUT',
      'Lock wait timeout exceeded',
      'Connection lost',
      'Redis connection failed'
    ];
    
    return transientErrors.some(pattern => 
      error.message.includes(pattern)
    );
  }
}

module.exports = { ScalableOrdersConsumer };
