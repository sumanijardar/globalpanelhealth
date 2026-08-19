const http = require("http");
const { URL } = require("url");
const pool = require("./config/database");
const { loadConfig } = require("./config/config_loader");

// Import protocol handlers
const mayurProtocol = require("./protocols/mayur");
const rassProtocol = require("./protocols/rass");
const smartiProtocol = require("./protocols/smarti");
const raxProtocol = require("./protocols/rax");
const securicoProtocol = require("./protocols/securico");
const intellitechProtocol = require("./protocols/intellitech");
const { startHealthPoller } = require("./services/health_poller");
const pkg = require("./package.json");

// Load master configuration
const appConfig = loadConfig();

// Start TCP / HTTP Protocol Servers
console.log("\n==================================================");
console.log(`🌐 GLOBAL PANEL HEALTH SERVER (v${pkg.version || '1.0.0'})`);
console.log("==================================================");
console.log("Starting Protocol Managers...");
console.log("--------------------------------------------------");

if (appConfig.protocols.mayur && appConfig.protocols.mayur.enabled) {
  const port = appConfig.protocols.mayur.port || 9999;
  console.log(`✅ Starting MAYUR Protocol (Port: ${port})`);
  mayurProtocol.startServer(port);
} else {
  console.log("⏸️ MAYUR Protocol is DISABLED (Check config.json)");
}

if (appConfig.protocols.rass && appConfig.protocols.rass.enabled) {
  const port = appConfig.protocols.rass.port || 6550;
  console.log(`✅ Starting RASS Protocol (Port: ${port})`);
  rassProtocol.startServer(port);
} else {
  console.log("⏸️ RASS Protocol is DISABLED (Check config.json)");
}

if (appConfig.protocols.smarti && appConfig.protocols.smarti.enabled) {
  const port = appConfig.protocols.smarti.port || 5500;
  console.log(`✅ Starting SMARTI Protocol (Port: ${port})`);
  smartiProtocol.startServer(port);
} else {
  console.log("⏸️ SMARTI Protocol is DISABLED (Check config.json)");
}

if (appConfig.protocols.rax && appConfig.protocols.rax.enabled) {
  const port = appConfig.protocols.rax.port || 5502;
  console.log(`✅ Starting RAX Protocol (Port: ${port})`);
  raxProtocol.startServer(port);
} else {
  console.log("⏸️ RAX Protocol is DISABLED (Check config.json)");
}

if (appConfig.protocols.securico && appConfig.protocols.securico.enabled) {
  const port = appConfig.protocols.securico.port || 5503;
  console.log(`✅ Starting SECURICO Protocol (Port: ${port})`);
  securicoProtocol.startServer(port);
} else {
  console.log("⏸️ SECURICO Protocol is DISABLED (Check config.json)");
}

if (appConfig.protocols.intellitech && appConfig.protocols.intellitech.enabled) {
  const port = appConfig.protocols.intellitech.port || 3001;
  console.log(`✅ Starting INTELLITECH Protocol (Port: ${port})`);
  intellitechProtocol.startServer(port);
} else {
  console.log("⏸️ INTELLITECH Protocol is DISABLED (Check config.json)");
}

// Start continuous sequential health polling engine
if (appConfig.health_check && appConfig.health_check.enabled) {
  startHealthPoller(appConfig);
} else {
  console.log("⏸️ Global Health Poller is DISABLED in config.json");
}

// ============================================================================
// 🌐 UNIVERSAL HTTP API SERVER
// ============================================================================
const API_PORT = appConfig.api_port || 3000;

const apiServer = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Unified routing helper
  const handleRequest = async (account, action) => {
    if (!account) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing 'account' parameter." }));
    }

    try {
      let panelMake = null;
      let handler = null;

      let [rows] = await pool.query(
        "SELECT Panel_Make FROM sites WHERE NewPanelID = ? LIMIT 1",
        [account]
      );

      if (rows.length > 0) {
        panelMake = (rows[0].Panel_Make || "").toString().trim().toUpperCase();
      } else {
        const mayurDevices = mayurProtocol.getStatus().devices;
        const rassDevices = rassProtocol.getStatus().devices;
        const smartiDevices = smartiProtocol.getStatus().devices;
        const raxDevices = raxProtocol.getStatus().devices;
        const securicoDevices = securicoProtocol.getStatus().devices;
        const intellitechDevices = intellitechProtocol.getStatus().devices;

        if (mayurDevices.find(d => d.account === account && d.connected) || mayurProtocol.getEvents(account, 1).count > 0) {
          panelMake = 'MAYUR';
        } else if (rassDevices.find(d => d.account === account && d.connected) || rassProtocol.getEvents(account, 1).count > 0) {
          panelMake = 'RASS';
        } else if (smartiDevices.find(d => d.account === account && d.connected) || smartiProtocol.getEvents(account, 1).count > 0) {
          panelMake = 'SMARTI';
        } else if (raxDevices.find(d => d.account === account && d.connected) || raxProtocol.getEvents(account, 1).count > 0) {
          panelMake = 'RAX';
        } else if (securicoDevices.find(d => d.account === account && d.connected) || securicoProtocol.getEvents(account, 1).count > 0) {
          panelMake = 'SECURICO';
        } else if (intellitechDevices.find(d => d.account === account && d.connected) || intellitechProtocol.getEvents(account, 1).count > 0) {
          panelMake = 'INTELLITECH';
        }
      }

      if (!panelMake) {
        res.writeHead(404);
        return res.end(JSON.stringify({ error: `Panel ID ${account} not found in database and is not actively connected.` }));
      }

      if (panelMake === 'MAYUR') handler = mayurProtocol;
      else if (panelMake === 'RASS') handler = rassProtocol;
      else if (panelMake.includes('SMART') || panelMake.includes('SMAERT') || panelMake.includes('ZICOM')) handler = smartiProtocol;
      else if (panelMake === 'RAX' || panelMake === 'REX') handler = raxProtocol;
      else if (panelMake.includes('SECURICO')) handler = securicoProtocol;
      else if (panelMake.includes('INTELLITECH') || panelMake.includes('GOLDBOX')) handler = intellitechProtocol;

      if (!handler) {
        res.writeHead(400);
        return res.end(JSON.stringify({ error: `Unsupported Panel Make: ${panelMake}` }));
      }

      await action(handler, panelMake);
    } catch (dbErr) {
      console.error("❌ Database query error:", dbErr.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Database error", details: dbErr.message }));
    }
  };

  // --- /api/check ---
  if (parsedUrl.pathname === '/api/check' && req.method === 'GET') {
    const account = parsedUrl.searchParams.get('account');
    await handleRequest(account, async (handler, make) => {
      const result = await handler.checkConnection(account, 100);
      res.writeHead(200);
      res.end(JSON.stringify({ ...result, panelMake: make }));
    });
  }

  // --- /api/connect ---
  else if (parsedUrl.pathname === '/api/connect' && req.method === 'GET') {
    const account = parsedUrl.searchParams.get('account');
    const wait = parseInt(parsedUrl.searchParams.get('wait') || '60') * 1000;
    await handleRequest(account, async (handler, make) => {
      const result = await handler.checkConnection(account, wait);
      res.writeHead(200);
      res.end(JSON.stringify({ ...result, panelMake: make }));
    });
  }

  // --- /api/zone_status ---
  else if (parsedUrl.pathname === '/api/zone_status' && req.method === 'GET') {
    const account = parsedUrl.searchParams.get('account');
    const wait = parseInt(parsedUrl.searchParams.get('wait') || '15') * 1000;
    await handleRequest(account, async (handler, make) => {
      let cmd = 'READ_ZONE_STATUS';
      if (make === 'RASS') cmd = 'READ_PORT_STATUS_1';
      else if (make === 'SECURICO' || make === 'RAX') cmd = 'READ_PORT_STATUS';
      else if (make.includes('SMART')) cmd = 'STATUS';

      const result = await handler.queueCommand(account, cmd, '000', wait);
      res.writeHead(result.success ? 200 : 500);
      res.end(JSON.stringify({ ...result, panelMake: make, commandSent: cmd }));
    });
  }

  // --- /api/relay_status ---
  else if (parsedUrl.pathname === '/api/relay_status' && req.method === 'GET') {
    const account = parsedUrl.searchParams.get('account');
    const zone = parsedUrl.searchParams.get('zone') || '000';
    const wait = parseInt(parsedUrl.searchParams.get('wait') || '15') * 1000;
    await handleRequest(account, async (handler, make) => {
      const result = await handler.queueCommand(account, 'READ_RELAY_STATUS', zone, wait);
      res.writeHead(result.success ? 200 : 500);
      res.end(JSON.stringify({ ...result, panelMake: make, commandSent: 'READ_RELAY_STATUS' }));
    });
  }

  // --- /api/command ---
  else if (parsedUrl.pathname === '/api/command' && req.method === 'GET') {
    const account = parsedUrl.searchParams.get('account');
    const command = parsedUrl.searchParams.get('command');
    const zone = parsedUrl.searchParams.get('zone') || '000';
    const wait = parseInt(parsedUrl.searchParams.get('wait') || '60') * 1000;

    if (!command) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: "Missing 'command' parameter." }));
    }

    await handleRequest(account, async (handler, make) => {
      console.log(`\n🌐 [API] Request routed to ${make} panel #${account} (Cmd: ${command}, Zone: ${zone})`);
      const result = await handler.queueCommand(account, command, zone, wait);
      res.writeHead(result.success ? 200 : (result.status === 'timeout' ? 200 : 500));
      res.end(JSON.stringify({ ...result, panelMake: make }));
    });
  }

  // --- /api/events ---
  else if (parsedUrl.pathname === '/api/events' && req.method === 'GET') {
    const account = parsedUrl.searchParams.get('account');
    const last = parseInt(parsedUrl.searchParams.get('last') || '0');

    if (account) {
      await handleRequest(account, async (handler, make) => {
        const result = handler.getEvents(account, last);
        res.writeHead(200);
        res.end(JSON.stringify({ ...result, panelMake: make }));
      });
    } else {
      const mayurEvts = mayurProtocol.getEvents(null, last).events;
      const rassEvts = rassProtocol.getEvents(null, last).events;
      const smartiEvts = smartiProtocol.getEvents(null, last).events;
      const raxEvts = raxProtocol.getEvents(null, last).events;
      const securicoEvts = securicoProtocol.getEvents(null, last).events;
      const intellitechEvts = intellitechProtocol.getEvents(null, last).events;
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        count: mayurEvts.length + rassEvts.length + smartiEvts.length + raxEvts.length + securicoEvts.length + intellitechEvts.length,
        events: [...rassEvts, ...securicoEvts, ...raxEvts, ...smartiEvts, ...mayurEvts, ...intellitechEvts]
      }));
    }
  }

  // --- /api/status ---
  else if (parsedUrl.pathname === '/api/status' && req.method === 'GET') {
    const mayurStatus = mayurProtocol.getStatus().devices;
    const rassStatus = rassProtocol.getStatus().devices;
    const smartiStatus = smartiProtocol.getStatus().devices;
    const raxStatus = raxProtocol.getStatus().devices;
    const securicoStatus = securicoProtocol.getStatus().devices;
    const intellitechStatus = intellitechProtocol.getStatus().devices;
    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      mayur: mayurStatus,
      rass: rassStatus,
      smarti: smartiStatus,
      rax: raxStatus,
      securico: securicoStatus,
      intellitech: intellitechStatus
    }));
  }

  // --- /api/health_config ---
  else if (parsedUrl.pathname === '/api/health_config' && req.method === 'GET') {
    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      health_check: appConfig.health_check
    }));
  }

  else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "Route not found. Supported routes: /api/check, /api/connect, /api/zone_status, /api/relay_status, /api/command, /api/events, /api/status, /api/health_config" }));
  }
});

apiServer.listen(API_PORT, () => {
  console.log(`\n🚀 Universal Panel Health Server running on port ${API_PORT}`);
  console.log(`🌐 Test Zone Status API : http://localhost:${API_PORT}/api/zone_status?account=040037`);
  console.log(`🌐 Test Relay Status API: http://localhost:${API_PORT}/api/relay_status?account=040037`);
});
