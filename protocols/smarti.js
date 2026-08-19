const net = require("net");
const pool = require("../config/database");
const decoders = require("../decoders");
const decodeSIA = decoders.smarti;
const healthEvents = require("../services/health_events");

const TCP_PORT = 5500;

const activeSockets = new Map();
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
      crc: match[1],
      length: match[2],
      protocol: match[3],
      sequence: match[4],
      receiver: match[5],
      line: match[6],
      account: match[7]
    };
  }
  return null;
}

function buildACK(header) {
  const ts = getTimestamp();
  const body = `"ACK"${header.sequence}${header.receiver}${header.line}#${header.account}[]_${ts}`;
  const crc = calculateCRC16(body);
  const len = calculateLength(body);
  return `\n${crc}${len}${body}\r`;
}

// Commands mapping for SMARTI / ZICOM Health Status
const COMMAND_MAP = {
  'READ_ZONE_STATUS': 'NYY040',
  'READ_PORT_STATUS': 'NYY040',
  'STATUS': 'NYY040',
  'READ_RELAY_STATUS': 'READ_RELAY_STATUS',
  'READ_OUTPUT_STATUS': 'READ_RELAY_STATUS'
};

function buildSIACommand(commandType, account, zone = "000", receiver = "R000001", line = "L000000") {
  const cmd = commandType.toUpperCase();
  const seq = String(outSequence++).padStart(4, '0');
  if (outSequence > 9999) outSequence = 1;
  const ts = getTimestamp();
  const paddedAccount = String(account).padStart(6, '0');

  let dataWithoutTs;
  if (cmd === 'READ_RELAY_STATUS' || cmd === 'READ_OUTPUT_STATUS') {
    const outNum = Number(zone) > 0 ? String(Number(zone)).padStart(2, '0') : '01';
    dataWithoutTs = `"SIA-DCS"${seq}${receiver}${line}#${paddedAccount}[#${paddedAccount}|NYY005][N|005|${outNum}|R]`;
  } else {
    // Zone status query NYY040
    dataWithoutTs = `"SIA-DCS"${seq}${receiver}${line}#${paddedAccount}[#${paddedAccount}|NYY040]`;
  }

  const dataWithTs = dataWithoutTs + '_' + ts;
  const crc = calculateCRC16(dataWithTs);
  const len = calculateLength(dataWithTs);
  return `\n${crc}${len}${dataWithTs}\r`;
}

function sendCommandToPanel(socket, commandType, accountNo, zone = "000") {
  if (!socket || socket.destroyed) {
    console.log("❌ SMARTI Connection lost, cannot send command.");
    return false;
  }

  const cmd = commandType.toUpperCase();
  if (cmd === 'READ_RELAY_STATUS' || cmd === 'READ_OUTPUT_STATUS') {
    const outNum = Number(zone);
    if (!outNum || outNum <= 0) {
      console.log(`\n🔄 [SMARTI] Reading all relay statuses (Relay 01 to 08) for Panel #${accountNo}...`);
      for (let i = 1; i <= 8; i++) {
        setTimeout(() => {
          if (socket && !socket.destroyed) {
            const singleCmd = buildSIACommand('READ_RELAY_STATUS', accountNo, String(i));
            socket.write(singleCmd);
          }
        }, (i - 1) * 800);
      }
      return true;
    }
  }

  const cmdPayload = buildSIACommand(commandType, accountNo, zone);
  if (!cmdPayload) return false;

  socket.write(cmdPayload);
  console.log(`\n📤 [SMARTI] Command Sent [${commandType}] for Panel #${accountNo}:`);
  console.log(`   Raw Format: ${cmdPayload.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`);
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

    console.log(`\n📩 [SMARTI] Raw Data Received: ${message}`);

    const header = parseSIAHeader(message);
    const decoded = decodeSIA(message);

    console.log(`🔓 [SMARTI] Decoded Meaning:`);
    console.log(JSON.stringify(decoded, null, 2));

    if (header && !decoded.account) {
      decoded.account = header.account;
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
        let panelName = 'SMARTI';
        try {
          const [siteRows] = await pool.query("SELECT Panel_Make FROM sites WHERE NewPanelID = ? LIMIT 1", [currentAccount]);
          if (siteRows && siteRows.length > 0) panelName = siteRows[0].Panel_Make || 'SMARTI';
        } catch (err) { }

        let columns = ['panelid', 'udate', 'ip', 'panelName'];
        let placeholders = ['?', '?', '?', '?'];
        let values = [currentAccount, receivedtime, remoteIp || '', panelName];
        let setQueryArr = ['udate = ?', 'ip = ?', 'panelName = ?'];
        let setValues = [receivedtime, remoteIp || '', panelName];

        zoneItems.forEach(z => {
          const zNum = parseInt(z.zone, 10);
          if (zNum >= 1 && zNum <= 60) {
            const colName = `zon${zNum}`;
            const stVal = z.description || z.statusDescription || z.status || '0';
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
          console.log(`✅ [SMARTI] Zone status (${zoneItems.length} zones) UPDATED in panel_health for Panel #${currentAccount}`);
        } else {
          const insertQuery = `INSERT INTO panel_health (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
          await pool.query(insertQuery, values);
          console.log(`✅ [SMARTI] Zone status (${zoneItems.length} zones) INSERTED into panel_health for Panel #${currentAccount}`);
        }

        healthEvents.emit('health_saved', {
          account: currentAccount,
          make: panelName,
          type: 'zone',
          count: zoneItems.length,
          timestamp: receivedtime
        });
      } catch (dbErr) {
        console.error(`❌ [SMARTI] DB Error saving zone status to panel_health:`, dbErr.message);
      }
    }

    // -------------------------------------------------
    // 💾 Save Output / Relay Statuses into panel_health
    // -------------------------------------------------
    const relayItems = decoded.channelList || decoded.relayList || decoded.outputs;
    if (((relayItems && Array.isArray(relayItems) && relayItems.length > 0) || (decoded.outputNo !== undefined && decoded.outputNo !== null)) && currentAccount) {
      try {
        const receivedtime = new Date().toISOString().slice(0, 19).replace('T', ' ');
        let panelName = 'SMARTI';
        try {
          const [siteRows] = await pool.query("SELECT Panel_Make FROM sites WHERE NewPanelID = ? LIMIT 1", [currentAccount]);
          if (siteRows && siteRows.length > 0) panelName = siteRows[0].Panel_Make || 'SMARTI';
        } catch (err) { }

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

        const [rows] = await pool.query("SELECT id FROM panel_health WHERE panelid = ? LIMIT 1", [currentAccount]);
        if (rows && rows.length > 0) {
          const updateQuery = `UPDATE panel_health SET ${setQueryArr.join(', ')} WHERE panelid = ?`;
          await pool.query(updateQuery, [...setValues, currentAccount]);
          console.log(`✅ [SMARTI] Relay status UPDATED in panel_health for Panel #${currentAccount}`);
        } else {
          const insertQuery = `INSERT INTO panel_health (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
          await pool.query(insertQuery, values);
          console.log(`✅ [SMARTI] Relay status INSERTED into panel_health for Panel #${currentAccount}`);
        }

        healthEvents.emit('health_saved', {
          account: currentAccount,
          make: panelName,
          type: 'relay',
          count: relayCount,
          timestamp: receivedtime
        });
      } catch (dbErr) {
        console.error(`❌ [SMARTI] DB Error saving relay status to panel_health:`, dbErr.message);
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
        socket.write(ackMsg);
      }
    }
  });

  socket.on("end", () => { if (currentAccount) activeSockets.delete(currentAccount); });
  socket.on("error", () => { });
  socket.on("close", () => { if (currentAccount) activeSockets.delete(currentAccount); });
}

function initiatePanelConnection(panelId, ip) {
  console.log(`\n⏳ [SMARTI] Attempting OUTGOING connection to Panel #${panelId} at IP: ${ip}:${TCP_PORT}...`);
  const socket = new net.Socket();

  socket.connect(TCP_PORT, ip, () => {
    console.log(`✅ [SMARTI] Successfully connected to Panel #${panelId} (${ip})`);
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
    console.log(`❌ [SMARTI] Connection failed to Panel #${panelId} (${ip}): ${err.message}`);
  });

  socket.on("close", () => {
    activeSockets.delete(panelId);
  });
}

function startServer(customPort) {
  const port = customPort || TCP_PORT;
  const tcpServer = net.createServer((socket) => {
    const remoteIp = socket.remoteAddress ? socket.remoteAddress.replace(/^.*:/, '').trim() : null;
    console.log(`\n📡 [SMARTI] Device TCP Connection Initiated from IP: ${remoteIp}`);
    handleSocketEvents(socket, remoteIp);
  });

  tcpServer.listen(port, () => {
    console.log(`📡 SMARTI Protocol Manager listening on TCP Port ${port}`);
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
