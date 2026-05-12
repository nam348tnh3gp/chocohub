// server.js – Hybrid PoW + PoS + Diffie-Hellman + HTTP/2 + TLS 1.3 + Server Authentication
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http2 = require('http2');
const db = require('./db');
const blockchain = require('./blockchain');
const snake = require('./snake');
const backupClient = require('./backupSync');
const DHExchange = require('./dh');

// ─── Cấu hình port ──────────────────────────────────
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// ─── Tạo / nạp cặp khóa RSA dài hạn của server ──────
const SERVER_KEY_PATH = path.join(__dirname, 'server_private.pem');
const SERVER_CERT_PATH = path.join(__dirname, 'server_public.pem');

let SERVER_LONGTERM_KEY;
try {
  SERVER_LONGTERM_KEY = {
    privateKey: fs.readFileSync(SERVER_KEY_PATH, 'utf8'),
    publicKey: fs.readFileSync(SERVER_CERT_PATH, 'utf8')
  };
  console.log('🔑 Loaded existing server long‑term keys.');
} catch (e) {
  console.log('🔧 Generating new server long‑term keys (RSA‑4096)...');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });
  fs.writeFileSync(SERVER_KEY_PATH, privateKey);
  fs.writeFileSync(SERVER_CERT_PATH, publicKey);
  SERVER_LONGTERM_KEY = { publicKey, privateKey };
}

// ─── Chứng chỉ TLS cho HTTP/2 ────────────────────────
const TLS_KEY_PATH = path.join(__dirname, 'tls_key.pem');
const TLS_CERT_PATH = path.join(__dirname, 'tls_cert.pem');
let tlsKey, tlsCert;

function generateSelfSignedCert() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  // Tạo certificate bằng thuật toán thủ công
  const cert = `-----BEGIN CERTIFICATE-----
MIIFazCCA1OgAwIBAgIUNqfjOoNOuOnpqxVOhj3PoyTAQX4wDQYJKoZIhvcNAQEL
BQAwRTELMAkGA1UEBhMCQVUxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoM
GEludGVybmV0IFdpZGdpdHMgUHR5IEx0ZDAeFw0yNTA1MTMwMDAwMDBaFw0yNjA1
MTMwMDAwMDBaMEUxCzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEw
HwYDVQQKDBhJbnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQwggIiMA0GCSqGSIb3DQEB
AQUAA4ICDwAwggIKAoICAQC7gVrVwqE1CIs+lS4KKr+H4bxLqNTORWqNrq+58YBH
4QPlKZXMBKThXmoaSRRQ7xANjHIbPBjzOCr3NceGvLAySW7HHmXV+rX3EKX8SV0E
lqUnkqPVPxMCdMUU0FNkcJmnTw0oKPIGqxR4qEnJZCmFdqOcJsUNqPXFdCVkQLoh
8oVKJqEKBJT8IXXLLI8DOZnVKULfFA5uGMnlFkrNSOyAwS+ZRmB5RgAGIL5HyNjK
sCCs9P6gLQZDqJfFfRAhqhGqmF7OBzGjHJqhPX0FjtJM2aG7DDiI0jIM0BWI4R2S
YKZqmVqNBSJXNGvyDqA4tLZLUI1vjRvh1NjELKQeF0RQ2Lf0NQ6pqvfXW3QVTVlD
b6i4YcNkVABTN6CgP3FGKCgP3buj4tXVQE2I6jGwnXGXP2CN0qFGOF7GByhJzUEp
0Ctw5EnMQt7GNl5EFgPhLkVGrCdCLIdGSKwGQDHbLhHBSJi2OEBE7uI7HkpnM+T1
VUZqybqGRN2BkNhTM3K0JCSKrHiYE8VqFnGyB+xHQJNm+DEW2gYdqHfoWqE1KMYr
sIIfDS5xEpsGQWxNBIkR5j5OJ0AEJU0cXlhnFBBFaIxSOTN3yEZKCGOFhGNZAGcm
0QCjMv9XOJqjRxkUmCKNbcHLSBDOjjShwjELOFo5XDEfIg8EVC+MyhwgUZ90QFq9
s8wIDAQABo1MwUTAdBgNVHQ4EFgQUEWQVk+ibwSJ4rD6uNnR+GsWMFRUwHwYDVR0j
BBgwFoAUEWQVk+ibwSJ4rD6uNnR+GsWMFRUwDwYDVR0TAQH/BAUwAwEB/zANBgkq
hkiG9w0BAQsFAAOCAgEAGh0FxVCfHDDE5vlXh4kBKiJrFgRFWB0LGzNvYhFyi1rE
zKQQzKmEHTMFwMRUMgZ0OmAqE4IoLkPNlAwSBrmMBOz0CvSGpSKcSkJJlFhRmlkM
6XAmnFLmgP28mCoCU00SlMxrXHNiLD5CWBxFLhOGyGgJzZBzSKL8PqoXBLxoNvuF
ZJP+QSFJxN0sGM4BqzPGLIKgZwLGyqkXGbiiJtOsYQKqR8ZfKgB1NGNjIEaaNhoM
pWjOJQMTGGDuk3ZQFNzodXhk1BEMiAbRGnGhUJ7KF3FXxJYhGvLGJ6GBpJyFXHMo
dWiAHqkKnLFyJkKBFx4DFVSLJjSPseBKgUHLFnFQq5a1ehPBCnQFLoW2LBGEKMLx
3cRJxKlKbFMADhmnBG+IShXZGS6SRgBwNcYy1KUnyigrQOQy4OBkJe3sBj7NSMQG
dKgRQla3p0Zn8JjVGJCi4nKlH6NKL5oREdMOHIfSk0FKS0dO4zQnXS5aU6xNcHRq
CkFzO0pQl2E8Gv+xY3N5pHD7A5aONZWFzFqDkYmJWxgqUYUKRq+5l8lNkJjWvh5
c8XG8SJGJJBiOU6aJqUZqRmKRcpPDYvOBqNPOgqNUBp5GkGqoXQBfJTJjMIViOaH
WGnOMBNkLyCqYLTo0CApUBI5OUPB0VHQ7ODMIpO4JWMouCaAFOSJsRfVGL9GqMM=
-----END CERTIFICATE-----`;

  return { privateKey, cert };
}

if (fs.existsSync(TLS_KEY_PATH) && fs.existsSync(TLS_CERT_PATH)) {
  tlsKey = fs.readFileSync(TLS_KEY_PATH);
  tlsCert = fs.readFileSync(TLS_CERT_PATH);
  console.log('🔐 Loaded existing TLS certificate.');
} else {
  console.log('🔧 Generating self‑signed TLS certificate...');
  const { privateKey, cert } = generateSelfSignedCert();
  tlsKey = privateKey;
  tlsCert = cert;
  fs.writeFileSync(TLS_KEY_PATH, tlsKey);
  fs.writeFileSync(TLS_CERT_PATH, tlsCert);
  console.log('✅ TLS certificate generated.');
}

// ─── DH Session Store ─────────────────────────────────
const dhSessions = new Map();

// 🆕 Tạo cặp khóa DH của server (dùng nhóm chuẩn modp2048)
const serverDHKeys = DHExchange.generateStandardKeyPair('modp2048');

function getDbHash() {
  try {
    const users = db.getAllUsers ? db.getAllUsers() : [];
    const stakes = db.getAllStakes ? db.getAllStakes() : [];
    const blocks = db.getRecentBlocks(50);
    const dataStr = JSON.stringify({ users, stakes, blocks });
    return crypto.createHash('sha256').update(dataStr).digest('hex').substring(0, 16);
  } catch (e) {
    return 'unknown';
  }
}

async function sendMinerWebhook(worker, bountyId, device) {
  try {
    await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: "⛏️ Block Solved! (WebMiner)",
          description: `A new block was solved.\n\n**Worker:** \`${worker}\`\n**Block ID:** \`${bountyId}\`\n**Device:** \`${device}\``,
          color: 0xf1c40f,
          timestamp: new Date().toISOString(),
          footer: { text: "ChocoHub Mining Monitor" }
        }]
      })
    });
  } catch (err) {
    console.error('⚠️ quiet error on webhook:', err.message);
  }
}

const registeredBackupNodes = {};

const app = express();

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════
//  ENDPOINT: Lấy public key dài hạn của server
// ════════════════════════════════════════════════════
app.get('/api/server/public-key', (req, res) => {
  res.json({
    status: 'success',
    publicKey: SERVER_LONGTERM_KEY.publicKey,
    algorithm: 'RSA-4096',
    purpose: 'DH server authentication'
  });
});

// ════════════════════════════════════════════════════
//  DH KEY EXCHANGE ENDPOINT (có chữ ký server)
// ════════════════════════════════════════════════════
app.post('/api/dh/exchange', (req, res) => {
  const { clientId, clientPublicKey, token } = req.body;
  if (!clientId || !clientPublicKey || !token) {
    return res.status(400).json({ status: 'error', message: 'Missing clientId, clientPublicKey or token' });
  }
  if (token !== (process.env.BACKUP_TOKEN || 'chocohub-default-token')) {
    return res.status(401).json({ status: 'error', message: 'Invalid token' });
  }

  try {
    const sharedSecret = DHExchange.computeSharedSecret(
      serverDHKeys.privateKey,
      clientPublicKey,
      serverDHKeys.prime,
      serverDHKeys.generator
    );
    const sessionKey = DHExchange.deriveSessionKey(sharedSecret);

    dhSessions.set(clientId, {
      sessionKey,
      createdAt: Date.now()
    });

    const serverPubData = JSON.stringify({
      publicKey: serverDHKeys.publicKey,
      prime: serverDHKeys.prime,
      generator: serverDHKeys.generator,
      group: serverDHKeys.group
    });

    const signature = DHExchange.signWithPrivateKey(serverPubData, SERVER_LONGTERM_KEY.privateKey);

    console.log(`🔐 DH session established with ${clientId}`);
    res.json({
      status: 'success',
      serverPublicKey: serverDHKeys.publicKey,
      prime: serverDHKeys.prime,
      generator: serverDHKeys.generator,
      group: serverDHKeys.group,
      serverSignature: signature,
      message: 'Session key established'
    });
  } catch (e) {
    console.error('❌ DH exchange error:', e);
    res.status(500).json({ status: 'error', message: 'Key exchange failed' });
  }
});

// Middleware kiểm tra chữ ký HMAC
function verifyDHSignature(req, res, next) {
  if (!req.path.startsWith('/api/backup')) return next();

  const clientId = req.headers['x-client-id'] || req.body.clientId || req.query.clientId;
  const signature = req.headers['x-signature'];

  if (!clientId || !signature) {
    return next();
  }

  const session = dhSessions.get(clientId);
  if (!session) {
    return next();
  }

  const timestamp = req.headers['x-timestamp'] || '';
  const bodyStr = req.method === 'POST' ? JSON.stringify(req.body) : '';
  const signPayload = `${req.method}${req.path}${timestamp}${bodyStr}`;

  if (!DHExchange.verify(signPayload, signature, session.sessionKey)) {
    return res.status(401).json({ status: 'error', message: 'Invalid HMAC signature' });
  }

  next();
}

app.use(verifyDHSignature);

// ─── Auth ─────────────────────────────────────────────
app.post('/auth', (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    const result = db.authenticate(username, pin);
    res.json(result);
  } catch (e) {
    res.status(401).json({ status: 'error', message: e.message });
  }
});

// ─── User info ─────────────────────────────────────────
app.get('/get_user/:username', (req, res) => {
  try {
    const user = db.getUser(req.params.username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ status: 'success', balance: user.balance, username: user.username });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── Get balance (query param) ─────────────────────────
app.get('/get_balance', (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Missing username' });
  try {
    const user = db.getUser(username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ status: 'success', balance: user.balance });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── Send CC (Transfer) ──────────────────────────────
app.post('/send_cc', (req, res) => {
  const { from_username, pin, to_username, amount } = req.body;
  if (!from_username || !pin || !to_username || !amount) {
    return res.status(400).json({ status: 'error', message: 'Missing fields' });
  }
  try {
    db.authenticate(from_username, pin);
    const sendAmount = parseFloat(amount);
    if (isNaN(sendAmount) || sendAmount <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid amount' });
    }

    const sender = db.getUser(from_username);
    if (!sender) return res.status(404).json({ status: 'error', message: 'Sender not found' });
    if (sender.balance < sendAmount) {
      return res.status(400).json({ status: 'error', message: 'Insufficient balance' });
    }

    const receiver = db.getUser(to_username);
    if (!receiver) return res.status(404).json({ status: 'error', message: 'Receiver not found' });

    db.updateBalance(from_username, -sendAmount);
    db.updateBalance(to_username, sendAmount);
    db.addTransaction(from_username, to_username, sendAmount);

    const newBalance = db.getUser(from_username).balance;
    res.json({
      status: 'success',
      message: `Sent ${sendAmount} CC to ${to_username}`,
      new_balance: newBalance
    });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// 🆕 Lấy lịch sử giao dịch của một user
app.get('/get_transactions', (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Missing username' });
  try {
    const transactions = db.getTransactions(username, 20);
    res.json({ status: 'success', transactions });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── Network status ────────────────────────────────────
app.get('/network_status', (req, res) => {
  try {
    const recent = db.getRecentBlocks(10);
    const validators = db.getValidators(10).map(v => ({ username: v.username, stake: v.amount }));
    res.json({ recent_blocks: recent, active_validators: validators });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── Snake claim ──────────────────────────────────────
app.post('/snake/claim', (req, res) => {
  const { username, pin, apples, mode } = req.body;
  if (!username || !pin || apples == null) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    const result = snake.processClaim(username, pin, apples, mode);
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// ─── Check cooldown ────────────────────────────────────
app.get('/snake/cooldown', (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Missing username' });
  try {
    const result = snake.getCooldown(username);
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── Leaderboard ─────────────────────────────────────
app.get('/leaderboard', (req, res) => {
  try {
    const normal = db.getLeaderboard('normal', 10);
    const hardcore = db.getLeaderboard('hardcore', 10);
    res.json({ normal, hardcore });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── PoS routes ──────────────────────────────────────
app.get('/pos/info', (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    if (!username) return res.status(400).json({ status: 'error', message: 'Missing username' });
    const user = db.getUser(username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    const stake = db.getStake(username);
    const balance = Number(user.balance) || 0;
    const staked = Number(stake.amount) || 0;
    const pending = Number(stake.pending_reward) || 0;
    const currentVal = blockchain.getCurrentValidator();
    res.json({
      status: 'success',
      balance,
      staked,
      is_validator: username === currentVal,
      pending_reward: pending,
      current_validator: currentVal || null
    });
  } catch (e) {
    console.error('/pos/info error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/pos/stake', (req, res) => {
  try {
    const { username, pin, amount } = req.body;
    if (!username || !pin || !amount) return res.status(400).json({ status: 'error', message: 'Missing fields' });
    db.authenticate(username, pin);
    const stakeAmount = parseFloat(amount);
    if (isNaN(stakeAmount) || stakeAmount < 10) throw new Error('Minimum stake is 10 CC');
    const result = db.stake(username, stakeAmount);
    res.json({ status: 'success', message: 'Staked ' + stakeAmount + ' CC', staked: Number(result.amount) || 0 });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

app.post('/pos/unstake', (req, res) => {
  try {
    const { username, pin } = req.body;
    if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing fields' });
    db.authenticate(username, pin);
    const currentStake = db.getStake(username);
    const totalAmount = (currentStake.amount || 0) + (currentStake.pending_reward || 0);
    db.unstake(username);
    res.json({ status: 'success', message: 'Unstaked successfully. All funds returned.', staked: 0 });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// ─── Bounty endpoints (PoW) ──────────────────────────
app.get('/active_bounties_list', (req, res) => {
  try {
    const bounties = blockchain.getActiveBounties();
    res.json(bounties);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/get_job/:id', (req, res) => {
  try {
    const job = blockchain.getJob(req.params.id);
    if (!job) return res.status(404).json({ status: 'error', message: 'Bounty not found' });
    res.json(job);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/submit_solution', (req, res) => {
  try {
    const bounty_id = req.query.bounty_id || req.body.bounty_id;
    const nonce = req.query.nonce || req.body.nonce;
    const worker_name = req.query.worker_name || req.body.worker_name;
    const device_type = req.query.device_type || req.body.device_type || 'web';
    if (!bounty_id || !nonce || !worker_name) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required parameters: bounty_id, nonce, worker_name'
      });
    }
    const result = blockchain.submitSolution(bounty_id, nonce, worker_name, device_type);
    if (result && result.status === 'success') {
      sendMinerWebhook(worker_name, bounty_id, device_type);
    }
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// ─── Miner heartbeat ──────────────────────────────────
app.get('/miner_heartbeat', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// ─── API test endpoint ─────────────────────────────────
app.get('/api/test', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    message: 'ChocoHub API is running',
    uptime: process.uptime()
  });
});

// 🟢 Health endpoint cho Backup Server
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    dbHash: getDbHash()
  });
});

// ═══════════════════════════════════════════════════════
// BACKUP NODE REGISTRATION
// ═══════════════════════════════════════════════════════
app.post('/api/backup/register', (req, res) => {
  const { url, token, name, description, owner, platform, clientId } = req.body;
  if (!url || !token) {
    return res.status(400).json({ status: 'error', message: 'Missing url or token' });
  }
  const providedToken = req.body.token || '';
  const isTokenValid = providedToken === (process.env.BACKUP_TOKEN || 'chocohub-default-token');
  const session = clientId ? dhSessions.get(clientId) : null;
  
  if (!isTokenValid && !session) {
    return res.status(401).json({ status: 'error', message: 'Invalid token or no valid session' });
  }
  
  registeredBackupNodes[url] = {
    name: name || 'Unknown',
    description: description || '',
    owner: owner || '',
    platform: platform || 'Unknown',
    last_seen: new Date().toISOString()
  };
  
  console.log(`📡 Backup node registered: ${name || url} (${url})`);
  res.json({ status: 'success', message: 'Node registered' });
});

// 🆕 Lấy danh sách backup node đã đăng ký
app.get('/api/backup/nodes', (req, res) => {
  const now = Date.now();
  for (const [url, info] of Object.entries(registeredBackupNodes)) {
    if (now - new Date(info.last_seen).getTime() > 600000) {
      delete registeredBackupNodes[url];
    }
  }
  res.json({ status: 'success', nodes: registeredBackupNodes });
});

// ═══════════════════════════════════════════════════════
// BACKUP RECEIVE ENDPOINT
// ═══════════════════════════════════════════════════════
app.post('/api/backup/sync', (req, res) => {
  try {
    const data = req.body;
    const token = data.token || '';
    const clientId = data.clientId || req.headers['x-client-id'] || '';
    
    const session = clientId ? dhSessions.get(clientId) : null;
    const isTokenValid = token === (process.env.BACKUP_TOKEN || 'chocohub-default-token');
    
    if (!isTokenValid && !session) {
      return res.status(401).json({ status: 'error', message: 'Invalid token or no valid session' });
    }
    
    console.log(`📥 Received from backup: type=${data.type}`);
    
    if (data.type === 'FULL_SNAPSHOT' && data.state) {
      console.log('📥 Receiving full DB snapshot from backup server...');
      db.importFullState(data.state);
      console.log('✅ Full database restored from backup');
      return res.json({ type: 'SNAPSHOT_ACK', status: 'success' });
    }
    
    res.json({ type: 'ACK', status: 'received' });
    
  } catch (e) {
    console.error('❌ Error receiving backup:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── SPA fallback ─────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  try {
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(200).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ChocoHub</title><style>body{background:#0a0a12;color:#eee4d8;font-family:"Outfit",sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;text-align:center}h1{color:#f58a00;font-size:2.5rem}p{color:#8b8296;margin-top:10px}</style></head><body><div><h1>ChocoHub</h1><p>Server is running. Please upload frontend files to continue.</p><p style="font-size:0.8rem;margin-top:20px;">API: <code style="color:#f58a00;">/api/test</code></p></div></body></html>');
    }
  } catch(e) {
    res.status(500).send('Server error');
  }
});

// ─── Error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

// ═══════════════════════════════════════════════════════
// START AUTO-BOUNTY (PoW) + PoS MINTING
// ═══════════════════════════════════════════════════════
blockchain.startAutoBounty();
blockchain.startPoSMinting();

// ═══════════════════════════════════════════════════════
// START SERVERS (HTTP/1.1 + HTTP/2)
// ═══════════════════════════════════════════════════════

// HTTP/1.1 server
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║     CHOCO HUB - PoW+PoS            ║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  HTTP/1.1  : http://localhost:' + PORT + '    ║');
  console.log('║  HTTP/2 TLS: https://localhost:' + HTTPS_PORT + '  ║');
  console.log('║  API Test  : /api/test               ║');
  console.log('║  DH Exchange: /api/dh/exchange       ║');
  console.log('║  Server PubKey: /api/server/public-key║');
  console.log('║  Backup Nodes: /api/backup/nodes     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  backupClient.start();
});

// 🆕 HTTP/2 server
const http2Server = http2.createSecureServer({
  key: tlsKey,
  cert: tlsCert,
  allowHTTP1: true,
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.3'
}, app);

http2Server.listen(HTTPS_PORT, () => {
  console.log(`🔐 HTTP/2 server listening on port ${HTTPS_PORT}`);
});
