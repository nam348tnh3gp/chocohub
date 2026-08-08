require('dotenv').config();
const os = require('os');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('better-sqlite3');
const { spawn } = require('child_process');
const DHExchange = require('./dh');
const WebSocket = require('ws');           // ← Thêm
const net = require('net');               // ← Thêm

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const err = (msg) => console.error(`[${new Date().toISOString()}] ${msg}`);

// ─── Config ───────────────────────────────────────
const NODE_PORT = parseInt(process.env.NODE_PORT) || 3002;
const WS_PORT = parseInt(process.env.WS_PORT) || 3003;          // ← Thêm
const TCP_PORT = parseInt(process.env.TCP_PORT) || 3004;        // ← Thêm
const MASTER_NODE_URL = (process.env.MASTER_NODE_URL || '').replace(/\/+$/, '');
const NODE_NAME = (process.env.NODE_NAME || 'ChocoHub Node').substring(0, 100);
const NODE_OWNER = (process.env.NODE_OWNER || '').substring(0, 100);
const NODE_LOCATION = (process.env.NODE_LOCATION || '').substring(0, 100);
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || '';
const BOT_BACKUP_TOKEN = process.env.BOT_BACKUP_TOKEN || '';
const DB_PATH = path.join(__dirname, process.env.BACKUP_DB_PATH || 'backup_node.db');
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '10', 10);
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '3', 10);
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT || '10000', 10);

const IS_TRUSTED_NODE = (process.env.TRUSTED_NODE || 'false') === 'true';
const TRUSTED_TOKEN = process.env.TRUSTED_TOKEN || '';
const TRUSTED_SYNC_INTERVAL = parseInt(process.env.TRUSTED_SYNC_INTERVAL || '90', 10);
const TRUSTED_LEDGER_SYNC_EVERY_N_CYCLES = parseInt(process.env.TRUSTED_LEDGER_SYNC_EVERY_N_CYCLES || '10', 10);
const TRUSTED_SYNC_PAGE = parseInt(process.env.TRUSTED_SYNC_PAGE || '1000', 10);
const JOB_CACHE_SIZE = parseInt(process.env.JOB_CACHE_SIZE || '20', 10);
const SUBMISSION_RETRY_INTERVAL = parseInt(process.env.SUBMISSION_RETRY_INTERVAL || '5', 10);
const MASTER_TOKEN = process.env.NODE_MASTER_TOKEN || '';

const app = express();
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '5000mb' }));

let nodeAuthToken = null;
let nodeId = null;
let connectedMiners = 0;
let lastBlockHeight = 0;
const activeWorkers = new Map();
const WORKER_TIMEOUT = parseInt(process.env.WORKER_TIMEOUT || '300000', 10);
let lastTrustedSyncAt = null;

function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(k => `"${k}":${canonicalStringify(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

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

  backupDb.exec(`
    CREATE TABLE IF NOT EXISTS trusted_chain (
      height INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      miner TEXT,
      node_id TEXT,
      nonce TEXT,
      timestamp TEXT,
      difficulty REAL,
      job_id TEXT,
      signature TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  backupDb.exec(`CREATE INDEX IF NOT EXISTS idx_trusted_chain_hash ON trusted_chain(hash)`);

  backupDb.exec(`
    CREATE TABLE IF NOT EXISTS job_cache (
      job_id TEXT PRIMARY KEY,
      tier TEXT,
      difficulty REAL,
      payload TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  backupDb.exec(`
    CREATE TABLE IF NOT EXISTS pending_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      body TEXT NOT NULL,
      attempts INTEGER DEFAULT 0,
      last_error TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  backupDb.exec(`
    CREATE TABLE IF NOT EXISTS chain_blocks (
      height INTEGER PRIMARY KEY,
      hash TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      miner TEXT,
      nonce TEXT,
      timestamp INTEGER,
      reward REAL,
      difficulty REAL,
      tx_count INTEGER DEFAULT 0,
      total_fees REAL DEFAULT 0,
      device_type TEXT DEFAULT 'unknown',
      synced_at TEXT DEFAULT (datetime('now'))
    )
  `);

  log('✅ Backup database ready');
}

const BOT_BACKUP_DIR = path.join(__dirname, process.env.BOT_BACKUP_DIR || 'backups');
const BOT_BACKUP_MAX_FILES = parseInt(process.env.BOT_BACKUP_MAX_FILES || '20', 10);
if (!fs.existsSync(BOT_BACKUP_DIR)) fs.mkdirSync(BOT_BACKUP_DIR, { recursive: true });

function botBackupPath(ts) {
  const safe = String(ts).replace(/:/g, '-').replace(/ /g, '_');
  return path.join(BOT_BACKUP_DIR, `backup_${safe}.json`);
}

function listBotBackupFiles() {
  return fs.readdirSync(BOT_BACKUP_DIR)
    .filter(f => f.startsWith('backup_') && f.endsWith('.json'))
    .sort()
    .reverse();
}

function pruneOldBotBackups() {
  const files = listBotBackupFiles();
  for (const old of files.slice(BOT_BACKUP_MAX_FILES)) {
    try { fs.unlinkSync(path.join(BOT_BACKUP_DIR, old)); } catch (e) {}
  }
}

function saveBotDataBackup(data) {
  const ts = data?.timestamp || new Date().toISOString();
  const filePath = botBackupPath(ts);
  const json = JSON.stringify(data);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, json);
  fs.renameSync(tmpPath, filePath);
  pruneOldBotBackups();
  const keyCount = Array.isArray(data?.api_keys) ? data.api_keys.length : 0;
  log(`🤖 Bot data backup saved: ${path.basename(filePath)} | api_keys=${keyCount} (${(json.length / 1024).toFixed(1)} KB)`);
  return { file: path.basename(filePath), api_keys: keyCount };
}

function getBotDataBackup() {
  try {
    const files = listBotBackupFiles();
    if (!files.length) return null;
    const filePath = path.join(BOT_BACKUP_DIR, files[0]);
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    err('Bot data backup read error:', e.message);
    return null;
  }
}

function trustedValidateChain(blocks = []) {
  if (!Array.isArray(blocks) || blocks.length === 0) return { ok: false, message: 'Empty chain' };
  const sorted = [...blocks].sort((a, b) => a.height - b.height);
  for (let i = 0; i < sorted.length; i++) {
    const block = sorted[i];
    if (typeof block.height !== 'number' || !block.hash || !block.prev_hash) {
      return { ok: false, message: `Invalid block at index ${i}` };
    }
    if (i > 0) {
      if (sorted[i].height !== sorted[i - 1].height + 1) return { ok: false, message: 'Height gap' };
      if (sorted[i].prev_hash !== sorted[i - 1].hash) return { ok: false, message: 'Prev hash mismatch' };
    }
  }
  return { ok: true, blocks: sorted };
}

function upsertTrustedBlocksLocal(blocks = []) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  const stmt = backupDb.prepare(`
    INSERT INTO trusted_chain (height, hash, prev_hash, miner, node_id, nonce, timestamp, difficulty, job_id, signature)
    VALUES (@height, @hash, @prev_hash, @miner, @node_id, @nonce, @timestamp, @difficulty, @job_id, @signature)
    ON CONFLICT(height) DO UPDATE SET
      hash=excluded.hash, prev_hash=excluded.prev_hash, miner=excluded.miner,
      node_id=excluded.node_id, nonce=excluded.nonce, timestamp=excluded.timestamp,
      difficulty=excluded.difficulty, job_id=excluded.job_id, signature=excluded.signature
  `);
  const tx = backupDb.transaction((rows) => {
    let count = 0;
    for (const b of rows) {
      stmt.run({
        height: b.height, hash: b.hash, prev_hash: b.prev_hash,
        miner: b.miner || null, node_id: b.node_id || null, nonce: b.nonce || null,
        timestamp: b.timestamp || null, difficulty: b.difficulty ?? null,
        job_id: b.job_id || null, signature: b.signature || ''
      });
      count++;
    }
    return count;
  });
  return tx(blocks);
}

function getTrustedChainLocal(limit = 1000, offset = 0) {
  return backupDb.prepare('SELECT * FROM trusted_chain ORDER BY height ASC LIMIT ? OFFSET ?').all(limit, offset);
}

function getTrustedTipLocal() {
  return backupDb.prepare('SELECT * FROM trusted_chain ORDER BY height DESC LIMIT 1').get();
}

function getTrustedChainCount() {
  const row = backupDb.prepare('SELECT COUNT(*) AS c FROM trusted_chain').get();
  return row ? row.c : 0;
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

function getSnapshotStorageBytes() {
  const row = backupDb.prepare('SELECT state FROM snapshot WHERE id = 1').get();
  return row && row.state ? Buffer.byteLength(row.state, 'utf8') : 0;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function getDiskStats() {
  try {
    const stats = fs.statfsSync(path.dirname(DB_PATH));
    const total = stats.blocks * stats.bsize;
    const free = stats.bfree * stats.bsize;
    return { totalBytes: total, freeBytes: free, usedBytes: total - free };
  } catch (e) {
    return { totalBytes: null, freeBytes: null, usedBytes: null };
  }
}

const RSA_PRIVATE_PATH = path.join(__dirname, process.env.RSA_PRIVATE_PATH || 'backup_private.pem');
const RSA_PUBLIC_PATH = path.join(__dirname, process.env.RSA_PUBLIC_PATH || 'backup_public.pem');
let serverPrivateKeyPem, serverPublicKeyPem;

function loadOrGenerateRSA() {
  if (fs.existsSync(RSA_PRIVATE_PATH) && fs.existsSync(RSA_PUBLIC_PATH)) {
    serverPrivateKeyPem = fs.readFileSync(RSA_PRIVATE_PATH, 'utf8');
    serverPublicKeyPem = fs.readFileSync(RSA_PUBLIC_PATH, 'utf8');
    log('🔑 Loaded existing RSA long-term keys');
  } else {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: parseInt(process.env.RSA_KEY_LENGTH || '4096', 10),
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

const serverDHKeys = DHExchange.generateStandardKeyPair(process.env.DH_GROUP || 'modp2048');
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

app.get('/api/backup/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), snapshot_time: getSnapshotTime() });
});

app.get('/api/backup/status', (req, res) => {
  const snap = getSnapshot();
  const users = snap ? (snap.users ? snap.users.length : 0) : 0;
  const storageBytes = getSnapshotStorageBytes();
  const disk = getDiskStats();

  res.json({
    status: 'ok',
    total_users: users,
    users: users,
    snapshot_time: getSnapshotTime(),
    main_server: MASTER_NODE_URL,
    max_backups: MAX_BACKUPS,
    storage: {
      used_bytes: storageBytes,
      used_human: formatBytes(storageBytes),
      disk_total_bytes: disk.totalBytes,
      disk_total_human: disk.totalBytes !== null ? formatBytes(disk.totalBytes) : 'unknown',
      disk_free_bytes: disk.freeBytes,
      disk_free_human: disk.freeBytes !== null ? formatBytes(disk.freeBytes) : 'unknown',
      summary: `${formatBytes(storageBytes)} / ${disk.totalBytes !== null ? formatBytes(disk.totalBytes) : 'unknown'}`
    }
  });
});

app.get('/api/backup/history', (req, res) => {
  const rows = backupDb.prepare(
    'SELECT id, users_count, total_items, created_at FROM snapshot_backups ORDER BY created_at DESC LIMIT 10'
  ).all();
  res.json({ status: 'success', history: rows, max_backups: MAX_BACKUPS });
});

app.post('/api/backup/bot-data', (req, res) => {
  const token = req.headers['x-backup-token'];
  if (token !== BOT_BACKUP_TOKEN) {
    return res.status(401).json({ status: 'error', message: 'Invalid token' });
  }
  const data = req.body?.data;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ status: 'error', message: 'Missing data' });
  }
  try {
    saveBotDataBackup(data);
    res.json({ status: 'success', message: 'Bot data backed up', timestamp: data.timestamp || new Date().toISOString() });
  } catch (e) {
    err('Bot data backup error:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/api/backup/bot-data/latest', (req, res) => {
  const token = req.headers['x-backup-token'];
  if (token !== BOT_BACKUP_TOKEN) {
    return res.status(401).json({ status: 'error', message: 'Invalid token' });
  }
  const data = getBotDataBackup();
  if (!data) {
    return res.status(404).json({ status: 'error', message: 'No bot data backup available' });
  }
  res.json(data);
});

app.post('/backup/push', (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'empty body' });
  }
  try {
    const result = saveBotDataBackup(data);
    res.json({ ok: true, file: result.file, api_keys: result.api_keys });
  } catch (e) {
    err('Bot data push error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/backup/latest', (req, res) => {
  const data = getBotDataBackup();
  if (!data) return res.status(404).json({ error: 'no backup found' });
  res.json(data);
});

app.all('/backup/pull', (req, res) => {
  const data = getBotDataBackup();
  if (!data) return res.json({ ok: true, message: 'no backup yet' });
  res.json(data);
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

app.get('/api/trusted/chain', (req, res) => {
  try {
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit) || 1000));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const blocks = getTrustedChainLocal(limit, offset);
    const tip = getTrustedTipLocal();
    res.json({ status: 'success', blocks, tip, total: blocks.length, source: 'local' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/trusted/sync', (req, res) => {
  try {
    const token = req.body?.token || req.headers['x-trusted-token'];
    if (token !== TRUSTED_TOKEN) {
      return res.status(401).json({ status: 'error', message: 'Invalid trusted token' });
    }
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const check = trustedValidateChain(blocks);
    if (!check.ok) {
      return res.status(400).json({ status: 'error', message: check.message });
    }
    const imported = upsertTrustedBlocksLocal(check.blocks);
    const tip = getTrustedTipLocal();
    log(`🔗 Trusted sync received: ${imported} blocks imported, tip height ${tip ? tip.height : 'n/a'}`);
    res.json({ status: 'success', imported, tip, received: blocks.length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/trusted/restore', async (req, res) => {
  try {
    const token = req.body?.token || req.headers['x-trusted-token'];
    if (token !== TRUSTED_TOKEN) {
      return res.status(401).json({ status: 'error', message: 'Invalid trusted token' });
    }
    const result = await restoreTrustedChainFromMaster({ full: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/api/trusted/status', (req, res) => {
  const tip = getTrustedTipLocal();
  const chainTip = getChainTip();
  res.json({
    status: 'success',
    trusted_node: IS_TRUSTED_NODE,
    local_tip: tip || null,
    local_count: getTrustedChainCount(),
    real_chain_tip: chainTip || null,
    real_chain_count: getChainCount(),
    pending_submissions: backupDb.prepare('SELECT COUNT(*) AS c FROM pending_submissions').get().c,
    cached_jobs: backupDb.prepare('SELECT COUNT(*) AS c FROM job_cache').get().c,
    last_sync: lastTrustedSyncAt
  });
});

app.get('/api/chain/blocks', (req, res) => {
  try {
    const since = Math.max(0, parseInt(req.query.since) || 0);
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit) || 5000));
    const blocks = since > 0
      ? backupDb.prepare('SELECT * FROM chain_blocks WHERE height > ? ORDER BY height ASC LIMIT ?').all(since, limit)
      : backupDb.prepare('SELECT * FROM chain_blocks ORDER BY height ASC LIMIT ?').all(limit);
    res.json({ status: 'success', blocks, last_block: getChainTip(), total: getChainCount() });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/chain/restore', async (req, res) => {
  try {
    const token = req.body?.token || req.headers['x-trusted-token'];
    if (token !== TRUSTED_TOKEN) {
      return res.status(401).json({ status: 'error', message: 'Invalid trusted token' });
    }
    const result = await restoreChainFromMaster({ full: true });
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/api/server/public-key', (req, res) => {
  res.json({
    status: 'success',
    publicKey: serverPublicKeyPem,
    algorithm: `RSA-${parseInt(process.env.RSA_KEY_LENGTH || '4096', 10)}`,
    purpose: 'DH server authentication'
  });
});

app.get('/node/performance/stats', (req, res) => {
  const now = Date.now();
  const currentUsage = process.cpuUsage();
  const userDelta = currentUsage.user - lastCpuUsage.user;
  const sysDelta = currentUsage.system - lastCpuUsage.system;
  const timeDelta = now - lastCpuTime;
  const cpuPercent = timeDelta > 0 ? Math.min(((userDelta + sysDelta) / (timeDelta * 1000)) * 100, 100) : 0;
  const totalWorkers = activeWorkers.size;
  const totalMemUsage = process.memoryUsage().heapUsed / Math.pow(1024, 2);
  const totalMem = os.totalmem() / Math.pow(1024, 3);
  const totalfreeram = os.freemem() / Math.pow(1024, 3);
  const totalthreads = os.cpus().length;
  const uptime = process.uptime();
  res.json({
    status: 'ok',
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    totalMemUsageMB: Number(totalMemUsage.toFixed(1)),
    totalMemGB: Number(totalMem.toFixed(2)),
    totalFreeRamGB: Number(totalfreeram.toFixed(2)),
    totalThreads: totalthreads,
    uptimeSeconds: Math.round(uptime),
    activeWorkers: totalWorkers
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

let registering = false;
async function registerWithMaster() {
  registering = true;
  const nodeUrl = PUBLIC_URL || `http://localhost:${NODE_PORT}`;
  const masterToken = MASTER_TOKEN;
  if (!masterToken) {
    err('⚠️ NODE_MASTER_TOKEN not set in environment');
    registering = false;
    return;
  }
  try {
    const resp = await fetchWithTimeout(`${MASTER_NODE_URL}/api/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: NODE_NAME, url: nodeUrl, token: masterToken, owner: NODE_OWNER, location: NODE_LOCATION, trusted: IS_TRUSTED_NODE })
    });
    const data = await resp.json();
    if (data.status === 'success') {
      nodeAuthToken = data.auth_token;
      nodeId = data.id;
      registering = false;
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

function triggerReregister(reason) {
  if (registering) return;
  log(`🔄 Re-registering with master (reason: ${reason})`);
  nodeAuthToken = null;
  registerWithMaster();
}

async function registerBackupWithMaster() {
  const selfUrl = PUBLIC_URL || `http://localhost:${NODE_PORT}`;
  if (!BACKUP_TOKEN) {
    err('⚠️ BACKUP_TOKEN not set in environment');
    return;
  }
  try {
    const resp = await fetch(`${MASTER_NODE_URL}/api/backup/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: canonicalStringify({ url: selfUrl, token: BACKUP_TOKEN, name: NODE_NAME, platform: 'Node.js' })
    });
    if (resp.ok) {
      log(`📡 Registered as backup node: ${selfUrl}`);
    } else {
      err('Backup registration failed:', resp.status);
      setTimeout(registerBackupWithMaster, 5000);
    }
  } catch (e) {
    err('Backup registration error:', e.message);
    setTimeout(registerBackupWithMaster, 5000);
  }
}

async function proxyToMaster(endpoint, body) {
  if (!nodeAuthToken) throw new Error('Not registered with master');
  let resp;
  try {
    resp = await fetchWithTimeout(`${MASTER_NODE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${nodeAuthToken}` },
      body: JSON.stringify(body)
    });
  } catch (netErr) {
    netErr.isNetworkError = true;
    throw netErr;
  }

  let data;
  try {
    data = await resp.json();
  } catch (parseErr) {
    const wrapped = new Error(`Master returned non-JSON response (HTTP ${resp.status})`);
    wrapped.isUpstreamRejection = true;
    wrapped.status = resp.status;
    wrapped.data = { status: 'error', message: `Upstream HTTP ${resp.status}` };
    throw wrapped;
  }

  if (!resp.ok) {
    const appErr = new Error(data.message || `HTTP ${resp.status}`);
    appErr.isUpstreamRejection = true;
    appErr.status = resp.status;
    appErr.data = data;
    throw appErr;
  }
  return data;
}

async function restoreTrustedChainFromMaster({ full = false } = {}) {
  const localTip = getTrustedTipLocal();
  let offset = full ? 0 : Math.max(0, getTrustedChainCount());
  let totalImported = 0;
  let page = 0;
  try {
    while (true) {
      const resp = await fetchWithTimeout(
        `${MASTER_NODE_URL}/api/trusted/chain?limit=${TRUSTED_SYNC_PAGE}&offset=${offset}`,
        { method: 'GET' }
      );
      if (!resp.ok) throw new Error(`Master returned HTTP ${resp.status}`);
      const data = await resp.json();
      const blocks = Array.isArray(data.blocks) ? data.blocks : [];
      if (blocks.length === 0) break;

      const check = trustedValidateChain(blocks);
      if (!check.ok) {
        err(`Trusted chain page rejected (offset ${offset}): ${check.message}`);
        break;
      }
      const imported = upsertTrustedBlocksLocal(check.blocks);
      totalImported += imported;
      offset += blocks.length;
      page++;
      if (blocks.length < TRUSTED_SYNC_PAGE) break;
      if (page > 500) break;
    }
    lastTrustedSyncAt = new Date().toISOString();
    const newTip = getTrustedTipLocal();
    if (newTip && newTip.height > lastBlockHeight) lastBlockHeight = newTip.height;
    log(`🔄 Trusted chain restore: +${totalImported} blocks, local tip ${newTip ? newTip.height : (localTip ? localTip.height : 'n/a')}`);
    return { status: 'success', imported: totalImported, tip: newTip };
  } catch (e) {
    err('Trusted chain restore failed:', e.message);
    return { status: 'error', message: e.message, imported: totalImported };
  }
}

async function pushTrustedChainToMaster() {
  const localTip = getTrustedTipLocal();
  if (!localTip) return;
  try {
    const resp = await fetchWithTimeout(`${MASTER_NODE_URL}/api/trusted/chain?limit=1&offset=0`, { method: 'GET' });
    if (!resp.ok) return;
    const data = await resp.json();
    const masterTip = data.tip;
    if (masterTip && masterTip.height >= localTip.height) return;

    const fromHeight = masterTip ? masterTip.height + 1 : 0;
    const blocks = backupDb.prepare('SELECT * FROM trusted_chain WHERE height >= ? ORDER BY height ASC LIMIT ?')
      .all(fromHeight, TRUSTED_SYNC_PAGE);
    if (blocks.length === 0) return;

    const pushResp = await fetchWithTimeout(`${MASTER_NODE_URL}/api/trusted/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Trusted-Token': TRUSTED_TOKEN },
      body: JSON.stringify({ token: TRUSTED_TOKEN, blocks })
    });
    if (pushResp.ok) {
      const result = await pushResp.json();
      log(`📤 Pushed ${blocks.length} blocks to master trusted chain (imported: ${result.imported})`);
    } else {
      err(`Push trusted chain failed: HTTP ${pushResp.status}`);
    }
  } catch (e) {
    err('Push trusted chain error:', e.message);
  }
}

let trustedSyncCycleCount = 0;
async function trustedSyncCycle() {
  await restoreChainFromMaster({ full: false });
  trustedSyncCycleCount++;
  if (trustedSyncCycleCount % TRUSTED_LEDGER_SYNC_EVERY_N_CYCLES === 0) {
    await restoreTrustedChainFromMaster({ full: false });
    await pushTrustedChainToMaster();
  }
}

function cacheJob(job) {
  if (!job || !job.job_id) return;
  try {
    backupDb.prepare(`
      INSERT OR REPLACE INTO job_cache (job_id, tier, difficulty, payload, created_at)
      VALUES (?, ?, ?, ?, datetime('now'))
    `).run(job.job_id, job.tier || null, job.difficulty ?? null, JSON.stringify(job));
    backupDb.prepare(`
      DELETE FROM job_cache WHERE job_id NOT IN (
        SELECT job_id FROM job_cache ORDER BY created_at DESC LIMIT ?
      )
    `).run(JOB_CACHE_SIZE);
  } catch (e) {
    err('cacheJob error:', e.message);
  }
}

function getCachedJob(tier) {
  const row = tier
    ? backupDb.prepare('SELECT * FROM job_cache WHERE tier = ? ORDER BY created_at DESC LIMIT 1').get(tier)
    : backupDb.prepare('SELECT * FROM job_cache ORDER BY created_at DESC LIMIT 1').get();
  if (!row) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

function queueSubmission(body) {
  backupDb.prepare('INSERT INTO pending_submissions (body) VALUES (?)').run(JSON.stringify(body));
}

async function retryPendingSubmissions() {
  if (!nodeAuthToken) return;
  const rows = backupDb.prepare('SELECT * FROM pending_submissions ORDER BY id ASC LIMIT 20').all();
  for (const row of rows) {
    try {
      const body = JSON.parse(row.body);
      const result = await proxyToMaster('/api/nodes/submit_solution', body);
      backupDb.prepare('DELETE FROM pending_submissions WHERE id = ?').run(row.id);
      log(`📮 Replayed queued submission #${row.id}: ${result?.status || 'ok'}`);
    } catch (e) {
      if (e.isUpstreamRejection && e.status !== 429) {
        backupDb.prepare('DELETE FROM pending_submissions WHERE id = ?').run(row.id);
        log(`🗑️ Dropping queued submission #${row.id}: rejected by master (${e.message})`);
        continue;
      }
      backupDb.prepare('UPDATE pending_submissions SET attempts = attempts + 1, last_error = ? WHERE id = ?')
        .run(e.message, row.id);
      if (row.attempts + 1 >= 20) {
        backupDb.prepare('DELETE FROM pending_submissions WHERE id = ?').run(row.id);
        err(`Dropping queued submission #${row.id} after ${row.attempts + 1} failed connectivity attempts`);
      }
    }
  }
}

function getCachedJobById(jobId) {
  if (!jobId) return null;
  const row = backupDb.prepare('SELECT * FROM job_cache WHERE job_id = ?').get(jobId);
  if (!row) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

function localValidatePow({ bounty_id, nonce, worker_name, instance_id }) {
  if (bounty_id === undefined || nonce === undefined || !worker_name) return { verdict: 'unknown' };
  const parsedNonce = parseInt(nonce, 10);
  if (isNaN(parsedNonce) || parsedNonce < 0) return { verdict: 'invalid', hashHex: null, reason: 'Invalid nonce' };

  const job = getCachedJobById(bounty_id);
  if (!job || !job.prev_hash || !job.target_hex) return { verdict: 'unknown' };

  const cleanWorker = String(worker_name).trim().substring(0, 100);
  const cleanInstance = String(instance_id || 'default').trim().substring(0, 50);
  const diffKey = cleanInstance ? `${cleanWorker}:${cleanInstance}` : cleanWorker;

  const input = job.prev_hash + String(parsedNonce).padStart(20, '0') + diffKey;
  const hashHex = crypto.createHash('sha256').update(input).digest('hex');
  const valid = hashHex < job.target_hex;
  return { verdict: valid ? 'valid' : 'invalid', hashHex, target_hex: job.target_hex };
}

function getChainCount() {
  const row = backupDb.prepare('SELECT COUNT(*) AS c FROM chain_blocks').get();
  return row ? row.c : 0;
}

function getChainTip() {
  return backupDb.prepare('SELECT * FROM chain_blocks ORDER BY height DESC LIMIT 1').get();
}

function upsertChainBlocksLocal(blocks = []) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  const stmt = backupDb.prepare(`
    INSERT INTO chain_blocks (height, hash, prev_hash, miner, nonce, timestamp, reward, difficulty, tx_count, total_fees, device_type)
    VALUES (@height, @hash, @prev_hash, @miner, @nonce, @timestamp, @reward, @difficulty, @tx_count, @total_fees, @device_type)
    ON CONFLICT(height) DO UPDATE SET
      hash=excluded.hash, prev_hash=excluded.prev_hash, miner=excluded.miner, nonce=excluded.nonce,
      timestamp=excluded.timestamp, reward=excluded.reward, difficulty=excluded.difficulty,
      tx_count=excluded.tx_count, total_fees=excluded.total_fees, device_type=excluded.device_type
  `);
  const tx = backupDb.transaction((rows) => {
    let count = 0;
    for (const b of rows) {
      stmt.run({
        height: b.height, hash: b.hash, prev_hash: b.prev_hash,
        miner: b.miner || null, nonce: b.nonce || null, timestamp: b.timestamp ?? null,
        reward: b.reward ?? null, difficulty: b.difficulty ?? null,
        tx_count: b.tx_count || 0, total_fees: b.total_fees || 0, device_type: b.device_type || 'unknown'
      });
      count++;
    }
    return count;
  });
  return tx(blocks);
}

async function restoreChainFromMaster({ full = false } = {}) {
  if (!nodeAuthToken) return { status: 'error', message: 'Not registered with master yet' };
  let since = full ? 0 : (getChainTip()?.height ?? -1) + 0;
  if (!full) {
    const tip = getChainTip();
    since = tip ? tip.height : 0;
  }
  let totalImported = 0;
  let guard = 0;
  try {
    while (true) {
      const resp = await fetchWithTimeout(
        `${MASTER_NODE_URL}/api/nodes/sync-blocks?since=${since}&limit=5000`,
        { method: 'GET', headers: { 'Authorization': `Bearer ${nodeAuthToken}` } }
      );
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.message || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const blocks = Array.isArray(data.blocks) ? data.blocks : [];
      if (blocks.length === 0) break;
      totalImported += upsertChainBlocksLocal(blocks);
      since = blocks[blocks.length - 1].height;
      guard++;
      if (blocks.length < 5000) break;
      if (guard > 500) break;
    }
    const tip = getChainTip();
    if (tip && tip.height > lastBlockHeight) lastBlockHeight = tip.height;
    log(`⛓️ Chain restore: +${totalImported} blocks, local tip ${tip ? tip.height : 'n/a'}`);
    return { status: 'success', imported: totalImported, tip };
  } catch (e) {
    err('Chain restore failed:', e.message);
    return { status: 'error', message: e.message, imported: totalImported };
  }
}

// ─── Heartbeat ──────────────────────────────────
let lastCpuUsage = process.cpuUsage();
let lastCpuTime = Date.now();

async function sendHeartbeat() {
  if (!nodeAuthToken) return;
  try {
    const now = Date.now();

    const currentUsage = process.cpuUsage();
    const userDelta = currentUsage.user - lastCpuUsage.user;
    const sysDelta = currentUsage.system - lastCpuUsage.system;
    const timeDelta = now - lastCpuTime;
    const cpuPercent = timeDelta > 0 ? Math.min(((userDelta + sysDelta) / (timeDelta * 1000)) * 100, 100) : 0;
    lastCpuUsage = currentUsage;
    lastCpuTime = now;

    const processMemUsageMB = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);

    const totalMem = os.totalmem() / Math.pow(1024, 3);
    const freeMem = os.freemem() / Math.pow(1024, 3);
    const usedMem = totalMem - freeMem;

    const totalMem_fixed = totalMem.toFixed(2);
    const totalfreeram_fixed = freeMem.toFixed(2);
    const usedMem_fixed = usedMem.toFixed(2);
    const totalMemUsage_fixed = processMemUsageMB;

    const totalWorkers = activeWorkers.size;
    const totalthreads = os.cpus().length;
    const uptime = process.uptime();

    console.log(
      `⛏️ Workers: ${totalWorkers} | CPU: ${cpuPercent.toFixed(1)}% | Threads: ${totalthreads} | Node RAM: ${processMemUsageMB} MB | Sys RAM: ${usedMem_fixed} GB / ${totalMem_fixed} GB | Uptime: ${uptime.toFixed(1)}s`
    );

    for (const [worker, lastSeen] of activeWorkers) {
      if (now - lastSeen > WORKER_TIMEOUT) activeWorkers.delete(worker);
    }

    const workerCount = activeWorkers.size;
    const effectiveMiners = Math.max(connectedMiners, workerCount);

    const resp = await fetchWithTimeout(`${MASTER_NODE_URL}/api/nodes/heartbeat`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Authorization': `Bearer ${nodeAuthToken}` 
      },
      body: JSON.stringify({
        connected_miners: effectiveMiners,
        cpu_load: Math.round(cpuPercent * 10) / 10,
        uptime_seconds: Math.round(uptime),
        totalmem_fixed: totalMem_fixed,
        totalfreeram_fixed: totalfreeram_fixed,
        totalthreads: totalthreads,
        totalMemUsage_fixed: totalMemUsage_fixed,
        ping_ms: 0,
        blockchain_height: lastBlockHeight
      })
    });

    if (resp.status === 401 || resp.status === 403) {
      triggerReregister('heartbeat unauthorized');
      return;
    }
    if (!resp.ok) {
      err(`Heartbeat failed: HTTP ${resp.status}`);
    }
  } catch (e) {
    err(`Heartbeat error: ${e.message}`);
  }
}

const rateLimits = {};
function rateLimit(key, maxPerMinute) {
  const now = Date.now();
  if (!rateLimits[key]) rateLimits[key] = [];
  rateLimits[key] = rateLimits[key].filter(t => now - t < 60000);
  if (rateLimits[key].length >= maxPerMinute) return false;
  rateLimits[key].push(now);
  return true;
}

app.get('/ping', (req, res) => {
  res.json({ pong: true, time: Date.now(), node: NODE_NAME, miners: connectedMiners, url: PUBLIC_URL, blockchain_height: lastBlockHeight });
});

app.get('/status', (req, res) => {
  res.json({ status: nodeAuthToken ? 'online' : 'registering', name: NODE_NAME, location: NODE_LOCATION, public_url: PUBLIC_URL, connected_miners: connectedMiners, master_server: MASTER_NODE_URL });
});

app.post('/get_job', async (req, res) => {
  if (!rateLimit('get_job', parseInt(process.env.GET_JOB_RATE_LIMIT || '120', 10))) {
    return res.status(429).json({ status: 'error', message: 'Rate limit exceeded' });
  }
  try {
    const worker = (req.body?.worker_name || 'unknown').substring(0, 16);
    activeWorkers.set(worker, Date.now());
    const result = await proxyToMaster('/api/nodes/get_job', req.body);
    if (result && result.height && result.height > lastBlockHeight) {
      lastBlockHeight = result.height;
    }
    if (result && result.job_id) cacheJob(result);
    log(`📦 Job for ${worker}`);
    res.json(result);
  } catch (e) {
    if (e.isUpstreamRejection && e.status !== 429) {
      if (e.status === 401 || e.status === 403) triggerReregister('get_job unauthorized');
      err(`get_job rejected by master: ${e.message}`);
      return res.status(e.status || 502).json(e.data || { status: 'error', message: e.message });
    }
    err('get_job transient error:', e.message);
    const cached = getCachedJob(req.body?.tier);
    if (cached) {
      log(`📦 Serving cached job to ${req.body?.worker_name || 'unknown'} (${e.status === 429 ? 'rate limited' : 'master unreachable'})`);
      return res.json(Object.assign({}, cached, { served_from_cache: true }));
    }
    res.status(e.status === 429 ? 429 : 502).json({ status: 'error', message: e.status === 429 ? 'Rate limit exceeded' : 'Upstream error' });
  }
});

app.post('/submit_solution', async (req, res) => {
  if (!rateLimit('submit', parseInt(process.env.SUBMIT_RATE_LIMIT || '60', 10))) {
    return res.status(429).json({ status: 'error', message: 'Rate limit exceeded' });
  }
  const worker = (req.body?.worker_name || 'unknown').substring(0, 16);

  const check = localValidatePow(req.body || {});
  if (check.verdict === 'invalid') {
    log(`🚫 Local PoW check failed for ${worker} (hash ${check.hashHex?.substring(0, 12)}... >= target)`);
    return res.status(400).json({ status: 'error', reason: `Invalid nonce: hash ${check.hashHex?.substring(0, 12)}... >= target`, verified_locally: true });
  }

  try {
    const result = await proxyToMaster('/api/nodes/submit_solution', req.body);
    if (result && result.status === 'success') {
      if (result.block_height || (result.message && result.message.match(/Block (\d+)/))) {
        const match = result.message ? result.message.match(/Block (\d+)/) : null;
        const height = result.block_height || (match ? parseInt(match[1]) : 0);
        if (height > lastBlockHeight) lastBlockHeight = height;
      }
    }
    log(`${result?.status === 'success' ? '✅ Accepted' : '❌ Rejected'} - ${worker}${check.verdict === 'valid' ? ' (PoW pre-verified locally)' : ''}`);
    res.json(result);
  } catch (e) {
    if (e.isUpstreamRejection && e.status !== 429) {
      if (e.status === 401 || e.status === 403) triggerReregister('submit_solution unauthorized');
      log(`❌ Rejected by master - ${worker}: ${e.message}`);
      return res.status(e.status || 400).json(e.data || { status: 'error', message: e.message });
    }
    err('submit_solution transient error:', e.message);
    queueSubmission(req.body);
    res.status(202).json({ status: 'queued', message: 'Master unreachable or rate-limited, solution queued locally and will be retried', verified_locally: check.verdict === 'valid' });
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
      const clientDH = DHExchange.generateStandardKeyPair(process.env.DH_GROUP || 'modp2048');
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

// ─── WebSocket Server ──────────────────────────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws) => {
  const clientId = `ws-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  log(`🔌 WebSocket client connected: ${clientId}`);

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.type) {
        ws.send(JSON.stringify({ status: 'error', message: 'Missing type' }));
        return;
      }

      switch (msg.type) {
        case 'get_job': {
          if (!rateLimit(`ws_get_job_${clientId}`, 120)) {
            ws.send(JSON.stringify({ status: 'error', message: 'Rate limited' }));
            break;
          }
          const worker = (msg.worker_name || 'unknown').substring(0, 16);
          activeWorkers.set(worker, Date.now());
          try {
            const result = await proxyToMaster('/api/nodes/get_job', msg);
            if (result && result.job_id) cacheJob(result);
            ws.send(JSON.stringify({ status: 'success', data: result }));
          } catch (e) {
            if (e.status === 401 || e.status === 403) triggerReregister('ws_get_job');
            const cached = getCachedJob(msg.tier);
            if (cached) {
              ws.send(JSON.stringify({ status: 'success', data: { ...cached, served_from_cache: true } }));
            } else {
              ws.send(JSON.stringify({ status: 'error', message: e.message || 'Upstream error' }));
            }
          }
          break;
        }

        case 'submit_solution': {
          if (!rateLimit(`ws_submit_${clientId}`, 60)) {
            ws.send(JSON.stringify({ status: 'error', message: 'Rate limited' }));
            break;
          }
          const worker = (msg.worker_name || 'unknown').substring(0, 16);
          const check = localValidatePow(msg);
          if (check.verdict === 'invalid') {
            ws.send(JSON.stringify({ status: 'error', reason: 'Invalid nonce', verified_locally: true }));
            break;
          }
          try {
            const result = await proxyToMaster('/api/nodes/submit_solution', msg);
            ws.send(JSON.stringify({ status: 'success', data: result }));
          } catch (e) {
            if (e.status === 401 || e.status === 403) triggerReregister('ws_submit');
            queueSubmission(msg);
            ws.send(JSON.stringify({ status: 'queued', message: 'Submitted and queued' }));
          }
          break;
        }

        case 'heartbeat': {
          ws.send(JSON.stringify({ status: 'ok', time: Date.now() }));
          break;
        }

        case 'ping': {
          ws.send(JSON.stringify({ pong: true, time: Date.now() }));
          break;
        }

        default: {
          ws.send(JSON.stringify({ status: 'error', message: `Unknown type: ${msg.type}` }));
        }
      }
    } catch (e) {
      err(`WebSocket error from ${clientId}:`, e.message);
      ws.send(JSON.stringify({ status: 'error', message: 'Invalid JSON' }));
    }
  });

  ws.on('close', () => {
    log(`🔌 WebSocket client disconnected: ${clientId}`);
  });

  ws.on('error', (e) => {
    err(`WebSocket error ${clientId}:`, e.message);
  });
});

log(`📡 WebSocket server listening on port ${WS_PORT}`);

// ─── TCP Server ──────────────────────────────────────────────────
const tcpServer = net.createServer((socket) => {
  const clientId = `tcp-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
  log(`🔌 TCP client connected: ${clientId}`);

  let buffer = '';

  socket.on('data', async (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (!msg.type) {
          socket.write(JSON.stringify({ status: 'error', message: 'Missing type' }) + '\n');
          continue;
        }

        switch (msg.type) {
          case 'get_job': {
            if (!rateLimit(`tcp_get_job_${clientId}`, 120)) {
              socket.write(JSON.stringify({ status: 'error', message: 'Rate limited' }) + '\n');
              break;
            }
            const worker = (msg.worker_name || 'unknown').substring(0, 16);
            activeWorkers.set(worker, Date.now());
            try {
              const result = await proxyToMaster('/api/nodes/get_job', msg);
              if (result && result.job_id) cacheJob(result);
              socket.write(JSON.stringify({ status: 'success', data: result }) + '\n');
            } catch (e) {
              if (e.status === 401 || e.status === 403) triggerReregister('tcp_get_job');
              const cached = getCachedJob(msg.tier);
              if (cached) {
                socket.write(JSON.stringify({ status: 'success', data: { ...cached, served_from_cache: true } }) + '\n');
              } else {
                socket.write(JSON.stringify({ status: 'error', message: e.message || 'Upstream error' }) + '\n');
              }
            }
            break;
          }

          case 'submit_solution': {
            if (!rateLimit(`tcp_submit_${clientId}`, 60)) {
              socket.write(JSON.stringify({ status: 'error', message: 'Rate limited' }) + '\n');
              break;
            }
            const worker = (msg.worker_name || 'unknown').substring(0, 16);
            const check = localValidatePow(msg);
            if (check.verdict === 'invalid') {
              socket.write(JSON.stringify({ status: 'error', reason: 'Invalid nonce', verified_locally: true }) + '\n');
              break;
            }
            try {
              const result = await proxyToMaster('/api/nodes/submit_solution', msg);
              socket.write(JSON.stringify({ status: 'success', data: result }) + '\n');
            } catch (e) {
              if (e.status === 401 || e.status === 403) triggerReregister('tcp_submit');
              queueSubmission(msg);
              socket.write(JSON.stringify({ status: 'queued', message: 'Submitted and queued' }) + '\n');
            }
            break;
          }

          case 'heartbeat': {
            socket.write(JSON.stringify({ status: 'ok', time: Date.now() }) + '\n');
            break;
          }

          case 'ping': {
            socket.write(JSON.stringify({ pong: true, time: Date.now() }) + '\n');
            break;
          }

          default: {
            socket.write(JSON.stringify({ status: 'error', message: `Unknown type: ${msg.type}` }) + '\n');
          }
        }
      } catch (e) {
        err(`TCP parse error from ${clientId}:`, e.message);
        socket.write(JSON.stringify({ status: 'error', message: 'Invalid JSON' }) + '\n');
      }
    }
  });

  socket.on('close', () => {
    log(`🔌 TCP client disconnected: ${clientId}`);
  });

  socket.on('error', (e) => {
    err(`TCP error ${clientId}:`, e.message);
  });
});

tcpServer.listen(TCP_PORT, () => {
  log(`🔌 TCP server listening on port ${TCP_PORT}`);
});

function gracefulShutdown(signal) {
  log(`🛑 ${signal} received. Shutting down...`);
  wss.close(() => {});
  tcpServer.close(() => {});
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (e) => { err(`Uncaught exception: ${e?.message || e}`); });
process.on('unhandledRejection', (e) => { err(`Unhandled rejection: ${e?.message || e}`); });

initBackupDB();
loadOrGenerateRSA();

app.listen(NODE_PORT, async () => {
  log('');
  log('╔════════════════════════════════════════════════╗');
  log('║      CHOCOHUB NODE                              ║');
  log('╠════════════════════════════════════════════════╣');
  log(`║  Name     : ${NODE_NAME}`);
  log(`║  Port     : ${NODE_PORT}`);
  log(`║  WS Port  : ${WS_PORT}`);
  log(`║  TCP Port : ${TCP_PORT}`);
  log(`║  URL      : ${PUBLIC_URL || 'not set'}`);
  log(`║  Master   : ${MASTER_NODE_URL || 'not set'}`);
  log(`║  Trusted  : ${IS_TRUSTED_NODE}`);
  log('╚════════════════════════════════════════════════╝');
  log('');

  if (!MASTER_NODE_URL) {
    err('⚠️ MASTER_NODE_URL not set in environment');
  }

  if (!MASTER_TOKEN) {
    err('⚠️ NODE_MASTER_TOKEN not set in environment');
  }

  await registerWithMaster();
  await registerBackupWithMaster();

  const localChainCount = getChainCount();
  if (localChainCount === 0) {
    log('📥 No local chain found — performing full restore from master...');
    await restoreChainFromMaster({ full: true });
  } else {
    log(`📚 Local chain has ${localChainCount} blocks — doing incremental sync...`);
    await restoreChainFromMaster({ full: false });
  }

  const localCount = getTrustedChainCount();
  if (localCount === 0) {
    await restoreTrustedChainFromMaster({ full: true });
  } else {
    await restoreTrustedChainFromMaster({ full: false });
  }

  setInterval(sendHeartbeat, 30000);
  setInterval(registerBackupWithMaster, 10 * 60 * 1000);
  setInterval(trustedSyncCycle, TRUSTED_SYNC_INTERVAL * 1000);
  setInterval(retryPendingSubmissions, SUBMISSION_RETRY_INTERVAL * 1000);
});