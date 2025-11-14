const EventEmitter = require('events');
const { redisCluster } = require('../../../config/redis');
const logger = require('../logger.service');

// Unique ID for this process to avoid handling our own published messages
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let subscribed = false;

class PortfolioEventBus extends EventEmitter {
  constructor() {
    super();
    // Increase max listeners to prevent warnings temporarily
    this.setMaxListeners(100);
    
    // Track listeners to prevent duplicates and enable cleanup
    this.listenerRegistry = new Map(); // eventName -> Set of handler functions
    this.userListeners = new Map(); // userKey -> Set of eventNames
  }

  makeUserKey(userType, userId) {
    // Normalize user type to handle strategy providers and copy followers
    const normalizedUserType = String(userType).toLowerCase();
    return `${normalizedUserType}:${String(userId)}`;
  }

  emitUserUpdate(userType, userId, payload = {}) {
    const key = this.makeUserKey(userType, userId);
    const evt = { userType, userId, ...payload };
    
    // Debug logging for pending order events
    if (payload.type === 'order_update' && payload.reason === 'pending_confirmed') {
      logger && logger.info && logger.info('Portfolio event emitting pending confirmation', {
        userKey: key,
        userType,
        userId,
        payloadType: payload.type,
        reason: payload.reason,
        orderId: payload.order_id
      });
    }
    
    if (payload.type === 'order_pending_confirmed') {
      logger && logger.info && logger.info('Portfolio event emitting dedicated pending confirmation', {
        userKey: key,
        userType,
        userId,
        payloadType: payload.type,
        orderId: payload.order_id
      });
    }
    
    // Emit locally (same-process listeners)
    this.emit(`user:${key}`, evt);
    // Publish cross-process via Redis Pub/Sub
    try {
      const msg = JSON.stringify({ _src: INSTANCE_ID, type: 'user_update', ...evt });
      // Channel name: portfolio_events
      redisCluster.publish('portfolio_events', msg).catch(() => {});
    } catch (e) {
      logger && logger.warn ? logger.warn('PortfolioEventBus publish failed', { error: e.message }) : null;
    }
  }

  // Specific method for copy follower account updates
  emitCopyFollowerAccountUpdate(copyFollowerAccountId, payload = {}) {
    const evt = { 
      userType: 'copy_follower', 
      userId: copyFollowerAccountId, 
      copyFollowerAccountId,
      ...payload 
    };
    const key = this.makeUserKey('copy_follower', copyFollowerAccountId);
    
    // Emit locally (same-process listeners)
    this.emit(`user:${key}`, evt);
    
    // Publish cross-process via Redis Pub/Sub
    try {
      const msg = JSON.stringify({ 
        _src: INSTANCE_ID, 
        type: 'copy_follower_account_update', 
        ...evt 
      });
      redisCluster.publish('portfolio_events', msg).catch(() => {});
    } catch (e) {
      logger && logger.warn ? logger.warn('PortfolioEventBus copy follower publish failed', { 
        error: e.message, 
        copyFollowerAccountId 
      }) : null;
    }
  }

  onUserUpdate(userType, userId, handler) {
    const key = this.makeUserKey(userType, userId);
    const eventName = `user:${key}`;
    
    // Track this listener to prevent duplicates
    if (!this.listenerRegistry.has(eventName)) {
      this.listenerRegistry.set(eventName, new Set());
    }
    
    if (!this.userListeners.has(key)) {
      this.userListeners.set(key, new Set());
    }
    
    // Check if we already have too many listeners for this user
    const currentCount = this.listenerCount(eventName);
    if (currentCount >= 5) {
      logger && logger.warn ? logger.warn(`Too many listeners for ${eventName} (${currentCount}), cleaning up old ones`) : null;
      this.removeAllListeners(eventName);
      this.listenerRegistry.set(eventName, new Set());
    }
    
    // Add the listener
    this.listenerRegistry.get(eventName).add(handler);
    this.userListeners.get(key).add(eventName);
    this.on(eventName, handler);
    
    // Return cleanup function
    return () => {
      this.removeListener(eventName, handler);
      if (this.listenerRegistry.has(eventName)) {
        this.listenerRegistry.get(eventName).delete(handler);
        if (this.listenerRegistry.get(eventName).size === 0) {
          this.listenerRegistry.delete(eventName);
        }
      }
      if (this.userListeners.has(key)) {
        this.userListeners.get(key).delete(eventName);
        if (this.userListeners.get(key).size === 0) {
          this.userListeners.delete(key);
        }
      }
    };
  }

  // Clean up all listeners for a specific user
  cleanupUserListeners(userType, userId) {
    const key = this.makeUserKey(userType, userId);
    const eventName = `user:${key}`;
    const listenerCount = this.listenerCount(eventName);
    
    if (listenerCount > 0) {
      this.removeAllListeners(eventName);
      
      // Clean up tracking maps
      this.listenerRegistry.delete(eventName);
      if (this.userListeners.has(key)) {
        this.userListeners.get(key).delete(eventName);
        if (this.userListeners.get(key).size === 0) {
          this.userListeners.delete(key);
        }
      }
      
      logger && logger.info ? logger.info(`Cleaned up ${listenerCount} listeners for ${eventName}`) : null;
    }
  }

  // Get listener count for debugging
  getUserListenerCount(userType, userId) {
    const key = this.makeUserKey(userType, userId);
    return this.listenerCount(`user:${key}`);
  }

  // Get comprehensive listener statistics
  getListenerStats() {
    const stats = {
      totalUsers: this.userListeners.size,
      totalEventNames: this.listenerRegistry.size,
      totalListeners: 0,
      userBreakdown: {}
    };

    for (const [eventName, handlers] of this.listenerRegistry) {
      const actualCount = this.listenerCount(eventName);
      stats.totalListeners += actualCount;
      
      // Extract user info from event name
      if (eventName.startsWith('user:')) {
        const userKey = eventName.substring(5); // Remove 'user:' prefix
        stats.userBreakdown[userKey] = actualCount;
      }
    }

    return stats;
  }

  // Emergency cleanup - remove all listeners
  emergencyCleanup() {
    const stats = this.getListenerStats();
    this.removeAllListeners();
    this.listenerRegistry.clear();
    this.userListeners.clear();
    
    logger && logger.warn ? logger.warn(`Emergency cleanup performed. Removed ${stats.totalListeners} listeners for ${stats.totalUsers} users`) : null;
    return stats;
  }

  // Initialize Redis subscription once per process
  _ensureSubscribed() {
    if (subscribed) return;
    subscribed = true;
    try {
      // Re-emit messages published by other processes
      redisCluster.on('message', (channel, message) => {
        if (channel !== 'portfolio_events') return;
        try {
          const data = JSON.parse(message);
          if (data && data._src && data._src === INSTANCE_ID) return; // ignore self
          if (!data || data.type !== 'user_update') return;
          const { userType, userId, ...rest } = data;
          const key = this.makeUserKey(userType, userId);
          this.emit(`user:${key}`, { userType, userId, ...rest });
        } catch (_) {}
      });
      redisCluster.subscribe('portfolio_events').then(() => {
        logger && logger.info ? logger.info('PortfolioEventBus subscribed to portfolio_events') : null;
      }).catch((e) => {
        logger && logger.warn ? logger.warn('PortfolioEventBus subscribe failed', { error: e.message }) : null;
      });
    } catch (e) {
      logger && logger.warn ? logger.warn('PortfolioEventBus init failed', { error: e.message }) : null;
    }
  }
}

const bus = new PortfolioEventBus();
// Start cross-process bridge
try { bus._ensureSubscribed(); } catch (_) {}

// Process cleanup handlers to prevent memory leaks
process.on('SIGTERM', () => {
  try {
    const stats = bus.emergencyCleanup();
    logger && logger.info ? logger.info('Process SIGTERM: Cleaned up PortfolioEventBus listeners', stats) : null;
  } catch (e) {
    logger && logger.error ? logger.error('Error during SIGTERM cleanup:', e) : null;
  }
});

process.on('SIGINT', () => {
  try {
    const stats = bus.emergencyCleanup();
    logger && logger.info ? logger.info('Process SIGINT: Cleaned up PortfolioEventBus listeners', stats) : null;
  } catch (e) {
    logger && logger.error ? logger.error('Error during SIGINT cleanup:', e) : null;
  }
});

// Periodic cleanup every 5 minutes to prevent accumulation
setInterval(() => {
  try {
    const stats = bus.getListenerStats();
    if (stats.totalListeners > 50) {
      logger && logger.warn ? logger.warn('High listener count detected, consider cleanup', stats) : null;
    }
    
    // Auto-cleanup users with excessive listeners (>10)
    for (const [userKey, count] of Object.entries(stats.userBreakdown)) {
      if (count > 10) {
        const [userType, userId] = userKey.split(':');
        logger && logger.warn ? logger.warn(`Auto-cleaning excessive listeners for user ${userKey} (${count} listeners)`) : null;
        bus.cleanupUserListeners(userType, userId);
      }
    }
  } catch (e) {
    logger && logger.error ? logger.error('Error during periodic cleanup:', e) : null;
  }
}, 5 * 60 * 1000); // 5 minutes

module.exports = bus;
