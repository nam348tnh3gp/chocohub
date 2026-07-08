// miningNode.js – Standalone mining node server with localtunnel + SQLite blockchain backup
// Production-hardened: auto-reconnect, graceful shutdown, rate limits, input validation
// 🆕 Stores full blockchain in SQLite for backup/restore capability

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const localtunnel = require('localtunnel');
const { spawn } = require('child_process');

// ─── SQLite blockchain storage ────────────────────
const Database = require('better-sqlite3');
const DB_PATH = process.env.NODE_DB_PATH || path.join(__dirname, 'node_blockchain.db');
const localDb = new Database(DB_PATH);
localDb.pragma('journal_mode = WAL');

localDb.exec(`
  CREATE TABLE IF NOT EXISTS blocks (
    height INTEGER PRIMARY KEY,
    hash TEXT UNIQUE NOT NULL,
    prev_hash TEXT NOT NULL,
    miner TEXT NOT NULL,
    nonce TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    reward REAL NOT NULL,
    difficulty REAL NOT NULL,
    tx_count INTEGER DEFAULT 0,
    total_fees REAL DEFAULT 0,
    device_type TEXT DEFAULT 'unknown',
    tier TEXT DEFAULT 'unknown',
    pos_contribution REAL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height DESC);
`);

const insertBlockStmt = localDb.prepare(`
  INSERT OR IGNORE INTO blocks (height, hash, prev_hash, miner, nonce, timestamp, reward, difficulty, tx_count, total_fees, device_type, tier, pos_contribution)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function getLocalBlockCount() {
  const row = localDb.prepare('SELECT COUNT(*) as count FROM blocks').get();
  return row ? row.count : 0;
}

function getLocalLastBlock() {
  return localDb.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get();
}

function getLocalBlocks(limit = 100, offset = 0) {
  return localDb.prepare('SELECT * FROM blocks ORDER BY height ASC LIMIT ? OFFSET ?').all(limit, offset);
}

function insertLocalBlock(block) {
  insertBlockStmt.run(
    block.height, block.hash, block.prev_hash, block.miner, block.nonce,
    block.timestamp, block.reward, block.difficulty,
    block.tx_count || 0, block.total_fees || 0,
    block.device_type || 'unknown', block.tier || 'unknown', block.pos_contribution || 0
  );
}

function getLocalBlocksSince(height) {
  return localDb.prepare('SELECT * FROM blocks WHERE height > ? ORDER BY height ASC').all(height);
}

function getAllLocalBlocks() {
  return localDb.prepare('SELECT * FROM blocks ORDER BY height ASC').all();
}

console.log('✅ Node blockchain database ready');

// ─── Config ───────────────────────────────────────
const NODE_PORT = parseInt(process.env.NODE_PORT) || 3444;
const MASTER_NODE_URL = (process.env.MASTER_NODE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const NODE_NAME = (process.env.NODE_NAME || 'ChocoHub Node').substring(0, 100);
const NODE_OWNER = (process.env.NODE_OWNER || 'bloodfell').substring(0, 100);
const NODE_LOCATION = (process.env.NODE_LOCATION || 'Brazil - São Paulo').substring(0, 100);
const LOCALTUNNEL_SUBDOMAIN = process.env.LOCALTUNNEL_SUBDOMAIN || '';
const TUNNEL_TYPE = (process.env.TUNNEL_TYPE || 'localtunnel').toLowerCase();
const FETCH_TIMEOUT = 10000;

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '1mb' }));

// ─── Node state ──────────────────────────────────
let nodeAuthToken = null;
let nodeId = null;
let connectedMiners = 0;
let lastSyncHeight = 0;
let publicUrl = null;
let registeredUrl = null;
let registered = false;
let server = null;
let tunnel = null;
let tunnelProcess = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 50;
const BASE_RECONNECT_DELAY = 2000;

// ─── Job cache for local validation ─────────────
const jobCache = new Map();
const JOB_CACHE_MAX = 500;

// ─── Fetch with timeout ──────────────────────────
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || FETCH_TIMEOUT);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return resp;
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// ─── Register with main server ───────────────────
async function registerWithMaster() {
  try {
    const nodeUrl = publicUrl || `http://localhost:${NODE_PORT}`;
    const masterToken = process.env.NODE_MASTER_TOKEN || 'chocohub-node-master';
    const registerUrl = `${MASTER_NODE_URL}/api/nodes/register`;
    console.log(`🔗 Registering at: ${registerUrl}`);
    const resp = await fetchWithTimeout(registerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: NODE_NAME,
        url: nodeUrl,
        token: masterToken,
        owner: NODE_OWNER,
        location: NODE_LOCATION
      })
    });
    const data = await resp.json();
    if (data.status === 'success') {
      nodeAuthToken = data.auth_token;
      nodeId = data.id;
      registered = true;
      reconnectAttempts = 0;
      console.log(`✅ Registered with master. Node ID: ${nodeId}`);
      await syncBlockchain();
    } else {
      console.error('❌ Registration failed:', data.message);
    }
  } catch (e) {
    console.error('❌ Registration error:', e.message);
    console.error('   URL:', MASTER_NODE_URL);
    scheduleReconnect();
  }
}

// ─── Auto-reconnect with exponential backoff ─────
function scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('❌ Max reconnect attempts reached. Giving up.');
    return;
  }
  reconnectAttempts++;
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1), 60000);
  console.log(`🔄 Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  setTimeout(async () => {
    registered = false;
    await registerWithMaster();
  }, delay);
}

// ─── Re-register with new URL (after tunnel) ────
async function reRegisterWithMaster() {
  if (!nodeAuthToken) return;
  try {
    const masterToken = process.env.NODE_MASTER_TOKEN || 'chocohub-node-master';
    const regUrl = publicUrl || `http://localhost:${NODE_PORT}`;
    const resp = await fetchWithTimeout(`${MASTER_NODE_URL}/api/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: NODE_NAME,
        url: regUrl,
        token: masterToken,
        owner: NODE_OWNER,
        location: NODE_LOCATION
      })
    });
    const data = await resp.json();
    if (data.status === 'success') {
      registeredUrl = regUrl;
      nodeAuthToken = data.auth_token;
      nodeId = data.id;
      console.log(`✅ Re-registered with URL: ${regUrl}`);
    }
  } catch (e) {
    console.warn('⚠️ Re-registration failed:', e.message);
  }
}

// ─── Sync blockchain from main server (to SQLite) ─
async function syncBlockchain() {
  if (!nodeAuthToken) return;
  try {
    const resp = await fetchWithTimeout(`${MASTER_NODE_URL}/api/nodes/sync-blocks?since=${lastSyncHeight}&limit=500`, {
      headers: { 'Authorization': `Bearer ${nodeAuthToken}` }
    });
    const data = await resp.json();
    if (data.status === 'success' && data.blocks && data.blocks.length > 0) {
      let newBlocks = 0;
      const insertMany = localDb.transaction((blocks) => {
        for (const block of blocks) {
          const before = getLocalBlockCount();
          insertLocalBlock(block);
          if (getLocalBlockCount() > before) newBlocks++;
        }
      });
      insertMany(data.blocks);
      lastSyncHeight = data.last_block ? data.last_block.height : lastSyncHeight;
      if (newBlocks > 0) {
        console.log(`📥 Synced ${data.blocks.length} blocks from master (${newBlocks} new, total: ${getLocalBlockCount()}, height: ${lastSyncHeight})`);
      }
    }
  } catch (e) {
    console.warn('⚠️ Sync error:', e.message);
  }
}

// ─── Heartbeat to main server ────────────────────
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

async function sendHeartbeat() {
  if (!nodeAuthToken) return;
  try {
    const currentUsage = process.cpuUsage();
    const userDelta = currentUsage.user - lastCpuUsage.user;
    const sysDelta = currentUsage.system - lastCpuUsage.system;
    const timeDelta = Date.now() - lastCpuTime;
    const cpuPercent = timeDelta > 0 ? Math.min(((userDelta + sysDelta) / (timeDelta * 1000)) * 100, 100) : 0;
    lastCpuUsage = currentUsage;
    lastCpuTime = Date.now();

    const lastBlock = getLocalLastBlock();

    await fetchWithTimeout(`${MASTER_NODE_URL}/api/nodes/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${nodeAuthToken}`
      },
      body: JSON.stringify({
        connected_miners: connectedMiners,
        cpu_load: Math.round(cpuPercent * 10) / 10,
        ping_ms: 0,
        blockchain_height: lastBlock ? lastBlock.height : 0
      })
    });
  } catch (e) {
    if (!registered) {
      console.warn('⚠️ Heartbeat failed, attempting re-register...');
      await registerWithMaster();
    }
  }
}

// ─── Proxy helper with timeout ───────────────────
async function proxyToMaster(endpoint, body) {
  if (!nodeAuthToken) throw new Error('Not registered with master');
  const resp = await fetchWithTimeout(`${MASTER_NODE_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${nodeAuthToken}`
    },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data.message || `HTTP ${resp.status}`);
  }
  return data;
}

// ─── Rate limiter (simple in-memory) ─────────────
const rateLimits = {};
function rateLimit(key, maxPerMinute) {
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key] = rateLimits[key].filter(t => now - t < 60000);
  if (rateLimits[key].length >= maxPerMinute) return false;
  rateLimits[key].push(now);
  return true;
}

// ═══════════════════════════════════════════════════
// PUBLIC ENDPOINTS (for miners)
// ═══════════════════════════════════════════════════

app.get('/ping', (req, res) => {
  res.json({
    pong: true,
    time: Date.now(),
    node: NODE_NAME,
    miners: connectedMiners,
    url: publicUrl,
    blockchain_height: getLocalBlockCount()
  });
});

app.get('/status', (req, res) => {
  const lastBlock = getLocalLastBlock();
  res.json({
    status: registered ? 'online' : 'registering',
    name: NODE_NAME,
    location: NODE_LOCATION,
    public_url: publicUrl,
    connected_miners: connectedMiners,
    blockchain_height: lastBlock ? lastBlock.height : 0,
    total_blocks_stored: getLocalBlockCount(),
    master_server: MASTER_NODE_URL
  });
});

app.get('/blocks', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const blocks = getLocalBlocks(limit, offset);
  res.json({ status: 'success', blocks, total: getLocalBlockCount() });
});

// ═══════════════════════════════════════════════════
// BACKUP ENDPOINTS (for restore / node-to-node sync)
// ═══════════════════════════════════════════════════

// Serve full blockchain for restore (authenticated with node token or master token)
app.get('/full-chain', (req, res) => {
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : queryToken;

  if (token !== nodeAuthToken && token !== (process.env.NODE_MASTER_TOKEN || 'chocohub-node-master')) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  try {
    const blocks = getAllLocalBlocks();
    const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
    res.json({
      status: 'success',
      blocks,
      total: blocks.length,
      last_height: lastBlock ? lastBlock.height : -1,
      node: NODE_NAME
    });
  } catch (e) {
    console.error('full-chain error:', e.message);
    res.status(500).json({ status: 'error', message: 'Failed to export blockchain' });
  }
});

// Receive blockchain from another node (for emergency restore)
app.post('/import-chain', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  if (token !== nodeAuthToken && token !== (process.env.NODE_MASTER_TOKEN || 'chocohub-node-master')) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  const { blocks } = req.body;
  if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Missing or empty blocks array' });
  }

  let imported = 0;
  const insertMany = localDb.transaction((blockArr) => {
    for (const block of blockArr) {
      if (!block || typeof block.height !== 'number') continue;
      if (!block.hash || !block.prev_hash || !block.miner) continue;
      const before = getLocalBlockCount();
      insertLocalBlock(block);
      if (getLocalBlockCount() > before) imported++;
    }
  });
  insertMany(blocks);

  const lastBlock = getLocalLastBlock();
  if (lastBlock) lastSyncHeight = lastBlock.height;

  console.log(`📥 Imported ${imported} blocks from another node (total: ${getLocalBlockCount()})`);
  res.json({ status: 'success', imported, total: getLocalBlockCount() });
});

// Get node info for backup coordination
app.get('/backup-info', (req, res) => {
  const lastBlock = getLocalLastBlock();
  res.json({
    status: 'success',
    node: NODE_NAME,
    node_id: nodeId,
    total_blocks: getLocalBlockCount(),
    last_height: lastBlock ? lastBlock.height : -1,
    last_hash: lastBlock ? lastBlock.hash : null,
    registered
  });
});

// ═══════════════════════════════════════════════════
// MINING PROXY ENDPOINTS
// ═══════════════════════════════════════════════════

app.post('/get_job', async (req, res) => {
  if (!rateLimit('get_job', 120)) {
    return res.status(429).json({ status: 'error', message: 'Rate limit exceeded' });
  }
  try {
    const result = await proxyToMaster('/api/nodes/get_job', req.body);
    const jobId = result.job_id || result.bounty_id;
    if (jobId && result.prev_hash && result.target_hex) {
      if (jobCache.size >= JOB_CACHE_MAX) {
        const oldest = jobCache.keys().next().value;
        jobCache.delete(oldest);
      }
      jobCache.set(jobId, {
        prev_hash: result.prev_hash,
        target_hex: result.target_hex,
        height: result.height
      });
    }
    res.json(result);
  } catch (e) {
    console.error('get_job proxy error:', e.message);
    res.status(502).json({ status: 'error', message: 'Upstream error' });
  }
});

app.post('/submit_solution', async (req, res) => {
  if (!rateLimit('submit', 60)) {
    return res.status(429).json({ status: 'error', message: 'Rate limit exceeded' });
  }

  const { bounty_id, nonce, worker_name, instance_id, device_type } = req.body;

  if (bounty_id && nonce !== undefined && worker_name) {
    const cached = jobCache.get(bounty_id);
    if (cached) {
      const diffKey = instance_id ? worker_name + ':' + instance_id : worker_name;
      const paddedNonce = String(nonce).padStart(20, '0');
      const input = cached.prev_hash + paddedNonce + diffKey;
      const hashHex = crypto.createHash('sha256').update(input).digest('hex');

      if (hashHex >= cached.target_hex) {
        return res.status(400).json({
          status: 'error',
          reason: `Invalid nonce: hash ${hashHex.substring(0,12)}... >= target`
        });
      }
      console.log(`✅ Local validation passed: job=${bounty_id} nonce=${nonce} hash=${hashHex.substring(0,16)}...`);
    }
  }

  try {
    const result = await proxyToMaster('/api/nodes/submit_solution', req.body);
    res.json(result);
  } catch (e) {
    console.error('submit proxy error:', e.message);
    res.status(502).json({ status: 'error', message: 'Upstream error' });
  }
});

// ─── Misc endpoints ──────────────────────────────

app.post('/miner_heartbeat', (req, res) => {
  const miners = parseInt(req.body?.miners);
  if (typeof miners === 'number' && miners >= 0 && miners <= 10000) {
    connectedMiners = miners;
  }
  res.json({ status: 'ok' });
});

app.get('/heartbeat', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// ─── Graceful shutdown ───────────────────────────
function gracefulShutdown(signal) {
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);
  if (tunnelProcess) { tunnelProcess.kill(); tunnelProcess = null; }
  if (tunnel) { tunnel.close(); tunnel = null; }
  if (server) {
    server.close(() => {
      try { localDb.close(); } catch (e) {}
      console.log('✅ HTTP server closed');
      process.exit(0);
    });
  }
  setTimeout(() => {
    try { localDb.close(); } catch (e) {}
    process.exit(1);
  }, 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection:', err?.message || err);
});

// ─── Tunnel management (localtunnel / cloudflared / ngrok) ──
async function establishTunnel() {
  if (TUNNEL_TYPE === 'none') {
    console.log('ℹ️ Tunnel disabled (TUNNEL_TYPE=none). Node accessible only locally.');
    return;
  }

  if (TUNNEL_TYPE === 'localtunnel') {
    if (process.env.LOCALTUNNEL_ENABLED === 'false') {
      console.log('ℹ️ Localtunnel disabled. Node accessible only locally.');
      return;
    }
    try {
      const tunnelOpts = { port: NODE_PORT };
      if (LOCALTUNNEL_SUBDOMAIN) tunnelOpts.subdomain = LOCALTUNNEL_SUBDOMAIN;
      console.log('🔗 Establishing localtunnel...');
      tunnel = await Promise.race([
        localtunnel(tunnelOpts),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tunnel timeout (15s)')), 15000))
      ]);
      const newUrl = tunnel.url;
      if (newUrl !== publicUrl) {
        publicUrl = newUrl;
        console.log(`✅ Tunnel established: ${publicUrl}`);
        await reRegisterWithMaster();
      }
      tunnel.on('close', () => {
        console.log('⚠️ Tunnel closed. Reconnecting...');
        publicUrl = null; tunnel = null;
        setTimeout(establishTunnel, 3000);
      });
      tunnel.on('error', (err) => console.error('❌ Tunnel error:', err.message));
    } catch (e) {
      console.warn(`⚠️ Could not establish tunnel: ${e.message}`);
      setTimeout(establishTunnel, 10000);
    }
    return;
  }

  // ─── cloudflared / ngrok ─────────────────────────
  const cmd = TUNNEL_TYPE === 'cloudflared' ? 'cloudflared' : 'ngrok';
  const args = TUNNEL_TYPE === 'cloudflared'
    ? ['tunnel', '--url', `http://localhost:${NODE_PORT}`]
    : ['http', String(NODE_PORT), '--log=stdout'];

  console.log(`🔗 Spawning ${cmd} tunnel...`);
  tunnelProcess = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let urlFound = false;
  const urlTimeout = setTimeout(() => {
    if (!urlFound) {
      console.warn(`⚠️ ${cmd} didn't report URL within 30s, will keep trying in background`);
    }
  }, 30000);

  const onData = (data) => {
    const text = data.toString();
    process.stdout.write(text);
    if (urlFound) return;
    const match = TUNNEL_TYPE === 'cloudflared'
      ? text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      : text.match(/https:\/\/[a-z0-9-]+\.ngrok[^\/\s]*/);
    if (match) {
      urlFound = true;
      clearTimeout(urlTimeout);
      publicUrl = match[0];
      console.log(`✅ ${cmd} tunnel established: ${publicUrl}`);
      reRegisterWithMaster().catch(() => {});
    }
  };

  tunnelProcess.stdout.on('data', onData);
  tunnelProcess.stderr.on('data', onData);

  tunnelProcess.on('error', (err) => {
    console.error(`❌ ${cmd} error: ${err.message}`);
    tunnelProcess = null;
    if (!urlFound) setTimeout(establishTunnel, 10000);
  });

  tunnelProcess.on('exit', (code) => {
    console.warn(`⚠️ ${cmd} exited (code ${code}). Reconnecting in 5s...`);
    tunnelProcess = null;
    publicUrl = null;
    if (!urlFound) setTimeout(establishTunnel, 5000);
  });
}

// ─── Tunnel health check (every 60s) ─────────────
async function checkTunnelHealth() {
  if (!publicUrl || process.env.LOCALTUNNEL_ENABLED === 'false') return;

  try {
    const resp = await fetchWithTimeout(`${publicUrl}/ping`, { timeout: 8000 });
    const data = await resp.json();
    if (!data.pong) throw new Error('No pong');
    if (registeredUrl !== publicUrl) {
      console.log(`🔄 Tunnel URL changed (${registeredUrl} → ${publicUrl}). Re-registering...`);
      await reRegisterWithMaster();
    }
  } catch (e) {
    console.warn(`⚠️ Tunnel health check failed: ${e.message}. Reconnecting...`);
    publicUrl = null;
    tunnel = null;
    await establishTunnel();
  }
}

// ─── Start ───────────────────────────────────────
async function start() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   CHOCOHUB MINING NODE + BACKUP          ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Name     : ${NODE_NAME}`);
  console.log(`║  Port     : ${NODE_PORT}`);
  console.log(`║  Master   : ${MASTER_NODE_URL}`);
  console.log(`║  DB       : ${DB_PATH}`);
  console.log(`║  Blocks   : ${getLocalBlockCount()}`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  if (!process.env.NODE_MASTER_TOKEN) {
    console.warn('⚠️ NODE_MASTER_TOKEN not set in .env — using default');
  }

  server = app.listen(NODE_PORT, async () => {
    console.log(`🌐 Node server listening on port ${NODE_PORT}`);

    // Load last sync height from local DB
    const lastBlock = getLocalLastBlock();
    if (lastBlock) {
      lastSyncHeight = lastBlock.height;
      console.log(`📊 Local blockchain height: ${lastSyncHeight} (${getLocalBlockCount()} blocks)`);
    }

    await registerWithMaster();
    await establishTunnel();

    // Heartbeat every 30s
    setInterval(sendHeartbeat, 30000);
    // Blockchain sync every 30s
    setInterval(syncBlockchain, 30000);
    // Tunnel health check every 60s
    setInterval(checkTunnelHealth, 60000);
  });
}

start();
