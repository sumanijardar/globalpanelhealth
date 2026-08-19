const net = require("net");
const fs = require("fs");
const path = require("path");
const pool = require("../config/database");
const decoders = require("../decoders");
const decodeSIA = decoders.rax;
const healthEvents = require("../services/health_events");

const configPath = path.join(process.cwd(), 'rax_config.json');
let raxConfig = {};

try {
  if (fs.existsSync(configPath) && fs.statSync(configPath).size > 0) {
    raxConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`✅ Loaded RAX device configuration for ${Object.keys(raxConfig).length} devices.`);
  } else {
    raxConfig = {};
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2));
  }
} catch (err) {
  raxConfig = {};
  fs.writeFileSync(configPath, JSON.stringify({}, null, 2));
}

const TCP_PORT = 5502;

const activeSockets = new Map();
const eventLog = [];
const MAX_LOG = 100;
const commandQueue = new Map();
const connectWaiters = new Map();

function buildRaxCommand(cmdName, account, mac, zone = "000") {
  const cmd = cmdName.toUpperCase();

  // Read Port Status -> START ... RPSENDD
  if (cmd === 'READ_PORT_STATUS' || cmd === 'READ_ZONE_STATUS') {
    return `STARTACC${account}MAC${mac}RPSENDD`;
  }

  // Read Channel Status -> START ... RCSEND
  if (cmd === 'READ_RELAY_STATUS' || cmd === 'READ_OUTPUT_STATUS') {
    return `STARTACC${account}MAC${mac}RCSEND`;
  }

  // Read Panel ID -> START ... RRLAEND
  if (cmd === 'READ_PANEL_ID') {
    return `STARTACC${account}MAC${mac}RRLAEND`;
  }

  return null;
}

async function sendCommandToPanel(socket, commandType, accountNo, zone = "000") {
  if (!socket || socket.destroyed) return false;

  let mac = "104039025063100105"; // Default fallback MAC

  try {
    const [rows] = await pool.query("SELECT mac_id FROM sites WHERE NewPanelID = ? LIMIT 1", [accountNo]);
    if (rows && rows.length > 0 && rows[0].mac_id) {
      mac = String(rows[0].mac_id).trim();
    } else {
      const meta = raxConfig[accountNo];
      if (meta && meta.mac_id) mac = meta.mac_id;
    }
  } catch (err) {
    const meta = raxConfig[accountNo];
    if (meta && meta.mac_id) mac = meta.mac_id;
  }

  const cmd = buildRaxCommand(commandType, accountNo, mac, zone);
  if (!cmd) return false;

  socket.write(cmd);
  console.log(`\n📤 [RAX] Command Sent [${commandType}] for Panel #${accountNo}:`);
  console.log(`   Raw Format: ${cmd}`);
  return true;
}

function handleSocketEvents(socket, remoteIp, initialAccount = null) {
  let currentAccount = initialAccount;
  socket.setKeepAlive(true, 30000);
  socket.setTimeout(180000);

  socket.on("timeout", () => socket.destroy());
  socket.on("data", async (data) => {
    const message = data.toString().trim();
    if (!message) return;

    console.log(`\n📩 [RAX] Raw Data Received:`, message);

    const decoded = decodeSIA(message);

    console.log(`🔓 [RAX] Decoded Meaning:`);
    console.log(JSON.stringify(decoded, null, 2));

    if (decoded.account) {
      currentAccount = decoded.account;
      activeSockets.set(currentAccount, socket);

      if (decoded.macId) {
        if (!raxConfig[currentAccount] || raxConfig[currentAccount].mac_id !== decoded.macId) {
          raxConfig[currentAccount] = { mac_id: decoded.macId };
          try {
            fs.writeFileSync(configPath, JSON.stringify(raxConfig, null, 2));
          } catch (e) {}
        }
      }

      const waiters = connectWaiters.get(currentAccount);
      if (waiters && waiters.length > 0) {
        for (const resolve of waiters) resolve({ account: currentAccount });
        connectWaiters.set(currentAccount, []);
      }
    }

    // Process Port/Zone Status
    if (decoded.code === "RPS_RES" && decoded.zonesList && currentAccount) {
      try {
        const receivedtime = new Date().toISOString().slice(0, 19).replace('T', ' ');
        let panelName = 'RAX';
        try {
          const [siteRows] = await pool.query("SELECT Panel_Make FROM sites WHERE NewPanelID = ? LIMIT 1", [currentAccount]);
          if (siteRows && siteRows.length > 0) panelName = siteRows[0].Panel_Make || 'RAX';
        } catch (err) { }

        let columns = ['panelid', 'udate', 'ip', 'panelName'];
        let placeholders = ['?', '?', '?', '?'];
        let values = [currentAccount, receivedtime, remoteIp || '', panelName];
        let setQueryArr = ['udate = ?', 'ip = ?', 'panelName = ?'];
        let setValues = [receivedtime, remoteIp || '', panelName];

        decoded.zonesList.forEach(z => {
          if (z.zone >= 1 && z.zone <= 60) {
            const colName = `zon${z.zone}`;
            columns.push(colName);
            placeholders.push('?');
            values.push(z.status);
            setQueryArr.push(`${colName} = ?`);
            setValues.push(z.status);
          }
        });

        const [rows] = await pool.query("SELECT id FROM panel_health WHERE panelid = ? LIMIT 1", [currentAccount]);
        if (rows && rows.length > 0) {
          const updateQuery = `UPDATE panel_health SET ${setQueryArr.join(', ')} WHERE panelid = ?`;
          await pool.query(updateQuery, [...setValues, currentAccount]);
          console.log(`✅ [RAX] Zone status (${decoded.zonesList.length} zones) UPDATED in panel_health for Panel #${currentAccount}`);
        } else {
          const insertQuery = `INSERT INTO panel_health (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
          await pool.query(insertQuery, values);
          console.log(`✅ [RAX] Zone status (${decoded.zonesList.length} zones) INSERTED into panel_health for Panel #${currentAccount}`);
        }

        healthEvents.emit('health_saved', {
          account: currentAccount,
          make: panelName,
          type: 'zone',
          count: decoded.zonesList.length,
          timestamp: receivedtime
        });
      } catch (dbErr) {
        console.error(`❌ [RAX] DB Error saving zone status to panel_health:`, dbErr.message);
      }
    }

    // Process Relay/Channel Status
    if (decoded.code === "RCS_RES" && decoded.channelList && currentAccount) {
      try {
        const receivedtime = new Date().toISOString().slice(0, 19).replace('T', ' ');
        let panelName = 'RAX';
        try {
          const [siteRows] = await pool.query("SELECT Panel_Make FROM sites WHERE NewPanelID = ? LIMIT 1", [currentAccount]);
          if (siteRows && siteRows.length > 0) panelName = siteRows[0].Panel_Make || 'RAX';
        } catch (err) { }

        let columns = ['panelid', 'udate', 'ip', 'panelName'];
        let placeholders = ['?', '?', '?', '?'];
        let values = [currentAccount, receivedtime, remoteIp || '', panelName];
        let setQueryArr = ['udate = ?', 'ip = ?', 'panelName = ?'];
        let setValues = [receivedtime, remoteIp || '', panelName];

        decoded.channelList.forEach(c => {
          if (c.channel >= 1 && c.channel <= 20) {
            const colName = `relay${c.channel}`;
            const stVal = c.status === '1' ? '1' : '0';
            columns.push(colName);
            placeholders.push('?');
            values.push(stVal);
            setQueryArr.push(`${colName} = ?`);
            setValues.push(stVal);
          }
        });

        const [rows] = await pool.query("SELECT id FROM panel_health WHERE panelid = ? LIMIT 1", [currentAccount]);
        if (rows && rows.length > 0) {
          const updateQuery = `UPDATE panel_health SET ${setQueryArr.join(', ')} WHERE panelid = ?`;
          await pool.query(updateQuery, [...setValues, currentAccount]);
          console.log(`✅ [RAX] Channel/Relay status UPDATED in panel_health for Panel #${currentAccount}`);
        } else {
          const insertQuery = `INSERT INTO panel_health (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
          await pool.query(insertQuery, values);
          console.log(`✅ [RAX] Channel/Relay status INSERTED into panel_health for Panel #${currentAccount}`);
        }

        healthEvents.emit('health_saved', {
          account: currentAccount,
          make: panelName,
          type: 'relay',
          count: decoded.channelList.length,
          timestamp: receivedtime
        });
      } catch (dbErr) {
        console.error(`❌ [RAX] DB Error saving channel status to panel_health:`, dbErr.message);
      }
    }

    eventLog.unshift({ ...decoded, raw: message, receivedAt: new Date().toISOString() });
    if (eventLog.length > MAX_LOG) eventLog.pop();

    if (currentAccount && !socket.destroyed) {
      const queue = commandQueue.get(currentAccount);
      if (queue && queue.length > 0) {
        const pending = [...queue];
        commandQueue.set(currentAccount, []);
        for (const item of pending) {
          const success = await sendCommandToPanel(socket, item.command, currentAccount, item.zone || '000');
          if (item.resolve) item.resolve({ sent: success, command: item.command, zone: item.zone || '000' });
        }
      }
    }
  });

  socket.on("end", () => { if (currentAccount) activeSockets.delete(currentAccount); });
  socket.on("error", () => { });
  socket.on("close", () => { if (currentAccount) activeSockets.delete(currentAccount); });
}

function initiatePanelConnection(panelId, ip) {
  console.log(`\n⏳ [RAX] Attempting OUTGOING connection to Panel #${panelId} at IP: ${ip}:${TCP_PORT}...`);
  const socket = new net.Socket();

  socket.connect(TCP_PORT, ip, () => {
    console.log(`✅ [RAX] Successfully connected to Panel #${panelId} (${ip})`);
    activeSockets.set(panelId, socket);
    handleSocketEvents(socket, ip, panelId);

    const queue = commandQueue.get(panelId);
    if (queue && queue.length > 0) {
      const pending = [...queue];
      commandQueue.set(panelId, []);
      for (const item of pending) {
        sendCommandToPanel(socket, item.command, panelId, item.zone || '000').then(success => {
          if (item.resolve) item.resolve({ sent: success, command: item.command, zone: item.zone || '000' });
        });
      }
    }
  });

  socket.on("error", (err) => {
    console.log(`❌ [RAX] Connection failed to Panel #${panelId} (${ip}): ${err.message}`);
  });

  socket.on("close", () => {
    activeSockets.delete(panelId);
  });
}

function startServer(customPort) {
  const port = customPort || TCP_PORT;
  const tcpServer = net.createServer((socket) => {
    const remoteIp = socket.remoteAddress ? socket.remoteAddress.replace(/^.*:/, '').trim() : null;
    console.log(`\n📡 [RAX] Device TCP Connection Initiated from IP: ${remoteIp}`);
    handleSocketEvents(socket, remoteIp);
  });

  tcpServer.listen(port, () => {
    console.log(`📡 RAX Protocol Manager listening on TCP Port ${port}`);
  });

  return tcpServer;
}

function queueCommand(account, command, zone = "000", waitMs = 60000) {
  return new Promise(async (resolve) => {
    const socket = activeSockets.get(account);
    if (socket && !socket.destroyed) {
      const success = await sendCommandToPanel(socket, command, account, zone);
      return resolve({ success, status: success ? 'sent' : 'send_failed', account, command });
    }

    if (!commandQueue.has(account)) commandQueue.set(account, []);
    const queue = commandQueue.get(account);
    const item = { command, zone, resolve, queuedAt: Date.now() };
    queue.push(item);

    setTimeout(() => {
      const currentQ = commandQueue.get(account) || [];
      const idx = currentQ.indexOf(item);
      if (idx !== -1) {
        currentQ.splice(idx, 1);
        resolve({ success: false, status: 'timeout', account, command });
      }
    }, waitMs);
  });
}

function checkConnection(account, waitMs = 100) {
  return new Promise((resolve) => {
    const socket = activeSockets.get(account);
    if (socket && !socket.destroyed) {
      return resolve({ success: true, status: 'connected', account });
    }
    if (waitMs <= 0) return resolve({ success: false, status: 'disconnected', account });

    if (!connectWaiters.has(account)) connectWaiters.set(account, []);
    const waiters = connectWaiters.get(account);
    let resolved = false;

    const onConnect = () => {
      if (!resolved) {
        resolved = true;
        resolve({ success: true, status: 'connected', account });
      }
    };
    waiters.push(onConnect);

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        const idx = waiters.indexOf(onConnect);
        if (idx !== -1) waiters.splice(idx, 1);
        resolve({ success: false, status: 'disconnected', account });
      }
    }, waitMs);
  });
}

function getEvents(account, lastIndex = 0) {
  let evts = account ? eventLog.filter(e => e.account === account) : eventLog;
  if (lastIndex > 0 && lastIndex < evts.length) {
    evts = evts.slice(0, lastIndex);
  }
  return { success: true, count: evts.length, events: evts };
}

function getStatus() {
  const devices = [];
  for (const [account, socket] of activeSockets.entries()) {
    devices.push({
      account,
      connected: socket && !socket.destroyed,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort
    });
  }
  return { success: true, devices };
}

module.exports = {
  startServer,
  queueCommand,
  checkConnection,
  getEvents,
  getStatus,
  initiatePanelConnection
};
