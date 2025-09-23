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
      max: 100,        // Increased from 50 to handle 1000 users with concurrent orders
      min: 15,         // Increased from 0 to keep warm connections (eliminates handshake latency)
      acquire: 60000,  // Increased from 30s to 60s for high-load scenarios
      idle: 30000,     // Increased from 10s to 30s to keep connections alive longer
      evict: 60000     // Added: Check for idle connections every 60s
    },
    define: {
      underscored: true, // optional, for snake_case columns
    }
  }
);

module.exports = sequelize;
