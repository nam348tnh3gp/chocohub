// backup.js – Backup Server (Node.js) với DH + canonical JSON + REQUEST_SNAPSHOT
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('better-sqlite3');
const DHExchange = require('./dh');

// ─── Helper: canonical JSON (sắp xếp key alphabet) ─────────────
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(k => `"${k}":${canonicalStringify(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

// ─── Cấu hình từ .env ─────────────────────────────
const BACKUP_PORT = process.env.BACKUP_PORT || 3001;
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || 'chocohub-default-token';
const MAIN_SERVER_URL = process.env.MAIN_SERVER_URL || 'https://chocohub-r011.onrender.com';
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '10', 10);
const DB_PATH = path.join(__dirname, process.env.BACKUP_DB_PATH || 'backup_node.db');
const SELF_URL = process.env.SELF_URL || '';
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS || '3', 10);

const NO_LIMIT = '5000mb';

const app = express();
app.use(cors());
app.use(express.json({ limit: NO_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: NO_LIMIT }));

// ─── SQLite ────────────────────────────────────────
let db;
function initDB() {
  db = sqlite3(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      state TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.exec(`INSERT OR IGNORE INTO snapshot (id, state) VALUES (1, '{}')`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL,
      users_count INTEGER DEFAULT 0,
      total_items INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  console.log('✅ Backup database ready (Node.js snapshot mode + history)');
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
  const transaction = db.transaction(() => {
    const oldRow = db.prepare('SELECT state FROM snapshot WHERE id = 1').get();
    if (oldRow && oldRow.state && oldRow.state !== '{}') {
      try {
        const oldState = JSON.parse(oldRow.state);
        const oldSize = countSnapshotSize(oldState);
        if (oldRow.state !== json) {
          db.prepare(
            'INSERT INTO snapshot_backups (state, users_count, total_items) VALUES (?, ?, ?)'
          ).run(oldRow.state, oldSize.users, oldSize.total);
          console.log(`📦 Backup bản cũ (${oldSize.users} users) vào history`);
        }
      } catch (e) {}
    }
    db.prepare(
      `INSERT OR REPLACE INTO snapshot (id, state, updated_at) VALUES (1, ?, datetime('now'))`
    ).run(json);
    db.prepare(
      `DELETE FROM snapshot_backups WHERE id NOT IN (
        SELECT id FROM snapshot_backups ORDER BY created_at DESC LIMIT ?
      )`
    ).run(MAX_BACKUPS);
  });
  try {
    transaction();
    console.log(`💾 Snapshot saved (${users} users, ${total} items, ${(json.length / 1024).toFixed(1)} KB)`);
  } catch (e) {
    console.error('❌ Save error:', e.message);
  }
}

function getSnapshot() {
  const row = db.prepare('SELECT state FROM snapshot WHERE id = 1').get();
  if (row && row.state) {
    try { return JSON.parse(row.state); } catch { return null; }
  }
  return null;
}

function getSnapshotTime() {
  const row = db.prepare('SELECT updated_at FROM snapshot WHERE id = 1').get();
  return row ? row.updated_at : 'unknown';
}

// ─── RSA long‑term keys ────────────────────────────
const RSA_PRIVATE_PATH = path.join(__dirname, 'backup_private.pem');
const RSA_PUBLIC_PATH = path.join(__dirname, 'backup_public.pem');
let serverPrivateKeyPem, serverPublicKeyPem;

function loadOrGenerateRSA() {
  if (fs.existsSync(RSA_PRIVATE_PATH) && fs.existsSync(RSA_PUBLIC_PATH)) {
    serverPrivateKeyPem = fs.readFileSync(RSA_PRIVATE_PATH, 'utf8');
    serverPublicKeyPem = fs.readFileSync(RSA_PUBLIC_PATH, 'utf8');
    console.log('🔑 Loaded existing RSA long‑term keys.');
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
    console.log('🔧 Generated new RSA long‑term keys.');
  }
}

// ─── DH keys ───────────────────────────────────────
const serverDHKeys = DHExchange.generateStandardKeyPair('modp2048');
const dhSessions = new Map();

// ═══════════════════════════════════════════════════
// MIDDLEWARE (kiểm tra HMAC với canonical JSON)
// ═══════════════════════════════════════════════════
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/backup')) return next();

  const clientId = req.headers['x-client-id'] || req.body.clientId || req.query.clientId;
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
// ROUTES
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
    main_server: MAIN_SERVER_URL,
    max_backups: MAX_BACKUPS
  });
});

app.get('/api/backup/history', (req, res) => {
  const rows = db.prepare(
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
  const row = db.prepare('SELECT state FROM snapshot_backups WHERE id = ?').get(backupId);
  if (!row) return res.status(404).json({ status: 'error', message: 'Backup not found' });
  try {
    const state = JSON.parse(row.state);
    const current = getSnapshot();
    if (current && current.users && current.users.length > 0) {
      const currentSize = countSnapshotSize(current);
      db.prepare(
        'INSERT INTO snapshot_backups (state, users_count, total_items) VALUES (?, ?, ?)'
      ).run(canonicalStringify(current), currentSize.users, currentSize.total);
    }
    db.prepare(
      `INSERT OR REPLACE INTO snapshot (id, state, updated_at) VALUES (1, ?, datetime('now'))`
    ).run(canonicalStringify(state));
    const size = countSnapshotSize(state);
    console.log(`🔄 Restored backup #${backupId} (${size.users} users)`);
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
      serverDHKeys.privateKey,
      clientPublicKey,
      serverDHKeys.prime,
      serverDHKeys.generator
    );
    const sessionKey = DHExchange.deriveSessionKey(sharedSecret);
    dhSessions.set(clientId, { sessionKey, createdAt: Date.now() });

    const serverPubData = canonicalStringify({
      publicKey: serverDHKeys.publicKey,
      prime: serverDHKeys.prime,
      generator: serverDHKeys.generator,
      group: serverDHKeys.group
    });
    const signature = DHExchange.signWithPrivateKey(serverPubData, serverPrivateKeyPem);

    console.log(`🔐 DH session established with ${clientId}`);
    res.json({
      status: 'success',
      serverPublicKey: serverDHKeys.publicKey,
      prime: serverDHKeys.prime,
      generator: serverDHKeys.generator,
      group: serverDHKeys.group,
      serverSignature: signature
    });
  } catch (e) {
    console.error('❌ DH exchange error:', e);
    res.status(500).json({ status: 'error', message: 'Key exchange failed' });
  }
});

// ═══════════════════════════════════════════════════
// BACKUP SYNC – ĐÃ SỬA CHỐNG GHI ĐÈ BẰNG HASH
// ═══════════════════════════════════════════════════
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

    console.log(`📋 READY: clientEmpty=${clientEmpty}, serverHasData=${serverHasData}`);

    if (clientEmpty) {
      const snap = getSnapshot();
      if (snap && snap.users && snap.users.length > 0) {
        console.log(`📤 Sending full snapshot (${snap.users.length} users)`);
        return res.json({ type: 'FULL_SNAPSHOT', token: BACKUP_TOKEN, state: snap });
      } else {
        console.log('ℹ️ Both empty, sending READY_ACK');
        return res.json({ type: 'READY_ACK', status: 'success', message: 'ready but empty' });
      }
    }

    if (!clientEmpty && !serverHasData) {
      console.log('📤 Server empty, requesting snapshot from client');
      return res.json({ type: 'REQUEST_SNAPSHOT', message: 'Server is empty, please send your snapshot' });
    }

    console.log('✅ Both have data or both empty, sending READY_ACK');
    return res.json({ type: 'READY_ACK', status: 'success', message: 'ack' });
  }
  else if (msgType === 'PING') {
    return res.json({ type: 'PONG', timestamp: new Date().toISOString() });
  }
  else if (msgType === 'FULL_SNAPSHOT') {
    if (!data.state) return res.status(400).json({ status: 'error', message: 'Missing state' });

    const state = data.state;
    const newSize = countSnapshotSize(state);
    const current = getSnapshot();

    // Tính hash của snapshot mới
    const newHash = crypto.createHash('sha256').update(canonicalStringify(state)).digest('hex');

    if (current && current.users && current.users.length > 0) {
      const currentHash = crypto.createHash('sha256').update(canonicalStringify(current)).digest('hex');

      // Nếu hash giống hệt -> bỏ qua
      if (newHash === currentHash) {
        console.log('⏭ Snapshot identical (same hash), skipping');
        return res.json({ type: 'SNAPSHOT_ACK', status: 'skipped', message: 'Identical' });
      }

      // Chống ghi đè lùi: nếu dữ liệu mới ít hơn 50% -> cảnh báo và bỏ qua (tuỳ chọn)
      const currentSize = countSnapshotSize(current);
      if (newSize.total < currentSize.total * 0.5) {
        console.log(`⚠️ SKIP snapshot: ${newSize.total} items < 50% of current ${currentSize.total} items (possible regression)`);
        return res.json({ type: 'SNAPSHOT_ACK', status: 'skipped', message: 'Less data' });
      }
    }

    console.log(`📥 Receiving snapshot (${newSize.users} users, ${newSize.total} items)...`);
    saveSnapshot(state);
    return res.json({ type: 'SNAPSHOT_ACK', status: 'success' });
  }
  else {
    return res.status(400).json({ status: 'error', message: `Unknown type: ${msgType}` });
  }
});

// ─── Gửi snapshot đến main server (có canonical) ────────────────
let mainServerPublicKey = null;

async function fetchMainServerPublicKey() {
  try {
    const resp = await fetch(`${MAIN_SERVER_URL}/api/server/public-key`);
    if (resp.ok) {
      const data = await resp.json();
      mainServerPublicKey = data.publicKey;
      console.log('🔑 Fetched main server public key');
    }
  } catch (e) {
    console.error('❌ Could not fetch main server public key:', e.message);
  }
}

async function sendSnapshotToMainServer() {
  const snap = getSnapshot();
  if (!snap || !snap.users || snap.users.length === 0) {
    console.log('⚠️ No snapshot data to send');
    return;
  }

  const snapSize = JSON.stringify(snap).length;
  const clientId = `backup-${require('os').hostname()}-${process.pid}`;
  let sessionKey = null;

  if (!mainServerPublicKey) await fetchMainServerPublicKey();

  if (mainServerPublicKey) {
    try {
      const clientDH = DHExchange.generateStandardKeyPair('modp2048');
      const resp = await fetch(`${MAIN_SERVER_URL}/api/dh/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: canonicalStringify({
          clientId,
          clientPublicKey: clientDH.publicKey,
          token: BACKUP_TOKEN
        })
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.serverPublicKey && data.serverSignature) {
          const pubDataStr = canonicalStringify({
            publicKey: data.serverPublicKey,
            prime: data.prime,
            generator: data.generator,
            group: data.group
          });
          const valid = DHExchange.verifyWithPublicKey(pubDataStr, data.serverSignature, mainServerPublicKey);
          if (valid) {
            const shared = DHExchange.computeSharedSecret(
              clientDH.privateKey,
              data.serverPublicKey,
              data.prime,
              data.generator
            );
            sessionKey = DHExchange.deriveSessionKey(shared);
            console.log('🔐 Authenticated DH session with main server');
          }
        }
      }
    } catch (e) {
      console.error('❌ DH exchange with main server failed:', e.message);
    }
  }

  const payload = { type: 'FULL_SNAPSHOT', token: BACKUP_TOKEN, state: snap };
  const bodyString = canonicalStringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'ChocoHub-BackupNode/1.0'
  };

  if (sessionKey) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = DHExchange.sign(`POST/api/backup/sync${timestamp}${bodyString}`, sessionKey);
    headers['X-Client-Id'] = clientId;
    headers['X-Timestamp'] = timestamp;
    headers['X-Signature'] = signature;
  }

  console.log(`📤 Sending snapshot to main server (${snap.users.length} users, ${(snapSize / 1024).toFixed(1)} KB)...`);
  try {
    const resp = await fetch(`${MAIN_SERVER_URL}/api/backup/sync`, {
      method: 'POST',
      headers,
      body: bodyString
    });
    if (resp.ok) console.log('✅ Snapshot sent to main server');
    else console.error(`❌ Send snapshot failed: ${resp.status}`);
  } catch (e) {
    console.error('❌ Error sending snapshot:', e.message);
  }
}

// ─── Auto‑register ────────────────────────────────
async function registerWithMainServer() {
  if (!SELF_URL) return;
  try {
    await fetch(`${MAIN_SERVER_URL}/api/backup/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: canonicalStringify({
        url: SELF_URL,
        token: BACKUP_TOKEN,
        name: 'ChocoHub Backup Node',
        platform: 'Node.js'
      })
    });
    console.log(`📡 Registered with main server as ${SELF_URL}`);
  } catch (e) {
    console.error('❌ Could not register with main server:', e.message);
  }
}

// ─── Monitor ──────────────────────────────────────
let wasDown = false;
setInterval(async () => {
  try {
    const resp = await fetch(`${MAIN_SERVER_URL}/health`);
    const online = resp.ok;
    if (!online && !wasDown) {
      console.log('🔴 Main server DOWN');
      wasDown = true;
    } else if (online && wasDown) {
      console.log('🟢 Main server BACK ONLINE');
      await sendSnapshotToMainServer();
      wasDown = false;
    }
  } catch (e) {
    if (!wasDown) {
      console.log('🔴 Main server DOWN');
      wasDown = true;
    }
  }
}, CHECK_INTERVAL * 1000);

// ═══════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════
initDB();
loadOrGenerateRSA();

app.listen(BACKUP_PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   CHOCO HUB - BACKUP SERVER (Node)  ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Port: ${BACKUP_PORT}                          ║`);
  console.log(`║  Main: ${MAIN_SERVER_URL.slice(0, 35).padEnd(35)}║`);
  console.log('║  Canonical JSON: ON                 ║');
  console.log('║  REQUEST_SNAPSHOT: ON               ║');
  console.log('║  Anti-overwrite: HASH-BASED         ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  registerWithMainServer();
});
