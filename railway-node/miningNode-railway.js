// miningNode-railway.js – ChocoHub Railway node: mining proxy + backup sync
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('better-sqlite3');
const DHExchange = require('./dh');

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const err = (msg) => console.error(`[${new Date().toISOString()}] ${msg}`);

// ─── Config ───────────────────────────────────────
const NODE_PORT = parseInt(process.env.NODE_PORT) || 3444;
const MASTER_NODE_URL = (process.env.MASTER_NODE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const NODE_NAME = (process.env.NODE_NAME || 'ChocoHub Railway Node').substring(0, 100);
const NODE_OWNER = (process.env.NODE_OWNER || 'bloodfell').substring(0, 100);
const NODE_LOCATION = (process.env.NODE_LOCATION || 'US West').substring(0, 100);
const PUBLIC_URL = process.env.PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || 'chocohub-default-token';
const DB_PATH = path.join(__dirname, process.env.BACKUP_DB_PATH || 'backup_node.db');
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '10', 10);
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '3', 10);
const FETCH_TIMEOUT = 10000;

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '5000mb' }));

// ─── Mining node state ────────────────────────────
let nodeAuthToken = null;
let nodeId = null;
let connectedMiners = 0;

// ═══════════════════════════════════════════════════
//  BACKUP: Canonical JSON
// ═══════════════════════════════════════════════════
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(k => `"${k}":${canonicalStringify(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

// ═══════════════════════════════════════════════════
//  BACKUP: SQLite
// ═══════════════════════════════════════════════════
let backupDb;
function initBackupDB() {
  backupDb = sqlite3(DB_PATH);
  backupDb.exec(`
    CREATE TABLE IF NOT EXISTS snapshot (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      state TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  backupDb.exec(`INSERT OR IGNORE INTO snapshot (id, state) VALUES (1, '{}')`);
  backupDb.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL,
      users_count INTEGER DEFAULT 0,
      total_items INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  log('✅ Backup database ready');
}

function countSnapshotSize(state) {
  const users = state.users ? state.users.length : 0;
  const stakes = state.stakes ? state.stakes.length : 0;
  const blocks = state.blocks ? state.blocks.length : 0;
  const transactions = state.transactions ? state.transactions.length : 0;
  return { total: users + stakes + blocks + transactions, users };
}

function saveSnapshot(state) {
  const json = canonicalStringify(state);
  const { total, users } = countSnapshotSize(state);
  const transaction = backupDb.transaction(() => {
    const oldRow = backupDb.prepare('SELECT state FROM snapshot WHERE id = 1').get();
    if (oldRow && oldRow.state && oldRow.state !== '{}') {
      try {
        const oldState = JSON.parse(oldRow.state);
        const oldSize = countSnapshotSize(oldState);
        if (oldRow.state !== json) {
          backupDb.prepare(
            'INSERT INTO snapshot_backups (state, users_count, total_items) VALUES (?, ?, ?)'
          ).run(oldRow.state, oldSize.users, oldSize.total);
        }
      } catch (e) {}
    }
    backupDb.prepare(
      `INSERT OR REPLACE INTO snapshot (id, state, updated_at) VALUES (1, ?, datetime('now'))`
    ).run(json);
    backupDb.prepare(
      `DELETE FROM snapshot_backups WHERE id NOT IN (
        SELECT id FROM snapshot_backups ORDER BY created_at DESC LIMIT ?
      )`
    ).run(MAX_BACKUPS);
  });
  try {
    transaction();
    log(`💾 Snapshot saved (${users} users, ${total} items, ${(json.length / 1024).toFixed(1)} KB)`);
  } catch (e) {
    err('Save snapshot error:', e.message);
  }
}

function getSnapshot() {
  const row = backupDb.prepare('SELECT state FROM snapshot WHERE id = 1').get();
  if (row && row.state) {
    try { return JSON.parse(row.state); } catch { return null; }
  }
  return null;
}

function getSnapshotTime() {
  const row = backupDb.prepare('SELECT updated_at FROM snapshot WHERE id = 1').get();
  return row ? row.updated_at : 'unknown';
}

// ═══════════════════════════════════════════════════
//  BACKUP: RSA + DH
// ═══════════════════════════════════════════════════
const RSA_PRIVATE_PATH = path.join(__dirname, 'backup_private.pem');
const RSA_PUBLIC_PATH = path.join(__dirname, 'backup_public.pem');
let serverPrivateKeyPem, serverPublicKeyPem;

function loadOrGenerateRSA() {
  if (fs.existsSync(RSA_PRIVATE_PATH) && fs.existsSync(RSA_PUBLIC_PATH)) {
    serverPrivateKeyPem = fs.readFileSync(RSA_PRIVATE_PATH, 'utf8');
    serverPublicKeyPem = fs.readFileSync(RSA_PUBLIC_PATH, 'utf8');
    log('🔑 Loaded existing RSA long-term keys');
  } else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    fs.writeFileSync(RSA_PRIVATE_PATH, privateKey);
    fs.writeFileSync(RSA_PUBLIC_PATH, publicKey);
    serverPrivateKeyPem = privateKey;
    serverPublicKeyPem = publicKey;
    log('🔧 Generated new RSA long-term keys');
  }
}

const serverDHKeys = DHExchange.generateStandardKeyPair('modp2048');
const dhSessions = new Map();

// Backup HMAC middleware
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/backup')) return next();
  const clientId = req.headers['x-client-id'] || req.body?.clientId || req.query?.clientId;
  const signature = req.headers['x-signature'];
  if (!clientId || !signature) return next();
  const session = dhSessions.get(clientId);
  if (!session) return next();
  const timestamp = req.headers['x-timestamp'] || '';
  const bodyStr = req.method === 'POST' ? canonicalStringify(req.body) : '';
  const message = `${req.method}${req.path}${timestamp}${bodyStr}`;
  if (!DHExchange.verify(message, signature, session.sessionKey)) {
    return res.status(401).json({ status: 'error', message: 'Invalid HMAC signature' });
  }
  next();
});

// ═══════════════════════════════════════════════════
//  BACKUP: Routes
// ═══════════════════════════════════════════════════
app.get('/api/backup/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), snapshot_time: getSnapshotTime() });
});

app.get('/api/backup/status', (req, res) => {
  const snap = getSnapshot();
  const users = snap ? (snap.users ? snap.users.length : 0) : 0;
  res.json({
    status: 'ok',
    total_users: users,
    snapshot_time: getSnapshotTime(),
    main_server: MASTER_NODE_URL,
    max_backups: MAX_BACKUPS
  });
});

app.get('/api/backup/history', (req, res) => {
  const rows = backupDb.prepare(
    'SELECT id, users_count, total_items, created_at FROM snapshot_backups ORDER BY created_at DESC LIMIT 10'
  ).all();
  res.json({ status: 'success', history: rows, max_backups: MAX_BACKUPS });
});

app.post('/api/backup/restore/:backupId', (req, res) => {
  const token = req.headers['x-backup-token'] || (req.body ? req.body.token : '');
  if (token !== BACKUP_TOKEN) {
    return res.status(401).json({ status: 'error', message: 'Invalid token' });
  }
  const backupId = parseInt(req.params.backupId, 10);
  const row = backupDb.prepare('SELECT state FROM snapshot_backups WHERE id = ?').get(backupId);
  if (!row) return res.status(404).json({ status: 'error', message: 'Backup not found' });
  try {
    const state = JSON.parse(row.state);
    const current = getSnapshot();
    if (current && current.users && current.users.length > 0) {
      const currentSize = countSnapshotSize(current);
      backupDb.prepare(
        'INSERT INTO snapshot_backups (state, users_count, total_items) VALUES (?, ?, ?)'
      ).run(canonicalStringify(current), currentSize.users, currentSize.total);
    }
    backupDb.prepare(
      `INSERT OR REPLACE INTO snapshot (id, state, updated_at) VALUES (1, ?, datetime('now'))`
    ).run(canonicalStringify(state));
    const size = countSnapshotSize(state);
    log(`🔄 Restored backup #${backupId} (${size.users} users)`);
    res.json({ status: 'success', message: `Restored backup #${backupId}`, users: size.users });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/api/server/public-key', (req, res) => {
  res.json({
    status: 'success',
    publicKey: serverPublicKeyPem,
    algorithm: 'RSA-4096',
    purpose: 'DH server authentication'
  });
});

app.post('/api/dh/exchange', (req, res) => {
  const { clientId, clientPublicKey, token } = req.body;
  if (!clientId || !clientPublicKey || !token) {
    return res.status(400).json({ status: 'error', message: 'Missing fields' });
  }
  if (token !== BACKUP_TOKEN) {
    return res.status(401).json({ status: 'error', message: 'Invalid token' });
  }
  try {
    const sharedSecret = DHExchange.computeSharedSecret(
      serverDHKeys.privateKey, clientPublicKey, serverDHKeys.prime, serverDHKeys.generator
    );
    const sessionKey = DHExchange.deriveSessionKey(sharedSecret);
    dhSessions.set(clientId, { sessionKey, createdAt: Date.now() });

    const serverPubData = canonicalStringify({
      publicKey: serverDHKeys.publicKey, prime: serverDHKeys.prime,
      generator: serverDHKeys.generator, group: serverDHKeys.group
    });
    const signature = DHExchange.signWithPrivateKey(serverPubData, serverPrivateKeyPem);

    log(`🔐 DH session established with ${clientId}`);
    res.json({
      status: 'success', serverPublicKey: serverDHKeys.publicKey,
      prime: serverDHKeys.prime, generator: serverDHKeys.generator,
      group: serverDHKeys.group, serverSignature: signature
    });
  } catch (e) {
    err('DH exchange error:', e);
    res.status(500).json({ status: 'error', message: 'Key exchange failed' });
  }
});

app.post('/api/backup/sync', (req, res) => {
  const data = req.body;
  if (!data || !data.type) return res.status(400).json({ status: 'error', message: 'Invalid request' });

  const msgType = data.type;
  const token = data.token || '';
  const clientId = req.headers['x-client-id'] || '';
  const session = clientId ? dhSessions.get(clientId) : null;
  if (!session && token !== BACKUP_TOKEN) {
    return res.status(401).json({ status: 'error', message: 'Invalid token or no session' });
  }

  if (msgType === 'READY') {
    const clientEmpty = data.empty === true;
    const serverHasData = getSnapshot() && getSnapshot().users && getSnapshot().users.length > 0;
    if (clientEmpty) {
      const snap = getSnapshot();
      if (snap && snap.users && snap.users.length > 0) {
        return res.json({ type: 'FULL_SNAPSHOT', token: BACKUP_TOKEN, state: snap });
      } else {
        return res.json({ type: 'READY_ACK', status: 'success', message: 'ready but empty' });
      }
    }
    if (!clientEmpty && !serverHasData) {
      return res.json({ type: 'REQUEST_SNAPSHOT', message: 'Server is empty, please send your snapshot' });
    }
    return res.json({ type: 'READY_ACK', status: 'success', message: 'ack' });
  } else if (msgType === 'PING') {
    return res.json({ type: 'PONG', timestamp: new Date().toISOString() });
  } else if (msgType === 'FULL_SNAPSHOT') {
    if (!data.state) return res.status(400).json({ status: 'error', message: 'Missing state' });
    const state = data.state;
    const newSize = countSnapshotSize(state);
    const current = getSnapshot();
    const newHash = crypto.createHash('sha256').update(canonicalStringify(state)).digest('hex');
    if (current && current.users && current.users.length > 0) {
      const currentHash = crypto.createHash('sha256').update(canonicalStringify(current)).digest('hex');
      if (newHash === currentHash) {
        return res.json({ type: 'SNAPSHOT_ACK', status: 'skipped', message: 'Identical' });
      }
      const currentSize = countSnapshotSize(current);
      if (newSize.total < currentSize.total * 0.5) {
        return res.json({ type: 'SNAPSHOT_ACK', status: 'skipped', message: 'Less data' });
      }
    }
    saveSnapshot(state);
    return res.json({ type: 'SNAPSHOT_ACK', status: 'success' });
  } else {
    return res.status(400).json({ status: 'error', message: `Unknown type: ${msgType}` });
  }
});

// ═══════════════════════════════════════════════════
//  FETCH helper (mining)
// ═══════════════════════════════════════════════════
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

// ─── Register as mining node ────────────────────
async function registerWithMaster() {
  const nodeUrl = PUBLIC_URL || `http://localhost:${NODE_PORT}`;
  const masterToken = process.env.NODE_MASTER_TOKEN || 'chocohub-node-master';
  try {
    const resp = await fetchWithTimeout(`${MASTER_NODE_URL}/api/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NODE_NAME, url: nodeUrl, token: masterToken, owner: NODE_OWNER, location: NODE_LOCATION })
    });
    const data = await resp.json();
    if (data.status === 'success') {
      nodeAuthToken = data.auth_token;
      nodeId = data.id;
      log(`✅ Registered with master. Node ID: ${nodeId}, URL: ${nodeUrl}`);
    } else {
      err('Registration failed:', data.message);
      setTimeout(registerWithMaster, 5000);
    }
  } catch (e) {
    err('Registration error:', e.message);
    setTimeout(registerWithMaster, 5000);
  }
}

async function registerBackupWithMaster() {
  const selfUrl = PUBLIC_URL || `http://localhost:${NODE_PORT}`;
  try {
    const resp = await fetch(`${MASTER_NODE_URL}/api/backup/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: canonicalStringify({ url: selfUrl, token: BACKUP_TOKEN, name: NODE_NAME, platform: 'Node.js' })
    });
    if (resp.ok) log(`📡 Registered as backup node: ${selfUrl}`);
    else err('Backup registration failed:', resp.status);
  } catch (e) {
    err('Backup registration error:', e.message);
  }
}

async function proxyToMaster(endpoint, body) {
  if (!nodeAuthToken) throw new Error('Not registered with master');
  const resp = await fetchWithTimeout(`${MASTER_NODE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${nodeAuthToken}` },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.message || `HTTP ${resp.status}`);
  return data;
}

// ─── Heartbeat ──────────────────────────────────
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
    await fetchWithTimeout(`${MASTER_NODE_URL}/api/nodes/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${nodeAuthToken}` },
      body: JSON.stringify({ connected_miners: connectedMiners, cpu_load: Math.round(cpuPercent * 10) / 10, ping_ms: 0, blockchain_height: 0 })
    });
  } catch (e) {
    if (e.message?.includes('401') || e.message?.includes('Unauthorized')) {
      log('Heartbeat unauthorized, re-registering...');
      await registerWithMaster();
    }
  }
}

// ─── Rate limiter ───────────────────────────────
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
//  MINING: Endpoints
// ═══════════════════════════════════════════════════
app.get('/ping', (req, res) => {
  res.json({ pong: true, time: Date.now(), node: NODE_NAME, miners: connectedMiners, url: PUBLIC_URL, blockchain_height: 0 });
});

app.get('/status', (req, res) => {
  res.json({ status: nodeAuthToken ? 'online' : 'registering', name: NODE_NAME, location: NODE_LOCATION, public_url: PUBLIC_URL, connected_miners: connectedMiners, master_server: MASTER_NODE_URL });
});

app.post('/get_job', async (req, res) => {
  if (!rateLimit('get_job', 120)) {
    return res.status(429).json({ status: 'error', message: 'Rate limit exceeded' });
  }
  try {
    const worker = (req.body?.worker_name || 'unknown').substring(0, 16);
    log(`📦 Job for ${worker}`);
    const result = await proxyToMaster('/api/nodes/get_job', req.body);
    res.json(result);
  } catch (e) {
    err('get_job proxy error:', e.message);
    res.status(502).json({ status: 'error', message: 'Upstream error' });
  }
});

app.post('/submit_solution', async (req, res) => {
  if (!rateLimit('submit', 60)) {
    return res.status(429).json({ status: 'error', message: 'Rate limit exceeded' });
  }
  try {
    const worker = (req.body?.worker_name || 'unknown').substring(0, 16);
    const result = await proxyToMaster('/api/nodes/submit_solution', req.body);
    log(`${result?.status === 'success' ? '✅ Accepted' : '❌ Rejected'} - ${worker}`);
    res.json(result);
  } catch (e) {
    err('submit proxy error:', e.message);
    res.status(502).json({ status: 'error', message: 'Upstream error' });
  }
});

app.post('/miner_heartbeat', (req, res) => {
  const miners = parseInt(req.body?.miners);
  if (typeof miners === 'number' && miners >= 0 && miners <= 10000) {
    if (connectedMiners !== miners) {
      log(`👥 Miners: ${connectedMiners} → ${miners}`);
    }
    connectedMiners = miners;
  }
  res.json({ status: 'ok' });
});

app.get('/heartbeat', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// ─── Catch-all proxy to master ──────────────────
app.use(async (req, res) => {
  const path = req.path;
  const targetUrl = `${MASTER_NODE_URL}${path}`;
  try {
    const opts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      timeout: FETCH_TIMEOUT
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      opts.body = JSON.stringify(req.body);
    }
    const resp = await fetchWithTimeout(targetUrl, opts);
    const body = await resp.text();
    res.status(resp.status).send(body);
  } catch (e) {
    err(`Proxy error for ${path}: ${e.message}`);
    res.status(502).json({ status: 'error', message: 'Upstream error' });
  }
});

// ─── Backup: send snapshot to main server ──────
let mainServerPublicKey = null;

async function fetchMainServerPublicKey() {
  try {
    const resp = await fetch(`${MASTER_NODE_URL}/api/server/public-key`);
    if (resp.ok) {
      const data = await resp.json();
      mainServerPublicKey = data.publicKey;
      log('🔑 Fetched main server public key');
    }
  } catch (e) {
    err('Could not fetch main server public key:', e.message);
  }
}

async function sendSnapshotToMainServer() {
  const snap = getSnapshot();
  if (!snap || !snap.users || snap.users.length === 0) {
    return;
  }
  const snapSize = JSON.stringify(snap).length;
  const clientId = `backup-${require('os').hostname()}-${process.pid}`;
  let sessionKey = null;

  if (!mainServerPublicKey) await fetchMainServerPublicKey();

  if (mainServerPublicKey) {
    try {
      const clientDH = DHExchange.generateStandardKeyPair('modp2048');
      const resp = await fetch(`${MASTER_NODE_URL}/api/dh/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: canonicalStringify({ clientId, clientPublicKey: clientDH.publicKey, token: BACKUP_TOKEN })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.serverPublicKey && data.serverSignature) {
          const pubDataStr = canonicalStringify({
            publicKey: data.serverPublicKey, prime: data.prime,
            generator: data.generator, group: data.group
          });
          const valid = DHExchange.verifyWithPublicKey(pubDataStr, data.serverSignature, mainServerPublicKey);
          if (valid) {
            const shared = DHExchange.computeSharedSecret(clientDH.privateKey, data.serverPublicKey, data.prime, data.generator);
            sessionKey = DHExchange.deriveSessionKey(shared);
            log('🔐 Authenticated DH session with main server');
          }
        }
      }
    } catch (e) {
      err('DH exchange with main server failed:', e.message);
    }
  }

  const payload = { type: 'FULL_SNAPSHOT', token: BACKUP_TOKEN, state: snap };
  const bodyString = canonicalStringify(payload);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'ChocoHub-BackupNode/1.0' };

  if (sessionKey) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = DHExchange.sign(`POST/api/backup/sync${timestamp}${bodyString}`, sessionKey);
    headers['X-Client-Id'] = clientId;
    headers['X-Timestamp'] = timestamp;
    headers['X-Signature'] = signature;
  }

  log(`📤 Sending snapshot to main server (${snap.users.length} users, ${(snapSize / 1024).toFixed(1)} KB)...`);
  try {
    const resp = await fetch(`${MASTER_NODE_URL}/api/backup/sync`, {
      method: 'POST', headers, body: bodyString
    });
    if (resp.ok) log('✅ Snapshot sent to main server');
    else err(`Send snapshot failed: ${resp.status}`);
  } catch (e) {
    err('Error sending snapshot:', e.message);
  }
}

// ─── Backup: health monitor ─────────────────────
let wasDown = false;
setInterval(async () => {
  try {
    const resp = await fetch(`${MASTER_NODE_URL}/health`);
    const online = resp.ok;
    if (!online && !wasDown) { log('🔴 Main server DOWN'); wasDown = true; }
    else if (online && wasDown) { log('🟢 Main server BACK ONLINE'); await sendSnapshotToMainServer(); wasDown = false; }
  } catch (e) {
    if (!wasDown) { log('🔴 Main server DOWN'); wasDown = true; }
  }
}, CHECK_INTERVAL * 1000);

// ─── Graceful shutdown ─────────────────────────
function gracefulShutdown(signal) {
  log(`🛑 ${signal} received. Shutting down...`);
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (e) => { err(`Uncaught exception: ${e?.message || e}`); });
process.on('unhandledRejection', (e) => { err(`Unhandled rejection: ${e?.message || e}`); });

// ─── Start ─────────────────────────────────────
initBackupDB();
loadOrGenerateRSA();

app.listen(NODE_PORT, async () => {
  log('');
  log('╔════════════════════════════════════════════════╗');
  log('║      CHOCOHUB RAILWAY NODE (merged)            ║');
  log('╠════════════════════════════════════════════════╣');
  log(`║  Name     : ${NODE_NAME}`);
  log(`║  Port     : ${NODE_PORT}`);
  log(`║  URL      : ${PUBLIC_URL || 'not set'}`);
  log(`║  Master   : ${MASTER_NODE_URL}`);
  log('╚════════════════════════════════════════════════╝');
  log('');

  await registerWithMaster();
  await registerBackupWithMaster();
  setInterval(sendHeartbeat, 30000);
});
