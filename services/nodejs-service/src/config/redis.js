const Redis = require('ioredis');
require('dotenv').config({ path: '../../.env' });

const redisHosts = process.env.REDIS_HOSTS;
let redisClient;

if (redisHosts) {
  console.log('Attempting to connect to Redis Cluster...');
  const clusterNodes = redisHosts.split(',').map(host => {
    const [hostName, port] = host.split(':');
    return { host: hostName, port: parseInt(port, 10) };
  });

  redisClient = new Redis.Cluster(clusterNodes, {
    clusterRetryStrategy: (times) => Math.min(100 + times * 2, 2000),
    redisOptions: {
      password: process.env.REDIS_PASSWORD,
    },
  });
} else {
  console.log('Attempting to connect to standalone Redis...');
  redisClient = new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || null,
  });
}

redisClient.on('connect', () => console.log('✅ Redis connection established.'));
redisClient.on('ready', () => console.log('✅ Redis is ready.'));
redisClient.on('error', (err) => console.error('Redis Error:', err.message));

module.exports = redisClient;
