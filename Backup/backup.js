// backupServer.js – Backup server for ChocoHub (Hybrid PoW+PoS)
require('dotenv').config();
const net = require('net');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// ---------- Configuration ----------
const BACKUP_PORT = parseInt(process.env.BACKUP_PORT) || 3001;
const ALLOWED_TOKENS = (process.env.BACKUP_TOKENS || 'chocohub-default-token')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);
const DB_PATH = process.env.BACKUP_DB_PATH || path.join(__dirname, 'backup.db');

if (ALLOWED_TOKENS.length === 0) {
  console.warn('⚠️  No backup tokens configured. Use BACKUP_TOKENS env.');
}

// ---------- Database ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pin_hash TEXT NOT NULL,
    balance REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS bounties (
    id TEXT PRIMARY KEY,
    creator_username TEXT,
    target_device TEXT,
    difficulty INTEGER,
    reward REAL,
    cost REAL,
    binary_target TEXT,
    last_hash TEXT,
    nonce TEXT,
    solver_username TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS snake_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    apples INTEGER,
    mode TEXT,
    reward REAL,
    claimed_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS blocks_mined (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    bounty_id TEXT,
    reward REAL,
    mined_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stakes (
    username TEXT PRIMARY KEY,
    amount REAL NOT NULL DEFAULT 0,
    pending_reward REAL NOT NULL DEFAULT 0,
    last_reward_block INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sync_seq (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    seq INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO sync_seq (id, seq) VALUES (1, 0);
`);

// Helper: get current sequence
function getSeq() {
  const row = db.prepare('SELECT seq FROM sync_seq WHERE id = 1').get();
  return row ? row.seq : 0;
}

function setSeq(newSeq) {
  db.prepare('UPDATE sync_seq SET seq = ? WHERE id = 1').run(newSeq);
}

// ---------- Full backup exporter ----------
function gatherFullBackup() {
  return {
    users: db.prepare('SELECT * FROM users').all(),
    bounties: db.prepare('SELECT * FROM bounties').all(),
    snake_claims: db.prepare('SELECT * FROM snake_claims').all(),
    blocks_mined: db.prepare('SELECT * FROM blocks_mined').all(),
    stakes: db.prepare('SELECT * FROM stakes').all()
  };
}

// ---------- TCP Server ----------
const server = net.createServer((socket) => {
  let authenticated = false;
  let token = null;
  let clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;

  console.log(`🔌 New connection: ${clientInfo}`);

  let buffer = '';
  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    // keep last (possibly incomplete) line in buffer
    buffer = lines.pop(); 
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleMessage(socket, msg);
      } catch (e) {
        console.error(`Invalid JSON from ${clientInfo}:`, line);
      }
    }
  });

  socket.on('close', () => {
    console.log(`🔌 Disconnected: ${clientInfo}`);
  });

  socket.on('error', (err) => {
    console.error(`Socket error (${clientInfo}): ${err.message}`);
  });

  function handleMessage(socket, msg) {
    // First message must be READY with token
    if (!authenticated) {
      if (msg.type === 'READY' && msg.token) {
        if (ALLOWED_TOKENS.includes(msg.token)) {
          authenticated = true;
          token = msg.token;
          processReady(socket, msg);
        } else {
          socket.write(JSON.stringify({ type: 'ERROR', message: 'Invalid token' }) + '\n');
          socket.end();
        }
      } else {
        socket.write(JSON.stringify({ type: 'ERROR', message: 'Unauthenticated, send READY with token' }) + '\n');
      }
      return;
    }

    // After authentication
    switch (msg.type) {
      case 'DELTA':
        // Handled later (receive incremental changes)
        // For now just acknowledge the highest seq
        if (Array.isArray(msg.changes)) {
          applyDeltas(msg.changes);
        }
        const currentSeq = getSeq();
        socket.write(JSON.stringify({ type: 'DELTA_ACK', seq: currentSeq }) + '\n');
        break;

      default:
        console.log(`Unknown message from ${clientInfo}:`, msg.type);
    }
  }

  function processReady(socket, msg) {
    const currentSeq = getSeq();
    // Always send READY_ACK
    socket.write(JSON.stringify({ type: 'READY_ACK', seq: currentSeq }) + '\n');
    console.log(`✅ ${clientInfo} authenticated (client seq: ${msg.seq}, empty: ${msg.empty})`);

    // If client is empty and we have data, send FULL_BACKUP
    if (msg.empty && currentSeq > 0) {
      const backup = gatherFullBackup();
      const payload = {
        type: 'FULL_BACKUP',
        rows: backup,
        seq: currentSeq
      };
      socket.write(JSON.stringify(payload) + '\n');
      console.log(`📤 Sent FULL_BACKUP (seq ${currentSeq}) to ${clientInfo}`);
    }
  }

  function applyDeltas(changes) {
    // changes: array of { seq, table, operation, data }
    const insert = db.prepare(`
      INSERT OR REPLACE INTO ? (??) VALUES (??)
    `); // This is pseudo, need dynamic SQL – implement properly when real DELTAs arrive.
    // Currently placeholder.
    console.log(`📥 Received ${changes.length} delta(s) – not applied yet (implement later)`);
    // For now only update seq to highest
    if (changes.length > 0) {
      const maxSeq = Math.max(...changes.map(c => c.seq));
      if (maxSeq > getSeq()) {
        setSeq(maxSeq);
      }
    }
  }
});

server.listen(BACKUP_PORT, () => {
  console.log(`🛡️  Backup server listening on port ${BACKUP_PORT}`);
  console.log(`🔐 Allowed tokens: ${ALLOWED_TOKENS.join(', ') || '(none)'}`);
  console.log(`💾 Database: ${DB_PATH}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down backup server...');
  db.close();
  server.close();
  process.exit(0);
});
