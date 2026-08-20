const mysql = require("mysql2/promise");
const { loadConfig } = require("./config_loader");

// Load configuration
const config = loadConfig();
const dbConfig = config.database;

console.log(`✅ Database configured for host: ${dbConfig.host}, port: ${dbConfig.port || 3306}, database: ${dbConfig.database}`);

// -------------------------------------------------
// 💾 DATABASE CONNECTION POOL
// -------------------------------------------------
const pool = mysql.createPool(dbConfig);

module.exports = pool;

