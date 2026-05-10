// backupSync.js – Client đồng bộ full-snapshot, chờ tất cả backup server rồi khôi phục
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
const READY_TIMEOUT = 15000;             // chờ tất cả server phản hồi READY tối đa 15s

// Agent TLS cho ngrok / chứng chỉ tự ký
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  minVersion: 'TLSv1.2',
  secureOptions: crypto.constants.SSL_OP_NO_TICKET,
  checkServerIdentity: () => undefined,
});

class BackupClient {
  constructor() {
    this.servers = BACKUP_SERVERS.map(cfg => {
      const [token, hostPort] = cfg.includes('@') ? cfg.split('@') : [BACKUP_TOKEN, cfg];

      if (hostPort.startsWith('https://') || hostPort.startsWith('http://')) {
        const url = new URL(hostPort);
        return {
          token,
          protocol: url.protocol.replace(':', ''),
          host: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname || '/'
        };
      }

      const [host, port] = hostPort.split(':');
      return { token, protocol: 'tcp', host, port: parseInt(port) || 3001 };
    });

    this.sockets = [];
    this.heartbeats = {};
    this.snapshotTimers = {};
    this.readySent = new Set();          // 🆕 Khởi tạo readySent
    this.pendingReady = {};
    this.readyTimer = null;
    this.readyProcessed = false;         // 🆕 Flag tránh chạy 2 lần
  }

  start() {
    if (this.servers.length === 0) {
      console.log('ℹ️ No backup servers configured. Skipping backup sync.');
      return;
    }
    console.log(`🔁 Backup sync (full snapshot, wait-all mode) starting to ${this.servers.length} server(s)...`);
    this.servers.forEach(srv => this.connect(srv));
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
      console.log(`🔗 [TCP] Backup client connected to ${serverKey}`);
      this.sendReadyTcp(client, server.token);
      this.startTcpHeartbeat(client, serverKey);
      this.startSnapshotIntervalTcp(client, server.token, serverKey);
    });

    client.on('data', (data) => this.handleTcpData(client, data));
    client.on('close', () => {
      console.log(`🔌 [TCP] Disconnected from ${serverKey}, retrying in ${RECONNECT_DELAY/1000}s...`);
      this.cleanupTcp(serverKey);
      setTimeout(() => this.connect(server), RECONNECT_DELAY);
    });
    client.on('error', (err) => {
      console.error(`❌ [TCP] Socket error (${serverKey}): ${err.message}`);
      client.destroy();
    });

    this.sockets.push({ socket: client, server, serverKey, type: 'tcp' });
  }

  sendReadyTcp(client, token) {
    const msg = { type: 'READY', token, empty: db.getSeq() === 0 };
    client.write(JSON.stringify(msg) + '\n');
  }

  sendSnapshotTcp(client, token) {
    const state = db.exportFullState();
    const msg = { type: 'FULL_SNAPSHOT', token, state };
    client.write(JSON.stringify(msg) + '\n');
  }

  handleTcpData(client, data) {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'PONG') continue;
        if (msg.type === 'FULL_SNAPSHOT' && msg.state) {
          console.log('📥 [TCP] Received FULL_SNAPSHOT, restoring...');
          db.importFullState(msg.state);
          console.log('✅ Database restored from snapshot');
        }
      } catch (e) {
        if (!line.includes('ngrok') && !line.includes('HTTP/') && !line.startsWith('X-'))
          console.error('❌ Invalid JSON:', line.substring(0, 100));
      }
    }
  }

  startTcpHeartbeat(client, serverKey) {
    this.stopHeartbeat(serverKey);
    const interval = setInterval(() => {
      if (!client.destroyed) {
        client.write(JSON.stringify({ type: 'PING' }) + '\n');
      }
    }, HEARTBEAT_INTERVAL);
    this.heartbeats[serverKey] = interval;
  }

  stopHeartbeat(serverKey) {
    if (this.heartbeats[serverKey]) {
      clearInterval(this.heartbeats[serverKey]);
      delete this.heartbeats[serverKey];
    }
  }

  startSnapshotIntervalTcp(client, token, serverKey) {
    if (this.snapshotTimers[serverKey]) clearInterval(this.snapshotTimers[serverKey]);
    this.snapshotTimers[serverKey] = setInterval(() => {
      if (!client.destroyed) {
        this.sendSnapshotTcp(client, token);
      }
    }, SNAPSHOT_INTERVAL);
  }

  cleanupTcp(serverKey) {
    this.stopHeartbeat(serverKey);
    if (this.snapshotTimers[serverKey]) {
      clearInterval(this.snapshotTimers[serverKey]);
      delete this.snapshotTimers[serverKey];
    }
  }

  // ==================== HTTP/HTTPS ====================
  connectHttp(server) {
    const serverKey = `${server.host}:${server.port}`;
    const httpModule = server.protocol === 'https' ? https : http;
    const agent = server.protocol === 'https' ? httpsAgent : undefined;

    const baseOptions = {
      hostname: server.host,
      port: server.port,
      path: '/api/backup/sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': '1',
        'User-Agent': 'ChocoHub-BackupClient/1.0',
        'Accept': 'application/json',
        'Connection': 'keep-alive'
      },
      agent,
      rejectUnauthorized: false
    };

    const sendReady = () => {
      const payload = JSON.stringify({
        type: 'READY',
        token: server.token,
        empty: db.getSeq() === 0
      });

      const req = httpModule.request({ ...baseOptions }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          // 🆕 Bỏ qua nếu đã xử lý xong
          if (this.readyProcessed) return;

          if (res.statusCode === 200 && body.trim()) {
            try {
              const msg = JSON.parse(body);

              if (msg.type === 'READY_ACK') {
                this.pendingReady[serverKey] = { type: 'empty' };
              } else if (msg.type === 'FULL_SNAPSHOT' && msg.state) {
                const userCount = Array.isArray(msg.state.users) ? msg.state.users.length : 0;
                this.pendingReady[serverKey] = { type: 'snapshot', state: msg.state, userCount };
              } else {
                console.error(`❌ Unexpected response from ${serverKey}:`, msg.type);
                this.pendingReady[serverKey] = { type: 'empty' };
              }
            } catch (e) {
              console.error(`❌ Invalid JSON from ${serverKey}:`, body.substring(0, 200));
              this.pendingReady[serverKey] = { type: 'empty' };
            }
          } else {
            console.error(`❌ READY failed (${serverKey}) with status ${res.statusCode}`);
            this.pendingReady[serverKey] = { type: 'empty' };
          }

          if (!this.readyTimer) {
            this.readyTimer = setTimeout(() => this.checkAllReady(), READY_TIMEOUT);
          }
          this.checkAllReady();
        });
      });

      req.on('error', (err) => {
        if (this.readyProcessed) return;
        console.error(`❌ [HTTP] READY error (${serverKey}): ${err.message}`);
        this.pendingReady[serverKey] = { type: 'empty' };
        if (!this.readyTimer) this.readyTimer = setTimeout(() => this.checkAllReady(), READY_TIMEOUT);
        this.checkAllReady();
        setTimeout(() => sendReady(), RECONNECT_DELAY);
      });

      req.setTimeout(10000);
      req.write(payload);
      req.end();
    };

    sendReady();
  }

  checkAllReady() {
    // 🆕 Chỉ chạy 1 lần
    if (this.readyProcessed) return;

    const total = this.servers.length;
    const received = Object.keys(this.pendingReady).length;

    if (received < total && this.readyTimer) return;

    this.readyProcessed = true;
    if (this.readyTimer) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }

    console.log('📋 Processing READY responses from backup servers...');

    let bestSnapshot = null;
    let bestUserCount = -1;

    for (const [key, data] of Object.entries(this.pendingReady)) {
      console.log(`   ${key}: ${data.type}${data.userCount !== undefined ? ` (${data.userCount} users)` : ''}`);
      if (data.type === 'snapshot' && data.userCount > bestUserCount) {
        bestSnapshot = data.state;
        bestUserCount = data.userCount;
      }
    }

    if (bestSnapshot && bestUserCount > 0) {
      console.log(`📥 Restoring from best snapshot (${bestUserCount} users)...`);
      db.importFullState(bestSnapshot);
      console.log('✅ Database restored');
    } else {
      console.log('ℹ️ No valid backup data found – starting fresh');
    }

    for (const server of this.servers) {
      const key = `${server.host}:${server.port}`;
      this.readySent.add(key);
      this.startHttpHeartbeat(server, key);
      this.startHttpSnapshot(server, key);
    }

    this.pendingReady = {};
  }

  startHttpHeartbeat(server, serverKey) {
    const httpModule = server.protocol === 'https' ? https : http;
    const agent = server.protocol === 'https' ? httpsAgent : undefined;
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

    const heartbeat = () => {
      const req = httpModule.request(options, (res) => {
        res.resume();
        if (res.statusCode !== 200) {
          console.error(`⚠️ [HTTP] Heartbeat failed ${serverKey}: ${res.statusCode}`);
        }
      });
      req.on('error', (err) => {
        console.error(`❌ [HTTP] Heartbeat error ${serverKey}: ${err.message}`);
      });
      req.setTimeout(10000);
      req.write(JSON.stringify({ type: 'PING', token: server.token }));
      req.end();
    };

    if (this.heartbeats[serverKey]) clearInterval(this.heartbeats[serverKey]);
    this.heartbeats[serverKey] = setInterval(heartbeat, HEARTBEAT_INTERVAL);
  }

  startHttpSnapshot(server, serverKey) {
    const httpModule = server.protocol === 'https' ? https : http;
    const agent = server.protocol === 'https' ? httpsAgent : undefined;
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

    const sendSnapshot = () => {
      const state = db.exportFullState();
      const payload = JSON.stringify({
        type: 'FULL_SNAPSHOT',
        token: server.token,
        state
      });

      const req = httpModule.request(options, (res) => {
        if (res.statusCode !== 200) {
          console.error(`⚠️ Snapshot send failed ${serverKey}: ${res.statusCode}`);
        } else {
          console.log(`📤 Snapshot sent to ${serverKey}`);
        }
      });
      req.on('error', (err) => {
        console.error(`❌ Snapshot error ${serverKey}: ${err.message}`);
      });
      req.setTimeout(15000);
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
