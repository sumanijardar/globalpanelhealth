const http = require("http");
const pool = require("../config/database");
const decodeIntellitech = require("../decoders/intellitech_decoder");
const healthEvents = require("../services/health_events");

const HTTP_PORT = 3001;

const activeDevices = new Map();
const eventLog = [];
const MAX_LOG = 100;

function getTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function startServer(customPort) {
  const port = customPort || HTTP_PORT;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });

      req.on('end', async () => {
        try {
          const payload = JSON.parse(body);

          if (!payload.deviceId || !payload.data) {
            res.writeHead(400);
            return res.end(JSON.stringify({ error: "Invalid payload format" }));
          }

          const currentAccount = payload.deviceId;
          const dataDate = payload.dataDate;
          const remoteIp = req.socket.remoteAddress ? req.socket.remoteAddress.replace(/^.*:/, '').trim() : '';

          activeDevices.set(currentAccount, Date.now());

          if (payload.data.status && Array.isArray(payload.data.status)) {
            const receivedtime = getTimestamp();
            let columns = ['panelid', 'udate', 'ip', 'panelName'];
            let placeholders = ['?', '?', '?', '?'];
            let values = [currentAccount, receivedtime, remoteIp, 'INTELLITECH'];
            let setQueryArr = ['udate = ?', 'ip = ?', 'panelName = ?'];
            let setValues = [receivedtime, remoteIp, 'INTELLITECH'];

            let hasZones = false;
            let hasRelays = false;

            for (const item of payload.data.status) {
              const decoded = decodeIntellitech(item, currentAccount, dataDate);
              const idStr = item.id.toString();

              if (idStr.startsWith("4")) {
                const zNum = parseInt(idStr.substring(1), 10);
                if (zNum >= 1 && zNum <= 60) {
                  hasZones = true;
                  const colName = `zon${zNum}`;
                  const stVal = decoded.status === 1 ? 'Alert' : (decoded.status === 0 ? 'Normal' : String(decoded.status));
                  columns.push(colName);
                  placeholders.push('?');
                  values.push(stVal);
                  setQueryArr.push(`${colName} = ?`);
                  setValues.push(stVal);
                }
              } else if (idStr.startsWith("2")) {
                const rNum = parseInt(idStr.substring(1), 10);
                if (rNum >= 1 && rNum <= 20) {
                  hasRelays = true;
                  const colName = `relay${rNum}`;
                  const stVal = (decoded.status === 1 || decoded.status === 3 || decoded.status === 5) ? '1' : '0';
                  columns.push(colName);
                  placeholders.push('?');
                  values.push(stVal);
                  setQueryArr.push(`${colName} = ?`);
                  setValues.push(stVal);
                }
              }

              eventLog.unshift({ ...decoded, receivedAt: new Date().toISOString() });
              if (eventLog.length > MAX_LOG) eventLog.pop();
            }

            try {
              const [rows] = await pool.query("SELECT id FROM panel_health WHERE panelid = ? LIMIT 1", [currentAccount]);
              if (rows && rows.length > 0) {
                const updateQuery = `UPDATE panel_health SET ${setQueryArr.join(', ')} WHERE panelid = ?`;
                await pool.query(updateQuery, [...setValues, currentAccount]);
                console.log(`✅ [INTELLITECH] Health data UPDATED in panel_health for Panel #${currentAccount}`);
              } else {
                const insertQuery = `INSERT INTO panel_health (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
                await pool.query(insertQuery, values);
                console.log(`✅ [INTELLITECH] Health data INSERTED into panel_health for Panel #${currentAccount}`);
              }

              healthEvents.emit('health_saved', {
                account: currentAccount,
                make: 'INTELLITECH',
                type: hasZones ? 'zone' : (hasRelays ? 'relay' : 'general'),
                timestamp: receivedtime
              });
            } catch (dbErr) {
              console.error(`❌ [INTELLITECH] DB Error updating panel_health:`, dbErr.message);
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: "Payload processed" }));

        } catch (err) {
          console.error("❌ Intellitech Webhook Parsing Error:", err.message);
          res.writeHead(500);
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
      });
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.listen(port, () => {
    console.log(`📡 INTELLITECH Protocol Webhook Server listening on port ${port}`);
  });

  return server;
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
  const now = Date.now();
  for (const [account, lastSeen] of activeDevices.entries()) {
    devices.push({
      account,
      connected: (now - lastSeen) < 120000,
      lastSeen: new Date(lastSeen).toISOString()
    });
  }
  return { success: true, devices };
}

function checkConnection(account, waitMs) {
  return new Promise((resolve) => {
    if (activeDevices.has(account) && (Date.now() - activeDevices.get(account) < 120000)) {
      return resolve({ success: true, status: 'connected', account });
    }
    resolve({ success: false, status: 'disconnected', account });
  });
}

function queueCommand(account, command, zone, waitMs) {
  return Promise.resolve({ success: false, status: 'error', message: 'Webhook does not support direct command queueing.' });
}

module.exports = {
  startServer,
  getEvents,
  getStatus,
  checkConnection,
  queueCommand
};
