const net = require("net");
const fs = require("fs");
const path = require("path");
const pool = require("../config/database");
const decoders = require("../decoders");
const decodeSIA = decoders.rass;
const healthEvents = require("../services/health_events");

// -------------------------------------------------
// 📂 RASS CONFIGURATION MANAGER
// -------------------------------------------------
const configPath = path.join(process.cwd(), 'rass_config.json');
let rassConfig = {};

try {
  if (fs.existsSync(configPath) && fs.statSync(configPath).size > 0) {
    rassConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`✅ Loaded RASS device configuration for ${Object.keys(rassConfig).length} devices.`);
  } else {
    rassConfig = {};
    fs.writeFileSync(configPath, JSON.stringify({}, null, 2));
  }
} catch (err) {
  rassConfig = {};
  fs.writeFileSync(configPath, JSON.stringify({}, null, 2));
}

async function getOrRegisterRASS(macId, remoteIp = null) {
  if (rassConfig[macId]) return rassConfig[macId];

  let panelId = null;
  const clientId = "000000";

  if (remoteIp) {
    try {
      const [rows] = await pool.query("SELECT NewPanelID FROM sites WHERE dvrip = ? LIMIT 1", [remoteIp]);
      if (rows && rows.length > 0 && rows[0].NewPanelID) {
        panelId = String(rows[0].NewPanelID).trim();
      }
    } catch (err) { }
  }

  if (!panelId) {
    let maxId = 13;
    Object.values(rassConfig).forEach(dev => {
      const pId = parseInt(dev.panel_id, 10);
      if (!isNaN(pId) && pId > maxId) maxId = pId;
    });
    panelId = String(maxId + 1).padStart(6, '0');
  }

  rassConfig[macId] = { client_id: clientId, panel_id: panelId, type: 'rass' };
  fs.writeFileSync(configPath, JSON.stringify(rassConfig, null, 2));
  return rassConfig[macId];
}

const TCP_PORT = 6550;
const activeSockets = new Map();
const panelMetadata = new Map();
const eventLog = [];
const MAX_LOG = 100;
const commandQueue = new Map();
const connectWaiters = new Map();
let outSequence = 1;

function calculateCRC16(str) {
  let crc = 0x0000;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      if (crc & 0x0001) crc = (crc >> 1) ^ 0xA001;
      else crc >>= 1;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function calculateLength(str) {
  return str.length.toString(16).toUpperCase().padStart(4, '0');
}

function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())},${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${now.getFullYear()}`;
}

function parseSIAHeader(message) {
  const match = message.match(/^([0-9A-Fa-f]{4})([0-9A-Fa-f]{4})"(.*?)"(\d{4})(R\w+)(L\w+)#(\w+)/);
  if (match) {
    return {
      crc: match[1], length: match[2], protocol: match[3],
      sequence: match[4], receiver: match[5], line: match[6], account: match[7]
    };
  }
  return null;
}

function buildACK(header) {
  const body = `"ACK"${header.sequence}${header.receiver}${header.line}#${header.account}[]`;
  const crc = calculateCRC16(body);
  const len = calculateLength(body);
  return `\n${crc}${len}${body}\r`;
}

function buildRASSRegistrationResponse(seq, macId, clientId, panelId, receiver = "R000001") {
  const ts = getTimestamp();
  const body = `"SIA-DCS"${seq}${receiver}L000000#000000[#000000|NYY002][N|${macId}|${clientId}|${panelId}]_${ts}`;
  const crc = calculateCRC16(body);
  const len = calculateLength(body);
  return `\n${crc}${len}${body}\r`;
}

function buildRASSControlCommand(seq, account, clientLine, commandContent, receiver = "R000001") {
  const ts = getTimestamp();
  const lineStr = clientLine.startsWith('L') ? clientLine : `L${clientLine}`;
  const acctStr = account.startsWith('#') ? account.substring(1) : account;

  let body;
  if (commandContent.startsWith('NYY') || commandContent.startsWith('NCL') || commandContent.startsWith('NOA')) {
    body = `"SIA-DCS"${seq}${receiver}${lineStr}#${acctStr}[#${acctStr}|${commandContent}]_${ts}`;
  } else {
    const nyyCode = commandContent.endsWith('R]') ? 'NYY004' : 'NYY005';
    body = `"SIA-DCS"${seq}${receiver}${lineStr}#${acctStr}[#${acctStr}|${nyyCode}]${commandContent}_${ts}`;
  }

  const crc = calculateCRC16(body);
  const len = calculateLength(body);
  return `\n${crc}${len}${body}\r`;
}

function getRASSCommandContent(commandName, zone = "000") {
  const cmd = commandName.toUpperCase();
  const zoneStr = String(zone).padStart(3, '0');

  // Zone Status Commands
  if (cmd === 'NYY040' || cmd === 'GET_ZONE_STATUS_1_30' || cmd === 'READ_ZONE_STATUS_1_30' || cmd === 'READ_PORT_STATUS_1') return 'NYY040';
  if (cmd === 'NYY041' || cmd === 'GET_ZONE_STATUS_31_60' || cmd === 'READ_ZONE_STATUS_31_60' || cmd === 'READ_PORT_STATUS_2') return 'NYY041';
  if (cmd === 'READ_PORT_STATUS' || cmd === 'GET_ZONE_STATUS' || cmd === 'READ_ALL_ZONE_STATUS' || cmd === 'READ_ZONE_STATUS') {
    if (zone === '31_60' || zone === '2' || Number(zone) > 30) return 'NYY041';
    return 'NYY040';
  }

  // Relay Status Commands
  if (cmd === 'READ_RELAY_STATUS' || cmd === 'READ_OUTPUT_STATUS' || cmd === 'READ_ALL_RELAYS') {
    const outNum = Number(zone);
    if (outNum > 0) return `[N|005|${String(outNum).padStart(2, '0')}|R]`;
    return `[N|005|01|R]`;
  }

  return null;
}

function getRASSMetadata(account) {
  for (const [mac, dev] of Object.entries(rassConfig)) {
    if (dev.panel_id === account) return { clientId: dev.client_id, macId: mac };
  }
  return null;
}

function sendSingleCommand(socket, commandType, accountNo, zone = "000") {
  if (!socket || socket.destroyed) return false;

  const meta = getRASSMetadata(accountNo);
  const clientId = meta ? meta.clientId : "011745";
  const rassContent = getRASSCommandContent(commandType, zone);
  if (!rassContent) return false;

  const seq = String(outSequence++).padStart(4, '0');
  if (outSequence > 9999) outSequence = 1;

  const cmd = buildRASSControlCommand(seq, accountNo, clientId, rassContent);
  socket.write(cmd);
  console.log(`\n📤 [RASS] Command Sent [${commandType} - Zone/Relay: ${zone}]:`);
  console.log(`   Raw Format: ${cmd.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`);
  return true;
}

function sendCommandToPanel(socket, commandType, accountNo, zone = "000") {
  if (!socket || socket.destroyed) return false;

  const cmd = commandType.toUpperCase();
  const outNum = Number(zone);

  // If READ_RELAY_STATUS / READ_OUTPUT_STATUS with zone 0 / 000, trigger all 8 relays sequentially
  if ((cmd === 'READ_RELAY_STATUS' || cmd === 'READ_OUTPUT_STATUS' || cmd === 'READ_ALL_RELAYS') && (!outNum || outNum <= 0)) {
    console.log(`\n🔄 [RASS] Reading all relay statuses (Relay 01 to 08) sequentially for Panel #${accountNo}...`);
    for (let i = 1; i <= 8; i++) {
      setTimeout(() => {
        if (socket && !socket.destroyed) {
          sendSingleCommand(socket, 'READ_RELAY_STATUS', accountNo, String(i));
        }
      }, (i - 1) * 800);
    }
    return true;
  }

  return sendSingleCommand(socket, commandType, accountNo, zone);
}

async function getPanelMake(currentAccount, remoteIp = null) {
  let panelName = 'RASS';
  try {
    const rawAcct = String(currentAccount || '').trim();
    const strippedAcct = rawAcct.replace(/^0+/, '');
    const paddedAcct = rawAcct.padStart(6, '0');
    const [siteRows] = await pool.query(
      "SELECT Panel_Make FROM sites WHERE NewPanelID = ? OR NewPanelID = ? OR NewPanelID = ? OR dvrip = ? LIMIT 1",
      [rawAcct, strippedAcct, paddedAcct, remoteIp || '']
    );
    if (siteRows && siteRows.length > 0 && siteRows[0].Panel_Make) {
      panelName = siteRows[0].Panel_Make;
    }
  } catch (err) { /* ignore */ }
  return panelName;
}

function handleSocketEvents(socket, remoteIp, initialAccount = null) {
  let currentAccount = initialAccount;
  socket.setKeepAlive(true, 30000);
  socket.setTimeout(180000);

  socket.on("timeout", () => socket.destroy());
  socket.on("data", async (data) => {
    const message = data.toString().trim();
    if (!message) return;

    console.log(`\n📩 [RASS] Raw Data Received:`, message);

    const header = parseSIAHeader(message);
    const decoded = decodeSIA(message);

    console.log(`🔓 [RASS] Decoded Meaning:`);
    console.log(JSON.stringify(decoded, null, 2));

    if (header && !decoded.account) decoded.account = header.account;

    if (decoded.code === 'YY' && decoded.zone === '001' && decoded.macId) {
      const rassDev = await getOrRegisterRASS(decoded.macId, remoteIp);
      currentAccount = rassDev.panel_id;
      activeSockets.set(currentAccount, socket);
      panelMetadata.set(currentAccount, { clientId: rassDev.client_id, macId: decoded.macId });

      const ack = buildACK(header);
      const regResponse = buildRASSRegistrationResponse(header.sequence, decoded.macId, rassDev.client_id, rassDev.panel_id, header.receiver);
      socket.write(ack + regResponse);
      return;
    }

    if (decoded.account) {
      currentAccount = decoded.account;
      activeSockets.set(currentAccount, socket);

      const waiters = connectWaiters.get(currentAccount);
      if (waiters && waiters.length > 0) {
        for (const resolve of waiters) resolve({ account: currentAccount });
        connectWaiters.set(currentAccount, []);
      }
    }

    // -------------------------------------------------
    // 💾 Save Zone Statuses into panel_health
    // -------------------------------------------------
    const zoneItems = decoded.sensors || decoded.zonesList;
    if (zoneItems && Array.isArray(zoneItems) && zoneItems.length > 0 && currentAccount) {
      try {
        const receivedtime = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const panelName = await getPanelMake(currentAccount, remoteIp);

        let columns = ['panelid', 'udate', 'ip', 'panelName'];
        let placeholders = ['?', '?', '?', '?'];
        let values = [currentAccount, receivedtime, remoteIp || '', panelName];
        let setQueryArr = ['udate = ?', 'ip = ?', 'panelName = ?'];
        let setValues = [receivedtime, remoteIp || '', panelName];

        zoneItems.forEach(z => {
          const zNum = parseInt(z.zone, 10);
          if (zNum >= 1 && zNum <= 60) {
            const colName = `zon${zNum}`;
            const stVal = (z.statusCode !== undefined) ? String(z.statusCode) : ((z.status !== undefined) ? String(z.status) : '0');
            columns.push(colName);
            placeholders.push('?');
            values.push(stVal);
            setQueryArr.push(`${colName} = ?`);
            setValues.push(stVal);
          }
        });

        const [rows] = await pool.query("SELECT panelid FROM panel_health WHERE panelid = ? LIMIT 1", [currentAccount]);
        if (rows && rows.length > 0) {
          const updateQuery = `UPDATE panel_health SET ${setQueryArr.join(', ')} WHERE panelid = ?`;
          await pool.query(updateQuery, [...setValues, currentAccount]);
          console.log(`✅ [RASS] Zone status (${zoneItems.length} zones) UPDATED in panel_health for Panel #${currentAccount}`);
        } else {
          const insertQuery = `INSERT INTO panel_health (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
          await pool.query(insertQuery, values);
          console.log(`✅ [RASS] Zone status (${zoneItems.length} zones) INSERTED into panel_health for Panel #${currentAccount}`);
        }

        healthEvents.emit('health_saved', {
          account: currentAccount,
          make: panelName,
          type: 'zone',
          count: zoneItems.length,
          timestamp: receivedtime
        });
      } catch (dbErr) {
        console.error(`❌ [RASS] DB Error saving zone status to panel_health:`, dbErr.message);
      }
    }

    // Auto-queue NYY041 (zones 31-60) after receiving NYY040 (zones 1-30)
    if (decoded.zone === '040' && currentAccount) {
      console.log(`\n🔄 [RASS] Auto-queuing NYY041 (Zone Status 31-60) for Panel #${currentAccount}...`);
      setTimeout(() => {
        queueCommand(currentAccount, 'NYY041', '000');
      }, 500);
    }

    // -------------------------------------------------
    // 💾 Save Output / Relay Statuses into panel_health
    // -------------------------------------------------
    const relayItems = decoded.channelList || decoded.relayList || decoded.outputs;
    if (((relayItems && Array.isArray(relayItems) && relayItems.length > 0) || (decoded.outputNo !== undefined && decoded.outputNo !== null)) && currentAccount) {
      try {
        const receivedtime = new Date().toISOString().slice(0, 19).replace('T', ' ');
        const panelName = await getPanelMake(currentAccount, remoteIp);

        let columns = ['panelid', 'udate', 'ip', 'panelName'];
        let placeholders = ['?', '?', '?', '?'];
        let values = [currentAccount, receivedtime, remoteIp || '', panelName];
        let setQueryArr = ['udate = ?', 'ip = ?', 'panelName = ?'];
        let setValues = [receivedtime, remoteIp || '', panelName];

        let relayCount = 0;
        if (relayItems && Array.isArray(relayItems)) {
          relayCount = relayItems.length;
          relayItems.forEach(c => {
            const ch = parseInt(c.channel || c.relayId || c.output, 10);
            if (ch >= 1 && ch <= 20) {
              const colName = `relay${ch}`;
              let stVal = c.status !== undefined ? c.status : c.state;
              stVal = (stVal === 'ON' || stVal === '1' || stVal === 1) ? '1' : '0';
              columns.push(colName);
              placeholders.push('?');
              values.push(stVal);
              setQueryArr.push(`${colName} = ?`);
              setValues.push(stVal);
            }
          });
        } else if (decoded.outputNo !== undefined && decoded.outputNo !== null) {
          relayCount = 1;
          const ch = parseInt(decoded.outputNo, 10);
          if (ch >= 1 && ch <= 20) {
            const colName = `relay${ch}`;
            let stVal = decoded.outputState;
            stVal = (stVal === 'ON' || stVal === '1' || stVal === 1) ? '1' : '0';
            columns.push(colName);
            placeholders.push('?');
            values.push(stVal);
            setQueryArr.push(`${colName} = ?`);
            setValues.push(stVal);
          }
        }

        const [rows] = await pool.query("SELECT panelid FROM panel_health WHERE panelid = ? LIMIT 1", [currentAccount]);
        if (rows && rows.length > 0) {
          const updateQuery = `UPDATE panel_health SET ${setQueryArr.join(', ')} WHERE panelid = ?`;
          await pool.query(updateQuery, [...setValues, currentAccount]);
          console.log(`✅ [RASS] Relay status UPDATED in panel_health for Panel #${currentAccount}`);
        } else {
          const insertQuery = `INSERT INTO panel_health (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
          await pool.query(insertQuery, values);
          console.log(`✅ [RASS] Relay status INSERTED into panel_health for Panel #${currentAccount}`);
        }

        healthEvents.emit('health_saved', {
          account: currentAccount,
          make: panelName,
          type: 'relay',
          count: relayCount,
          timestamp: receivedtime
        });
      } catch (dbErr) {
        console.error(`❌ [RASS] DB Error saving relay/output status to panel_health:`, dbErr.message);
      }
    }

    eventLog.unshift({ ...decoded, raw: message, receivedAt: new Date().toISOString() });
    if (eventLog.length > MAX_LOG) eventLog.pop();

    if (header && !socket.destroyed) {
      let commandSentFromQueue = false;
      if (currentAccount) {
        const queue = commandQueue.get(currentAccount);
        if (queue && queue.length > 0) {
          const pending = [...queue];
          commandQueue.set(currentAccount, []);
          for (const item of pending) {
            const success = sendCommandToPanel(socket, item.command, currentAccount, item.zone);
            commandSentFromQueue = true;
            if (item.resolve) item.resolve({ sent: success, command: item.command, zone: item.zone });
          }
        }
      }
      if (!commandSentFromQueue && !message.includes('"ACK"')) {
        socket.write(buildACK(header));
      }
    }
  });

  socket.on("end", () => { if (currentAccount) activeSockets.delete(currentAccount); });
  socket.on("error", () => { });
  socket.on("close", () => { if (currentAccount) activeSockets.delete(currentAccount); });
}

function initiatePanelConnection(panelId, ip) {
  console.log(`\n⏳ [RASS] Attempting OUTGOING connection to Panel #${panelId} at IP: ${ip}:${TCP_PORT}...`);
  const socket = new net.Socket();

  socket.connect(TCP_PORT, ip, () => {
    console.log(`✅ [RASS] Successfully connected to Panel #${panelId} (${ip})`);
    activeSockets.set(panelId, socket);
    handleSocketEvents(socket, ip, panelId);

    const queue = commandQueue.get(panelId);
    if (queue && queue.length > 0) {
      const pending = [...queue];
      commandQueue.set(panelId, []);
      for (const item of pending) {
        const success = sendCommandToPanel(socket, item.command, panelId, item.zone);
        if (item.resolve) item.resolve({ sent: success, command: item.command, zone: item.zone });
      }
    }
  });

  socket.on("error", (err) => {
    console.log(`❌ [RASS] Connection failed to Panel #${panelId} (${ip}): ${err.message}`);
  });

  socket.on("close", () => {
    activeSockets.delete(panelId);
  });
}

function startServer(customPort) {
  const port = customPort || TCP_PORT;
  const tcpServer = net.createServer((socket) => {
    const remoteIp = socket.remoteAddress ? socket.remoteAddress.replace(/^.*:/, '').trim() : null;
    console.log(`\n📡 [RASS] Device TCP Connection Initiated from IP: ${remoteIp}`);
    handleSocketEvents(socket, remoteIp);
  });

  tcpServer.listen(port, () => {
    console.log(`📡 RASS Protocol Manager listening on TCP Port ${port}`);
  });

  return tcpServer;
}

function queueCommand(account, command, zone = "000", waitMs = 60000) {
  return new Promise((resolve) => {
    const socket = activeSockets.get(account);
    if (socket && !socket.destroyed) {
      const success = sendCommandToPanel(socket, command, account, zone);
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
