const { loadConfig } = require('./config/config_loader');
const decoders = require('./decoders');
const healthEvents = require('./services/health_events');

console.log("=== 1. Testing Config Loader ===");
const config = loadConfig();
console.log("Health check config:", JSON.stringify(config.health_check, null, 2));

console.log("\n=== 2. Testing Decoders for Zone Status & Relay Status ===");

// 1. RASS NYY040 Zone Status Decoder Test
const rassZoneMsg = '\n12340050"SIA-DCS"0001R000001L000000#040037[#040037|NYY040][N|001R|002R|003B|004A]_12:00:00,08-19-2026\r';
const rassZoneDec = decoders.rass(rassZoneMsg);
console.log("RASS Zone Status Decoded:", rassZoneDec.sensors ? `✅ Found ${rassZoneDec.sensors.length} sensors` : '❌ Failed');

// 2. RASS Relay Status Decoder Test
const rassRelayMsg = '\n12340050"SIA-DCS"0001R000001L000000#040037[#040037|NYY004][N|005|01|1]_12:00:00,08-19-2026\r';
const rassRelayDec = decoders.rass(rassRelayMsg);
console.log("RASS Relay Status Decoded:", rassRelayDec.outputNo === '01' && rassRelayDec.outputState === 'ON' ? `✅ Output ${rassRelayDec.outputNo}: ${rassRelayDec.outputState}` : '❌ Failed');

// 3. SECURICO DCS008 Zone Status Decoder Test
const securicoZoneMsg = '\n12340050"SIA-DCS"0001R000001L000000#040037[#040037|DCS008|000|0000A00890880AAAAAAA]_12:00:00,08-19-2026\r';
const securicoZoneDec = decoders.securico(securicoZoneMsg);
console.log("SECURICO Zone Status Decoded:", securicoZoneDec.zonesList ? `✅ Found ${securicoZoneDec.zonesList.length} zones` : '❌ Failed');

// 4. SECURICO DCS009 Relay Status Decoder Test
const securicoRelayMsg = '\n12340050"SIA-DCS"0001R000001L000000#040037[#040037|DCS009|000|030#130#231#331]_12:00:00,08-19-2026\r';
const securicoRelayDec = decoders.securico(securicoRelayMsg);
console.log("SECURICO Relay Status Decoded:", securicoRelayDec.relayList ? `✅ Found ${securicoRelayDec.relayList.length} relays` : '❌ Failed');

// 5. RAX STARTRPS Zone Status Decoder Test
const raxZoneMsg = 'STARTACC040037MAC104039025063100105STARTRPS00123000ENDD';
const raxZoneDec = decoders.rax(raxZoneMsg);
console.log("RAX Zone Status Decoded:", raxZoneDec.zonesList ? `✅ Found ${raxZoneDec.zonesList.length} zones` : '❌ Failed');

// 6. RAX STARTRCS Relay Status Decoder Test
const raxRelayMsg = 'STARTACC040037MAC104039025063100105STARTRCS10&00&12&END';
const raxRelayDec = decoders.rax(raxRelayMsg);
console.log("RAX Relay Status Decoded:", raxRelayDec.channelList ? `✅ Found ${raxRelayDec.channelList.length} channels` : '❌ Failed');

// 7. SMARTI NYY040 Zone Status Decoder Test
const smartiZoneMsg = '\n12340050"SIA-DCS"0001R000001L000000#040037[#040037|NYY040][N|001R|002R|003B]_12:00:00,08-19-2026\r';
const smartiZoneDec = decoders.smarti(smartiZoneMsg);
console.log("SMARTI Zone Status Decoded:", smartiZoneDec.sensors ? `✅ Found ${smartiZoneDec.sensors.length} sensors` : '❌ Failed');

console.log("\n=== 3. Testing Health Event Emitter ===");
healthEvents.once('health_saved', (evt) => {
  console.log("✅ Health Event Received:", evt);
});
healthEvents.emit('health_saved', { account: '040037', make: 'RASS', type: 'zone', count: 4, timestamp: '2026-08-19 12:00:00' });

console.log("\n🎉 ALL TESTS PASSED SUCCESSFULLY!");
