const fetch = require('node-fetch');

const LIVATO_SERVER  = process.env.LIVATO_SERVER  || 'https://livato-server-production.up.railway.app';
const LIVATO_TOKEN   = process.env.LIVATO_TOKEN   || '';
const SCAN_INTERVAL  = parseInt(process.env.SCAN_INTERVAL || '30') * 1000;
const NETWORK_SUBNET = process.env.NETWORK_SUBNET || '192.168.0';

// ─── Known devices cache ──────────────────────────────────────────────────────
let knownDevices = [];

// ─── Logging ──────────────────────────────────────────────────────────────────
const log = (msg) => console.log(`[Livato Hub] ${new Date().toISOString()} ${msg}`);

// ─── HTTP helper with timeout ─────────────────────────────────────────────────
const fetchWithTimeout = async (url, options = {}, timeout = 3000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
};

// ─── Shelly Discovery ─────────────────────────────────────────────────────────
// Shelly devices respond on port 80 at /shelly endpoint
const discoverShelly = async (ip) => {
  try {
    const res = await fetchWithTimeout(`http://${ip}/shelly`, {}, 2000);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.type && !data.model && !data.app) return null;

    // Get current status
    let state = 'unknown';
    let power = null;
    try {
      // Gen 2+ devices
      const statusRes = await fetchWithTimeout(`http://${ip}/rpc/Switch.GetStatus?id=0`, {}, 2000);
      if (statusRes.ok) {
        const status = await statusRes.json();
        state = status.output ? 'on' : 'off';
        power = status.apower || null;
      }
    } catch {
      try {
        // Gen 1 devices
        const statusRes = await fetchWithTimeout(`http://${ip}/status`, {}, 2000);
        if (statusRes.ok) {
          const status = await statusRes.json();
          state = status.relays?.[0]?.ison ? 'on' : 'off';
          power = status.meters?.[0]?.power || null;
        }
      } catch {}
    }

    return {
      id:           `shelly_${(data.mac || ip).replace(/:/g, '').toLowerCase()}`,
      name:         data.name || data.app || data.type || `Shelly ${ip}`,
      type:         'switch',
      brand:        'shelly',
      ip,
      mac:          data.mac || null,
      model:        data.model || data.app || data.type,
      state,
      power_watts:  power,
      source:       'hub',
      last_seen:    new Date().toISOString(),
    };
  } catch { return null; }
};

// ─── Philips Hue Discovery ────────────────────────────────────────────────────
// Hue bridges respond at /api/config without auth
const discoverHue = async (ip) => {
  try {
    const res = await fetchWithTimeout(`http://${ip}/api/config`, {}, 2000);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.bridgeid) return null;
    return {
      id:        `hue_${data.bridgeid.toLowerCase()}`,
      name:      data.name || `Hue Bridge ${ip}`,
      type:      'hub',
      brand:     'hue',
      ip,
      mac:       data.mac || null,
      model:     data.modelid || 'BSB002',
      state:     'on',
      source:    'hub',
      last_seen: new Date().toISOString(),
    };
  } catch { return null; }
};

// ─── LIFX Discovery ───────────────────────────────────────────────────────────
// LIFX devices have a local HTTP API on port 56780
const discoverLIFX = async (ip) => {
  try {
    const res = await fetchWithTimeout(`http://${ip}:56780/v1/lights`, {}, 2000);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;
    return data.map(light => ({
      id:        `lifx_${light.id}`,
      name:      light.label || `LIFX ${ip}`,
      type:      'light',
      brand:     'lifx',
      ip,
      state:     light.power === 'on' ? 'on' : 'off',
      source:    'hub',
      last_seen: new Date().toISOString(),
    }));
  } catch { return null; }
};

// ─── TP-Link Kasa Discovery ───────────────────────────────────────────────────
// Kasa devices respond on port 9999 with a JSON payload
const discoverKasa = async (ip) => {
  try {
    const net = require('net');
    return await new Promise((resolve) => {
      const client = new net.Socket();
      let data = Buffer.alloc(0);
      client.setTimeout(2000);
      client.connect(9999, ip, () => {
        // XOR encode the query
        const query = JSON.stringify({ system: { get_sysinfo: {} } });
        const buf = Buffer.alloc(query.length + 4);
        buf.writeUInt32BE(query.length, 0);
        let key = 171;
        for (let i = 0; i < query.length; i++) {
          key = buf[i + 4] = query.charCodeAt(i) ^ key;
        }
        client.write(buf);
      });
      client.on('data', chunk => { data = Buffer.concat([data, chunk]); });
      client.on('end', () => {
        try {
          let key = 171, result = '';
          for (let i = 4; i < data.length; i++) {
            const byte = data[i] ^ key;
            key = data[i];
            result += String.fromCharCode(byte);
          }
          const info = JSON.parse(result)?.system?.get_sysinfo;
          if (!info) return resolve(null);
          resolve({
            id:        `kasa_${info.deviceId || ip}`,
            name:      info.alias || `Kasa ${ip}`,
            type:      info.dev_name?.includes('Bulb') ? 'light' : 'switch',
            brand:     'kasa',
            ip,
            mac:       info.mac,
            model:     info.model,
            state:     info.relay_state === 1 ? 'on' : 'off',
            source:    'hub',
            last_seen: new Date().toISOString(),
          });
        } catch { resolve(null); }
        client.destroy();
      });
      client.on('error', () => { client.destroy(); resolve(null); });
      client.on('timeout', () => { client.destroy(); resolve(null); });
    });
  } catch { return null; }
};

// ─── Scan entire subnet ───────────────────────────────────────────────────────
const scanSubnet = async () => {
  log(`Scanning ${NETWORK_SUBNET}.1-254 for smart devices...`);
  const found = [];
  const BATCH = 20; // scan 20 IPs at a time

  for (let start = 1; start <= 254; start += BATCH) {
    const end = Math.min(start + BATCH - 1, 254);
    const batch = [];
    for (let i = start; i <= end; i++) {
      batch.push(i);
    }

    const results = await Promise.all(batch.map(async (i) => {
      const ip = `${NETWORK_SUBNET}.${i}`;
      const checks = await Promise.allSettled([
        discoverShelly(ip),
        discoverHue(ip),
        discoverLIFX(ip),
        discoverKasa(ip),
      ]);
      const devices = [];
      for (const result of checks) {
        if (result.status === 'fulfilled' && result.value) {
          if (Array.isArray(result.value)) devices.push(...result.value);
          else devices.push(result.value);
        }
      }
      return devices;
    }));

    for (const devices of results) {
      found.push(...devices);
    }
  }

  log(`Scan complete — found ${found.length} devices`);
  return found;
};

// ─── Sync to Livato server ────────────────────────────────────────────────────
const syncToServer = async (devices) => {
  if (!LIVATO_TOKEN) {
    log('No LIVATO_TOKEN set — skipping sync');
    return;
  }
  try {
    const res = await fetchWithTimeout(`${LIVATO_SERVER}/hub/sync`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${LIVATO_TOKEN}`,
      },
      body: JSON.stringify({ devices, hub_version: '1.0.0', subnet: NETWORK_SUBNET }),
    }, 10000);
    if (res.ok) {
      log(`Synced ${devices.length} devices to Livato server`);
    } else {
      const err = await res.text();
      log(`Sync failed: ${res.status} ${err}`);
    }
  } catch (err) {
    log(`Sync error: ${err.message}`);
  }
};

// ─── Handle control commands from server ─────────────────────────────────────
const pollCommands = async () => {
  if (!LIVATO_TOKEN) return;
  try {
    const res = await fetchWithTimeout(`${LIVATO_SERVER}/hub/commands`, {
      headers: { 'Authorization': `Bearer ${LIVATO_TOKEN}` },
    }, 5000);
    if (!res.ok) return;
    const data = await res.json();
    const commands = data.commands || [];
    for (const cmd of commands) {
      await executeCommand(cmd);
    }
  } catch {}
};

const executeCommand = async (cmd) => {
  const device = knownDevices.find(d => d.id === cmd.device_id);
  if (!device) { log(`Command for unknown device: ${cmd.device_id}`); return; }

  log(`Executing: ${cmd.action} on ${device.name} (${device.ip})`);

  try {
    if (device.brand === 'shelly') {
      // Try Gen 2 first
      try {
        const on = cmd.action === 'turn_on';
        await fetchWithTimeout(`http://${device.ip}/rpc/Switch.Set?id=0&on=${on}`, {}, 3000);
        device.state = on ? 'on' : 'off';
      } catch {
        // Fall back to Gen 1
        const action = cmd.action === 'turn_on' ? 'on' : 'off';
        await fetchWithTimeout(`http://${device.ip}/relay/0?turn=${action}`, {}, 3000);
        device.state = cmd.action === 'turn_on' ? 'on' : 'off';
      }
    } else if (device.brand === 'kasa') {
      const net = require('net');
      const on = cmd.action === 'turn_on' ? 1 : 0;
      const query = JSON.stringify({ system: { set_relay_state: { state: on } } });
      const buf = Buffer.alloc(query.length + 4);
      buf.writeUInt32BE(query.length, 0);
      let key = 171;
      for (let i = 0; i < query.length; i++) {
        key = buf[i + 4] = query.charCodeAt(i) ^ key;
      }
      await new Promise((resolve) => {
        const client = new net.Socket();
        client.setTimeout(3000);
        client.connect(9999, device.ip, () => { client.write(buf); });
        client.on('data', () => { client.destroy(); resolve(); });
        client.on('error', () => { client.destroy(); resolve(); });
        client.on('timeout', () => { client.destroy(); resolve(); });
      });
      device.state = on ? 'on' : 'off';
    }

    // Report result back to server
    await fetchWithTimeout(`${LIVATO_SERVER}/hub/command-result`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LIVATO_TOKEN}` },
      body:    JSON.stringify({ command_id: cmd.id, success: true, new_state: device.state }),
    }, 5000);

  } catch (err) {
    log(`Command failed: ${err.message}`);
  }
};

// ─── Main loop ────────────────────────────────────────────────────────────────
const main = async () => {
  log('Livato Hub starting up...');
  log(`Server: ${LIVATO_SERVER}`);
  log(`Subnet: ${NETWORK_SUBNET}.x`);
  log(`Scan interval: ${SCAN_INTERVAL / 1000}s`);

  // Initial scan
  knownDevices = await scanSubnet();
  await syncToServer(knownDevices);

  // Ongoing loop
  setInterval(async () => {
    try {
      // Poll for commands every interval
      await pollCommands();

      // Full rescan every interval
      knownDevices = await scanSubnet();
      await syncToServer(knownDevices);
    } catch (err) {
      log(`Loop error: ${err.message}`);
    }
  }, SCAN_INTERVAL);

  // Poll commands more frequently (every 5 seconds)
  setInterval(async () => {
    try { await pollCommands(); } catch {}
  }, 5000);
};

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
