const EventEmitter = require('events');

class PortfolioEventBus extends EventEmitter {
  makeUserKey(userType, userId) {
    return `${String(userType).toLowerCase()}:${String(userId)}`;
  }

  emitUserUpdate(userType, userId, payload = {}) {
    const key = this.makeUserKey(userType, userId);
    this.emit(`user:${key}`, { userType, userId, ...payload });
  }

  onUserUpdate(userType, userId, handler) {
    const key = this.makeUserKey(userType, userId);
    this.on(`user:${key}`, handler);
    return () => this.removeListener(`user:${key}`, handler);
  }
}

module.exports = new PortfolioEventBus();
