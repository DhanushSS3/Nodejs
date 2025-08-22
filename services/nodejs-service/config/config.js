// // require('dotenv').config();
// require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// module.exports = {
//   development: {
//     username: process.env.DB_USER,
//     password: process.env.DB_PASS,
//     database: process.env.DB_NAME,
//     host: process.env.DB_HOST,
//     port: process.env.DB_PORT,
//     dialect: 'mariadb'
//   },
//   production: {
//     // add prod credentials if needed
//   }
// };
// console.log('DB USER:', process.env.DB_USER);
// console.log('DB PASS:', process.env.DB_PASS ? '***' : '(empty)');


console.log("Loading hardcoded values");
module.exports = {
  development: {
    username: "u436589492_forex",
    password: "Setupdev@1998",
    database: "u436589492_forex",
    host: "127.0.0.1",
    port: 3306,
    dialect: "mariadb",
  },
};
