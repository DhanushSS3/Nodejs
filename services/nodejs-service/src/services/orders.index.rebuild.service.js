const { redisCluster } = require('../../config/redis');
const logger = require('./logger.service');

class OrdersIndexRebuildService {
  constructor(redis = redisCluster) {
    this.redis = redis;
  }

  // Utility: scan across all master nodes for a given MATCH pattern
  async scanMastersForPattern(pattern, count = 500) {
    const masters = this.redis.nodes('master');
    const keys = [];
    for (const node of masters) {
      let cursor = '0';
      do {
        try {
          const res = await node.scan(cursor, 'MATCH', pattern, 'COUNT', count);
          cursor = res[0];
          const batch = res[1] || [];
          for (const k of batch) keys.push(k);
        } catch (err) {
          logger.warn(`SCAN failed on a master for pattern ${pattern}: ${err.message}`);
          break;
        }
      } while (cursor !== '0');
    }
    return keys;
  }

  // Utility: run pipeline in chunks for better throughput
  async runPipelined(commands, chunkSize = 200) {
    const results = [];
    for (let i = 0; i < commands.length; i += chunkSize) {
      const slice = commands.slice(i, i + chunkSize);
      const pipeline = this.redis.pipeline();
      for (const cmd of slice) {
        pipeline[cmd[0]](...cmd.slice(1));
      }
      const res = await pipeline.exec();
      results.push(...res);
    }
    return results;
  }

  // Derive order_id from order key: user_holdings:{user_type:user_id}:{order_id}
  extractOrderIdFromKey(orderKey) {
    const parts = String(orderKey).split(':');
    return parts[parts.length - 1];
  }

  // Extract {user_type, user_id} from user_orders_index:{user_type:user_id}
  extractHashTagFromIndexKey(indexKey) {
    // indexKey format: user_orders_index:{user_type:user_id}
    const start = indexKey.indexOf('{');
    const end = indexKey.indexOf('}');
    if (start === -1 || end === -1 || end <= start + 1) return null;
    const hashTag = indexKey.substring(start + 1, end);
    const [user_type, user_id] = hashTag.split(':');
    if (!user_type || !user_id) return null;
    return { hashTag, user_type, user_id };
  }

  // Rebuild indices for a single user (fast and safe as all keys share the same slot)
  async rebuildUserIndices(userType, userId) {
    const hashTag = `${userType}:${userId}`;
    const orderPattern = `user_holdings:{${hashTag}}:*`;
    const indexKey = `user_orders_index:{${hashTag}}`;

    // 1) Find all order keys for this user across cluster (they all live on one slot)
    const orderKeys = await this.scanMastersForPattern(orderPattern, 500);

    // 2) Derive order IDs
    const orderIds = orderKeys.map(k => this.extractOrderIdFromKey(k));
    const uniqueOrderIds = Array.from(new Set(orderIds));

    // 3) Fetch symbols for each order to rebuild symbol_holders
    const symbolFetchCmds = orderKeys.map(k => ['hget', k, 'symbol']);
    const symbolRes = await this.runPipelined(symbolFetchCmds, 300);
    const symbols = [];
    for (let i = 0; i < symbolRes.length; i++) {
      const [err, val] = symbolRes[i];
      if (!err && val) symbols.push(String(val).toUpperCase());
      else symbols.push(null);
    }

    // 4) Rebuild user_orders_index by adding missing and removing stale
    const existing = new Set(await this.redis.smembers(indexKey));
    const desired = new Set(uniqueOrderIds);
    const toAdd = uniqueOrderIds.filter(oid => !existing.has(oid));
    const toRemove = Array.from(existing).filter(oid => !desired.has(oid));

    const addCmds = toAdd.length ? [['sadd', indexKey, ...toAdd]] : [];
    const removeCmds = toRemove.map(oid => ['srem', indexKey, oid]);
    await this.runPipelined([...addCmds, ...removeCmds], 1); // single op pipelines

    // 5) Ensure symbol_holders has this user for all symbols encountered
    const uniqueSymbols = Array.from(new Set(symbols.filter(Boolean)));
    const holderValue = `${userType}:${userId}`;
    const shCmds = uniqueSymbols.map(sym => ['sadd', `symbol_holders:${sym}:${userType}`, holderValue]);
    if (shCmds.length) await this.runPipelined(shCmds, 200);

    return {
      user_type: userType,
      user_id: userId,
      orders_found: uniqueOrderIds.length,
      index_added: toAdd.length,
      index_removed: toRemove.length,
      symbols_updated: uniqueSymbols.length,
    };
  }

  // Rebuild symbol_holders for a symbol by walking user_orders_index (lighter than scanning all orders)
  async rebuildSymbolHolders(symbol, scope = 'both') {
    const sym = String(symbol).toUpperCase();

    // 1) Find all user_orders_index:* keys
    const idxPattern = 'user_orders_index:*';
    const indexKeys = await this.scanMastersForPattern(idxPattern, 1000);

    let ensured = 0;
    let scannedUsers = 0;

    // 2) For each index, fetch oids and check order symbol
    for (const indexKey of indexKeys) {
      const parsed = this.extractHashTagFromIndexKey(indexKey);
      if (!parsed) continue;
      const { hashTag, user_type, user_id } = parsed;

      if (scope !== 'both' && user_type !== scope) continue;
      scannedUsers += 1;

      let oids = [];
      try {
        oids = await this.redis.smembers(indexKey);
      } catch (e) {
        logger.warn(`SMEMBERS failed for ${indexKey}: ${e.message}`);
        continue;
      }
      if (!oids || !oids.length) continue;

      // Build order keys and fetch symbols in pipeline
      const orderKeys = oids.map(oid => `user_holdings:{${hashTag}}:${oid}`);
      const symbolFetch = orderKeys.map(k => ['hget', k, 'symbol']);
      const symRes = await this.runPipelined(symbolFetch, 300);

      let matchFound = false;
      for (const [err, val] of symRes) {
        if (err) continue;
        if (val && String(val).toUpperCase() === sym) {
          matchFound = true;
          break;
        }
      }

      if (matchFound) {
        try {
          await this.redis.sadd(`symbol_holders:${sym}:${user_type}`, `${user_type}:${user_id}`);
          ensured += 1;
        } catch (e) {
          logger.warn(`SADD symbol_holders error: ${e.message}`);
        }
      }
    }

    return { symbol: sym, scope, holders_ensured: ensured, users_scanned: scannedUsers };
  }

  // Ensure a single mapping exists
  async ensureSymbolHolder(userType, userId, symbol) {
    const sym = String(symbol).toUpperCase();
    const added = await this.redis.sadd(`symbol_holders:${sym}:${userType}`, `${userType}:${userId}`);
    return { ensured: added === 1, symbol: sym, user_type: userType, user_id: userId };
  }
}

module.exports = new OrdersIndexRebuildService();
