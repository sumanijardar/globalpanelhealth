const net = require("net");
const pool = require("../config/database");
const decoders = require("../decoders");
const decodeSIA = decoders.securico;
const healthEvents = require("../services/health_events");

const TCP_PORT = 5503;

const activeSockets = new Map();
const eventLog = [];
const MAX_LOG = 100;
const commandQueue = new Map();
const connectWaiters = new Map();
let outSequence = 1;

const rpsBuffer = new Map();

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
      crc: match[1],
      length: match[2],
      protocol: match[3],
      sequence: match[4],
      receiver: match[5],
      line: match[6],
      account: match[7],
      matchIndex: match[0].length - (match[7].length + 1)
    };
  }
  return null;
}

function buildACK(header) {
  if (!header) return null;
  const ts = getTimestamp();
  const body = `"ACK"${header.sequence}${header.receiver}${header.line}#${header.account}[]_${ts}`;
  const crc = calculateCRC16(body);
  const len = calculateLength(body);
  return `\n${crc}${len}${body}\r`;
}

// Commands mapping for Securico Health Status
const COMMAND_MAP = {
  // Read Port Status (Zones)
  'READ_PORT_STATUS_1': 'DCS008|R|000', // Zones 1-20
  'READ_PORT_STATUS_2': 'DCS008|R|001', // Zones 21-40
  'READ_PORT_STATUS_3': 'DCS008|R|002', // Zones 41-47
  'READ_ZONE_STATUS': 'READ_PORT_STATUS',
  'READ_PORT_STATUS': 'READ_PORT_STATUS',

  // Relay Status Command
  'READ_RELAY_STATUS': 'DCS009|R|000',
  'READ_OUTPUT_STATUS': 'DCS009|R|000'
};

function buildSIACommand(commandType, account, zone = "000", receiver = "R000001", line = "L000000") {
  let commandPayload = COMMAND_MAP[commandType.toUpperCase()];
  if (!commandPayload) return null;

  const seq = String(outSequence++).padStart(4, '0');
  if (outSequence > 9999) outSequence = 1;
  const ts = getTimestamp();
  const paddedAccount = String(account).padStart(6, '0');

  const dataWithoutTs = `"SIA-DCS"${seq}${receiver}${line}#${paddedAccount}[#${paddedAccount}|${commandPayload}]`;
  const dataWithTs = dataWithoutTs + '_' + ts;

  const crc = calculateCRC16(dataWithTs);
  const len = calculateLength(dataWithTs);
  return `\n${crc}${len}${dataWithTs}\r`;
}

function sendCommandToPanel(socket, commandType, accountNo, zone = "000") {
  if (!socket || socket.destroyed) {
    console.log("❌ SECURICO Connection lost, cannot send command.");
    return false;
  }

  const cmdUpper = commandType.toUpperCase();

  // Multi-part Zone Status command
  if (cmdUpper === 'READ_PORT_STATUS' || cmdUpper === 'READ_ZONE_STATUS') {
    const cmd1 = buildSIACommand('READ_PORT_STATUS_1', accountNo, zone);
    if (cmd1) socket.write(cmd1);
    console.log(`\n📤 [SECURICO] Command Sent [READ_PORT_STATUS_1] (Starting Sequence) for Panel #${accountNo}`);
    return true;
  }

  const cmd = buildSIACommand(commandType, accountNo, zone);
  if (!cmd) {
    console.log(`⚠️ SECURICO Unknown Command: ${commandType}`);
    return false;
  }
  socket.write(cmd);
  console.log(`\n📤 [SECURICO] Command Sent [${commandType}] for Panel #${accountNo}:`);
  console.log(`   Raw Format: ${cmd.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`);
  return true;
}

function handleSocketEvents(socket, remoteIp, initialAccount = null) {
  let currentAccount = initialAccount;
  socket.setKeepAlive(true, 30000);
  socket.setTimeout(60000);

  socket.on("timeout", () => socket.destroy());
  socket.on("data", async (data) => {
    const message = data.toString().trim();
    if (!message) return;

    console.log(`\n📩 [SECURICO] Raw Data Received: ${message}`);

    const header = parseSIAHeader(message);
    const decoded = decodeSIA(message);

    console.log(`🔓 [SECURICO] Decoded Meaning:`);
    console.log(JSON.stringify(decoded, null, 2));

    if (header && !decoded.account) {
      decoded.account = header.account;
    }

    let crcOK = false;
    if (header) {
      const dataBody = message.substring(header.matchIndex);
      const calculatedCRC = calculateCRC16(dataBody);
      crcOK = header.crc.toUpperCase() === calculatedCRC.toUpperCase();
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

    // Process Zone Status Responses (DCS008 parts)
    if (decoded.code === "RPS_RES" && decoded.zonesList) {
      if (decoded.event && decoded.event.startsWith("Zone Status Response Part")) {
        if (!rpsBuffer.has(currentAccount)) {
          rpsBuffer.set(currentAccount, {
            parts: [],
            rawMessages: [],
            timeout: setTimeout(() => {
              const buffer = rpsBuffer.get(currentAccount);
              if (buffer) {
                mergeAndPushRPS(currentAccount, buffer, crcOK, remoteIp);
                rpsBuffer.delete(currentAccount);
              }
            }, 15000)
          });
        }
        const buffer = rpsBuffer.get(currentAccount);
        buffer.parts.push(decoded);
        buffer.rawMessages.push(message);

        if (decoded.event.includes("Part 0")) {
          setTimeout(() => {
            console.log(`\n🔄 [SECURICO] Queuing READ_PORT_STATUS_2 for Panel #${currentAccount}...`);
            queueCommand(currentAccount, 'READ_PORT_STATUS_2', "000");
          }, 1500);
        } else if (decoded.event.includes("Part 1")) {
          setTimeout(() => {
            console.log(`\n🔄 [SECURICO] Queuing READ_PORT_STATUS_3 for Panel #${currentAccount}...`);
            queueCommand(currentAccount, 'READ_PORT_STATUS_3', "000");
          }, 1500);
        }

        if (buffer.parts.length >= 3) {
          clearTimeout(buffer.timeout);
          mergeAndPushRPS(currentAccount, buffer, crcOK, remoteIp);
          rpsBuffer.delete(currentAccount);
        }
        return;
      } else {
        await processRpsDb(decoded, currentAccount, remoteIp);
      }
    }
    // Process Relay Status Responses (DCS009)
    else if (decoded.code === "RLS_RES" && decoded.relayList) {
      try {
        const receivedtime = new Date().toISOString().slice(0, 19).replace('T', ' ');
        let panelName = 'SECURICO';
        try {
          const [siteRows] = await pool.query("SELECT Panel_Make FROM sites WHERE NewPanelID = ? LIMIT 1", [currentAccount]);
          if (siteRows && siteRows.length > 0) panelName = siteRows[0].Panel_Make || 'SECURICO';
        } catch (err) { }

        let columns = ['panelid', 'udate', 'ip', 'panelName'];
        let placeholders = ['?', '?', '?', '?'];
        let values = [currentAccount, receivedtime, remoteIp || '', panelName];
        let setQueryArr = ['udate = ?', 'ip = ?', 'panelName = ?'];
        let setValues = [receivedtime, remoteIp || '', panelName];

        decoded.relayList.forEach(r => {
          if (r.relayId >= 1 && r.relayId <= 20) {
            const colName = `relay${r.relayId}`;
            const stVal = (r.status === '1' || r.status === 1 || r.status === 'ON') ? '1' : '0';
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
          console.log(`✅ [SECURICO] Relay status UPDATED in panel_health for Panel #${currentAccount}`);
        } else {
          const insertQuery = `INSERT INTO panel_health (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
          await pool.query(insertQuery, values);
          console.log(`✅ [SECURICO] Relay status INSERTED into panel_health for Panel #${currentAccount}`);
        }

        healthEvents.emit('health_saved', {
          account: currentAccount,
          make: panelName,
          type: 'relay',
          count: decoded.relayList.length,
          timestamp: receivedtime
        });
      } catch (dbErr) {
        console.error(`❌ [SECURICO] DB Error saving relay status to panel_health:`, dbErr.message);
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
            const success = sendCommandToPanel(socket, item.command, currentAccount, item.zone || '000');
            if (success) {
              commandSentFromQueue = true;
              if (item.resolve) item.resolve({ sent: true, command: item.command, zone: item.zone || '000' });
            }
          }
        }
      }
      if (!commandSentFromQueue && !message.includes('"ACK"')) {
        const ackMsg = buildACK(header);
        if (ackMsg) socket.write(ackMsg);
      }
    }
  });

  socket.on("end", () => { if (currentAccount) activeSockets.delete(currentAccount); });
  socket.on("error", () => { });
  socket.on("close", () => { if (currentAccount) activeSockets.delete(currentAccount); });
}

async function processRpsDb(decoded, currentAccount, remoteIp) {
  try {
    const receivedtime = new Date().toISOString().slice(0, 19).replace('T', ' ');
    let panelName = 'SECURICO';
    try {
      const [siteRows] = await pool.query("SELECT Panel_Make FROM sites WHERE NewPanelID = ? LIMIT 1", [currentAccount]);
      if (siteRows && siteRows.length > 0) panelName = siteRows[0].Panel_Make || 'SECURICO';
    } catch (err) { }

    let columns = ['panelid', 'udate', 'ip', 'panelName'];
    let placeholders = ['?', '?', '?', '?'];
    let values = [currentAccount, receivedtime, remoteIp || '', panelName];
    let setQueryArr = ['udate = ?', 'ip = ?', 'panelName = ?'];
    let setValues = [receivedtime, remoteIp || '', panelName];

    decoded.zonesList.forEach(z => {
      if (z.zone >= 1 && z.zone <= 60) {
        const colName = `zon${z.zone}`;
        const stVal = z.statusDescription || z.status || '0';
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
      console.log(`✅ [SECURICO] Zone status (${decoded.zonesList.length} zones) UPDATED in panel_health for Panel #${currentAccount}`);
    } else {
      const insertQuery = `INSERT INTO panel_health (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
      await pool.query(insertQuery, values);
      console.log(`✅ [SECURICO] Zone status (${decoded.zonesList.length} zones) INSERTED into panel_health for Panel #${currentAccount}`);
    }

    healthEvents.emit('health_saved', {
      account: currentAccount,
      make: panelName,
      type: 'zone',
      count: decoded.zonesList.length,
      timestamp: receivedtime
    });
  } catch (dbErr) {
    console.error(`❌ [SECURICO] DB Error saving zone status to panel_health:`, dbErr.message);
  }
}

async function mergeAndPushRPS(account, buffer, crcOK, remoteIp) {
  let combinedZones = [];
  const sortedParts = buffer.parts.sort((a, b) => (a.zonesList[0]?.zone || 0) - (b.zonesList[0]?.zone || 0));
  sortedParts.forEach(p => { combinedZones = combinedZones.concat(p.zonesList); });

  const mergedDecoded = {
    account: account,
    code: "RPS_RES",
    event: `Full Zone Status Response (${combinedZones.length} Zones)`,
    zonesList: combinedZones,
    timestamp: sortedParts[0]?.timestamp || null,
    formattedDate: sortedParts[0]?.formattedDate || null
  };

  await processRpsDb(mergedDecoded, account, remoteIp);
}

function initiatePanelConnection(panelId, ip) {
  console.log(`\n⏳ [SECURICO] Attempting OUTGOING connection to Panel #${panelId} at IP: ${ip}:${TCP_PORT}...`);
  const socket = new net.Socket();

  socket.connect(TCP_PORT, ip, () => {
    console.log(`✅ [SECURICO] Successfully connected to Panel #${panelId} (${ip})`);
    activeSockets.set(panelId, socket);
    handleSocketEvents(socket, ip, panelId);

    const queue = commandQueue.get(panelId);
    if (queue && queue.length > 0) {
      const pending = [...queue];
      commandQueue.set(panelId, []);
      for (const item of pending) {
        const success = sendCommandToPanel(socket, item.command, panelId, item.zone || '000');
        if (item.resolve) item.resolve({ sent: success, command: item.command, zone: item.zone || '000' });
      }
    }
  });

  socket.on("error", (err) => {
    console.log(`❌ [SECURICO] Connection failed to Panel #${panelId} (${ip}): ${err.message}`);
  });

  socket.on("close", () => {
    activeSockets.delete(panelId);
  });
}

function startServer(customPort) {
  const port = customPort || TCP_PORT;
  const tcpServer = net.createServer((socket) => {
    const remoteIp = socket.remoteAddress ? socket.remoteAddress.replace(/^.*:/, '').trim() : null;
    console.log(`\n📡 [SECURICO] Device TCP Connection Initiated from IP: ${remoteIp}`);
    handleSocketEvents(socket, remoteIp);
  });

  tcpServer.listen(port, () => {
    console.log(`📡 SECURICO Protocol Manager listening on TCP Port ${port}`);
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
