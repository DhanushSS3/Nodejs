// config/redis.js
const Redis = require("ioredis");

let connected = false;

// The nodes your app will initially connect to from the host machine.
const startupNodes = [
  { host: "127.0.0.1", port: 7001 },
  { host: "127.0.0.1", port: 7002 },
  { host: "127.0.0.1", port: 7003 },
  // Add more if needed, but a few is enough for discovery.
];

const redisCluster = new Redis.Cluster(startupNodes, {
  // THIS IS THE FIX: Map internal Docker IPs to localhost.
  natMap: {
    "172.28.0.2": { host: "127.0.0.1", port: 7001 },
    "172.28.0.3": { host: "127.0.0.1", port: 7002 },
    "172.28.0.4": { host: "127.0.0.1", port: 7003 },
    "172.28.0.5": { host: "127.0.0.1", port: 7004 },
    "172.28.0.6": { host: "127.0.0.1", port: 7005 },
    "172.28.0.7": { host: "127.0.0.1", port: 7006 },
    "172.28.0.8": { host: "127.0.0.1", port: 7007 },
    "172.28.0.9": { host: "127.0.0.1", port: 7008 },
    "172.28.0.10": { host: "127.0.0.1", port: 7009 },
  },
  redisOptions: {
    connectTimeout: 10000,
  },
});

redisCluster.on("connect", () => {
  if (!connected) {
    console.log("✅ Redis Cluster connected");
    connected = true;
  }
});

redisCluster.on("error", (err) => {
    // It's a good practice to log errors.
    console.error("❌ Redis Cluster client error:", err);
});

module.exports = redisCluster;