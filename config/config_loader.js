const fs = require('fs');
const path = require('path');

const defaultConfig = {
  database: {
    host: "10.15.10.194",
    port: 3306,
    user: "sarsafe2",
    password: "Sarsoft@2026#",
    database: "esurv",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  },
  api_port: 3000,
  protocols: {
    mayur: { enabled: true, port: 9999 },
    rass: { enabled: true, port: 6550 },
    smarti: { enabled: true, port: 5500 },
    rax: { enabled: true, port: 5502 },
    securico: { enabled: true, port: 5503 },
    intellitech: { enabled: true, port: 3001 }
  }
};

function loadConfig() {
  const configPath = path.join(process.cwd(), 'config.json');
  let config = defaultConfig;

  try {
    if (fs.existsSync(configPath)) {
      const fileData = fs.readFileSync(configPath, 'utf8');
      const parsedConfig = JSON.parse(fileData);
      
      // Deep merge with defaultConfig to ensure all properties exist
      config = {
        ...defaultConfig,
        ...parsedConfig,
        database: {
          ...defaultConfig.database,
          ...(parsedConfig.database || {})
        },
        protocols: {
          ...defaultConfig.protocols,
          ...(parsedConfig.protocols || {})
        }
      };
      
      // Ensure sub-protocol objects have defaults
      for (const key of Object.keys(defaultConfig.protocols)) {
        config.protocols[key] = {
          ...defaultConfig.protocols[key],
          ...(parsedConfig.protocols ? parsedConfig.protocols[key] : {})
        };
      }

      console.log(`✅ Loaded main configuration from config.json`);
    } else {
      // Legacy fallbacks check if config.json does not exist
      const legacyDbPath = path.join(process.cwd(), 'db_config.json');
      if (fs.existsSync(legacyDbPath)) {
        try {
          const dbData = JSON.parse(fs.readFileSync(legacyDbPath, 'utf8'));
          config.database = { ...config.database, ...dbData };
        } catch (e) {}
      }

      const legacyServerPath = path.join(process.cwd(), 'server_config.json');
      if (fs.existsSync(legacyServerPath)) {
        try {
          const srvData = JSON.parse(fs.readFileSync(legacyServerPath, 'utf8'));
          if (srvData.RUN_MAYUR !== undefined) config.protocols.mayur.enabled = srvData.RUN_MAYUR;
          if (srvData.RUN_RASS !== undefined) config.protocols.rass.enabled = srvData.RUN_RASS;
          if (srvData.RUN_SMARTI !== undefined) config.protocols.smarti.enabled = srvData.RUN_SMARTI;
          if (srvData.RUN_RAX !== undefined) config.protocols.rax.enabled = srvData.RUN_RAX;
          if (srvData.RUN_SECURICO !== undefined) config.protocols.securico.enabled = srvData.RUN_SECURICO;
          if (srvData.RUN_INTELLITECH !== undefined) config.protocols.intellitech.enabled = srvData.RUN_INTELLITECH;
        } catch (e) {}
      }

      // Save initial unified config.json
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
