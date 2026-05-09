// backup.js – Backup server for ChocoHub
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const net = require('net');
const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');

// ---------- Configuration ----------
const TCP_PORT = parseInt(process.env.TCP_PORT) || 3001;
const HTTP_PORT = parseInt(process.env.HTTP_PORT) || 3001;
const ALLOWED_TOKENS = (process.env.BACKUP_TOKENS || 'chocohub-default-token')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);
const DB_PATH = process.env.BACKUP_DB_PATH || path.join(__dirname, 'backup.db');
const MAIN_SERVERS = (process.env.MAIN_SERVERS || '')
  .split(',')
  .filter(Boolean)
  .map(url => url.trim());

// ---------- Database ----------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS backup_data (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO backup_data (key, value) VALUES ('seq', '0');
  INSERT OR IGNORE INTO backup_data (key, value) VALUES ('ready_count', '0');
  INSERT OR IGNORE INTO backup_data (key, value) VALUES ('last_backup', '');
  INSERT OR IGNORE INTO backup_data (key, value) VALUES ('backup_status', 'idle');
`);

// ---------- Helpers ----------
function getBackupValue(key) {
  const row = db.prepare('SELECT value FROM backup_data WHERE key = ?').get(key);
  return row ? row.value : '0';
}

function setBackupValue(key, value) {
  db.prepare('INSERT OR REPLACE INTO backup_data (key, value) VALUES (?, ?)').run(key, String(value));
}

function getReadyCount() {
  return parseInt(getBackupValue('ready_count')) || 0;
}

function incrementReady() {
  const count = getReadyCount() + 1;
  setBackupValue('ready_count', count);
  return count;
}

function resetReady() {
  setBackupValue('ready_count', '0');
}

// ---------- Lấy dữ liệu từ main server (nếu có config) ----------
let mainBackupData = null;

function fetchFromMainServers() {
  if (MAIN_SERVERS.length === 0) {
    console.log('ℹ️  No MAIN_SERVERS configured. Waiting for data push...');
    return;
  }

  console.log(`🔄 Fetching data from ${MAIN_SERVERS.length} main server(s)...`);
  
  MAIN_SERVERS.forEach(mainUrl => {
    try {
      const url = new URL(mainUrl.startsWith('http') ? mainUrl : `http://${mainUrl}`);
      const options = {
        hostname: url.hostname,
        port: url.port || 3000,
        path: '/network_status',
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      };
      const httpModule = url.protocol === 'https:' ? require('https') : http;

      const req = httpModule.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            mainBackupData = data;
            setBackupValue('last_backup', JSON.stringify(data));
            setBackupValue('seq', String(Date.now()));
            setBackupValue('backup_status', 'synced');
            const now = new Date().toISOString();
            console.log(`✅ [${now}] Fetched data from ${url.hostname}:${url.port}`);
          } catch (e) {
            console.error(`❌ Parse error from ${mainUrl}:`, e.message);
          }
        });
      });

      req.on('error', (err) => {
        console.error(`❌ Fetch error from ${mainUrl}:`, err.message);
      });

      req.setTimeout(5000, () => {
        req.destroy();
        console.error(`⏰ Timeout fetching from ${mainUrl}`);
      });

      req.end();
    } catch (e) {
      console.error(`❌ URL parse error for ${mainUrl}:`, e.message);
    }
  });
}

// ---------- Gửi backup về main server ----------
function pushBackupToMain() {
  if (MAIN_SERVERS.length === 0) {
    console.log('ℹ️  No MAIN_SERVERS to push backup to.');
    return;
  }

  const backupPayload = {
    type: 'FULL_BACKUP',
    rows: mainBackupData || JSON.parse(getBackupValue('last_backup') || '{}'),
    seq: getBackupValue('seq'),
    timestamp: new Date().toISOString(),
    server: 'backup'
  };

  console.log(`📤 Pushing FULL_BACKUP to ${MAIN_SERVERS.length} main server(s)...`);

  MAIN_SERVERS.forEach(mainUrl => {
    try {
      const url = new URL(mainUrl.startsWith('http') ? mainUrl : `http://${mainUrl}`);
      const options = {
        hostname: url.hostname,
        port: url.port || 3000,
        path: '/api/backup/receive',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Backup-Token': ALLOWED_TOKENS[0] || 'chocohub-default-token'
        }
      };
      const httpModule = url.protocol === 'https:' ? require('https') : http;

      const req = httpModule.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            console.log(`✅ Backup pushed to ${url.hostname}:${url.port}`);
            setBackupValue('backup_status', 'pushed');
          } else {
            console.error(`❌ Push failed to ${url.hostname}:${url.port} (${res.statusCode}):`, body.substring(0, 100));
          }
        });
      });

      req.on('error', (err) => {
        console.error(`❌ Push error to ${mainUrl}:`, err.message);
      });

      req.setTimeout(5000, () => {
        req.destroy();
        console.error(`⏰ Push timeout to ${mainUrl}`);
      });

      req.write(JSON.stringify(backupPayload));
      req.end();
    } catch (e) {
      console.error(`❌ URL parse error for push ${mainUrl}:`, e.message);
    }
  });
}

// ==================== HTTP Server ====================
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning, X-Backup-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      seq: getBackupValue('seq'),
      ready_count: getReadyCount(),
      backup_status: getBackupValue('backup_status'),
      main_servers: MAIN_SERVERS.length,
      time: new Date().toISOString()
    }));
    return;
  }

  // Nhận backup từ main server
  if ((req.method === 'POST') && (req.url === '/api/backup/sync' || req.url === '/api/backup/receive')) {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        console.log(`📥 [HTTP] Received: ${msg.type}`);

        // Xác thực token
        const token = msg.token || req.headers['x-backup-token'];
        if (token && !ALLOWED_TOKENS.includes(token)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'ERROR', message: 'Invalid token' }));
          return;
        }

        let response;

        switch (msg.type) {
          case 'READY':
            const count = incrementReady();
            console.log(`📥 READY received (count: ${count}/2)`);
            response = { type: 'READY_ACK', seq: getBackupValue('seq'), ready_count: count };

            // Nếu nhận READY 2 lần → push backup về main
            if (count >= 2) {
              console.log('🎯 READY received 2 times! Triggering backup push...');
              resetReady();
              // Đẩy backup sau 1 giây để đảm bảo response READY_ACK đã gửi
              setTimeout(() => pushBackupToMain(), 1000);
              response.message = 'Backup will be pushed to main servers';
            }
            break;

          case 'FULL_BACKUP':
            // Nhận backup từ main server → lưu lại
            console.log('📥 Receiving FULL_BACKUP from main server...');
            if (msg.rows) {
              mainBackupData = msg.rows;
              setBackupValue('last_backup', JSON.stringify(msg.rows));
              setBackupValue('seq', String(msg.seq || Date.now()));
              setBackupValue('backup_status', 'received');
            }
            response = { type: 'BACKUP_ACK', status: 'saved', seq: getBackupValue('seq') };
            break;

          case 'DELTA':
            console.log('📥 Receiving DELTA...');
            response = { type: 'DELTA_ACK', seq: getBackupValue('seq') };
            break;

          default:
            response = { type: 'UNKNOWN', message: `Unknown type: ${msg.type}` };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      } catch (e) {
        console.error('❌ Invalid JSON:', body.substring(0, 100));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'ERROR', message: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Trạng thái backup
  if (req.url === '/backup/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: getBackupValue('backup_status'),
      seq: getBackupValue('seq'),
      ready_count: getReadyCount(),
      has_data: !!mainBackupData,
      main_servers: MAIN_SERVERS
    }));
    return;
  }

  // Force push backup
  if (req.url === '/backup/push' && req.method === 'POST') {
    pushBackupToMain();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'pushing', message: 'Backup push initiated' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ type: 'ERROR', message: 'Not found' }));
});

httpServer.listen(HTTP_PORT, () => {
  console.log(`🌐 HTTP Backup server on port ${HTTP_PORT}`);
  console.log(`   Health: http://localhost:${HTTP_PORT}/health`);
});

// ==================== TCP Server ====================
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
        
        if (!authenticated) {
          if (msg.type === 'READY' && msg.token && ALLOWED_TOKENS.includes(msg.token)) {
            authenticated = true;
            const count = incrementReady();
            console.log(`✅ [TCP] ${clientInfo} authenticated (READY count: ${count}/2)`);
            
            socket.write(JSON.stringify({ 
              type: 'READY_ACK', 
              seq: getBackupValue('seq'), 
              ready_count: count 
            }) + '\n');

            // READY 2 lần → push backup
            if (count >= 2) {
              console.log('🎯 [TCP] READY 2 times! Pushing backup...');
              resetReady();
              setTimeout(() => pushBackupToMain(), 1000);
            }
          } else {
            socket.write(JSON.stringify({ type: 'ERROR', message: 'Invalid token' }) + '\n');
            socket.end();
          }
        } else {
          // Đã authenticate → xử lý message
          switch (msg.type) {
            case 'DELTA':
              socket.write(JSON.stringify({ type: 'DELTA_ACK', seq: getBackupValue('seq') }) + '\n');
              break;
            default:
              socket.write(JSON.stringify({ type: 'UNKNOWN', message: `Unknown: ${msg.type}` }) + '\n');
          }
        }
      } catch (e) {
        console.error(`❌ Parse error: ${line.substring(0, 100)}`);
      }
    }
  });

  socket.on('close', () => {
    console.log(`🔌 [TCP] Disconnected: ${clientInfo}`);
  });
  socket.on('error', (err) => {
    console.error(`❌ [TCP] Socket error: ${err.message}`);
  });
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`🔌 TCP Backup server on port ${TCP_PORT}`);
  console.log(`🔐 Tokens: ${ALLOWED_TOKENS.join(', ') || '(none)'}`);
  console.log(`💾 DB: ${DB_PATH}`);
  console.log(`📡 Main servers: ${MAIN_SERVERS.length > 0 ? MAIN_SERVERS.join(', ') : '(none - will only receive, not push)'}`);
  console.log('');
});

// ==================== Auto-fetch từ main server ====================
if (MAIN_SERVERS.length > 0) {
  // Fetch ngay khi start
  setTimeout(fetchFromMainServers, 2000);
  // Fetch định kỳ mỗi 60 giây
  setInterval(fetchFromMainServers, 60000);
}

// ==================== Graceful Shutdown ====================
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  db.close();
  tcpServer.close();
  httpServer.close();
  process.exit(0);
});

console.log('╔══════════════════════════════════════╗');
console.log('║   CHOCO HUB - BACKUP SERVER         ║');
console.log('╚══════════════════════════════════════╝');
