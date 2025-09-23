const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'mariadb',
    logging: false,
    pool: {
      // Increased pool for higher concurrency and to keep warm connections
      // Suitable starting point for deployments serving up to ~1000 active users
      max: 150,
      min: 10,
      acquire: 60000, // wait up to 60s to get a connection under load
      idle: 30000,    // keep idle connections for 30s
      evict: 10000,   // run eviction every 10s
    },
    define: {
      underscored: true, // optional, for snake_case columns
    }
  }
);

module.exports = sequelize;
