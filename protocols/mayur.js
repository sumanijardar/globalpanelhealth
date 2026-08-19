const net = require("net");
const pool = require("../config/database");
const decoders = require("../decoders");
const decodeSIA = decoders.mayur;
const healthEvents = require("../services/health_events");

const TCP_PORT = 9999;

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
  const body = `"ACK"${header.sequence}${header.receiver}${header.line}#${header.account}[]`;
  const crc = calculateCRC16(body);
  const len = calculateLength(body);
  return `\n${crc}${len}${body}\r`;
}

function buildSIACommand(commandType, account, zone = "000", receiver = "R0", line = "L0") {
  const cmd = commandType.toUpperCase();
  const seq = String(outSequence++).padStart(4, '0');
  if (outSequence > 9999) outSequence = 1;
  const ts = getTimestamp();

  let siaCode = 'RP'; // default test/ping
  if (cmd === 'READ_ZONE_STATUS' || cmd === 'READ_PORT_STATUS') siaCode = 'RP';
  if (cmd === 'READ_RELAY_STATUS' || cmd === 'READ_OUTPUT_STATUS') siaCode = 'RC';

  const dataWithoutTs = `"SIA-DCS"${seq}${receiver}${line}#${account}[#${account}|N${siaCode}${zone}]`;
  const dataWithTs = dataWithoutTs + '_' + ts;
  const crc = calculateCRC16(dataWithTs);
  const len = calculateLength(dataWithTs);
  return `\n${crc}${len}${dataWithTs}\r`;
}

function sendCommandToPanel(socket, commandType, accountNo, zone = "000") {
  if (!socket || socket.destroyed) return false;
  const cmd = buildSIACommand(commandType, accountNo, zone);
  if (!cmd) return false;

  socket.write(cmd);
  console.log(`\n📤 [MAYUR] Command Sent [${commandType}] for Panel #${accountNo}:`);
  console.log(`   Raw Format: ${cmd.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}`);
  return true;
}

async function savePanelHealthToDb(panelId, ip, panelMake = 'MAYUR') {
  try {
    const receivedtime = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const [rows] = await pool.query("SELECT id FROM panel_health WHERE panelid = ? LIMIT 1", [panelId]);
    if (rows && rows.length > 0) {
      await pool.query(
        "UPDATE panel_health SET udate = ?, ip = ?, panelName = ? WHERE panelid = ?",
        [receivedtime, ip || '', panelMake, panelId]
      );
      console.log(`✅ [MAYUR] Panel Health Data UPDATED in 'panel_health' for Panel #${panelId}`);
    } else {
      await pool.query(
        "INSERT INTO panel_health (panelid, udate, ip, panelName) VALUES (?, ?, ?, ?)",
        [panelId, receivedtime, ip || '', panelMake]
      );
      console.log(`✅ [MAYUR] Panel Health Data INSERTED into 'panel_health' for Panel #${panelId}`);
    }

    healthEvents.emit('health_saved', {
      account: panelId,
      make: panelMake,
      type: 'general',
      timestamp: receivedtime
    });
  } catch (dbErr) {
    console.error(`❌ [MAYUR] DB Error updating panel_health for Panel #${panelId}:`, dbErr.message);
  }
}

function handleSocketEvents(socket, remoteIp, initialAccount = null) {
  let currentAccount = initialAccount;
  socket.setKeepAlive(true, 30000);
  socket.setTimeout(180000);

  socket.on("timeout", () => socket.destroy());
  socket.on("data", async (data) => {
    const message = data.toString().trim();
    if (!message) return;

    console.log(`\n📩 [MAYUR] Raw Data Received:`, message);

    const header = parseSIAHeader(message);
    const decoded = decodeSIA(message);

    console.log(`🔓 [MAYUR] Decoded Meaning:`);
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

      await savePanelHealthToDb(currentAccount, remoteIp, 'MAYUR');
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
  console.log(`\n⏳ [MAYUR] Attempting OUTGOING connection to Panel #${panelId} at IP: ${ip}:${TCP_PORT}...`);
  const socket = new net.Socket();

  socket.connect(TCP_PORT, ip, () => {
    console.log(`✅ [MAYUR] Successfully connected to Panel #${panelId} (${ip})`);
    activeSockets.set(panelId, socket);
    handleSocketEvents(socket, ip, panelId);
    savePanelHealthToDb(panelId, ip, 'MAYUR');

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
    console.log(`❌ [MAYUR] Connection failed to Panel #${panelId} (${ip}): ${err.message}`);
  });

  socket.on("close", () => {
    activeSockets.delete(panelId);
  });
}

function startServer(customPort) {
  const port = customPort || TCP_PORT;
  const tcpServer = net.createServer((socket) => {
    const remoteIp = socket.remoteAddress ? socket.remoteAddress.replace(/^.*:/, '').trim() : null;
    console.log(`\n📡 [MAYUR] Device TCP Connection Initiated from IP: ${remoteIp}`);
    handleSocketEvents(socket, remoteIp);
  });

  tcpServer.listen(port, () => {
    console.log(`📡 MAYUR Protocol Manager listening on TCP Port ${port}`);
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
