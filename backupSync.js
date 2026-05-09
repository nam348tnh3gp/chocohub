// backupSync.js – Client đồng bộ real-time đến Backup Server
const net = require('net');
const https = require('https');
const http = require('http');
const db = require('./db');

const BACKUP_SERVERS = (process.env.BACKUP_SERVERS || '').split(',').filter(Boolean);
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || 'chocohub-default-token';
const RECONNECT_DELAY = 5000; // 5 giây

class BackupClient {
  constructor() {
    // Phân tích danh sách server từ env: 
    // TCP: "host:port" hoặc "token@host:port"
    // HTTP/HTTPS: "https://host" hoặc "http://host:port"
    this.servers = BACKUP_SERVERS.map(cfg => {
      const [token, hostPort] = cfg.includes('@') ? cfg.split('@') : [BACKUP_TOKEN, cfg];
      
      // Tự động nhận diện protocol
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
      
      // TCP raw
      const [host, port] = hostPort.split(':');
      return { token, protocol: 'tcp', host, port: parseInt(port) || 3001 };
    });
    
    this.sockets = [];
    this.httpClients = [];
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
    const client = new net.Socket();
    
    client.connect(server.port, server.host, () => {
      console.log(`🔗 [TCP] Backup client connected to ${server.host}:${server.port}`);
      this.sendReadyTcp(client, server.token);
    });

    client.on('data', (data) => this.handleDataTcp(client, data, server));
    client.on('close', () => {
      console.log(`🔌 [TCP] Disconnected from ${server.host}:${server.port}, retrying in ${RECONNECT_DELAY/1000}s...`);
      setTimeout(() => this.connect(server), RECONNECT_DELAY);
    });
    client.on('error', (err) => {
      console.error(`❌ [TCP] Socket error (${server.host}:${server.port}): ${err.message}`);
      client.destroy();
    });
    
    this.sockets.push({ socket: client, server, type: 'tcp' });
  }

  sendReadyTcp(client, token) {
    const currentSeq = db.getSeq();
    const isEmpty = currentSeq === 0;
    const msg = { type: 'READY', token, seq: currentSeq, empty: isEmpty };
    client.write(JSON.stringify(msg) + '\n');
    console.log(`📤 [TCP] Sent READY (seq=${currentSeq}, empty=${isEmpty})`);
  }

  handleDataTcp(client, data, server) {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        this.processMessage(msg, server);
      } catch (e) {
        // Bỏ qua noise từ ngrok interstitial
        if (line.includes('ngrok') || line.includes('HTTP/') || line.startsWith('X-')) return;
        console.error('❌ Invalid JSON from backup:', line.substring(0, 100));
      }
    }
  }

  // ==================== HTTP/HTTPS Connection ====================
  connectHttp(server) {
    const httpModule = server.protocol === 'https' ? https : http;
    
    const options = {
      hostname: server.host,
      port: server.port,
      path: '/api/backup/sync',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': '1',        // Bỏ qua interstitial
        'User-Agent': 'ChocoHub-BackupClient/1.0', // Custom User-Agent
        'Accept': 'application/json',
        'Connection': 'keep-alive'
      },
      rejectUnauthorized: false // Cho phép self-signed cert nếu có
    };

    const doRequest = () => {
      const req = httpModule.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          console.log(`🔗 [HTTPS] Connected to ${server.host}, status: ${res.statusCode}`);
          
          // Xử lý redirect 3xx
          if (res.statusCode >= 300 && res.statusCode < 400) {
            console.log(`↪️ Redirect to: ${res.headers.location}`);
            return;
          }
          
          if (res.statusCode === 503) {
            console.error('❌ Ngrok gateway error - có thể header chưa đúng hoặc backend không reachable');
            console.error('Body:', body.substring(0, 200));
            setTimeout(() => doRequest(), RECONNECT_DELAY);
            return;
          }
          
          try {
            if (body.trim()) {
              const msg = JSON.parse(body);
              this.processMessage(msg, server);
            }
          } catch (e) {
            console.error('❌ Invalid response from backup:', body.substring(0, 200));
          }
          
          // Poll tiếp sau 5s
          setTimeout(() => doRequest(), 5000);
        });
      });

      req.on('error', (err) => {
        console.error(`❌ [HTTPS] Request error (${server.host}): ${err.message}`);
        setTimeout(() => this.connect(server), RECONNECT_DELAY);
      });

      req.on('timeout', () => {
        console.error('⏰ [HTTPS] Request timeout');
        req.destroy();
        setTimeout(() => this.connect(server), RECONNECT_DELAY);
      });

      req.setTimeout(10000); // 10s timeout

      const currentSeq = db.getSeq();
      const isEmpty = currentSeq === 0;
      const payload = JSON.stringify({
        type: 'READY',
        token: server.token,
        seq: currentSeq,
        empty: isEmpty
      });

      req.write(payload);
      req.end();
      console.log(`📤 [HTTPS] Sent READY (seq=${currentSeq}, empty=${isEmpty})`);
    };

    doRequest();
    this.httpClients.push({ server, doRequest });
  }

  // ==================== Message Processing ====================
  processMessage(msg, server) {
    switch (msg.type) {
      case 'READY_ACK':
        console.log(`✅ Backup server ${server.host}:${server.port} ack, last seq=${msg.seq}`);
        break;
      case 'FULL_BACKUP':
        if (db.getSeq() === 0) {
          console.log(`📥 Receiving full backup (${msg.rows ? msg.rows.length : 0} items)...`);
          this.restoreFromBackup(msg.rows || []);
        } else {
          console.log('⚠️ Ignoring FULL_BACKUP because local DB is not empty.');
        }
        break;
      case 'DELTA':
        console.log(`🔄 Received delta from backup: ${msg.action || 'unknown'}`);
        break;
      default:
        console.log('❓ Unknown message from backup:', msg.type);
    }
  }

  restoreFromBackup(rows) {
    console.log('🔄 Restore function not fully implemented yet. Would restore', rows.length, 'items.');
  }

  // ==================== Broadcast ====================
  broadcast(deltaMsg) {
    const data = JSON.stringify(deltaMsg) + '\n';
    
    // Gửi qua TCP
    this.sockets.forEach(({ socket }) => {
      try { socket.write(data); } catch (e) {}
    });

    // HTTP clients tự poll nên không cần push real-time
  }
}

// Singleton
const backupClient = new BackupClient();
module.exports = backupClient;
