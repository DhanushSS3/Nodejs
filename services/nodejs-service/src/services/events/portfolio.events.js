const EventEmitter = require('events');
const { redisCluster } = require('../../../config/redis');
const logger = require('../logger.service');

// Unique ID for this process to avoid handling our own published messages
const INSTANCE_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let subscribed = false;

class PortfolioEventBus extends EventEmitter {
  makeUserKey(userType, userId) {
    return `${String(userType).toLowerCase()}:${String(userId)}`;
  }

  emitUserUpdate(userType, userId, payload = {}) {
    const key = this.makeUserKey(userType, userId);
    const evt = { userType, userId, ...payload };
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

  onUserUpdate(userType, userId, handler) {
    const key = this.makeUserKey(userType, userId);
    this.on(`user:${key}`, handler);
    return () => this.removeListener(`user:${key}`, handler);
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

module.exports = bus;
