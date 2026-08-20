const fs = require('fs');
const path = require('path');

const defaultConfig = {
  database: {
    host: "localhost",
    port: 3306,
    user: "root",
    password: "",
    database: "esurv",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  },
  api_port: 3000,
  health_check: {
    enabled: true,
    check_zone_status: false,
    check_relay_status: false,
    panel_timeout_seconds: 15,
    delay_between_panels_ms: 1000,
    cycle_interval_seconds: 10,
    panel_make_filter: "ALL"
  },
  protocols: {
    mayur: { enabled: false, port: 9999 },
    rass: { enabled: false, port: 6550 },
    smarti: { enabled: false, port: 5500 },
    rax: { enabled: false, port: 5502 },
    securico: { enabled: false, port: 5503 },
    intellitech: { enabled: false, port: 3001 }
  }
};

function loadConfig() {
  const configPath = path.join(process.cwd(), 'config.json');
  let config = defaultConfig;

  try {
    if (fs.existsSync(configPath)) {
      const fileData = fs.readFileSync(configPath, 'utf8');
      const parsedConfig = JSON.parse(fileData);

      config = {
        ...defaultConfig,
        ...parsedConfig,
        database: {
          ...defaultConfig.database,
          ...(parsedConfig.database || {})
        },
        health_check: {
          ...defaultConfig.health_check,
          ...(parsedConfig.health_check || {})
        },
        protocols: {
          ...defaultConfig.protocols,
          ...(parsedConfig.protocols || {})
        }
      };

      for (const key of Object.keys(defaultConfig.protocols)) {
        config.protocols[key] = {
          ...defaultConfig.protocols[key],
          ...(parsedConfig.protocols ? parsedConfig.protocols[key] : {})
        };
      }

      console.log(`✅ Loaded main configuration from config.json`);
    } else {
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
      console.log(`ℹ️ Created default config.json template at ${configPath}`);
    }
  } catch (err) {
    console.error(`❌ Error reading config.json, using defaults:`, err.message);
  }

  return config;
}

module.exports = {
  loadConfig,
  defaultConfig
};
