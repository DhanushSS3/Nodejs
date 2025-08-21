#!/usr/bin/env node

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env") });

const sequelize = require('../config/db');
const PermissionSeeder = require('../seeders/permissions.seeder');

async function main() {
  try {
    // Connect to database
    await sequelize.authenticate();
    console.log('✅ Database connected.');

    // Get command line arguments
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
      case 'seed':
        await PermissionSeeder.seed();
        break;
      case 'clear':
        await PermissionSeeder.clear();
        break;
      case 'reset':
        await PermissionSeeder.clear();
        await PermissionSeeder.seed();
        break;
      default:
        console.log(`
Usage: node seed-permissions.js [command]

Commands:
  seed    - Add default permissions to database
  clear   - Remove all permissions from database
  reset   - Clear and re-seed permissions

Examples:
  node seed-permissions.js seed
  node seed-permissions.js reset
        `);
        break;
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
