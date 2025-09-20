// const Redis = require("ioredis");

// const hosts = (process.env.REDIS_HOSTS || "127.0.0.1:7001,127.0.0.1:7002,127.0.0.1:7003").split(",");
// const nodes = hosts.map(h => {
//   const [host, port] = h.split(":");
//   return { host, port: parseInt(port) };
// });

// const redisCluster = new Redis.Cluster(nodes, {
//   redisOptions: {
//     connectTimeout: 10000,
//   },
//   // Add this natMap configuration
//   natMap: {
//     "172.28.0.2:7001": { host: "127.0.0.1", port: 7001 },
//     "172.28.0.3:7002": { host: "127.0.0.1", port: 7002 },
//     "172.28.0.4:7003": { host: "127.0.0.1", port: 7003 },
//     "172.28.0.5:7004": { host: "127.0.0.1", port: 7004 },
//     "172.28.0.6:7005": { host: "127.0.0.1", port: 7005 },
//     "172.28.0.7:7006": { host: "127.0.0.1", port: 7006 },
//     "172.28.0.8:7007": { host: "127.0.0.1", port: 7007 },
//     "172.28.0.9:7008": { host: "127.0.0.1", port: 7008 },
//     "172.28.0.10:7009": { host: "127.0.0.1", port: 7009 },
//   },
// });

// redisCluster.on("error", (err) => {
//   console.error("❌ Redis Cluster error:", err);
// });

// const redisReadyPromise = new Promise((resolve, reject) => {
//   redisCluster.on('ready', () => {
//     console.log("✅ Redis Cluster is ready to receive commands");
//     resolve(redisCluster);
//   });
//   redisCluster.on('error', (err) => {
//     reject(err);
//   });
// });

// module.exports = {
//   redisCluster,
//   redisReadyPromise,
// };



// Load environment variables from the root .env file
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

const Redis = require("ioredis");

const hosts = (process.env.REDIS_HOSTS || "127.0.0.1:7001").split(",");
const nodes = hosts.map(h => {
  const [host, port] = h.split(":");
  return { host, port: parseInt(port) };
});

const redisCluster = new Redis.Cluster(nodes, {
  // Add password to redisOptions
  redisOptions: {
    password: process.env.REDIS_PASSWORD,
    connectTimeout: 10000,
  },
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