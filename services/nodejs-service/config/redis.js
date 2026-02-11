// Load environment variables from the root .env file
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const Redis = require("ioredis");

const hosts = (process.env.REDIS_HOSTS || "127.0.0.1:7001").split(",");
const nodes = hosts.map(h => {
  const [host, port] = h.split(":");
  return { host, port: parseInt(port) };
});

// Dedicated non-cluster client for Pub/Sub publishing.
// Redis Cluster Pub/Sub is node-local; pinning to a single node (same one Python subscribes to)
// makes delivery deterministic.
const pubsubHost = nodes[0]?.host || '127.0.0.1';
const pubsubPort = nodes[0]?.port || 7001;
const redisPubSubPublisher = new Redis({
  host: pubsubHost,
  port: pubsubPort,
  password: process.env.REDIS_PASSWORD || 'admin@livefxhub@123',
  connectTimeout: 10000,
  enableReadyCheck: true,
  maxRetriesPerRequest: null,
});

redisPubSubPublisher.on('error', (err) => {
  console.error('❌ Redis PubSub Publisher error:', err);
});

const redisCluster = new Redis.Cluster(nodes, {
  // Redis options applied to each node connection
  redisOptions: {
    password: process.env.REDIS_PASSWORD || 'admin@livefxhub@123',
    connectTimeout: 10000,
    maxRetriesPerRequest: null, // Allow unlimited retries for initial connection
    retryDelayOnFailover: 100,
    keepAlive: 30000,
    family: 4,
    lazyConnect: false, // Connect immediately to avoid offline queue issues
    enableReadyCheck: true,
    // Each node can have up to ~167 connections (1000/6 nodes)
    // Note: ioredis doesn't have maxConnections per node, it manages pool automatically
  },
  // Cluster-level settings
  enableOfflineQueue: true,  // Enable offline queue to handle commands before cluster is ready
  maxRetriesPerRequest: null, // Allow unlimited retries
  retryDelayOnFailover: 100,
  scaleReads: 'slave',
  enableReadyCheck: true,
  // The natMap is essential for connecting from outside the Docker network
  natMap: {
    "172.28.0.2:7001": { host: "127.0.0.1", port: 7001 },
    "172.28.0.3:7002": { host: "127.0.0.1", port: 7002 },
    "172.28.0.4:7003": { host: "127.0.0.1", port: 7003 },
    "172.28.0.5:7004": { host: "127.0.0.1", port: 7004 },
    "172.28.0.6:7005": { host: "127.0.0.1", port: 7005 },
    "172.28.0.7:7006": { host: "127.0.0.1", port: 7006 },
    "172.28.0.8:7007": { host: "127.0.0.1", port: 7007 },
    "172.28.0.9:7008": { host: "127.0.0.1", port: 7008 },
    "172.28.0.10:7009": { host: "127.0.0.1", port: 7009 },
  },
});

redisCluster.on("error", (err) => {
  console.error("❌ Redis Cluster error:", err);
});

redisCluster.on("connect", () => {
  console.log("🔄 Redis Cluster connecting...");
});

redisCluster.on("ready", () => {
  console.log("✅ Redis Cluster is ready to receive commands");
});

redisCluster.on("close", () => {
  console.log("🔌 Redis Cluster connection closed");
});

redisCluster.on("reconnecting", () => {
  console.log("🔄 Redis Cluster reconnecting...");
});

const redisReadyPromise = new Promise((resolve, reject) => {
  // Set a timeout for initial connection
  const timeout = setTimeout(() => {
    console.warn("⚠️ Redis cluster taking longer than expected to connect, but continuing...");
    resolve(redisCluster); // Resolve anyway since offline queue is enabled
  }, 15000); // 15 second timeout

  redisCluster.on('ready', () => {
    clearTimeout(timeout);
    console.log("✅ Redis Cluster is ready to receive commands");
    resolve(redisCluster);
  });
  
  redisCluster.on('error', (err) => {
    clearTimeout(timeout);
    console.error("❌ Redis Cluster connection failed:", err);
    // Don't reject immediately, let offline queue handle it
    resolve(redisCluster);
  });
});

module.exports = {
  redisCluster,
  redisReadyPromise,
  redisPubSubPublisher,
};