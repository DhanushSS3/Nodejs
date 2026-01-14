const path = require('path');
// Go up 3 levels: config -> nodejs-service -> services -> root
const envPath = path.resolve(__dirname, '../../../.env'); 

require('dotenv').config({ path: envPath });
module.exports = {
  development: {
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: "mysql",
  },
};