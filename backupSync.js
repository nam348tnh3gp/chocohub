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
const READY_TIMEOUT = 10000;             // 10s cho 1 request READY
const RETRY_INTERVAL = 30000;            // 30s thử lại server lỗi

// Cria agent TLS por hostname (SNI correto por servidor)
// servername: undefined quebrava SNI no Render/ngrok — corrigido
function makeHttpsAgent(hostname) {
  return new https.Agent({
    rejectUnauthorized: false,
    minVersion: 'TLSv1.2',
    checkServerIdentity: () => undefined,
    servername: hostname,   // SNI obrigatório
    keepAlive: true,
    timeout: 20000
  });
}

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
    this.restored = false;               // Đã restore chưa?
    this.activeServers = new Set();      // Server đã kết nối thành công
    this.heartbeatLogCounter = {};       // Đếm số lần heartbeat để giảm log spam
  }

  start() {
    if (this.servers.length === 0) {
      console.log('ℹ️ No backup servers configured. Skipping backup sync.');
      return;
    }
    console.log(`🔁 Backup sync starting to ${this.servers.length} server(s)...`);
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
      console.log(`🔗 [TCP] Connected to ${serverKey}`);
      this.sendReadyTcp(client, server);
      this.startTcpHeartbeat(client, serverKey);
      this.startSnapshotIntervalTcp(client, server, serverKey);
    });

    client.on('data', (data) => this.handleTcpData(client, data));
    client.on('close', () => {
      console.log(`🔌 [TCP] Disconnected ${serverKey}, retry in ${RECONNECT_DELAY/1000}s...`);
      this.cleanupTcp(serverKey);
      setTimeout(() => this.connect(server), RECONNECT_DELAY);
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
    // FIX: agent por hostname garante SNI correto
    const agent = server.protocol === 'https' ? makeHttpsAgent(server.host) : undefined;

    const tryReady = () => {
      // Se já restaurou, só precisa de heartbeat + snapshot
      if (this.restored) {
        if (!this.heartbeats[serverKey])    this.startHttpHeartbeat(server, serverKey, agent);
        if (!this.snapshotTimers[serverKey]) this.startHttpSnapshot(server, serverKey, agent);
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
          // Outro servidor já restaurou enquanto esperávamos
          if (this.restored) {
            if (!this.heartbeats[serverKey])    this.startHttpHeartbeat(server, serverKey, agent);
            if (!this.snapshotTimers[serverKey]) this.startHttpSnapshot(server, serverKey, agent);
            return;
          }

          if (res.statusCode === 200 && body.trim()) {
            try {
              const msg = JSON.parse(body);

              // Backup tem dados e main está vazio → restaura
              if (msg.type === 'FULL_SNAPSHOT' && msg.state) {
                const users = Array.isArray(msg.state.users) ? msg.state.users.length : 0;
                if (users > 0) {
                  console.log(`📥 [HTTP] Restaurando de ${serverKey} (${users} users)...`);
                  db.importFullState(msg.state);
                  this.restored = true;
                  console.log('✅ Database restaurado');
                }
                // Mesmo com 0 users, inicia sync normal
                this.startHttpHeartbeat(server, serverKey, agent);
                this.startHttpSnapshot(server, serverKey, agent);
                return;
              }

              // FIX BUG 2: READY_ACK = main já tem dados → inicia heartbeat+snapshot imediatamente
              // Antes caia no setTimeout(tryReady) = loop eterno sem nunca enviar snapshots
              if (msg.type === 'READY_ACK') {
                console.log(`🔗 [HTTP] Conectado a ${serverKey} (main já tem dados)`);
                this.restored = true;
                this.startHttpHeartbeat(server, serverKey, agent);
                this.startHttpSnapshot(server, serverKey, agent);
                return;
              }

            } catch (e) {
              console.error(`❌ Parse error ${serverKey}:`, body.substring(0, 120));
            }
          } else {
            console.error(`❌ ${serverKey} status ${res.statusCode}, retry em ${RETRY_INTERVAL/1000}s...`);
          }

          // Falhou → tenta novamente
          setTimeout(() => tryReady(), RETRY_INTERVAL);
        });
      });

      req.on('error', (err) => {
        if (this.restored) {
          if (!this.heartbeats[serverKey])    this.startHttpHeartbeat(server, serverKey, agent);
          if (!this.snapshotTimers[serverKey]) this.startHttpSnapshot(server, serverKey, agent);
          return;
        }
        console.error(`❌ ${serverKey} erro: ${err.message}, retry em ${RETRY_INTERVAL/1000}s...`);
        setTimeout(() => tryReady(), RETRY_INTERVAL);
      });

      // FIX BUG 1: handler obrigatório para o timeout não travar o request
      req.on('timeout', () => {
        console.error(`⏱ ${serverKey} READY timeout (${READY_TIMEOUT/1000}s), abortando...`);
        req.destroy(new Error('READY timeout'));
      });
      req.setTimeout(READY_TIMEOUT);
      req.write(payload);
      req.end();
    };

    tryReady();
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
          if (this.heartbeatLogCounter[serverKey] % 10 === 0) {
            console.log(`💚 Heartbeat OK (${serverKey})`);
          }
        } else {
          console.error(`⚠️ [HTTP] Heartbeat failed ${serverKey}: ${res.statusCode}`);
        }
      });
      req.on('error', (err) => console.error(`❌ [HTTP] Heartbeat error ${serverKey}: ${err.message}`));
      // FIX: handler de timeout obrigatório
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

    // FIX BUG 4: deduplicação — não envia se snapshot não mudou
    let lastSnapshotHash = null;

    const sendSnapshot = () => {
      const state   = db.exportFullState();
      const payload = JSON.stringify({ type: 'FULL_SNAPSHOT', token: server.token, state });
      const hash    = crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);

      if (hash === lastSnapshotHash) {
        console.log(`⏭ Snapshot inalterado, pulando envio para ${serverKey}`);
        return;
      }

      const reqOpts = { ...options, headers: { ...options.headers, 'Content-Length': Buffer.byteLength(payload) } };
      const req = httpModule.request(reqOpts, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          lastSnapshotHash = hash;
          console.log(`📤 Snapshot enviado a ${serverKey} (hash ${hash})`);
        } else {
          console.error(`⚠️ Snapshot falhou ${serverKey}: ${res.statusCode}`);
        }
      });
      req.on('error', (err) => console.error(`❌ Snapshot erro ${serverKey}: ${err.message}`));
      // FIX: handler de timeout
      req.on('timeout', () => req.destroy(new Error('snapshot timeout')));
      req.setTimeout(20000);
      req.write(payload);
      req.end();
    };

    if (this.snapshotTimers[serverKey]) clearInterval(this.snapshotTimers[serverKey]);
    this.snapshotTimers[serverKey] = setInterval(sendSnapshot, SNAPSHOT_INTERVAL);
    sendSnapshot(); // envia imediatamente na conexão
  }
}

// Singleton
const backupClient = new BackupClient();
module.exports = backupClient;
