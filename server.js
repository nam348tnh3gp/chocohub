// server.js – Hybrid PoW + PoS + Diffie-Hellman + HTTP/2 + TLS 1.3 + Session Token (JWT) + Rate Limit + Trust Proxy + SWAP
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
const db = require('./db');
const blockchain = require('./blockchain');
const snake = require('./snake');
const backupClient = require('./backupSync');
const DHExchange = require('./dh');

// ════════════════════════════════════════════════════
//  ADMIN CONFIG - Chỉ 2 user này có quyền admin
// ════════════════════════════════════════════════════
const ADMIN_USERS = ['chocoetom', 'Nam2010'];

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

// ─── Helper: canonical JSON ─────────────
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(k => `"${k}":${canonicalStringify(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

// ════════════════════════════════════════════════════════════════
//  RATE LIMITERS
// ════════════════════════════════════════════════════════════════
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

const snakeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 2,
  message: { status: 'error', message: 'Please wait before claiming again.' },
});

const swapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { status: 'error', message: 'Too many swap requests, please slow down.' },
});

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

// ─── Chứng chỉ TLS cho HTTP/2 – KHÔNG dùng execSync ──
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

// ─── DH Session Store ─────────────────────────────────
const dhSessions = new Map();
const serverDHKeys = DHExchange.generateStandardKeyPair('modp2048');

// ─── SWAP STORAGE ─────────────────────────────────────
let swapRequests = []; // { id, from_user, amount_cc, swap_type, receiver, rate, status, created_at }

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
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ════════════════════════════════════════════════════
//  MIDDLEWARE: Verify JWT token
// ════════════════════════════════════════════════════
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Missing or invalid token' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ status: 'error', message: 'Invalid or expired token' });
  }
}

// ════════════════════════════════════════════════════
//  PUBLIC ENDPOINTS
// ════════════════════════════════════════════════════
app.get('/api/server/public-key', (req, res) => {
  res.json({
    status: 'success',
    publicKey: SERVER_LONGTERM_KEY.publicKey,
    algorithm: 'RSA-4096',
    purpose: 'DH server authentication'
  });
});

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
    dhSessions.set(clientId, { sessionKey, createdAt: Date.now() });

    const serverPubData = canonicalStringify({
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

function verifyDHSignature(req, res, next) {
  if (!req.path.startsWith('/api/backup')) return next();

  const clientId = req.headers['x-client-id'] || req.body.clientId || req.query.clientId;
  const signature = req.headers['x-signature'];
  if (!clientId || !signature) return next();

  const session = dhSessions.get(clientId);
  if (!session) return next();

  const timestamp = req.headers['x-timestamp'] || '';
  const bodyStr = req.method === 'POST' ? canonicalStringify(req.body) : '';
  const signPayload = `${req.method}${req.path}${timestamp}${bodyStr}`;

  if (!DHExchange.verify(signPayload, signature, session.sessionKey)) {
    return res.status(401).json({ status: 'error', message: 'Invalid HMAC signature' });
  }
  next();
}

app.use(verifyDHSignature);

// AUTH
app.post('/auth', authLimiter, (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    const result = db.authenticate(username, pin);
    // Thêm thông tin is_admin vào response
    if (result.status === 'success' && result.token) {
      const decoded = jwt.verify(result.token, process.env.JWT_SECRET || 'secret');
      result.is_admin = isAdmin(decoded.username);
    }
    res.json(result);
  } catch (e) {
    res.status(401).json({ status: 'error', message: e.message });
  }
});

// Các route công khai (không cần token)
app.get('/get_user/:username', (req, res) => {
  try {
    const user = db.getUser(req.params.username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ status: 'success', balance: user.balance, username: user.username });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

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

app.get('/network_status', (req, res) => {
  try {
    const recent = db.getRecentBlocks(10);
    const validators = db.getValidators(10).map(v => ({ username: v.username, stake: v.amount }));
    res.json({ recent_blocks: recent, active_validators: validators });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

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

app.get('/leaderboard', (req, res) => {
  try {
    const normal = db.getLeaderboard('normal', 10);
    const hardcore = db.getLeaderboard('hardcore', 10);
    res.json({ normal, hardcore });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

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
    res.json({ status: 'success', balance, staked, is_validator: username === currentVal, pending_reward: pending, current_validator: currentVal || null });
  } catch (e) {
    console.error('/pos/info error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ════════════════════════════════════════════════════
//  SWAP ENDPOINTS (THÊM MỚI)
// ════════════════════════════════════════════════════

// Tạo yêu cầu swap
app.post('/swap/create', verifyToken, swapLimiter, (req, res) => {
  try {
    const { from_user, amount_cc, swap_type, receiver } = req.body;
    
    if (req.user.username !== from_user) {
      return res.status(403).json({ status: 'error', message: 'Unauthorized: username mismatch' });
    }
    
    if (!amount_cc || !swap_type || !receiver) {
      return res.status(400).json({ status: 'error', message: 'Missing required fields' });
    }
    
    const amount = parseFloat(amount_cc);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid amount' });
    }
    
    if (swap_type !== 'duco' && swap_type !== 'ccpoc') {
      return res.status(400).json({ status: 'error', message: 'Invalid swap type. Must be "duco" or "ccpoc"' });
    }
    
    const user = db.getUser(from_user);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    
    if (user.balance < amount) {
      return res.status(400).json({ status: 'error', message: 'Insufficient CC balance' });
    }
    
    // Trừ CC ngay lập tức
    db.updateBalance(from_user, -amount);
    db.addTransaction(from_user, 'swap_system', amount, `Swap to ${swap_type.toUpperCase()} for ${receiver}`);
    
    const newRequest = {
      id: Date.now() + '-' + crypto.randomBytes(8).toString('hex'),
      from_user,
      amount_cc: amount,
      swap_type,
      receiver: receiver.trim(),
      rate: swap_type === 'duco' ? 10 : 0.75,
      status: 'pending',
      created_at: new Date().toISOString()
    };
    
    swapRequests.push(newRequest);
    
    // Lưu swap requests vào file để persist
    try {
      fs.writeFileSync(path.join(__dirname, 'swap_requests.json'), JSON.stringify(swapRequests, null, 2));
    } catch(e) { /* ignore */ }
    
    console.log(`🔄 Swap request created: ${newRequest.id} | ${from_user} -> ${amount} CC to ${swap_type} for ${receiver}`);
    
    res.json({
      status: 'success',
      message: `Swap request created. ${amount} CC deducted.`,
      request_id: newRequest.id,
      new_balance: user.balance - amount
    });
    
  } catch (e) {
    console.error('Swap create error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Lấy danh sách swap pending – user thường chỉ thấy của mình, admin thấy tất cả
app.get('/swap/pending', verifyToken, (req, res) => {
  try {
    let pending = swapRequests.filter(r => r.status === 'pending');
    
    if (!isAdmin(req.user.username)) {
      pending = pending.filter(r => r.from_user === req.user.username);
    }
    
    res.json({
      status: 'success',
      pending,
      count: pending.length
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Đánh dấu swap hoàn thành – CHỈ ADMIN
app.post('/swap/fulfill', verifyToken, verifyAdmin, (req, res) => {
  try {
    const { request_id } = req.body;
    
    if (!request_id) {
      return res.status(400).json({ status: 'error', message: 'Missing request_id' });
    }
    
    const reqIndex = swapRequests.findIndex(r => r.id === request_id);
    if (reqIndex === -1) {
      return res.status(404).json({ status: 'error', message: 'Swap request not found' });
    }
    
    if (swapRequests[reqIndex].status !== 'pending') {
      return res.status(400).json({ status: 'error', message: 'Swap already processed' });
    }
    
    swapRequests[reqIndex].status = 'completed';
    swapRequests[reqIndex].completed_at = new Date().toISOString();
    swapRequests[reqIndex].fulfilled_by = req.user.username;
    
    try {
      fs.writeFileSync(path.join(__dirname, 'swap_requests.json'), JSON.stringify(swapRequests, null, 2));
    } catch(e) { /* ignore */ }
    
    console.log(`✅ Swap fulfilled by ${req.user.username}: ${request_id}`);
    
    res.json({
      status: 'success',
      message: 'Swap marked as completed'
    });
    
  } catch (e) {
    console.error('Swap fulfill error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Lấy tỷ giá swap
app.get('/swap/rates', (req, res) => {
  res.json({
    status: 'success',
    rates: {
      cc_to_duco: 10,
      cc_to_ccpoc: 0.75,
      note: '1 DUCO = 10 CC, 1 CC PoC = 0.75 CC'
    }
  });
});

// Lấy lịch sử swap của user
app.get('/swap/history', verifyToken, (req, res) => {
  try {
    const userHistory = swapRequests.filter(r => r.from_user === req.user.username);
    res.json({
      status: 'success',
      history: userHistory,
      total: userHistory.length
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Admin endpoints quản lý swap
app.get('/admin/swaps', verifyToken, verifyAdmin, (req, res) => {
  try {
    res.json({
      status: 'success',
      swaps: swapRequests,
      total: swapRequests.length
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.delete('/admin/swaps/:id', verifyToken, verifyAdmin, (req, res) => {
  try {
    const id = req.params.id;
    const index = swapRequests.findIndex(r => r.id === id);
    if (index === -1) {
      return res.status(404).json({ status: 'error', message: 'Swap not found' });
    }
    swapRequests.splice(index, 1);
    try {
      fs.writeFileSync(path.join(__dirname, 'swap_requests.json'), JSON.stringify(swapRequests, null, 2));
    } catch(e) { /* ignore */ }
    res.json({ status: 'success', message: 'Swap deleted' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ════════════════════════════════════════════════════
//  CÁC ROUTE YÊU CẦU TOKEN (GIỮ NGUYÊN)
// ════════════════════════════════════════════════════
app.post('/send_cc', verifyToken, sendLimiter, (req, res) => {
  const { to_username, amount } = req.body;
  const from_username = req.user.username;

  if (!to_username || !amount) {
    return res.status(400).json({ status: 'error', message: 'Missing fields' });
  }
  try {
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
    res.json({ status: 'success', message: `Sent ${sendAmount} CC to ${to_username}`, new_balance: newBalance });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

app.post('/snake/claim', verifyToken, snakeLimiter, (req, res) => {
  const { apples, mode } = req.body;
  const username = req.user.username;
  if (apples == null) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    const result = snake.processClaim(username, null, apples, mode);
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

app.post('/pos/stake', verifyToken, stakeLimiter, (req, res) => {
  try {
    const { amount } = req.body;
    const username = req.user.username;
    if (!amount) return res.status(400).json({ status: 'error', message: 'Missing amount' });
    const stakeAmount = parseFloat(amount);
    if (isNaN(stakeAmount) || stakeAmount < 10) throw new Error('Minimum stake is 10 CC');
    const result = db.stake(username, stakeAmount);
    res.json({ status: 'success', message: 'Staked ' + stakeAmount + ' CC', staked: Number(result.amount) || 0 });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

app.post('/pos/unstake', verifyToken, stakeLimiter, (req, res) => {
  try {
    const username = req.user.username;
    const currentStake = db.getStake(username);
    const totalAmount = (currentStake.amount || 0) + (currentStake.pending_reward || 0);
    db.unstake(username);
    res.json({ status: 'success', message: 'Unstaked successfully. All funds returned.', staked: 0 });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// ════════════════════════════════════════════════════
//  MINING ROUTES (CÔNG KHAI)
// ════════════════════════════════════════════════════
app.get('/active_bounties_list', (req, res) => {
  try {
    const bounties = blockchain.getActiveBounties();
    res.json(bounties);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/get_job', (req, res) => {
  try {
    const { worker_name } = req.body;
    if (!worker_name) {
      return res.status(400).json({ status: 'error', message: 'Missing worker_name' });
    }
    const job = blockchain.getJobForWorker(worker_name);
    if (!job) {
      return res.status(404).json({ status: 'error', message: 'No job available' });
    }
    res.json(job);
  } catch (e) {
    console.error('get_job error:', e);
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
      return res.status(400).json({ status: 'error', message: 'Missing required parameters: bounty_id, nonce, worker_name' });
    }
    const result = blockchain.submitSolution(bounty_id, nonce, worker_name, device_type);
    if (result && result.status === 'success') sendMinerWebhook(worker_name, bounty_id, device_type);
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

app.get('/miner_heartbeat', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), message: 'ChocoHub API is running', uptime: process.uptime() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), dbHash: getDbHash() });
});

// ════════════════════════════════════════════════════
//  BACKUP ENDPOINTS (GIỮ NGUYÊN)
// ════════════════════════════════════════════════════
app.post('/api/backup/register', (req, res) => {
  const { url, token, name, description, owner, platform, clientId } = req.body;
  if (!url || !token) return res.status(400).json({ status: 'error', message: 'Missing url or token' });
  const providedToken = req.body.token || '';
  const isTokenValid = providedToken === (process.env.BACKUP_TOKEN || 'chocohub-default-token');
  const session = clientId ? dhSessions.get(clientId) : null;
  if (!isTokenValid && !session) return res.status(401).json({ status: 'error', message: 'Invalid token or no valid session' });
  registeredBackupNodes[url] = { name: name || 'Unknown', description: description || '', owner: owner || '', platform: platform || 'Unknown', last_seen: new Date().toISOString() };
  console.log(`📡 Backup node registered: ${name || url} (${url})`);
  res.json({ status: 'success', message: 'Node registered' });
});

app.get('/api/backup/nodes', (req, res) => {
  const now = Date.now();
  for (const [url, info] of Object.entries(registeredBackupNodes)) {
    if (now - new Date(info.last_seen).getTime() > 600000) delete registeredBackupNodes[url];
  }
  res.json({ status: 'success', nodes: registeredBackupNodes });
});

app.post('/api/backup/sync', (req, res) => {
  try {
    const data = req.body;
    const token = data.token || '';
    const clientId = data.clientId || req.headers['x-client-id'] || '';
    const session = clientId ? dhSessions.get(clientId) : null;
    const isTokenValid = token === (process.env.BACKUP_TOKEN || 'chocohub-default-token');
    if (!isTokenValid && !session) return res.status(401).json({ status: 'error', message: 'Invalid token or no valid session' });
    console.log(`📥 Received from backup: type=${data.type}, empty=${data.empty}`);
    if (data.type === 'FULL_SNAPSHOT' && data.state) {
      console.log('📥 Receiving full DB snapshot from backup client...');
      db.importFullState(data.state);
      console.log('✅ Full database restored from backup client');
      return res.json({ type: 'SNAPSHOT_ACK', status: 'success' });
    }
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

// Load swap requests from file on startup
try {
  const swapFile = path.join(__dirname, 'swap_requests.json');
  if (fs.existsSync(swapFile)) {
    const saved = JSON.parse(fs.readFileSync(swapFile, 'utf8'));
    if (Array.isArray(saved)) swapRequests.push(...saved);
    console.log(`📦 Loaded ${swapRequests.length} swap requests from file`);
  }
} catch(e) { console.warn('Could not load swap requests:', e.message); }

// SPA fallback
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  try {
    if (fs.existsSync(indexPath)) res.sendFile(indexPath);
    else res.status(200).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ChocoHub</title><style>body{background:#0a0a12;color:#eee4d8;font-family:"Outfit",sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;text-align:center}h1{color:#f58a00;font-size:2.5rem}p{color:#8b8296;margin-top:10px}</style></head><body><div><h1>ChocoHub</h1><p>Server is running. Please upload frontend files to continue.</p><p style="font-size:0.8rem;margin-top:20px;">API: <code style="color:#f58a00;">/api/test</code></p></div></body></html>');
  } catch(e) {
    res.status(500).send('Server error');
  }
});

app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

blockchain.startAutoBounty();
blockchain.startPoSMinting();

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║     CHOCO HUB - PoW+PoS + SWAP       ║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  HTTP/1.1  : http://localhost:' + PORT + '    ║');
  console.log('║  HTTP/2 TLS: https://localhost:' + HTTPS_PORT + '  ║');
  console.log('║  API Test  : /api/test               ║');
  console.log('║  DH Exchange: /api/dh/exchange       ║');
  console.log('║  Server PubKey: /api/server/public-key║');
  console.log('║  Backup Nodes: /api/backup/nodes     ║');
  console.log('║  SWAP       : /swap/create           ║');
  console.log('║  SWAP Rates : /swap/rates            ║');
  console.log('║  Admins     : chocoetom, Nam2010     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  backupClient.start();
});

const http2Server = http2.createSecureServer({ key: tlsKey, cert: tlsCert, allowHTTP1: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }, app);
http2Server.listen(HTTPS_PORT, () => {
  console.log(`🔐 HTTP/2 server listening on port ${HTTPS_PORT}`);
});
