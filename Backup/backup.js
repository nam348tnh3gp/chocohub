// backupServer.js – Backup server for ChocoHub (Hybrid PoW+PoS)
require('dotenv').config();
const net = require('net');
const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// ---------- Configuration ----------
const BACKUP_PORT = parseInt(process.env.BACKUP_PORT) || 3001;
const HTTP_PORT = parseInt(process.env.HTTP_PORT) || 3001; // Có thể dùng chung port nếu chỉ HTTP
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

// ---------- Message Processing (dùng chung) ----------
function handleReady(msg) {
  const currentSeq = getSeq();
  const response = { type: 'READY_ACK', seq: currentSeq };

  // Nếu client empty và mình có data → gửi FULL_BACKUP
  if (msg.empty && currentSeq > 0) {
    response.full_backup = gatherFullBackup();
    response.full_backup_seq = currentSeq;
  }

  return response;
}

function handlePoll(msg) {
  // Trả về delta nếu có (hiện tại placeholder)
  return { type: 'POLL_ACK', seq: getSeq() };
}

// ==================== HTTP Server ====================
const httpServer = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Chỉ chấp nhận POST /api/backup/sync
  if (req.method === 'POST' && req.url === '/api/backup/sync') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        console.log(`📥 [HTTP] Received: ${msg.type} (token: ${msg.token ? 'yes' : 'no'})`);

        // Xác thực token
        if (msg.token && !ALLOWED_TOKENS.includes(msg.token)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'ERROR', message: 'Invalid token' }));
          return;
        }

        let response;
        switch (msg.type) {
          case 'READY':
            response = handleReady(msg);
            console.log(`✅ [HTTP] READY from client (seq=${msg.seq}, empty=${msg.empty})`);
            if (response.full_backup) {
              console.log(`📤 [HTTP] Sending FULL_BACKUP (seq=${response.full_backup_seq})`);
            }
            break;
          case 'POLL':
            response = handlePoll(msg);
            break;
          default:
            response = { type: 'UNKNOWN', message: `Unknown type: ${msg.type}` };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        console.error('❌ [HTTP] Invalid JSON:', body.substring(0, 100));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'ERROR', message: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', seq: getSeq() }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'ERROR', message: 'Not found' }));
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP Backup server listening on port ${HTTP_PORT}`);
  console.log(`   Endpoint: POST http://localhost:${HTTP_PORT}/api/backup/sync`);
});

// ==================== TCP Server (giữ nguyên) ====================
const tcpServer = net.createServer((socket) => {
  let authenticated = false;
  let clientInfo = `${socket.remoteAddress}:${socket.remotePort}`;

  console.log(`🔌 [TCP] New connection: ${clientInfo}`);

  let buffer = '';
  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleTcpMessage(socket, msg, clientInfo);
      } catch (e) {
        console.error(`❌ Invalid JSON from ${clientInfo}:`, line.substring(0, 100));
      }
    }
  });

  socket.on('close', () => {
    console.log(`🔌 [TCP] Disconnected: ${clientInfo}`);
  });

  socket.on('error', (err) => {
    console.error(`❌ [TCP] Socket error (${clientInfo}): ${err.message}`);
  });

  function handleTcpMessage(socket, msg, clientInfo) {
    if (!authenticated) {
      if (msg.type === 'READY' && msg.token) {
        if (ALLOWED_TOKENS.includes(msg.token)) {
          authenticated = true;
          const response = handleReady(msg);
          socket.write(JSON.stringify({ type: 'READY_ACK', seq: response.seq }) + '\n');
          
          if (response.full_backup) {
            socket.write(JSON.stringify({
              type: 'FULL_BACKUP',
              rows: response.full_backup,
              seq: response.full_backup_seq
            }) + '\n');
            console.log(`📤 [TCP] Sent FULL_BACKUP to ${clientInfo}`);
          }
          console.log(`✅ [TCP] ${clientInfo} authenticated`);
        } else {
          socket.write(JSON.stringify({ type: 'ERROR', message: 'Invalid token' }) + '\n');
          socket.end();
        }
      }
      return;
    }

    // Messages sau khi authenticated
    switch (msg.type) {
      case 'DELTA':
        if (Array.isArray(msg.changes)) {
          const maxSeq = Math.max(...msg.changes.map(c => c.seq || 0));
          if (maxSeq > getSeq()) setSeq(maxSeq);
        }
        socket.write(JSON.stringify({ type: 'DELTA_ACK', seq: getSeq() }) + '\n');
        break;
      default:
        console.log(`❓ Unknown TCP message: ${msg.type}`);
    }
  }
});

tcpServer.listen(BACKUP_PORT, () => {
  console.log(`🔌 TCP Backup server listening on port ${BACKUP_PORT}`);
  console.log(`🔐 Allowed tokens: ${ALLOWED_TOKENS.join(', ') || '(none)'}`);
  console.log(`💾 Database: ${DB_PATH}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down backup server...');
  db.close();
  tcpServer.close();
  httpServer.close();
  process.exit(0);
});
