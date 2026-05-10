// backupSync.js – Client đồng bộ real-time đến Backup Server
const net = require('net');
const https = require('https');
const http = require('http');
const db = require('./db');

const BACKUP_SERVERS = (process.env.BACKUP_SERVERS || '').split(',').filter(Boolean);
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || 'chocohub-default-token';
const RECONNECT_DELAY = 5000;
const HEARTBEAT_INTERVAL = 30000; // 30 giây heartbeat

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
    this.httpClients = [];
    this.readySent = new Set();
    this.heartbeats = {}; // lưu interval cho TCP
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

  // ==================== TCP Connection ====================
  connectTcp(server) {
    const serverKey = `${server.host}:${server.port}`;
    const client = new net.Socket();
    
    client.connect(server.port, server.host, () => {
      console.log(`🔗 [TCP] Backup client connected to ${serverKey}`);
      
      if (!this.readySent.has(serverKey)) {
        this.sendReadyTcp(client, server.token);
        this.readySent.add(serverKey);
      } else {
        this.sendResyncTcp(client, server.token);
      }
      
      this.startTcpHeartbeat(client, serverKey);
    });

    client.on('data', (data) => this.handleDataTcp(client, data, server));
    client.on('close', () => {
      console.log(`🔌 [TCP] Disconnected from ${serverKey}, retrying in ${RECONNECT_DELAY/1000}s...`);
      this.stopHeartbeat(serverKey);
      setTimeout(() => this.connect(server), RECONNECT_DELAY);
    });
    client.on('error', (err) => {
      console.error(`❌ [TCP] Socket error (${serverKey}): ${err.message}`);
      this.readySent.delete(serverKey);
      client.destroy();
    });
    
    this.sockets.push({ socket: client, server, serverKey, type: 'tcp' });
  }

  sendReadyTcp(client, token) {
    const currentSeq = db.getSeq();
    const isEmpty = currentSeq === 0;
    const msg = { type: 'READY', token, seq: currentSeq, empty: isEmpty };
    client.write(JSON.stringify(msg) + '\n');
    console.log(`📤 [TCP] Sent READY (seq=${currentSeq}, empty=${isEmpty})`);
  }

  sendResyncTcp(client, token) {
    const currentSeq = db.getSeq();
    const msg = { type: 'RESYNC', token, seq: currentSeq };
    client.write(JSON.stringify(msg) + '\n');
    console.log(`📤 [TCP] Sent RESYNC (seq=${currentSeq})`);
  }

  startTcpHeartbeat(client, serverKey) {
    this.stopHeartbeat(serverKey);
    
    const interval = setInterval(() => {
      if (!client.destroyed) {
        const heartbeat = { type: 'PING', timestamp: Date.now() };
        client.write(JSON.stringify(heartbeat) + '\n');
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

  handleDataTcp(client, data, server) {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'PONG') continue;
        this.processMessage(msg, server);
      } catch (e) {
        if (line.includes('ngrok') || line.includes('HTTP/') || line.startsWith('X-')) continue;
        console.error('❌ Invalid JSON from backup:', line.substring(0, 100));
      }
    }
  }

  // ==================== HTTP/HTTPS Connection ====================
  connectHttp(server) {
    const serverKey = `${server.host}:${server.port}`;
    const httpModule = server.protocol === 'https' ? https : http;
    
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
      rejectUnauthorized: false
    };

    // Gửi READY lần đầu
    const sendReady = () => {
      const currentSeq = db.getSeq();
      const isEmpty = currentSeq === 0;
      const payload = JSON.stringify({
        type: 'READY',
        token: server.token,
        seq: currentSeq,
        empty: isEmpty
      });

      const req = httpModule.request({ ...baseOptions }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          console.log(`🔗 [HTTP] Initial connection to ${serverKey}, status: ${res.statusCode}`);
          
          if (res.statusCode === 200 && body.trim()) {
            try {
              const msg = JSON.parse(body);
              if (msg.type === 'READY_ACK') {
                console.log(`✅ [HTTP] Server ${serverKey} acknowledged READY`);
                this.readySent.add(serverKey);
                setTimeout(() => startHeartbeat(), HEARTBEAT_INTERVAL);
              } else if (msg.type === 'FULL_BACKUP') {
                // Backup server gửi ngay full backup
                console.log(`📥 [HTTP] Received FULL_BACKUP in READY response`);
                this.processMessage(msg, server);
                this.readySent.add(serverKey);
                setTimeout(() => startHeartbeat(), HEARTBEAT_INTERVAL);
              } else {
                console.error('❌ Unexpected READY response type:', msg.type);
                setTimeout(() => sendReady(), RECONNECT_DELAY);
              }
            } catch (e) {
              console.error('❌ Invalid READY response:', body.substring(0, 200));
              setTimeout(() => sendReady(), RECONNECT_DELAY);
            }
          } else {
            console.error(`❌ READY failed with status ${res.statusCode}`);
            setTimeout(() => sendReady(), RECONNECT_DELAY);
          }
        });
      });

      req.on('error', (err) => {
        console.error(`❌ [HTTP] READY error (${serverKey}): ${err.message}`);
        setTimeout(() => sendReady(), RECONNECT_DELAY);
      });

      req.setTimeout(10000);
      req.write(payload);
      req.end();
      console.log(`📤 [HTTP] Sent READY to ${serverKey} (seq=${currentSeq}, empty=${isEmpty})`);
    };

    // Heartbeat định kỳ
    const startHeartbeat = () => {
      const doHeartbeat = () => {
        const currentSeq = db.getSeq();
        const payload = JSON.stringify({
          type: 'PING',
          token: server.token,
          seq: currentSeq
        });

        const req = httpModule.request({ ...baseOptions }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            if (res.statusCode !== 200) {
              console.error(`⚠️ [HTTP] Heartbeat failed (${serverKey}): ${res.statusCode}`);
              this.readySent.delete(serverKey);
              setTimeout(() => sendReady(), RECONNECT_DELAY);
              return;
            }
            
            try {
              if (body.trim()) {
                const msg = JSON.parse(body);
                if (msg.type !== 'PONG') {
                  this.processMessage(msg, server);
                }
              }
            } catch (e) {}
            
            setTimeout(() => doHeartbeat(), HEARTBEAT_INTERVAL);
          });
        });

        req.on('error', (err) => {
          console.error(`❌ [HTTP] Heartbeat error (${serverKey}): ${err.message}`);
          this.readySent.delete(serverKey);
          setTimeout(() => sendReady(), RECONNECT_DELAY);
        });

        req.setTimeout(10000);
        req.write(payload);
        req.end();
      };

      doHeartbeat();
      this.httpClients.push({ server, serverKey, startHeartbeat, sendReady });
    };

    sendReady();
  }

  // ==================== Message Processing ====================
  processMessage(msg, server) {
    switch (msg.type) {
      case 'READY_ACK':
        console.log(`✅ Backup server ${server.host}:${server.port} ack, last seq=${msg.seq}`);
        break;
        
      case 'FULL_BACKUP':
        console.log(`📥 Receiving full backup (${msg.rows ? msg.rows.length : 0} items)...`);
        this.restoreFromBackup(msg.rows || []);
        break;
        
      case 'DELTA':
        console.log(`🔄 Received delta from backup: ${msg.action || 'unknown'}`);
        if (msg.action && msg.payload) {
          db.applyDelta({
            action: msg.action,
            username: msg.username,
            payload: msg.payload
          });
        }
        break;
        
      case 'PONG':
        break;
        
      default:
        console.log('❓ Unknown message from backup:', msg.type);
    }
  }

  restoreFromBackup(rows) {
    console.log(`🔄 Restoring ${rows.length} items from backup...`);
    let restored = 0;
    rows.forEach(row => {
      try {
        if (row.type === 'DELTA' && row.payload) {
          db.applyDelta({
            action: row.payload.action || row.action || 'unknown',
            username: row.payload.username || row.username || 'unknown',
            payload: row.payload.payload || row.payload
          });
          restored++;
        }
      } catch (e) {
        console.error(`❌ Error restoring row: ${e.message}`);
      }
    });
    console.log(`✅ Restored ${restored}/${rows.length} items from backup`);
  }

  // ==================== Broadcast ====================
  broadcast(deltaMsg) {
    const data = JSON.stringify(deltaMsg) + '\n';
    
    // TCP
    this.sockets.forEach(({ socket }) => {
      if (!socket.destroyed) {
        try { socket.write(data); } catch (e) {
          console.error(`❌ TCP broadcast error: ${e.message}`);
        }
      }
    });

    // HTTP/HTTPS
    this.httpClients.forEach(({ server }) => {
      this.sendDeltaHttp(server, deltaMsg);
    });
  }
  
  sendDeltaHttp(server, deltaMsg) {
    const httpModule = server.protocol === 'https' ? https : http;
    const payload = JSON.stringify({
      type: 'DELTA',
      token: server.token,
      seq: deltaMsg.seq,
      action: deltaMsg.action,
      username: deltaMsg.username,
      payload: deltaMsg.payload,
      dbHash: deltaMsg.dbHash
    });
    
    const options = {
      hostname: server.host,
      port: server.port,
      path: '/api/backup/sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ChocoHub-BackupClient/1.0',
        'ngrok-skip-browser-warning': '1',   // Quan trọng cho ngrok
        'Accept': 'application/json',
        'Connection': 'keep-alive'
      },
      rejectUnauthorized: false
    };
    
    const req = httpModule.request(options, (res) => {
      if (res.statusCode !== 200) {
        console.error(`⚠️ HTTP delta failed: ${res.statusCode}`);
      }
    });
    
    req.on('error', (err) => {
      console.error(`❌ HTTP delta error: ${err.message}`);
    });
    
    req.setTimeout(5000);
    req.write(payload);
    req.end();
  }
}

// Singleton
const backupClient = new BackupClient();
module.exports = backupClient;
