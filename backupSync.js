// backupSync.js – Client đồng bộ real-time đến Backup Server
const net = require('net');
const https = require('https');
const http = require('http');
const db = require('./db');

const BACKUP_SERVERS = (process.env.BACKUP_SERVERS || '').split(',').filter(Boolean);
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || 'chocohub-default-token';
const RECONNECT_DELAY = 5000;
const HEARTBEAT_INTERVAL = 30000; // 30 giây heartbeat thay vì poll 5s

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
    this.readySent = new Set(); // Track server nào đã gửi READY
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
      
      // Chỉ gửi READY nếu chưa từng gửi hoặc reconnect
      if (!this.readySent.has(serverKey)) {
        this.sendReadyTcp(client, server.token);
        this.readySent.add(serverKey);
      } else {
        // Gửi RESYNC nhẹ hơn khi reconnect
        this.sendResyncTcp(client, server.token);
      }
      
      // Setup heartbeat để giữ connection alive
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
      this.readySent.delete(serverKey); // Reset để gửi lại READY khi reconnect
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
    // Clear heartbeat cũ nếu có
    this.stopHeartbeat(serverKey);
    
    // Gửi PING mỗi 30s để giữ kết nối
    const interval = setInterval(() => {
      if (!client.destroyed) {
        const heartbeat = { type: 'PING', timestamp: Date.now() };
        client.write(JSON.stringify(heartbeat) + '\n');
      }
    }, HEARTBEAT_INTERVAL);
    
    // Lưu interval để cleanup
    if (!this.heartbeats) this.heartbeats = {};
    this.heartbeats[serverKey] = interval;
  }

  stopHeartbeat(serverKey) {
    if (this.heartbeats && this.heartbeats[serverKey]) {
      clearInterval(this.heartbeats[serverKey]);
      delete this.heartbeats[serverKey];
    }
  }

  handleDataTcp(client, data, server) {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        // Bỏ qua PONG responses
        if (msg.type === 'PONG') return;
        this.processMessage(msg, server);
      } catch (e) {
        if (line.includes('ngrok') || line.includes('HTTP/') || line.startsWith('X-')) return;
        console.error('❌ Invalid JSON from backup:', line.substring(0, 100));
      }
    }
  }

  // ==================== HTTP/HTTPS Connection ====================
  connectHttp(server) {
    const serverKey = `${server.host}:${server.port}`;
    const httpModule = server.protocol === 'https' ? https : http;
    
    const options = {
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
      const readyOptions = { ...options };
      const currentSeq = db.getSeq();
      const isEmpty = currentSeq === 0;
      const payload = JSON.stringify({
        type: 'READY',
        token: server.token,
        seq: currentSeq,
        empty: isEmpty
      });

      const req = httpModule.request(readyOptions, (res) => {
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
                // Sau READY thành công, chuyển sang heartbeat
                setTimeout(() => startHeartbeat(), HEARTBEAT_INTERVAL);
              }
            } catch (e) {
              console.error('❌ Invalid READY response:', body.substring(0, 200));
              setTimeout(() => sendReady(), RECONNECT_DELAY);
            }
          } else {
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

    // Heartbeat nhẹ, chỉ kiểm tra sync
    const startHeartbeat = () => {
      const doHeartbeat = () => {
        const currentSeq = db.getSeq();
        const payload = JSON.stringify({
          type: 'PING',
          token: server.token,
          seq: currentSeq
        });

        const req = httpModule.request(options, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            // Chỉ log khi cần debug
            if (res.statusCode !== 200) {
              console.error(`⚠️ [HTTP] Heartbeat failed (${serverKey}): ${res.statusCode}`);
              // Nếu heartbeat fail liên tục, gửi lại READY
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
            } catch (e) {
              // Bỏ qua lỗi parse trong heartbeat
            }
            
            // Lên lịch heartbeat tiếp theo
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
      
      // Lưu để cleanup nếu cần
      this.httpClients.push({ server, serverKey, startHeartbeat, sendReady });
    };

    // Bắt đầu với READY
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
        // Heartbeat response, không cần log
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
    
    // Gửi qua TCP
    this.sockets.forEach(({ socket }) => {
      if (!socket.destroyed) {
        try { 
          socket.write(data); 
        } catch (e) {
          console.error(`❌ TCP broadcast error: ${e.message}`);
        }
      }
    });

    // Gửi qua HTTP ngay lập tức (không đợi heartbeat)
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
        'User-Agent': 'ChocoHub-BackupClient/1.0'
      },
      rejectUnauthorized: false
    };
    
    const req = httpModule.request(options, (res) => {
      // Không cần xử lý response, chỉ log nếu lỗi
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
