require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http2 = require('http2');
const selfsigned = require('selfsigned');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const db = require('./db');
const blockchain = require('./blockchain');
const snake = require('./snake');
const backupClient = require('./backupSync');
const DHExchange = require('./dh');
const SwapRouter = require('./routes/swap');
const NodeFeesRouter = require('./routes/node_fees');

// ─── CỜ TOÀN CỤC KIỂM SOÁT RESTORE ──────────────────────────
let isRestoring = false;                     // true khi đang import snapshot
let restorePromise = null;                  // dùng để chờ restore hoàn tất

const ADMIN_USERS = ['chocoetom', 'Nam2010'];
const NODE_MASTER_TOKEN = process.env.NODE_MASTER_TOKEN || 'null';
if (!process.env.NODE_MASTER_TOKEN || NODE_MASTER_TOKEN === 'null') {
  console.warn('⚠️ WARNING: NODE_MASTER_TOKEN is default/weak. Set a real token in Render dashboard!');
}

const nodeRateLimit = rateLimit({ windowMs: 60 * 1000, max: 120, message: { status: 'error', message: 'Rate limit exceeded' } });
const nodeSubmitLimit = rateLimit({ windowMs: 60 * 1000, max: 60, message: { status: 'error', message: 'Too many submissions' } });
const nodeRegisterLimit = rateLimit({ windowMs: 5 * 60 * 1000, max: 10, message: { status: 'error', message: 'Too many registration attempts' } });

function isAdmin(username) {
    return ADMIN_USERS.includes(username);
}

function verifyAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ status: 'error', message: 'Not authenticated' });
    }
    if (!isAdmin(req.user.username)) {
        return res.status(403).json({ status: 'error', message: 'Admin access required' });
    }
    next();
}

function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(k => `"${k}":${canonicalStringify(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { status: 'error', message: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { status: 'error', message: 'Too many send requests, please slow down.' },
});

const stakeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  message: { status: 'error', message: 'Too many stake/unstake actions.' },
});

const snakeSessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  message: { status: 'error', message: 'Too many game sessions, please slow down.' },
});

const snakeClaimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { status: 'error', message: 'Please wait before claiming again.' },
});

const swapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { status: 'error', message: 'Too many swap requests, please slow down.' },
});

const boostLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  message: { status: 'error', message: 'Too many boost activations, please slow down.' },
});

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

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

const TLS_KEY_PATH = path.join(__dirname, 'tls_key.pem');
const TLS_CERT_PATH = path.join(__dirname, 'tls_cert.pem');
let tlsKey, tlsCert;

function generateSelfSignedCert() {
  const attrs = [{ name: 'commonName', value: 'ChocoHub' }];
  const pem = selfsigned.generate(attrs, { days: 365, keySize: 2048 });
  return {
    privateKey: pem.private,
    cert: pem.cert
  };
}

if (fs.existsSync(TLS_KEY_PATH) && fs.existsSync(TLS_CERT_PATH)) {
  tlsKey = fs.readFileSync(TLS_KEY_PATH);
  tlsCert = fs.readFileSync(TLS_CERT_PATH);
  console.log('🔐 Loaded existing TLS certificate.');
} else {
  console.log('🔧 Generating self‑signed TLS certificate (Node.js native)...');
  const { privateKey, cert } = generateSelfSignedCert();
  tlsKey = privateKey;
  tlsCert = cert;
  fs.writeFileSync(TLS_KEY_PATH, tlsKey);
  fs.writeFileSync(TLS_CERT_PATH, tlsCert);
  console.log('✅ TLS certificate generated without execSync.');
}

const dhSessions = new Map();
const serverDHKeys = DHExchange.generateStandardKeyPair('modp2048');

const ALLOWED_BACKUP_HOSTS = (process.env.BACKUP_SERVERS || '')
  .split(',').map(s => {
    try { return new URL(s.trim()).hostname; } catch { return ''; }
  }).filter(Boolean);

function isAllowedBackupHost(url) {
  if (!ALLOWED_BACKUP_HOSTS.length) return false;
  try {
    return ALLOWED_BACKUP_HOSTS.includes(new URL(url).hostname);
  } catch { return false; }
}
console.log(`🔒 Allowed backup hosts: ${ALLOWED_BACKUP_HOSTS.join(', ') || '(none — all blocked)'}`);

function getDbHash() {
  try {
    const users = db.getAllUsers ? db.getAllUsers() : [];
    const stakes = db.getAllStakes ? db.getAllStakes() : [];
    const posRewardPool = db.getPosRewardPool ? db.getPosRewardPool() : {};
    const blocks = db.getBlocks ? db.getBlocks(10) : [];
    const dataStr = JSON.stringify({ users, stakes, blocks, posRewardPool });
    return crypto.createHash('sha256').update(dataStr).digest('hex').substring(0, 16);
  } catch (e) {
    return 'unknown';
  }
}

const registeredBackupNodes = {};

const app = express();
app.set('trust proxy', 1);

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    maxAge: 3600000
  }
}));

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── MIDDLEWARE KIỂM TRA TRẠNG THÁI RESTORE ────────────────────
app.use((req, res, next) => {
  // Cho phép một số đường dẫn đặc biệt luôn được phục vụ
  if (req.path === '/health' || req.path === '/api/status' || req.path === '/api/test') {
    return next();
  }
  if (isRestoring) {
    return res.status(503).json({
      status: 'error',
      message: 'Server is restoring from backup, please wait...',
      retry_after: 5
    });
  }
  next();
});

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    const user = db.getUser(decoded.username);
    if (!user) return res.status(401).json({ status: 'error', message: 'User not found' });
    if (user.banned) return res.status(403).json({ status: 'error', message: 'Account is banned' });
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ status: 'error', message: 'Invalid or expired token' });
  }
}

// ─── ROUTE KIỂM TRA TRẠNG THÁI ──────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({
    status: isRestoring ? 'restoring' : 'ready',
    message: isRestoring ? 'Server is restoring from backup' : 'Server is ready'
  });
});

// ─── PHẦN CÒN LẠI CỦA SERVER (GIỮ NGUYÊN) ──────────────────
// Tất cả các route và logic khác giữ nguyên, bao gồm admin, swap, mining, v.v.
// ... (giữ nguyên toàn bộ code từ file gốc, chỉ thêm sửa trong route /api/backup/sync)

// ===== CHỈ SỬA ROUTE /api/backup/sync =====
app.post('/api/backup/sync', (req, res) => {
  try {
    const data = req.body;
    const clientId = data.clientId || req.headers['x-client-id'] || '';
    const session = clientId ? dhSessions.get(clientId) : null;
    if (!session) return res.status(401).json({ status: 'error', message: 'DH session required (no token fallback)' });
    console.log(`📥 Received from backup: type=${data.type}, empty=${data.empty}`);
    if (data.type === 'FULL_SNAPSHOT' && data.state) {
      const incomingUsers = (data.state.users || []).length;
      const incomingBlockCount = (data.state.blocks || []).length;

      // Layer 1: compare against all registered backup nodes' reported data
      const now = Date.now();
      let bestKnownUsers = 0, bestKnownBlocks = 0;
      for (const info of Object.values(registeredBackupNodes)) {
        if (now - new Date(info.last_seen).getTime() > 600000) continue;
        if (info.users > bestKnownUsers) bestKnownUsers = info.users;
        if (info.blocks > bestKnownBlocks) bestKnownBlocks = info.blocks;
      }

      // Layer 2: also compare against best snapshot we've already accepted this session
      if (bestSnapshotMetrics.users > bestKnownUsers) bestKnownUsers = bestSnapshotMetrics.users;
      if (bestSnapshotMetrics.blocks > bestKnownBlocks) bestKnownBlocks = bestSnapshotMetrics.blocks;

      // Reject if significantly behind peers or previously accepted state
      if (bestKnownUsers > 0 && incomingUsers < bestKnownUsers * 0.8) {
        console.warn(`🚫 Rejected FULL_SNAPSHOT: incoming has ${incomingUsers} users, best known is ${bestKnownUsers}. Refusing downgrade.`);
        return res.json({ type: 'SNAPSHOT_REJECTED', status: 'error', message: `Best backup node has ${bestKnownUsers} users but this snapshot has only ${incomingUsers}. Refusing restore.` });
      }
      if (bestKnownBlocks > 0 && incomingBlockCount < bestKnownBlocks * 0.8) {
        console.warn(`🚫 Rejected FULL_SNAPSHOT: incoming has ${incomingBlockCount} blocks, best known is ${bestKnownBlocks}. Refusing downgrade.`);
        return res.json({ type: 'SNAPSHOT_REJECTED', status: 'error', message: `Best backup node has ${bestKnownBlocks} blocks but this snapshot has only ${incomingBlockCount}. Refusing restore.` });
      }

      // Layer 3: absolute floor — even if no peers exist, reject obviously empty snapshots
      const ABSOLUTE_MIN_USERS = 5;
      const ABSOLUTE_MIN_BLOCKS = 5;
      if ((bestKnownUsers === 0 && bestKnownBlocks === 0) && (incomingUsers < ABSOLUTE_MIN_USERS || incomingBlockCount < ABSOLUTE_MIN_BLOCKS)) {
        console.warn(`🚫 Rejected FULL_SNAPSHOT: too few data (${incomingUsers} users, ${incomingBlockCount} blocks) and no peers to compare against. Minimum floor: ${ABSOLUTE_MIN_USERS} users, ${ABSOLUTE_MIN_BLOCKS} blocks.`);
        return res.json({ type: 'SNAPSHOT_REJECTED', status: 'error', message: `Snapshot has only ${incomingUsers} users and ${incomingBlockCount} blocks. Refusing restore.` });
      }

      // ─── BẮT ĐẦU RESTORE ────────────────────────────────────────
      console.log(`📥 Receiving full DB snapshot from backup client (${incomingUsers} users, ${incomingBlockCount} blocks)...`);
      
      // Đặt cờ restore, chặn mọi request khác
      isRestoring = true;
      
      // Tạm dừng các tiến trình nền
      if (global.posMintingInterval) clearInterval(global.posMintingInterval);
      if (global.nodeFeesInterval) clearInterval(global.nodeFeesInterval);
      
      try {
        db.importFullState(data.state);
        console.log('✅ Full database restored from backup client');
        
        // Cập nhật metrics
        const incomingTotal = incomingUsers + incomingBlockCount
          + (data.state.stakes || []).length
          + (data.state.snake_claims || []).length
          + (data.state.bounties || []).length;
        if (incomingUsers > bestSnapshotMetrics.users) bestSnapshotMetrics.users = incomingUsers;
        if (incomingBlockCount > bestSnapshotMetrics.blocks) bestSnapshotMetrics.blocks = incomingBlockCount;
        
        // Tạo lại các tài khoản hệ thống
        NodeFeesRouter.ensureHoldingAccount();
        NodeFeesRouter.ensureNodeFeesAccount();
        let swapHolding = db.getUser('swap_holding');
        if (!swapHolding) {
          const randomPin = crypto.randomBytes(16).toString('hex');
          db.authenticate('swap_holding', randomPin);
          console.log('🏦 Re-created swap_holding account after restore');
        }
        let swapLiquidity = db.getUser('swap_liquidity');
        if (!swapLiquidity) {
          const randomPin = crypto.randomBytes(16).toString('hex');
          db.authenticate('swap_liquidity', randomPin);
          console.log('🏊 Re-created swap_liquidity account after restore');
        }
        // Khởi động lại các tiến trình nền
        blockchain.startPoSMinting();
        NodeFeesRouter.initNodeFees();
        
        res.json({ type: 'SNAPSHOT_ACK', status: 'success' });
      } catch (err) {
        console.error('❌ Restore failed:', err.message);
        res.status(500).json({ type: 'SNAPSHOT_ERROR', status: 'error', message: err.message });
      } finally {
        // Luôn tắt cờ restore, kể cả lỗi
        isRestoring = false;
        // Phục hồi các tiến trình nếu chưa được bật lại
        if (!global.posMintingInterval) blockchain.startPoSMinting();
        if (!global.nodeFeesInterval) NodeFeesRouter.initNodeFees();
      }
      return;
    }
    // Các loại message khác (READY, PING, ...) giữ nguyên
    if (data.type === 'READY') {
      const serverHasData = db.getSeq() > 0;
      const clientHasData = data.empty === false;
      console.log(`📋 READY: serverHasData=${serverHasData}, clientHasData=${clientHasData}`);
      if (data.empty === true) {
        console.log('📤 Client is empty, sending snapshot to client...');
        return res.json({ type: 'FULL_SNAPSHOT', state: db.exportFullState() });
      } else if (serverHasData === false && clientHasData === true) {
        console.log('📤 Server is empty, requesting snapshot from client...');
        return res.json({ type: 'REQUEST_SNAPSHOT', message: 'Server is empty, please send your snapshot' });
      } else {
        console.log('✅ Both have data or both empty, sending READY_ACK');
        return res.json({ type: 'READY_ACK', status: 'ok' });
      }
    }
    if (data.type === 'PING') return res.json({ type: 'PONG' });
    res.json({ type: 'ACK', status: 'received' });
  } catch (e) {
    console.error('❌ Error receiving backup:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ... (các route còn lại giữ nguyên, bao gồm /api/backup/register, /admin, swap, mining, v.v.)
// Để tránh quá dài, tôi chỉ trích dẫn phần cần sửa. Toàn bộ code server.js sẽ bao gồm tất cả route như ban đầu.

// ===== PHẦN CUỐI SERVER =====
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

blockchain.startPoSMinting();
NodeFeesRouter.initNodeFees();

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║     CHOCO HUB - PoW+PoS + SWAP       ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  HTTP/1.1  : http://localhost:${PORT} ║`);
  console.log(`║  HTTP/2 TLS: https://localhost:${HTTPS_PORT} ║`);
  console.log('║  Admin web : http://localhost:' + PORT + '/admin ║');
  console.log('║  Blockchain: Genesis created        ║');
  console.log('║  Mempool + Node Fees: Enabled       ║');
  console.log('║  User Management: Enabled           ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  backupClient.start();

  // Khởi động restore từ node nếu trống
  setTimeout(async () => {
    const blockCount = db.getBlockCount();
    if (blockCount === 0) {
      console.log('⚠️ Blockchain is empty, attempting restore from mining nodes...');
      // ... (giữ nguyên logic restore)
    }
  }, 3000);

  setInterval(() => db.pruneMiningNodes(), 60000);
});

const http2Server = http2.createSecureServer({ key: tlsKey, cert: tlsCert, allowHTTP1: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }, app);
http2Server.listen(HTTPS_PORT, () => {
  console.log(`🔐 HTTP/2 server listening on port ${HTTPS_PORT}`);
});

// ─── Biến metrics snapshot (đã có) ────────────────────────────
let bestSnapshotMetrics = { users: 0, blocks: 0, total_items: 0 };