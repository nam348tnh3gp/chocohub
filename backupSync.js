// backupSync.js – Client đồng bộ full-snapshot + TLS 1.3 + DH (có fallback token)
// ✅ FIX: KHÔNG gửi token trong body khi dùng DH mode
// ✅ FIX: Xóa bodyObj.token trong sendWithDH

const net = require('net');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const db = require('./db');
const DHExchange = require('./dh');

// ─── Cấu hình từ môi trường ────────────────────────────
const BACKUP_SERVERS = (process.env.BACKUP_SERVERS || '').split(',').filter(Boolean);
const BACKUP_TOKEN = process.env.BACKUP_TOKEN || 'chocohub';
const RECONNECT_DELAY = 5000;
const HEARTBEAT_INTERVAL = 30000;
const SNAPSHOT_INTERVAL = 300000;
const READY_TIMEOUT = 60000;
const RETRY_INTERVAL = 30000;
const NODE_SYNC_INTERVAL = 300000;
const MAX_RETRIES = 5;
const MAX_HEARTBEAT_FAILURES = 3;

// ─── Helper: canonical JSON ─────────────────────────────
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(k => `"${k}":${canonicalStringify(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

// ─── TLS Agent ────────────────────────────────────────────
function makeSecureHttpsAgent(hostname, allowUnauthorized = false) {
  return new https.Agent({
    rejectUnauthorized: !allowUnauthorized,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    servername: hostname,
    keepAlive: false,
  });
}

class BackupClient {
  constructor() {
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
          isDynamic: false,
          dhSupported: true
        };
      }
      const [host, port] = hostPort.split(':');
      return { token, protocol: 'tcp', host, port: parseInt(port) || 3001, isDynamic: false, dhSupported: false };
    });

    this.servers = [...this.staticServers];
    this.sockets = [];
    this.heartbeats = {};
    this.snapshotTimers = {};
    this.restored = false;
    this.activeServers = new Set();
    this.heartbeatLogCounter = {};
    this.heartbeatFailureCount = {};
    this.knownHosts = new Set(this.servers.map(s => s.host));
    this.retryCount = {};
    this.failedNodes = new Set();

    this.dhSessions = new Map();
    this.clientBaseId = `backup-${os.hostname()}-${process.pid}`;
    this.serverPublicKeys = new Map();
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
          if (parsed.status !== 'success' || !parsed.nodes) {
            console.log('ℹ️ No nodes data from /api/backup/nodes');
            return;
          }

          let nodeUrls = [];
          if (Array.isArray(parsed.nodes)) {
            nodeUrls = parsed.nodes
              .filter(item => item && typeof item.url === 'string')
              .map(item => item.url);
          } else if (typeof parsed.nodes === 'object') {
            nodeUrls = Object.keys(parsed.nodes).filter(key => typeof key === 'string');
          } else {
            console.log('ℹ️ Invalid nodes format from /api/backup/nodes');
            return;
          }

          let found = 0;
          for (const rawUrl of nodeUrls) {
            let urlStr = rawUrl.trim();
            if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
              urlStr = 'https://' + urlStr;
            }

            let parsedUrl;
            try {
              parsedUrl = new URL(urlStr);
            } catch (e) {
              console.warn(`⚠️ Skipping invalid node URL: ${rawUrl} (${e.message})`);
              continue;
            }

            const host = parsedUrl.hostname;
            if (!this.knownHosts.has(host) || this.failedNodes.has(host)) {
              const isStatic = this.staticServers.some(s => s.host === host);
              if (isStatic) continue;

              this.failedNodes.delete(host);

              const newServer = {
                token: BACKUP_TOKEN,
                protocol: parsedUrl.protocol.replace(':', ''),
                host: host,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname || '/',
                isDynamic: true,
                dhSupported: true
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
        } catch (e) {
          console.error('❌ Failed to parse dynamic nodes:', e.message);
        }
      });
    });
    req.on('error', (err) => console.warn('⚠️ Node sync request error:', err.message));
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
      this.retryCount[serverKey] = 0;
      this.heartbeatFailureCount[serverKey] = 0;
      this.sendReadyTcp(client, server);
      this.startTcpHeartbeat(client, serverKey);
      this.startSnapshotIntervalTcp(client, server, serverKey);
    });

    client.on('data', (data) => this.handleTcpData(client, data));
    client.on('close', () => {
      console.log(`🔌 [TCP] Disconnected ${serverKey}, will retry...`);
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
            ['swap_holding', 'swap_liquidity', 'mempool_holding', 'node_fees'].forEach(name => {
              if (!db.getUser(name)) {
                const pin = crypto.randomBytes(16).toString('hex');
                db.authenticate(name, pin);
                console.log(`🏦 Re-created ${name} account after restore`);
              }
            });
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

  // ==================== Lấy public key ====================
  async fetchServerPublicKey(server, agent) {
    const httpModule = server.protocol === 'https' ? https : http;
    const serverKey = `${server.host}:${server.port}`;
    return new Promise((resolve) => {
      const req = httpModule.get({
        hostname: server.host,
        port: server.port,
        path: '/api/server/public-key',
        agent,
        rejectUnauthorized: true,
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.publicKey) {
              this.serverPublicKeys.set(serverKey, json.publicKey);
              console.log(`🔑 Server public key obtained for ${server.host}`);
              resolve(true);
            } else {
              resolve(false);
            }
          } catch { resolve(false); }
        });
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  // ==================== DH Exchange ====================
  async performSecureDHExchange(server, serverKey, agent) {
    let serverPubKey = this.serverPublicKeys.get(serverKey);
    if (!serverPubKey) {
      const fetched = await this.fetchServerPublicKey(server, agent);
      if (!fetched) {
        console.log(`⚠️ Cannot fetch server public key for ${serverKey}, falling back to token mode`);
        return null;
      }
      serverPubKey = this.serverPublicKeys.get(serverKey);
    }

    const httpModule = server.protocol === 'https' ? https : http;
    const clientDHKeys = DHExchange.generateStandardKeyPair('modp2048');
    const clientId = `${this.clientBaseId}-${serverKey}`;

    const payload = canonicalStringify({
      clientId,
      clientPublicKey: clientDHKeys.publicKey,
      token: server.token  // ✅ CHỈ GỬI TOKEN TRONG DH EXCHANGE
    });

    return new Promise((resolve) => {
      const req = httpModule.request({
        hostname: server.host,
        port: server.port,
        path: '/api/dh/exchange',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'ChocoHub-BackupClient/1.0'
        },
        agent,
        rejectUnauthorized: true,
        timeout: 10000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            console.log(`⚠️ DH exchange failed for ${serverKey}: status ${res.statusCode}, falling back to token mode`);
            return resolve(null);
          }
          try {
            const data = JSON.parse(body);
            if (!data.serverPublicKey || !data.prime || !data.generator || !data.serverSignature) {
              console.log(`⚠️ DH exchange incomplete for ${serverKey}, falling back to token mode`);
              return resolve(null);
            }

            const serverPubData = canonicalStringify({
              publicKey: data.serverPublicKey,
              prime: data.prime,
              generator: data.generator,
              group: data.group
            });
            const isValid = DHExchange.verifyWithPublicKey(
              serverPubData,
              data.serverSignature,
              serverPubKey
            );
            if (!isValid) {
              console.log(`⚠️ Server signature verification FAILED for ${serverKey}, falling back to token mode`);
              return resolve(null);
            }

            const sharedSecret = DHExchange.computeSharedSecret(
              clientDHKeys.privateKey,
              data.serverPublicKey,
              data.prime,
              data.generator
            );
            const sessionKey = DHExchange.deriveSessionKey(sharedSecret);
            console.log(`🔐 Secure DH session established with ${serverKey} (server authenticated)`);
            resolve({ clientId, sessionKey });
          } catch (e) {
            console.error(`❌ DH parse/verify error ${serverKey}:`, e.message);
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        console.error(`❌ DH exchange network error ${serverKey}: ${err.message}, falling back to token mode`);
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy(new Error('DH exchange timeout'));
        resolve(null);
      });
      req.write(payload);
      req.end();
    });
  }

  // ─── sendWithToken (giữ nguyên) ──────────────────────────
  sendWithToken(method, path, bodyObj, server, agent, isEmpty) {
    bodyObj.token = server.token;
    if (isEmpty !== undefined) { bodyObj.empty = isEmpty; }
    const payload = canonicalStringify(bodyObj);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ChocoHub-BackupClient/1.0',
      'ngrok-skip-browser-warning': '1',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    };
    return { payload, headers };
  }

  // ✅ FIX: sendWithDH - KHÔNG gửi token trong body
  sendWithDH(method, path, bodyObj, session, isEmpty) {
    // ✅ Tạo bản sao KHÔNG có token
    const cleanBody = { ...bodyObj };
    delete cleanBody.token;  // ✅ XÓA token khỏi body!
    
    if (isEmpty !== undefined) { cleanBody.empty = isEmpty; }
    
    const payload = canonicalStringify(cleanBody);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'ChocoHub-BackupClient/1.0',
      'ngrok-skip-browser-warning': '1'
    };
    
    if (session) {
      const timestamp = Date.now().toString();
      const bodyStr = method === 'POST' ? payload : '';
      const signPayload = `${method}${path}${timestamp}${bodyStr}`;
      const signature = DHExchange.sign(signPayload, session.sessionKey);
      headers['x-client-id'] = session.clientId;
      headers['x-timestamp'] = timestamp;
      headers['x-signature'] = signature;
      
      // Debug log
      console.log(`🔐 [DH] Signed ${method} ${path} with clientId ${session.clientId.substring(0, 30)}...`);
      console.log(`🔍 Payload: ${payload.substring(0, 100)}...`);
      console.log(`🔍 Has token? ${payload.includes('"token"') ? '⚠️ YES' : '✅ NO'}`);
    }
    
    return { payload, headers };
  }

  sendSnapshotNow(server, serverKey, agent, session, useDH) {
    const httpModule = server.protocol === 'https' ? https : http;
    // ✅ SNAPSHOT payload sẽ được xử lý bởi sendWithDH (xóa token)
    const snapshotPayload = { type: 'FULL_SNAPSHOT', token: server.token, state: db.exportFullState() };
    let payload, headers;
    if (useDH && session) {
      const result = this.sendWithDH('POST', '/api/backup/sync', snapshotPayload, session);
      payload = result.payload;
      headers = result.headers;
    } else {
      const result = this.sendWithToken('POST', '/api/backup/sync', snapshotPayload, server, agent);
      payload = result.payload;
      headers = result.headers;
    }

    const req = httpModule.request({
      hostname: server.host,
      port: server.port,
      path: '/api/backup/sync',
      method: 'POST',
      headers,
      agent,
      rejectUnauthorized: useDH ? true : false
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log(`📤 Snapshot sent to ${serverKey} (${useDH ? 'DH' : 'TOKEN'})`);
          if (!this.restored) {
            this.restored = true;
            console.log(`✅ Database sent to ${serverKey}`);
          }
          this.ensureHeartbeatAndSnapshot(server, serverKey, agent, session, useDH);
        } else {
          console.error(`❌ Failed to send snapshot to ${serverKey}: ${res.statusCode}`);
          console.error(`📥 Response: ${body.substring(0, 200)}`);
          this.handleConnectionFailure(server, () => this.sendSnapshotNow(server, serverKey, agent, session, useDH));
        }
      });
    });
    req.on('error', (err) => {
      console.error(`❌ Snapshot send error ${serverKey}: ${err.message}`);
      this.handleConnectionFailure(server, () => this.sendSnapshotNow(server, serverKey, agent, session, useDH));
    });
    req.on('timeout', () => req.destroy(new Error('snapshot send timeout')));
    req.setTimeout(30000);
    req.write(payload);
    req.end();
  }

  connectHttp(server) {
    const serverKey = `${server.host}:${server.port}`;
    const httpModule = server.protocol === 'https' ? https : http;
    const dhAgent = server.protocol === 'https' ? makeSecureHttpsAgent(server.host, false) : undefined;
    const fallbackAgent = server.protocol === 'https' ? makeSecureHttpsAgent(server.host, true) : undefined;

    this.performSecureDHExchange(server, serverKey, dhAgent).then(session => {
      if (session) {
        this.dhSessions.set(serverKey, session);
        console.log(`🔐 Using DH secure mode for ${serverKey}`);
        this.launchReadyProtocol(server, serverKey, httpModule, dhAgent, session, true);
      } else {
        console.log(`🔓 Falling back to TOKEN mode for ${serverKey} (no DH)`);
        this.launchReadyProtocol(server, serverKey, httpModule, fallbackAgent, null, false);
      }
    });
  }

  // ✅ FIX: launchReadyProtocol - KHÔNG gửi token trong body
  launchReadyProtocol(server, serverKey, httpModule, agent, session, useDH) {
    const tryReady = () => {
      if (this.restored) {
        this.ensureHeartbeatAndSnapshot(server, serverKey, agent, session, useDH);
        return;
      }

      // ✅ KHÔNG có token trong payload!
      const readyPayload = { type: 'READY' };
      const isEmpty = db.getSeq() === 0;

      let payload, headers;
      if (useDH && session) {
        const result = this.sendWithDH('POST', '/api/backup/sync', readyPayload, session, isEmpty);
        payload = result.payload;
        headers = result.headers;
      } else {
        // ⚠️ Fallback token mode - vẫn gửi token (kém an toàn)
        const result = this.sendWithToken('POST', '/api/backup/sync', { type: 'READY' }, server, agent, isEmpty);
        payload = result.payload;
        headers = result.headers;
      }

      console.log(`📤 [${useDH ? 'DH' : 'TOKEN'}] Sending READY to ${serverKey}`);
      console.log(`🔍 Payload: ${payload.substring(0, 150)}...`);
      console.log(`🔍 Has token? ${payload.includes('"token"') ? '⚠️ YES' : '✅ NO'}`);

      const req = httpModule.request({
        hostname: server.host,
        port: server.port,
        path: '/api/backup/sync',
        method: 'POST',
        headers,
        agent,
        rejectUnauthorized: useDH ? true : false
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (this.restored) {
            this.ensureHeartbeatAndSnapshot(server, serverKey, agent, session, useDH);
            return;
          }

          console.log(`📥 Response from ${serverKey}: status ${res.statusCode}`);
          console.log(`📥 Body: ${body.substring(0, 200)}`);

          if (res.statusCode === 200 && body.trim()) {
            try {
              const msg = JSON.parse(body);
              if (msg.type === 'REQUEST_SNAPSHOT') {
                console.log(`📤 Server ${serverKey} requested snapshot, sending...`);
                this.sendSnapshotNow(server, serverKey, agent, session, useDH);
                return;
              }
              if (msg.type === 'FULL_SNAPSHOT' && msg.state) {
                const users = Array.isArray(msg.state.users) ? msg.state.users.length : 0;
                if (users > 0) {
                  console.log(`📥 [${useDH ? 'DH' : 'TOKEN'}] Restoring from ${serverKey} (${users} users)...`);
                  db.importFullState(msg.state);
                  this.restored = true;
                  ['swap_holding', 'swap_liquidity', 'mempool_holding', 'node_fees'].forEach(name => {
                    if (!db.getUser(name)) {
                      const pin = crypto.randomBytes(16).toString('hex');
                      db.authenticate(name, pin);
                      console.log(`🏦 Re-created ${name} account after restore`);
                    }
                  });
                  console.log('✅ Database restored');
                }
                this.retryCount[serverKey] = 0;
                this.heartbeatFailureCount[serverKey] = 0;
                this.ensureHeartbeatAndSnapshot(server, serverKey, agent, session, useDH);
                return;
              }
              if (msg.type === 'READY_ACK') {
                console.log(`🔗 [${useDH ? 'DH' : 'TOKEN'}] Connected to ${serverKey} (main already has data)`);
                if (db.getSeq() > 0) {
                  this.restored = true;
                }
                this.retryCount[serverKey] = 0;
                this.heartbeatFailureCount[serverKey] = 0;
                this.ensureHeartbeatAndSnapshot(server, serverKey, agent, session, useDH);
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
          this.ensureHeartbeatAndSnapshot(server, serverKey, agent, session, useDH);
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

  ensureHeartbeatAndSnapshot(server, serverKey, agent, session, useDH) {
    if (!this.heartbeats[serverKey]) {
      console.log(`💓 Starting heartbeat for ${serverKey} (${useDH ? 'DH' : 'TOKEN'} mode)`);
      if (useDH && session) {
        this.startHttpHeartbeatDH(server, serverKey, agent, session);
      } else {
        this.startHttpHeartbeatToken(server, serverKey, agent);
      }
    }
    if (!this.snapshotTimers[serverKey]) {
      console.log(`📸 Starting snapshot for ${serverKey} (${useDH ? 'DH' : 'TOKEN'} mode)`);
      if (useDH && session) {
        this.startHttpSnapshotDH(server, serverKey, agent, session);
      } else {
        this.startHttpSnapshotToken(server, serverKey, agent);
      }
    }
  }

  handleConnectionFailure(server, retryFn) {
    const serverKey = `${server.host}:${server.port}`;
    this.retryCount[serverKey] = (this.retryCount[serverKey] || 0) + 1;

    if (this.retryCount[serverKey] >= MAX_RETRIES) {
      console.log(`🗑️ Removing dead node ${serverKey} after ${MAX_RETRIES} failed retries.`);
      this.servers = this.servers.filter(s => `${s.host}:${s.port}` !== serverKey);
      if (server.isDynamic) {
        this.failedNodes.add(server.host);
      }
      if (this.heartbeats[serverKey]) {
        clearInterval(this.heartbeats[serverKey]);
        delete this.heartbeats[serverKey];
      }
      if (this.snapshotTimers[serverKey]) {
        clearInterval(this.snapshotTimers[serverKey]);
        delete this.snapshotTimers[serverKey];
      }
      this.sockets = this.sockets.filter(s => s.serverKey !== serverKey);
      if (this.dhSessions.has(serverKey)) {
        this.dhSessions.delete(serverKey);
      }
      delete this.heartbeatFailureCount[serverKey];
      console.log(`🧹 Cleaned up resources for ${serverKey}`);
    } else {
      console.log(`🔄 Retry ${this.retryCount[serverKey]}/${MAX_RETRIES} for ${serverKey} in ${RETRY_INTERVAL/1000}s...`);
      if (retryFn) setTimeout(retryFn, RETRY_INTERVAL);
      else setTimeout(() => this.connect(server), RECONNECT_DELAY);
    }
  }

  // ==================== Heartbeat & Snapshot - TOKEN MODE ====================
  startHttpHeartbeatToken(server, serverKey, agent) {
    const httpModule = server.protocol === 'https' ? https : http;
    if (!this.heartbeatLogCounter[serverKey]) this.heartbeatLogCounter[serverKey] = 0;
    if (this.heartbeatFailureCount[serverKey] === undefined) this.heartbeatFailureCount[serverKey] = 0;

    const heartbeat = () => {
      const payload = canonicalStringify({ type: 'PING', token: server.token });
      const req = httpModule.request({
        hostname: server.host,
        port: server.port,
        path: '/api/backup/sync',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'ngrok-skip-browser-warning': '1',
          'User-Agent': 'ChocoHub-BackupClient/1.0'
        },
        agent,
        rejectUnauthorized: false
      }, (res) => {
        if (res.statusCode === 200) {
          this.heartbeatFailureCount[serverKey] = 0;
          this.heartbeatLogCounter[serverKey]++;
          if (this.heartbeatLogCounter[serverKey] % 5 === 0) {
            console.log(`💚 Heartbeat OK (${serverKey} - TOKEN)`);
          }
        } else {
          this.heartbeatFailureCount[serverKey]++;
          console.error(`⚠️ [HTTP] Heartbeat failed ${serverKey}: status ${res.statusCode} (${this.heartbeatFailureCount[serverKey]}/${MAX_HEARTBEAT_FAILURES})`);
          if (this.heartbeatFailureCount[serverKey] >= MAX_HEARTBEAT_FAILURES) {
            console.error(`❌ Heartbeat failed ${MAX_HEARTBEAT_FAILURES} times, treating node ${serverKey} as dead`);
            this.handleConnectionFailure(server);
          }
        }
        res.resume();
      });
      req.on('error', (err) => {
        this.heartbeatFailureCount[serverKey]++;
        console.error(`❌ [HTTP] Heartbeat error ${serverKey}: ${err.message} (${this.heartbeatFailureCount[serverKey]}/${MAX_HEARTBEAT_FAILURES})`);
        if (this.heartbeatFailureCount[serverKey] >= MAX_HEARTBEAT_FAILURES) {
          console.error(`❌ Heartbeat failed ${MAX_HEARTBEAT_FAILURES} times, treating node ${serverKey} as dead`);
          this.handleConnectionFailure(server);
        }
      });
      req.on('timeout', () => {
        this.heartbeatFailureCount[serverKey]++;
        console.error(`⏱ [HTTP] Heartbeat timeout ${serverKey} (${this.heartbeatFailureCount[serverKey]}/${MAX_HEARTBEAT_FAILURES})`);
        if (this.heartbeatFailureCount[serverKey] >= MAX_HEARTBEAT_FAILURES) {
          console.error(`❌ Heartbeat failed ${MAX_HEARTBEAT_FAILURES} times, treating node ${serverKey} as dead`);
          this.handleConnectionFailure(server);
        }
        req.destroy(new Error('heartbeat timeout'));
      });
      req.setTimeout(10000);
      req.write(payload);
      req.end();
    };

    if (this.heartbeats[serverKey]) clearInterval(this.heartbeats[serverKey]);
    this.heartbeats[serverKey] = setInterval(heartbeat, HEARTBEAT_INTERVAL);
    heartbeat();
  }

  startHttpSnapshotToken(server, serverKey, agent) {
    const httpModule = server.protocol === 'https' ? https : http;
    let lastSnapshotHash = null;

    const sendSnapshot = () => {
      const state = db.exportFullState();
      const payload = canonicalStringify({ type: 'FULL_SNAPSHOT', token: server.token, state });
      const hash = crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);

      if (hash === lastSnapshotHash) {
        console.log(`⏭ Snapshot unchanged, skipping send to ${serverKey}`);
        return;
      }

      const req = httpModule.request({
        hostname: server.host,
        port: server.port,
        path: '/api/backup/sync',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'ngrok-skip-browser-warning': '1',
          'User-Agent': 'ChocoHub-BackupClient/1.0'
        },
        agent,
        rejectUnauthorized: false
      }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          lastSnapshotHash = hash;
          console.log(`📤 Snapshot sent to ${serverKey} (hash ${hash} - TOKEN)`);
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

  // ==================== Heartbeat & Snapshot - DH MODE ====================
  startHttpHeartbeatDH(server, serverKey, agent, session) {
    const httpModule = server.protocol === 'https' ? https : http;
    if (!this.heartbeatLogCounter[serverKey]) this.heartbeatLogCounter[serverKey] = 0;
    if (this.heartbeatFailureCount[serverKey] === undefined) this.heartbeatFailureCount[serverKey] = 0;

    const heartbeat = () => {
      // ✅ FIX: sempre busca a sessão ATUAL no mapa, nunca a capturada no closure —
      // evita assinar com uma chave DH desatualizada depois de um re-handshake.
      const currentSession = this.dhSessions.get(serverKey) || session;
      // ✅ PING KHÔNG có token trong body
      const pingPayload = { type: 'PING' };
      const { payload, headers } = this.sendWithDH('POST', '/api/backup/sync', pingPayload, currentSession);

      const req = httpModule.request({
        hostname: server.host,
        port: server.port,
        path: '/api/backup/sync',
        method: 'POST',
        headers,
        agent,
        rejectUnauthorized: true
      }, (res) => {
        if (res.statusCode === 200) {
          this.heartbeatFailureCount[serverKey] = 0;
          this.heartbeatLogCounter[serverKey]++;
          if (this.heartbeatLogCounter[serverKey] % 5 === 0) {
            console.log(`💚 Heartbeat OK (${serverKey} - DH)`);
          }
        } else {
          this.heartbeatFailureCount[serverKey]++;
          console.error(`⚠️ [HTTP] Heartbeat failed ${serverKey}: status ${res.statusCode} (${this.heartbeatFailureCount[serverKey]}/${MAX_HEARTBEAT_FAILURES})`);
          if (this.heartbeatFailureCount[serverKey] >= MAX_HEARTBEAT_FAILURES) {
            console.error(`❌ Heartbeat failed ${MAX_HEARTBEAT_FAILURES} times, treating node ${serverKey} as dead`);
            this.handleConnectionFailure(server);
          }
        }
        res.resume();
      });
      req.on('error', (err) => {
        this.heartbeatFailureCount[serverKey]++;
        console.error(`❌ [HTTP] Heartbeat error ${serverKey}: ${err.message} (${this.heartbeatFailureCount[serverKey]}/${MAX_HEARTBEAT_FAILURES})`);
        if (this.heartbeatFailureCount[serverKey] >= MAX_HEARTBEAT_FAILURES) {
          console.error(`❌ Heartbeat failed ${MAX_HEARTBEAT_FAILURES} times, treating node ${serverKey} as dead`);
          this.handleConnectionFailure(server);
        }
      });
      req.on('timeout', () => {
        this.heartbeatFailureCount[serverKey]++;
        console.error(`⏱ [HTTP] Heartbeat timeout ${serverKey} (${this.heartbeatFailureCount[serverKey]}/${MAX_HEARTBEAT_FAILURES})`);
        if (this.heartbeatFailureCount[serverKey] >= MAX_HEARTBEAT_FAILURES) {
          console.error(`❌ Heartbeat failed ${MAX_HEARTBEAT_FAILURES} times, treating node ${serverKey} as dead`);
          this.handleConnectionFailure(server);
        }
        req.destroy(new Error('heartbeat timeout'));
      });
      req.setTimeout(10000);
      req.write(payload);
      req.end();
    };

    if (this.heartbeats[serverKey]) clearInterval(this.heartbeats[serverKey]);
    this.heartbeats[serverKey] = setInterval(heartbeat, HEARTBEAT_INTERVAL);
    heartbeat();
  }

  // ✅ FIX: startHttpSnapshotDH - KHÔNG gửi token trong body
  startHttpSnapshotDH(server, serverKey, agent, session) {
    const httpModule = server.protocol === 'https' ? https : http;
    let lastSnapshotHash = null;

    const sendSnapshot = () => {
      // ✅ FIX: sempre busca a sessão ATUAL no mapa, nunca a capturada no closure —
      // evita assinar com uma chave DH desatualizada depois de um re-handshake.
      const currentSession = this.dhSessions.get(serverKey) || session;
      const state = db.exportFullState();
      // ✅ SNAPSHOT payload sẽ được xử lý bởi sendWithDH (xóa token)
      const snapshotPayload = { type: 'FULL_SNAPSHOT', state };
      const { payload, headers } = this.sendWithDH('POST', '/api/backup/sync', snapshotPayload, currentSession);
      const hash = crypto.createHash('sha256').update(payload).digest('hex').substring(0, 16);

      if (hash === lastSnapshotHash) {
        console.log(`⏭ Snapshot unchanged, skipping send to ${serverKey}`);
        return;
      }

      const req = httpModule.request({
        hostname: server.host,
        port: server.port,
        path: '/api/backup/sync',
        method: 'POST',
        headers,
        agent,
        rejectUnauthorized: true
      }, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          lastSnapshotHash = hash;
          console.log(`📤 Snapshot sent to ${serverKey} (hash ${hash} - DH)`);
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

const backupClient = new BackupClient();
module.exports = backupClient;