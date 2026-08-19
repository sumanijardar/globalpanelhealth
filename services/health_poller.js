const pool = require("../config/database");
const healthEvents = require("./health_events");
const mayurProtocol = require("../protocols/mayur");
const rassProtocol = require("../protocols/rass");
const smartiProtocol = require("../protocols/smarti");
const raxProtocol = require("../protocols/rax");
const securicoProtocol = require("../protocols/securico");
const intellitechProtocol = require("../protocols/intellitech");

let isRunning = false;

function getProtocolHandler(panelMake) {
  const make = (panelMake || "").toString().trim().toUpperCase();
  if (make === 'MAYUR') return { name: 'MAYUR', handler: mayurProtocol };
  if (make === 'RASS') return { name: 'RASS', handler: rassProtocol };
  if (make.includes('SMART') || make.includes('SMAERT') || make.includes('ZICOM')) return { name: 'SMARTI', handler: smartiProtocol };
  if (make === 'RAX' || make === 'REX') return { name: 'RAX', handler: raxProtocol };
  if (make.includes('SECURICO')) return { name: 'SECURICO', handler: securicoProtocol };
  if (make.includes('INTELLITECH') || make.includes('GOLDBOX')) return { name: 'INTELLITECH', handler: intellitechProtocol };
  return null;
}

function waitForHealthDbInsert(panelId, expectedType, timeoutMs) {
  return new Promise((resolve) => {
    let resolved = false;

    const onHealthSaved = (data) => {
      const acc = String(data.account || '').trim();
      const targetAcc = String(panelId || '').trim();
      const strippedAcc = targetAcc.replace(/^0+/, '');
      const paddedAcc = targetAcc.padStart(6, '0');

      if ((acc === targetAcc || acc === strippedAcc || acc === paddedAcc) && (data.type === expectedType || data.type === 'general')) {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({ success: true, count: data.count || 0, type: data.type, timestamp: data.timestamp });
        }
      }
    };

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        resolve({ success: false, timeout: true });
      }
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      healthEvents.removeListener('health_saved', onHealthSaved);
    }

    healthEvents.on('health_saved', onHealthSaved);
  });
}

async function processSinglePanelHealth(panel, index, total, config) {
  const panelId = String(panel.NewPanelID || panel.PanelID || '').trim();
  const rawMake = panel.Panel_Make || '';
  const ip = String(panel.dvrip || '').trim();
  const timeoutMs = (config.panel_timeout_seconds || 15) * 1000;

  const target = getProtocolHandler(rawMake);
  if (!target) {
    console.log(`⚠️ [HEALTH] [${index}/${total}] Unsupported Make '${rawMake}' for Panel #${panelId}. Skipping.`);
    return;
  }

  const { name: protocolName, handler } = target;

  console.log(`\n================================================================================`);
  console.log(`🔍 [HEALTH] [${index}/${total}] Starting Panel #${panelId} | Make: ${protocolName} (${rawMake}) | IP: ${ip || 'N/A'}`);
  console.log(`================================================================================`);

  // If panel is not connected and has IP, try to initiate outgoing connection if supported
  if (ip && handler.initiatePanelConnection) {
    const conn = await handler.checkConnection(panelId, 50);
    if (!conn.success) {
      handler.initiatePanelConnection(panelId, ip);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // -------------------------------------------------------------
  // 1. ZONE STATUS CHECK (If Enabled)
  // -------------------------------------------------------------
  if (config.check_zone_status) {
    console.log(`📡 [HEALTH] [${index}/${total}] Requesting ZONE STATUS for Panel #${panelId}...`);
    const dbWaitPromise = waitForHealthDbInsert(panelId, 'zone', timeoutMs);

    // Dispatch zone status command
    let cmdName = 'READ_ZONE_STATUS';
    if (protocolName === 'RASS') cmdName = 'READ_PORT_STATUS_1';
    else if (protocolName === 'SECURICO') cmdName = 'READ_PORT_STATUS';
    else if (protocolName === 'RAX') cmdName = 'READ_PORT_STATUS';
    else if (protocolName === 'SMARTI') cmdName = 'STATUS';

    handler.queueCommand(panelId, cmdName, '000', timeoutMs).catch(() => {});

    const dbResult = await dbWaitPromise;
    if (dbResult.success) {
      console.log(`✅ [HEALTH] [${index}/${total}] Zone Status COMPLETED & INSERTED into DB (panel_health) for Panel #${panelId}`);
    } else {
      console.log(`⚠️ [HEALTH] [${index}/${total}] Zone Status TIMEOUT (No response / Offline) for Panel #${panelId}`);
    }
  } else {
    console.log(`⏸️ [HEALTH] [${index}/${total}] Zone Status Check is DISABLED in config.`);
  }

  // -------------------------------------------------------------
  // 2. RELAY STATUS CHECK (If Enabled)
  // -------------------------------------------------------------
  if (config.check_relay_status) {
    console.log(`📡 [HEALTH] [${index}/${total}] Requesting RELAY STATUS for Panel #${panelId}...`);
    const dbWaitPromise = waitForHealthDbInsert(panelId, 'relay', timeoutMs);

    // Dispatch relay status command
    let cmdName = 'READ_RELAY_STATUS';
    handler.queueCommand(panelId, cmdName, '000', timeoutMs).catch(() => {});

    const dbResult = await dbWaitPromise;
    if (dbResult.success) {
      console.log(`✅ [HEALTH] [${index}/${total}] Relay Status COMPLETED & INSERTED into DB (panel_health) for Panel #${panelId}`);
    } else {
      console.log(`⚠️ [HEALTH] [${index}/${total}] Relay Status TIMEOUT (No response / Offline) for Panel #${panelId}`);
    }
  } else {
    console.log(`⏸️ [HEALTH] [${index}/${total}] Relay Status Check is DISABLED in config.`);
  }

  console.log(`🏁 [HEALTH] [${index}/${total}] Completed processing for Panel #${panelId}.\n`);
}

async function startHealthPoller(appConfig) {
  if (isRunning) return;
  isRunning = true;

  const healthCfg = appConfig.health_check || {
    enabled: true,
    check_zone_status: true,
    check_relay_status: true,
    panel_timeout_seconds: 15,
    delay_between_panels_ms: 1000,
    cycle_interval_seconds: 10,
    panel_make_filter: "ALL"
  };

  if (!healthCfg.enabled) {
    console.log("⏸️ Global Health Poller is DISABLED (Check config.json 'health_check.enabled')");
    return;
  }

  console.log("\n==================================================");
  console.log("🚀 STARTING GLOBAL PANEL HEALTH SEQUENTIAL POLLER");
  console.log(`   - Zone Status Check  : ${healthCfg.check_zone_status ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`   - Relay Status Check : ${healthCfg.check_relay_status ? '✅ ENABLED' : '❌ DISABLED'}`);
  console.log(`   - Timeout Per Panel  : ${healthCfg.panel_timeout_seconds} seconds`);
  console.log(`   - Delay Between Panels: ${healthCfg.delay_between_panels_ms} ms`);
  console.log(`   - Cycle Interval     : ${healthCfg.cycle_interval_seconds} seconds`);
  console.log(`   - Panel Make Filter  : ${healthCfg.panel_make_filter}`);
  console.log("==================================================\n");

  while (true) {
    try {
      let query = "SELECT NewPanelID, PanelID, Panel_Make, dvrip, mac_id FROM sites WHERE dvrip IS NOT NULL AND dvrip != '' AND TRIM(dvrip) != ''";
      const params = [];

      if (healthCfg.panel_make_filter && healthCfg.panel_make_filter.toUpperCase() !== 'ALL') {
        query += " AND Panel_Make LIKE ?";
        params.push(`%${healthCfg.panel_make_filter}%`);
      }

      query += " ORDER BY SN ASC";

      const [rows] = await pool.query(query, params);

      if (rows && rows.length > 0) {
        console.log(`\n📋 [HEALTH POLLER] Loaded ${rows.length} panel(s) from 'sites' table. Processing sequentially one-by-one...\n`);
        for (let i = 0; i < rows.length; i++) {
          await processSinglePanelHealth(rows[i], i + 1, rows.length, healthCfg);
          if (healthCfg.delay_between_panels_ms > 0) {
            await new Promise(r => setTimeout(r, healthCfg.delay_between_panels_ms));
          }
        }
        console.log(`\n🎉 [HEALTH CYCLE COMPLETE] Finished all ${rows.length} panels in 'sites' table.`);
        console.log(`⏳ Waiting ${healthCfg.cycle_interval_seconds} seconds before starting next polling cycle...\n`);
        await new Promise(r => setTimeout(r, (healthCfg.cycle_interval_seconds || 10) * 1000));
      } else {
        console.log(`ℹ️ [HEALTH POLLER] No matching panels found in 'sites' table with valid IP. Waiting 10s...`);
        await new Promise(r => setTimeout(r, 10000));
      }
    } catch (err) {
      console.error(`❌ [HEALTH POLLER] Error in polling loop:`, err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

module.exports = {
  startHealthPoller
};
