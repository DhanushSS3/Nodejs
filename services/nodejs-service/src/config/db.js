const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'mysql',
    logging: false,
    timezone: '+00:00', // Force UTC timezone for all operations
    dialectOptions: {
      timezone: 'Z',    // MySQL UTC timezone (equivalent to +00:00)
      dateStrings: true,
      typeCast: function (field, next) {
        // Cast DATETIME fields to UTC
        if (field.type === 'DATETIME') {
          return field.string();
        }
        return next();
      }
    },
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
