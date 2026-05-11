// backupSync.js – Client đồng bộ full-snapshot. Chỉ cần 1 server online là restore ngay.
const net = require('net');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const db = require('./db');

const BACKUP_SERVERS = (process.env.BACKUP_SERVERS || '').split(',').filter(Boolean);
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || 'chocohub';
const RECONNECT_DELAY = 5000;
const HEARTBEAT_INTERVAL = 30000;        // 30 giây
const SNAPSHOT_INTERVAL = 300000;        // 5 phút gửi snapshot
const READY_TIMEOUT = 20000;             // 20s cho 1 request READY
const RETRY_INTERVAL = 30000;            // 30s thử lại server lỗi
const NODE_SYNC_INTERVAL = 300000;       // 5 phút đồng bộ danh sách node từ server.js
const MAX_RETRIES = 5;                  // Số lần thử lại tối đa trước khi xóa node động

// Creates a fresh TLS agent per request — keepAlive: false prevents
// "bad record mac" errors caused by reusing TCP connections with stale TLS state
function makeHttpsAgent(hostname) {
  return new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    checkServerIdentity: () => undefined,
    servername: hostname,   // correct SNI per server
    keepAlive: false,       // fresh TLS handshake on every request
  });
}

class BackupClient {
  constructor() {
    // Phân biệt server tĩnh (.env) và server động (từ backup.py)
    this.staticServers = BACKUP_SERVERS.map(cfg => {
      const [token, hostPort] = cfg.includes('@') ? cfg.split('@') : [BACKUP_TOKEN, cfg];
      if (hostPort.startsWith('https://') || hostPort.startsWith('http://')) {
        const url = new URL(hostPort);
        return {
          token,
          protocol: url.protocol.replace(':', ''),
          host: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname || '/',
          isDynamic: false
        };
      }
      const [host, port] = hostPort.split(':');
      return { token, protocol: 'tcp', host, port: parseInt(port) || 3001, isDynamic: false };
    });

    this.servers = [...this.staticServers]; // Mảng tổng hợp để duyệt kết nối
    this.sockets = [];
    this.heartbeats = {};
    this.snapshotTimers = {};
    this.restored = false;
    this.activeServers = new Set();
    this.heartbeatLogCounter = {};
    this.knownHosts = new Set(this.servers.map(s => s.host));
    this.retryCount = {}; // Đếm số lần retry cho mỗi node
    this.failedNodes = new Set(); // Lưu host đã bị xóa để không thêm lại
  }

  start() {
    if (this.servers.length === 0) {
      console.log('ℹ️ No static backup servers. Waiting for dynamic nodes...');
    } else {
      console.log(`🔁 Backup sync starting to ${this.servers.length} server(s)...`);
      this.servers.forEach(srv => this.connect(srv));
    }

    this.nodeSyncInterval = setInterval(() => this.syncNodesFromServer(), NODE_SYNC_INTERVAL);
    this.syncNodesFromServer();
  }

  syncNodesFromServer() {
    const port = process.env.PORT || 3000;
    console.log('🔍 Scanning for dynamic backup nodes...');
    const req = http.get(`http://localhost:${port}/api/backup/nodes`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.status === 'success' && parsed.nodes) {
            const urls = Object.keys(parsed.nodes);
            let found = 0;
            for (const url of urls) {
              const parsedUrl = new URL(url);
              const host = parsedUrl.hostname;
              if (!this.knownHosts.has(host) && !this.failedNodes.has(host)) {
                const isStatic = this.staticServers.some(s => s.host === host);
                if (isStatic) continue;

                const newServer = {
                  token: BACKUP_TOKEN,
                  protocol: parsedUrl.protocol.replace(':', ''),
                  host: host,
                  port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                  path: parsedUrl.pathname || '/',
                  isDynamic: true
                };
                console.log(`🆕 New backup node discovered: ${host} (from dynamic registration)`);
                this.servers.push(newServer);
                this.knownHosts.add(host);
                this.connect(newServer);
                found++;
              }
            }
            if (found === 0) {
              console.log('ℹ️ No new dynamic nodes found.');
            } else {
              console.log(`✅ Added ${found} new dynamic node(s).`);
            }
          }
        } catch (e) {
          console.error('❌ Failed to parse dynamic nodes:', e.message);
        }
      });
    });
    req.on('error', () => {});
    req.setTimeout(5000);
  }

  connect(server) {
    if (server.protocol === 'https' || server.protocol === 'http') {
      this.connectHttp(server);
    } else {
      this.connectTcp(server);
    }
  }

  // ==================== TCP ====================
  connectTcp(server) {
    const serverKey = `${server.host}:${server.port}`;
    const client = new net.Socket();

    client.connect(server.port, server.host, () => {
      console.log(`🔗 [TCP] Connected to ${serverKey}`);
      this.sendReadyTcp(client, server);
      this.startTcpHeartbeat(client, serverKey);
      this.startSnapshotIntervalTcp(client, server, serverKey);
      if (server.isDynamic) this.retryCount[serverKey] = 0;
    });

    client.on('data', (data) => this.handleTcpData(client, data));
    client.on('close', () => {
      console.log(`🔌 [TCP] Disconnected ${serverKey}, retry in ${RECONNECT_DELAY/1000}s...`);
      this.cleanupTcp(serverKey);
      this.handleConnectionFailure(server);
    });
    client.on('error', (err) => {
      console.error(`❌ [TCP] Error ${serverKey}: ${err.message}`);
      client.destroy();
    });

    this.sockets.push({ socket: client, server, serverKey, type: 'tcp' });
  }

  sendReadyTcp(client, server) {
    client.write(JSON.stringify({ type: 'READY', token: server.token, empty: db.getSeq() === 0 }) + '\n');
  }

  handleTcpData(client, data) {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'PONG') continue;
        if (msg.type === 'FULL_SNAPSHOT' && msg.state && !this.restored) {
          const users = Array.isArray(msg.state.users) ? msg.state.users.length : 0;
          if (users > 0) {
            console.log(`📥 [TCP] Restoring from backup (${users} users)...`);
            db.importFullState(msg.state);
            this.restored = true;
            console.log('✅ Database restored');
          }
        }
      } catch (e) {
        if (!line.includes('ngrok') && !line.includes('HTTP/') && !line.startsWith('X-'))
          console.error('❌ Invalid JSON:', line.substring(0, 100));
      }
    }
  }

  startTcpHeartbeat(client, serverKey) {
    this.stopHeartbeat(serverKey);
    this.heartbeats[serverKey] = setInterval(() => {
      if (!client.destroyed) client.write(JSON.stringify({ type: 'PING' }) + '\n');
    }, HEARTBEAT_INTERVAL);
  }

  stopHeartbeat(serverKey) {
    if (this.heartbeats[serverKey]) { clearInterval(this.heartbeats[serverKey]); delete this.heartbeats[serverKey]; }
  }

  startSnapshotIntervalTcp(client, server, serverKey) {
    if (this.snapshotTimers[serverKey]) clearInterval(this.snapshotTimers[serverKey]);
    this.snapshotTimers[serverKey] = setInterval(() => {
      if (!client.destroyed) {
        client.write(JSON.stringify({ type: 'FULL_SNAPSHOT', token: server.token, state: db.exportFullState() }) + '\n');
        console.log(`📤 [TCP] Snapshot sent to ${serverKey}`);
      }
    }, SNAPSHOT_INTERVAL);
  }

  cleanupTcp(serverKey) {
    this.stopHeartbeat(serverKey);
    if (this.snapshotTimers[serverKey]) { clearInterval(this.snapshotTimers[serverKey]); delete this.snapshotTimers[serverKey]; }
  }

  // ==================== HTTP/HTTPS ====================
  connectHttp(server) {
    const serverKey = `${server.host}:${server.port}`;
    const httpModule = server.protocol === 'https' ? https : http;
    const agent = server.protocol === 'https' ? makeHttpsAgent(server.host) : undefined;

    const tryReady = () => {
      if (this.restored) {
        if (!this.heartbeats[serverKey]) {
          console.log(`💓 Starting heartbeat for ${serverKey}`);
          this.startHttpHeartbeat(server, serverKey, agent);
        }
        if (!this.snapshotTimers[serverKey]) {
          console.log(`📸 Starting snapshot for ${serverKey}`);
          this.startHttpSnapshot(server, serverKey, agent);
        }
        return;
      }

      const payload = JSON.stringify({
        type: 'READY',
        token: server.token,
        empty: db.getSeq() === 0
      });

      const req = httpModule.request({
        hostname: server.host,
        port: server.port,
        path: '/api/backup/sync',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'ngrok-skip-browser-warning': '1',
          'User-Agent': 'ChocoHub-BackupClient/1.0',
          'Accept': 'application/json'
        },
        agent,
        rejectUnauthorized: false
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (this.restored) {
            if (!this.heartbeats[serverKey]) {
              console.log(`💓 Starting heartbeat for ${serverKey} (post-restore)`);
              this.startHttpHeartbeat(server, serverKey, agent);
            }
            if (!this.snapshotTimers[serverKey]) {
              console.log(`📸 Starting snapshot for ${serverKey} (post-restore)`);
              this.startHttpSnapshot(server, serverKey, agent);
            }
            return;
          }

          if (res.statusCode === 200 && body.trim()) {
            try {
              const msg = JSON.parse(body);

              if (msg.type === 'FULL_SNAPSHOT' && msg.state) {
                const users = Array.isArray(msg.state.users) ? msg.state.users.length : 0;
                if (users > 0) {
                  console.log(`📥 [HTTP] Restoring from ${serverKey} (${users} users)...`);
                  db.importFullState(msg.state);
                  this.restored = true;
                  console.log('✅ Database restored');
                }
                console.log(`💓 Starting heartbeat for ${serverKey}`);
                this.startHttpHeartbeat(server, serverKey, agent);
                console.log(`📸 Starting snapshot for ${serverKey}`);
                this.startHttpSnapshot(server, serverKey, agent);
                if (server.isDynamic) this.retryCount[serverKey] = 0;
                return;
              }

              if (msg.type === 'READY_ACK') {
                console.log(`🔗 [HTTP] Connected to ${serverKey} (main already has data)`);
                this.restored = true;
                console.log(`💓 Starting heartbeat for ${serverKey}`);
                this.startHttpHeartbeat(server, serverKey, agent);
                console.log(`📸 Starting snapshot for ${serverKey}`);
                this.startHttpSnapshot(server, serverKey, agent);
                if (server.isDynamic) this.retryCount[serverKey] = 0;
                return;
              }

            } catch (e) {
              console.error(`❌ Parse error ${serverKey}:`, body.substring(0, 120));
            }
          } else {
            console.error(`❌ ${serverKey} status ${res.statusCode}, retry...`);
          }

          this.handleConnectionFailure(server, tryReady);
        });
      });

      req.on('error', (err) => {
        if (this.restored) {
          if (!this.heartbeats[serverKey]) {
            console.log(`💓 Starting heartbeat for ${serverKey} (error path)`);
            this.startHttpHeartbeat(server, serverKey, agent);
          }
          if (!this.snapshotTimers[serverKey]) {
            console.log(`📸 Starting snapshot for ${serverKey} (error path)`);
            this.startHttpSnapshot(server, serverKey, agent);
          }
          return;
        }
        console.error(`❌ ${serverKey} error: ${err.message}, retry...`);
        this.handleConnectionFailure(server, tryReady);
      });

      req.on('timeout', () => {
        console.error(`⏱ ${serverKey} READY timeout (${READY_TIMEOUT/1000}s), aborting...`);
        req.destroy(new Error('READY timeout'));
      });
      req.setTimeout(READY_TIMEOUT);
      req.write(payload);
      req.end();
    };

    tryReady();
  }

  // Xử lý khi kết nối thất bại: tăng retry count, xóa node nếu quá hạn
  handleConnectionFailure(server, retryFn) {
    if (!server.isDynamic) {
      // Server tĩnh: luôn thử lại, không xóa
      if (retryFn) setTimeout(retryFn, RETRY_INTERVAL);
      else setTimeout(() => this.connect(server), RECONNECT_DELAY);
      return;
    }

    const serverKey = `${server.host}:${server.port}`;
    this.retryCount[serverKey] = (this.retryCount[serverKey] || 0) + 1;

    if (this.retryCount[serverKey] >= MAX_RETRIES) {
      console.log(`🗑️ Removing dead dynamic node ${serverKey} after ${MAX_RETRIES} failed retries.`);
      this.failedNodes.add(server.host);
      // Xóa khỏi danh sách servers
      this.servers = this.servers.filter(s => `${s.host}:${s.port}` !== serverKey);
      // Xóa heartbeat & snapshot timers nếu có
      if (this.heartbeats[serverKey]) {
        clearInterval(this.heartbeats[serverKey]);
        delete this.heartbeats[serverKey];
      }
      if (this.snapshotTimers[serverKey]) {
        clearInterval(this.snapshotTimers[serverKey]);
        delete this.snapshotTimers[serverKey];
      }
      // Xóa socket nếu có
      this.sockets = this.sockets.filter(s => s.serverKey !== serverKey);
      console.log(`🧹 Cleaned up resources for ${serverKey}`);
    } else {
      console.log(`🔄 Retry ${this.retryCount[serverKey]}/${MAX_RETRIES} for ${serverKey} in ${RETRY_INTERVAL/1000}s...`);
      if (retryFn) setTimeout(retryFn, RETRY_INTERVAL);
      else setTimeout(() => this.connect(server), RECONNECT_DELAY);
    }
  }

  startHttpHeartbeat(server, serverKey, agent) {
    const httpModule = server.protocol === 'https' ? https : http;
    const options = {
      hostname: server.host,
      port: server.port,
      path: '/api/backup/sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': '1',
        'User-Agent': 'ChocoHub-BackupClient/1.0'
      },
      agent,
      rejectUnauthorized: false
    };

    if (!this.heartbeatLogCounter[serverKey]) this.heartbeatLogCounter[serverKey] = 0;

    const heartbeat = () => {
      const payload = JSON.stringify({ type: 'PING', token: server.token });
      const req = httpModule.request(options, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          this.heartbeatLogCounter[serverKey]++;
          if (this.heartbeatLogCounter[serverKey] % 5 === 0) {
            console.log(`💚 Heartbeat OK (${serverKey})`);
          }
        } else {
          console.error(`⚠️ [HTTP] Heartbeat failed ${serverKey}: ${res.statusCode}`);
        }
      });
      req.on('error', (err) => console.error(`❌ [HTTP] Heartbeat error ${serverKey}: ${err.message}`));
      req.on('timeout', () => req.destroy(new Error('heartbeat timeout')));
      req.setTimeout(10000);
      req.write(payload);
      req.end();
    };

    if (this.heartbeats[serverKey]) clearInterval(this.heartbeats[serverKey]);
    this.heartbeats[serverKey] = setInterval(heartbeat, HEARTBEAT_INTERVAL);
    heartbeat();
  }

  startHttpSnapshot(server, serverKey, agent) {
    const httpModule = server.protocol === 'https' ? https : http;
    const options = {
      hostname: server.host,
      port: server.port,
      path: '/api/backup/sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': '1',
        'User-Agent': 'ChocoHub-BackupClient/1.0'
      },
      agent,
      rejectUnauthorized: false
    };

    let lastSnapshotHash = null;

    const sendSnapshot = () => {
      const state   = db.exportFullState();
      const payload = JSON.stringify({ type: 'FULL_SNAPSHOT', token: server.token, state });
      const hash    = crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);

      if (hash === lastSnapshotHash) {
        console.log(`⏭ Snapshot unchanged, skipping send to ${serverKey}`);
        return;
      }

      const reqOpts = { ...options, headers: { ...options.headers, 'Content-Length': Buffer.byteLength(payload) } };
      const req = httpModule.request(reqOpts, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          lastSnapshotHash = hash;
          console.log(`📤 Snapshot sent to ${serverKey} (hash ${hash})`);
        } else {
          console.error(`⚠️ Snapshot failed ${serverKey}: ${res.statusCode}`);
        }
      });
      req.on('error', (err) => console.error(`❌ Snapshot error ${serverKey}: ${err.message}`));
      req.on('timeout', () => req.destroy(new Error('snapshot timeout')));
      req.setTimeout(20000);
      req.write(payload);
      req.end();
    };

    if (this.snapshotTimers[serverKey]) clearInterval(this.snapshotTimers[serverKey]);
    this.snapshotTimers[serverKey] = setInterval(sendSnapshot, SNAPSHOT_INTERVAL);
    sendSnapshot();
  }
}

// Singleton
const backupClient = new BackupClient();
module.exports = backupClient;
