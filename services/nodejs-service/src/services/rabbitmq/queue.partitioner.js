const amqp = require('amqplib');
const logger = require('../logger.service');

/**
 * Queue Partitioning Service for High-Throughput Order Processing
 * Distributes orders across multiple queues for parallel processing
 */
class QueuePartitioner {
  
  constructor() {
    this.connection = null;
    this.channel = null;
    this.partitionCount = parseInt(process.env.RABBITMQ_QUEUE_PARTITIONS) || 4;
  }

  /**
   * Initialize connection and create partitioned queues
   */
  async initialize() {
    try {
      this.connection = await amqp.connect(process.env.RABBITMQ_URL);
      this.channel = await this.connection.createChannel();
      
      // Create main exchange for routing
      await this.channel.assertExchange('order_updates_exchange', 'direct', { durable: true });
      
      // Create partitioned queues
      for (let i = 0; i < this.partitionCount; i++) {
        const queueName = `order_db_update_queue_partition_${i}`;
        const routingKey = `partition_${i}`;
        
        await this.channel.assertQueue(queueName, { 
          durable: true,
          arguments: {
            'x-max-priority': 10,
            'x-message-ttl': 300000, // 5 minute TTL
            'x-dead-letter-exchange': 'order_updates_dlx'
          }
        });
        
        await this.channel.bindQueue(queueName, 'order_updates_exchange', routingKey);
      }
      
      // Create dead letter exchange and queue
      await this.channel.assertExchange('order_updates_dlx', 'direct', { durable: true });
      await this.channel.assertQueue('order_updates_dead_letter', { durable: true });
      await this.channel.bindQueue('order_updates_dead_letter', 'order_updates_dlx', '');
      
      logger.info('Queue partitioner initialized', {
        partitionCount: this.partitionCount,
        exchange: 'order_updates_exchange'
      });
      
    } catch (error) {
      logger.error('Failed to initialize queue partitioner', { error: error.message });
      throw error;
    }
  }

  /**
   * Publish message to appropriate partition based on user_id
   * This ensures all orders for the same user go to the same partition
   * maintaining order processing sequence per user
   */
  async publishMessage(message, priority = 5) {
    try {
      const { user_id, order_id, type } = message;
      
      // Partition based on user_id to maintain user-level ordering
      const partition = this.getUserPartition(user_id);
      const routingKey = `partition_${partition}`;
      
      // Higher priority for critical message types
      const messagePriority = this.getMessagePriority(type, priority);
      
      const published = await this.channel.publish(
        'order_updates_exchange',
        routingKey,
        Buffer.from(JSON.stringify(message)),
        {
          persistent: true,
          priority: messagePriority,
          messageId: `${order_id}_${Date.now()}`,
          timestamp: Date.now(),
          headers: {
            user_id: String(user_id),
            order_id: String(order_id),
            message_type: String(type),
            partition: partition
          }
        }
      );
      
      if (published) {
        logger.debug('Message published to partition', {
          orderId: order_id,
          userId: user_id,
          partition,
          priority: messagePriority,
          type
        });
      }
      
      return published;
      
    } catch (error) {
      logger.error('Failed to publish partitioned message', {
        error: error.message,
        orderId: message.order_id,
        userId: message.user_id
      });
      throw error;
    }
  }

  /**
   * Get partition for user to ensure consistent routing
   */
  getUserPartition(userId) {
    // Use consistent hashing to ensure same user always goes to same partition
    const hash = this.hashUserId(userId);
    return hash % this.partitionCount;
  }

  /**
   * Simple hash function for user ID
   */
  hashUserId(userId) {
    let hash = 0;
    const str = String(userId);
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Determine message priority based on type
   */
  getMessagePriority(type, defaultPriority = 5) {
    const priorityMap = {
      'ORDER_CLOSE_CONFIRMED': 9,     // Highest priority
      'ORDER_OPEN_CONFIRMED': 8,
      'ORDER_PENDING_CONFIRMED': 7,
      'ORDER_PENDING_TRIGGERED': 6,
      'ORDER_REJECTION_RECORD': 5,
      'ORDER_CLOSE_ID_UPDATE': 4,
      'ORDER_TRIGGER_UPDATE': 3       // Lowest priority
    };
    
    return priorityMap[type] || defaultPriority;
  }

  /**
   * Get queue statistics for monitoring
   */
  async getQueueStats() {
    const stats = [];
    
    for (let i = 0; i < this.partitionCount; i++) {
      const queueName = `order_db_update_queue_partition_${i}`;
      try {
        const queueInfo = await this.channel.checkQueue(queueName);
        stats.push({
          partition: i,
          queueName,
          messageCount: queueInfo.messageCount,
          consumerCount: queueInfo.consumerCount
        });
      } catch (error) {
        stats.push({
          partition: i,
          queueName,
          error: error.message
        });
      }
    }
    
    return stats;
  }

  /**
   * Close connection
   */
  async close() {
    if (this.channel) {
      await this.channel.close();
    }
    if (this.connection) {
      await this.connection.close();
    }
  }
}

module.exports = { QueuePartitioner };
