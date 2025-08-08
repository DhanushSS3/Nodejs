// config/redis.js
const Redis = require("ioredis");

const hosts = (process.env.REDIS_HOSTS || "127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003").split(",");
const nodes = hosts.map(h => {
  const [host, port] = h.split(":");
  return { host, port: parseInt(port) };
});

const redisCluster = new Redis.Cluster(nodes, {
  redisOptions: {
    connectTimeout: 10000,
  },
});

redisCluster.on("connect", () => {
  console.log("✅ Redis Cluster connected (connection initiated)");
});

redisCluster.on("error", (err) => {
  console.error("❌ Redis Cluster error:", err);
});

// A new promise to ensure the cluster is ready before use
const redisReadyPromise = new Promise((resolve, reject) => {
  redisCluster.on('ready', () => {
    console.log("✅ Redis Cluster is ready to receive commands");
    resolve(redisCluster);
  });
  redisCluster.on('error', (err) => {
    reject(err);
  });
});

module.exports = {
  redisCluster,
  redisReadyPromise,
};