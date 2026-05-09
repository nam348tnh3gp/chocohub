// backupSync.js – Client đồng bộ real-time đến Backup Server
const net = require('net');
const db = require('./db');

const BACKUP_SERVERS = (process.env.BACKUP_SERVERS || '').split(',').filter(Boolean);
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || 'chocohub-default-token';
const RECONNECT_DELAY = 5000; // 5 giây

class BackupClient {
  constructor() {
    // Phân tích danh sách server từ env: "token@host:port,token@host2:port2"
    this.servers = BACKUP_SERVERS.map(cfg => {
      const [token, hostPort] = cfg.includes('@') ? cfg.split('@') : [BACKUP_TOKEN, cfg];
      const [host, port] = hostPort.split(':');
      return { token, host, port: parseInt(port) };
    });
    this.sockets = [];
  }

  // Gọi khi server.js khởi động xong
  start() {
    if (this.servers.length === 0) {
      console.log('ℹ️ No backup servers configured. Skipping backup sync.');
      return;
    }
    console.log(`🔁 Backup sync starting to ${this.servers.length} server(s)...`);
    this.servers.forEach(srv => this.connect(srv));
  }

  connect(server) {
    const client = new net.Socket();
    client.connect(server.port, server.host, () => {
      console.log(`🔗 Backup client connected to ${server.host}:${server.port}`);
      this.sendReady(client, server.token);
    });

    client.on('data', (data) => this.handleData(client, data, server));
    client.on('close', () => {
      console.log(`🔌 Disconnected from ${server.host}:${server.port}, retrying in ${RECONNECT_DELAY/1000}s...`);
      setTimeout(() => this.connect(server), RECONNECT_DELAY);
    });
    client.on('error', (err) => {
      console.error(`Backup socket error (${server.host}:${server.port}): ${err.message}`);
      client.destroy();
    });
    this.sockets.push({ socket: client, server });
  }

  sendReady(client, token) {
    const currentSeq = db.getSeq();
    const isEmpty = currentSeq === 0; // DB chưa có dữ liệu → yêu cầu backup gửi FULL
    const msg = {
      type: 'READY',
      token,
      seq: currentSeq,
      empty: isEmpty
    };
    client.write(JSON.stringify(msg) + '\n');
    console.log(`📤 Sent READY (seq=${currentSeq}, empty=${isEmpty}) to backup server`);
  }

  handleData(client, data, server) {
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        this.processMessage(client, msg, server);
      } catch (e) {
        console.error('Invalid JSON from backup:', line);
      }
    }
  }

  processMessage(client, msg, server) {
    switch (msg.type) {
      case 'READY_ACK':
        console.log(`✅ Backup server ${server.host}:${server.port} ack, last seq=${msg.seq}`);
        // Nếu backup có seq cao hơn → có thể họ sẽ gửi FULL_BACKUP tiếp
        break;
      case 'FULL_BACKUP':
        // Chỉ nhận full backup nếu server chính đang trống (empty = true)
        if (db.getSeq() === 0) {
          console.log(`📥 Receiving full backup (${msg.rows ? msg.rows.length : 0} items)...`);
          this.restoreFromBackup(msg.rows || []);
        } else {
          console.log('⚠️ Ignoring FULL_BACKUP because local DB is not empty.');
        }
        break;
      default:
        console.log('Unknown message from backup:', msg.type);
    }
  }

  restoreFromBackup(rows) {
    // Sẽ được mở rộng để khôi phục toàn bộ các bảng
    // Hiện tại log và đánh dấu seq mới nhất
    console.log('🔄 Restore function not fully implemented yet. Would restore', rows.length, 'items.');
    // Sau này sẽ INSERT INTO các bảng tương ứng, đồng bộ seq
  }

  // Gửi dữ liệu delta (một thay đổi) đến tất cả backup server
  broadcast(deltaMsg) {
    const data = JSON.stringify(deltaMsg) + '\n';
    this.sockets.forEach(({ socket }) => {
      try { socket.write(data); } catch (e) {}
    });
  }
}

// Singleton
const backupClient = new BackupClient();
module.exports = backupClient;
