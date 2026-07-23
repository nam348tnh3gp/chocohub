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

app.get('/admin', (req, res) => {
  if (req.session.admin) {
    return res.redirect('/admin/dashboard');
  }
  res.sendFile(path.join(__dirname, 'views', 'admin', 'login.html'));
});
app.post('/admin/login', async (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing credentials' });
  try {
    const authResult = db.authenticate(username, pin);
    if (authResult.status !== 'success') {
      return res.status(401).json({ status: 'error', message: 'Invalid credentials' });
    }
    if (!isAdmin(username)) {
      return res.status(403).json({ status: 'error', message: 'Not an admin user' });
    }
    const adminToken = jwt.sign({ username }, process.env.JWT_SECRET || 'secret', { expiresIn: '24h' });
    req.session.admin = true;
    req.session.adminUsername = username;
    req.session.adminToken = adminToken;
    res.json({ status: 'success', message: 'Login successful' });
  } catch (e) {
    res.status(401).json({ status: 'error', message: e.message });
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/admin');
});

function requireAdminSession(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.status(401).json({ status: 'error', message: 'Admin session required' });
}


app.get('/admin/api/all-users', requireAdminSession, async (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json({ status: 'success', users });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/admin/api/users', requireAdminSession, async (req, res) => {
  try {
    const { username, pin } = req.body;
    if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing username or pin' });
    if (username.length < 3 || pin.length < 4) return res.status(400).json({ status: 'error', message: 'Username min 3, PIN min 4' });
    // Check whether the user already exists
    const existing = db.getUser(username);
    if (existing) return res.status(400).json({ status: 'error', message: 'User already exists' });
    const result = db.authenticate(username, pin);
    res.json({ status: 'success', message: `User ${username} created`, user: { username, balance: result.balance || 0 } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/admin/api/users/:username', requireAdminSession, async (req, res) => {
  try {
    const username = req.params.username;
    if (isAdmin(username)) {
      return res.status(403).json({ status: 'error', message: 'Cannot delete admin user' });
    }
    db.deleteUser(username);
    res.json({ status: 'success', message: `User ${username} deleted` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/admin/api/users/:username/ban', requireAdminSession, async (req, res) => {
  try {
    const username = req.params.username;
    const { banned } = req.body; // true hoặc false
    if (isAdmin(username)) {
      return res.status(403).json({ status: 'error', message: 'Cannot ban admin user' });
    }
    db.setUserBanned(username, banned);
    res.json({ status: 'success', message: `User ${username} ${banned ? 'banned' : 'unbanned'}` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/admin/api/users/:username/detail', requireAdminSession, async (req, res) => {
  try {
    const username = req.params.username;
    const user = db.getUser(username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    const stake = db.getStake(username) || { amount: 0, pending_reward: 0 };
    const transactions = db.getTransactions(username, 20) || [];
    res.json({ status: 'success', user, stake, transactions });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});


app.get('/admin/api/all-swaps', requireAdminSession, async (req, res) => {
  try {
    const swaps = SwapRouter.getAllSwapRequests();
    res.json({ status: 'success', swaps, total: swaps.length });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/admin/api/balance/:username', requireAdminSession, async (req, res) => {
  try {
    const user = db.getUser(req.params.username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ status: 'success', balance: user.balance });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/admin/api/update-balance', requireAdminSession, async (req, res) => {
  try {
    const { username, amount, action } = req.body;
    const user = db.getUser(username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    
    if (action === 'add') {
      db.updateBalance(username, amount);
    } else if (action === 'remove') {
      if (user.balance < amount) {
        return res.status(400).json({ status: 'error', message: 'Insufficient balance' });
      }
      db.updateBalance(username, -amount);
    } else if (action === 'set') {
      const currentBalance = user.balance;
      const diff = amount - currentBalance;
      db.updateBalance(username, diff);
    } else {
      return res.status(400).json({ status: 'error', message: 'Invalid action' });
    }
    
    const newUser = db.getUser(username);
    res.json({ status: 'success', message: `Balance updated`, new_balance: newUser.balance });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/admin/api/update-stake', requireAdminSession, async (req, res) => {
  try {
    const { username, amount, action } = req.body;
    const num = Number(amount);
    if (!username || isNaN(num) || num < 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid amount' });
    }
    const user = db.getUser(username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });

    const current = db.getStake(username);
    let newAmount;
    if (action === 'add') {
      newAmount = (Number(current.amount) || 0) + num;
    } else if (action === 'remove') {
      if ((Number(current.amount) || 0) < num) {
        return res.status(400).json({ status: 'error', message: 'Insufficient staked amount' });
      }
      newAmount = (Number(current.amount) || 0) - num;
    } else if (action === 'set') {
      newAmount = num;
    } else {
      return res.status(400).json({ status: 'error', message: 'Invalid action' });
    }

    db.prepare('UPDATE stakes SET amount = ? WHERE username = ?').run(newAmount, username);
    const fresh = db.getStake(username);
    res.json({ status: 'success', message: 'Stake updated', new_stake: fresh.amount, pending_reward: fresh.pending_reward });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/admin/api/transactions/:username', requireAdminSession, async (req, res) => {
  try {
    const transactions = db.getTransactions(req.params.username, 50);
    res.json({ status: 'success', transactions });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/admin/api/fulfill', requireAdminSession, async (req, res) => {
  try {
    const { request_id, xno_txid } = req.body;
    const token = req.session.adminToken;
    const response = await fetch(`http://localhost:${PORT}/swap/fulfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ request_id, xno_txid })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.delete('/admin/api/delete/:id', requireAdminSession, async (req, res) => {
  try {
    const id = req.params.id;
    const result = SwapRouter.deleteSwapById(id, true);
    if (!result.ok) {
      return res.status(result.code || 400).json({ status: 'error', message: result.message });
    }
    res.json({ status: 'success', message: 'Swap deleted' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});


app.get('/admin/api/flagged-workers', requireAdminSession, (req, res) => {
  try {
    const flagged = db.getFlaggedWorkers();
    // Enrich with tier info
    const enriched = flagged.map(w => ({
      ...w,
      tier: db.getWorkerTier(w.worker_name)
    }));
    res.json({ status: 'success', workers: enriched });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/admin/api/workers/:worker/suspend', requireAdminSession, (req, res) => {
  try {
    const workerName = req.params.worker;
    const { reason } = req.body;
    db.suspendWorker(workerName, reason || 'Manual suspension by admin');
    res.json({ status: 'success', message: `Worker ${workerName} suspended` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/admin/api/workers/:worker/clear', requireAdminSession, (req, res) => {
  try {
    const workerName = req.params.worker;
    const adminUsername = req.session.adminUsername;
    db.clearWorkerSuspension(workerName, adminUsername);
    res.json({ status: 'success', message: `Worker ${workerName} cleared by ${adminUsername}` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.get('/admin/dashboard', requireAdminSession, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin', 'dashboard.html'));
});
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

app.use('/swap', SwapRouter);

app.use('/node_fees', NodeFeesRouter.router);

app.post('/auth', authLimiter, (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    // Check whether the user is banned
    const user = db.getUser(username);
    if (user && user.banned) {
      return res.status(403).json({ status: 'error', message: 'Account is banned' });
    }
    const result = db.authenticate(username, pin);
    if (result.status === 'success' && result.token) {
      const decoded = jwt.verify(result.token, process.env.JWT_SECRET || 'secret');
      result.is_admin = isAdmin(decoded.username);
    }
    res.json(result);
  } catch (e) {
    res.status(401).json({ status: 'error', message: e.message });
  }
});

app.get('/get_user/:username', (req, res) => {
  try {
    const user = db.getUser(req.params.username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    if (user.banned) {
      return res.status(403).json({ status: 'error', message: 'Account is banned' });
    }
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
    if (user.banned) {
      return res.status(403).json({ status: 'error', message: 'Account is banned' });
    }
    res.json({ status: 'success', balance: user.balance });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/get_transactions', (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Missing username' });
  try {
    const user = db.getUser(username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    // Banned users can still view history if we choose to allow it.
    const transactions = db.getTransactions(username, 20);
    res.json({ status: 'success', transactions });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/network_status', (req, res) => {
  try {
    const lastBlock = db.getLastBlock();
    const blocks = db.getBlocks(10);
    const validators = db.getValidators(10).map(v => ({ username: v.username, stake: v.amount }));
    const posRewardPool = db.getPosRewardPool ? db.getPosRewardPool() : { balance: 0, total_fees: 0 };
    res.json({
      recent_blocks: blocks,
      last_block: lastBlock,
      active_validators: validators,
      pos_reward_pool: posRewardPool,
      total_blocks: db.getBlockCount ? db.getBlockCount() : 0
    });
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
    const posRewardPool = db.getPosRewardPool ? db.getPosRewardPool() : { balance: 0, total_fees: 0 };
    res.json({ status: 'success', balance, staked, is_validator: username === currentVal, pending_reward: pending, current_validator: currentVal || null, reward_pool: posRewardPool });
  } catch (e) {
    console.error('/pos/info error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

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
    // Check the sender.
    const sender = db.getUser(from_username);
    if (!sender) return res.status(404).json({ status: 'error', message: 'Sender not found' });
    if (sender.banned) {
      return res.status(403).json({ status: 'error', message: 'Account is banned' });
    }
    // Check the recipient.
    const receiver = db.getUser(to_username);
    if (!receiver) return res.status(404).json({ status: 'error', message: 'Receiver not found' });
    if (receiver.banned) {
      return res.status(403).json({ status: 'error', message: 'Cannot send to banned account' });
    }

    // Calculate the fee using the node_fees config, defaulting to 1%.
    const feePercent = NodeFeesRouter.TRANSACTION_FEE_PERCENT || 1;
    const fee = parseFloat((sendAmount * feePercent / 100).toFixed(8));
    const totalDeducted = parseFloat((sendAmount + fee).toFixed(8));

    // Check the balance.
    if (sender.balance < totalDeducted) {
      return res.status(400).json({ status: 'error', message: `Insufficient balance. Need ${totalDeducted} CC (including ${fee} CC fee)` });
    }

    // Deduct funds from the sender and move them into mempool_holding.
    db.updateBalance(from_username, -totalDeducted);
    db.updateBalance('mempool_holding', totalDeducted);
    const txId = 'tx_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const mempoolTx = {
      id: txId,
      from_username: from_username,
      to_username: to_username,
      amount: sendAmount,
      fee: fee,
      total_deducted: totalDeducted
    };
    db.addToMempool(mempoolTx);

    console.log(`📥 [Mempool] ${from_username} sent ${sendAmount} CC to ${to_username} (fee ${fee} CC), pending confirmation`);

    res.json({
      status: 'pending',
      message: `Transaction added to mempool. ${sendAmount} CC will be sent to ${to_username} after confirmation (fee ${fee} CC)`,
      tx_id: txId,
      fee: fee,
      total_deducted: totalDeducted,
      new_balance: sender.balance - totalDeducted
    });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

app.post('/snake/start-game', snakeSessionLimiter, (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) {
    return res.status(401).json({ status: 'error', message: 'Missing username or pin' });
  }
  try {
    const authResult = db.authenticate(username, pin);
    if (authResult.status !== 'success') {
      return res.status(401).json({ status: 'error', message: 'Invalid username or pin' });
    }
    const user = db.getUser(username);
    if (user && user.banned) {
      return res.status(403).json({ status: 'error', message: 'Account is banned' });
    }
    const session = snake.createGameSession(username);
    res.json({ status: 'success', game_session_id: session.id, expires_at: session.expires_at });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/snake/claim', snakeClaimLimiter, (req, res) => {
  const { username, pin, apples, mode, game_session_id } = req.body;
  if (!username || !pin) {
    return res.status(401).json({ status: 'error', message: 'Missing username or pin' });
  }
  if (apples == null) {
    return res.status(400).json({ status: 'error', message: 'Missing apples' });
  }
  if (!game_session_id) {
    return res.status(400).json({ status: 'error', message: 'Missing game session' });
  }
  try {
    const authResult = db.authenticate(username, pin);
    if (authResult.status !== 'success') {
      return res.status(401).json({ status: 'error', message: 'Invalid username or pin' });
    }
    const user = db.getUser(username);
    if (user && user.banned) {
      return res.status(403).json({ status: 'error', message: 'Account is banned' });
    }
    const result = snake.processClaim(username, game_session_id, apples, mode);
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
    db.unstake(username);
    res.json({ status: 'success', message: 'Unstaked successfully. All funds returned.', staked: 0 });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});


const boostChallenges = new Map();
const BOOST_CHALLENGE_TTL = 120; // segundos
const BOOST_MIN_VIEW_SECONDS = 10; // Minimum seconds between challenge and activate.

setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, c] of boostChallenges) {
    if (c.used || (now - c.issued_at) > BOOST_CHALLENGE_TTL) boostChallenges.delete(id);
  }
}, 60000);

app.post('/mining/boost/challenge', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ status: 'error', message: 'Missing username' });
  const id = 'ch_' + Date.now() + '_' + crypto.randomBytes(6).toString('hex');
  const issued_at = Math.floor(Date.now() / 1000);
  boostChallenges.set(id, { username: username.trim(), issued_at, used: false });
  res.json({ status: 'success', challenge_id: id, issued_at });
});

app.post('/mining/boost/activate', boostLimiter, (req, res) => {
  const { username, challenge_id } = req.body;
  if (!username) return res.status(400).json({ status: 'error', message: 'Missing username' });
  if (!challenge_id) return res.status(400).json({ status: 'error', message: 'Missing challenge_id' });
  try {
    // Validate the challenge (implicit authentication).
    const challenge = boostChallenges.get(challenge_id);
    if (!challenge) return res.status(400).json({ status: 'error', message: 'Invalid or expired challenge' });
    if (challenge.username !== username.trim()) return res.status(400).json({ status: 'error', message: 'Challenge belongs to another user' });
    if (challenge.used) return res.status(400).json({ status: 'error', message: 'Challenge already used' });

    // Validate the minimum viewing time.
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - challenge.issued_at;
    if (elapsed < BOOST_MIN_VIEW_SECONDS) {
      return res.status(400).json({
        status: 'error',
        message: `Ad must be visible for at least ${BOOST_MIN_VIEW_SECONDS}s (only ${elapsed}s elapsed)`
      });
    }

    const user = db.getUser(username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    if (user && user.banned) return res.status(403).json({ status: 'error', message: 'Account is banned' });

    // Mark the challenge as used and activate the boost.
    challenge.used = true;
    boostChallenges.set(challenge_id, challenge);
    const result = db.activateMiningBoost(username, 1.3);
    res.json({
      status: 'success',
      message: `1.3x mining boost activated! Expires at ${new Date(result.expires_at * 1000).toISOString()}`,
      multiplier: result.multiplier,
      expires_at: result.expires_at,
      total_activations: result.total_activations
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/mining/boost/status', (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Missing username' });
  try {
    const boost = db.getMiningBoost(username);
    if (!boost) {
      return res.json({ status: 'success', active: false, multiplier: 1.0 });
    }
    const remainingMs = Math.max(0, (boost.expires_at * 1000) - Date.now());
    res.json({
      status: 'success',
      active: true,
      multiplier: boost.multiplier,
      expires_at: boost.expires_at,
      remaining_ms: remainingMs,
      remaining_minutes: Math.ceil(remainingMs / 60000)
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});


// ĐÃ XÓA endpoint /mining/register-tier

app.get('/mining/tier', verifyToken, (req, res) => {
  try {
    const workerName = req.user.username;
    const instanceId = req.query.instance_id;
    const tierKey = instanceId ? `${workerName}:${instanceId}` : workerName;
    let tier = db.getWorkerTier(tierKey);
    if (!tier || tier === 'cpu') {
      tier = db.getWorkerTier(workerName);
    }

    const tierInfo = blockchain.TIER_CONFIG ? blockchain.TIER_CONFIG[tier] : null;

    const flags = db.getWorkerFlags(workerName);

    res.json({
      status: 'success',
      worker: workerName,
      tier,
      multiplier: tierInfo ? tierInfo.multiplier : 1.0,
      max_difficulty: tierInfo ? tierInfo.maxDifficulty : null,
      description: tierInfo ? tierInfo.description : null,
      warning_count: flags.warning_count || 0,
      suspended: flags.suspended || false
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/blocks', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const blocks = db.getBlocks(limit);
    const last = db.getLastBlock();
    res.json({ status: 'success', blocks, last_block: last, total: db.getBlockCount ? db.getBlockCount() : 0 });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/block/:height', (req, res) => {
  try {
    const height = parseInt(req.params.height);
    if (isNaN(height) || height < 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid height' });
    }
    const block = db.getBlockByHeight(height);
    if (!block) return res.status(404).json({ status: 'error', message: 'Block not found' });
    res.json({ status: 'success', block });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/get_job', (req, res) => {
  try {
    const { worker_name, instance_id, device_type } = req.body;
    if (!worker_name || typeof worker_name !== 'string') {
      return res.status(400).json({ status: 'error', message: 'Missing worker_name' });
    }
    const cleanWorker = worker_name.trim().substring(0, 100);
    const cleanInstance = instance_id ? String(instance_id).trim().substring(0, 50) : instance_id;
    const cleanDevice = device_type ? String(device_type).trim().substring(0, 50) : device_type;
    const job = blockchain.getJobForWorker(cleanWorker, cleanInstance, cleanDevice);
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
    const job = db.getActiveJob(req.params.id);
    if (!job) return res.status(404).json({ status: 'error', message: 'Job not found' });
    res.json({
      job_id: job.id,
      height: job.height,
      prev_hash: job.prev_hash,
      difficulty: job.difficulty,
      target_hex: job.target_hex,
      reward: job.reward,
      assigned_to: job.assigned_to
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/submit_solution', (req, res) => {
  try {
    const bounty_id = req.query.bounty_id || req.body.bounty_id;
    const nonce = req.query.nonce || req.body.nonce;
    const device_type = req.query.device_type || req.body.device_type || 'web';
    const hashrate_reported = parseFloat(req.body.hashrate_reported) || 0;
    const instance_id = req.body.instance_id; // per-instance difficulty tracking

    if (!bounty_id || !nonce) {
      return res.status(400).json({ status: 'error', message: 'Missing required parameters: bounty_id, nonce' });
    }

    // Support both JWT-authenticated (MPG miner) and unauthenticated (webminer) flows
    let worker_name;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], process.env.JWT_SECRET || 'secret');
        worker_name = decoded.username;
      } catch (e) {
        return res.status(403).json({ status: 'error', message: 'Invalid or expired token' });
      }
      // If token is present, submitted worker_name must match
      const submitted_worker = req.query.worker_name || req.body.worker_name;
      if (submitted_worker && submitted_worker !== worker_name) {
        return res.status(403).json({ status: 'error', message: `worker_name mismatch: token is ${worker_name} but submitted ${submitted_worker}` });
      }
    } else {
      // Unauthenticated fallback: use worker_name from body (webminer)
      worker_name = req.query.worker_name || req.body.worker_name;
      if (!worker_name || typeof worker_name !== 'string') {
        return res.status(400).json({ status: 'error', message: 'Missing worker_name. Authenticate with JWT or provide worker_name in body.' });
      }
    }

    // Sanitize/cap length of client-controlled fields, matching the hardened
    // node-relayed route (previously unbounded here, allowing oversized or
    // malformed instance_id/device_type/worker_name to reach the DB/hash input)
    const cleanWorkerName = String(worker_name).trim().substring(0, 100);
    const cleanInstanceId = instance_id ? String(instance_id).trim().substring(0, 50) : instance_id;
    const cleanDeviceType = String(device_type).trim().substring(0, 50);

    const result = blockchain.submitSolution(bounty_id, nonce, cleanWorkerName, cleanDeviceType, hashrate_reported, cleanInstanceId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

app.get('/miner_heartbeat', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

app.get('/active_bounties_list', (req, res) => {
  try {
    const blocks = db.getBlocks(20);
    const last = db.getLastBlock();
    res.json({ status: 'success', blocks, last_block: last });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/mining/user-stats', (req, res) => {
  const username = req.query.username;
  if (!username) return res.status(400).json({ status: 'error', message: 'Missing username' });
  try {
    const now = Math.floor(Date.now() / 1000);
    const dayAgo = now - 86400;
    const blocks = db.getBlocksByMiner(username, dayAgo);
    const workerNames = [...new Set(blocks.map(b => b.miner))];
    const dailyProfit = blocks.reduce((sum, b) => sum + (b.reward || 0), 0);
    res.json({
      status: 'success',
      workers: workerNames,
      worker_count: workerNames.length,
      daily_profit: parseFloat(dailyProfit.toFixed(8)),
      blocks_today: blocks.length,
      blocks
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), message: 'ChocoHub API is running', uptime: process.uptime() });
});

function trustedValidateChain(blocks = []) {
  if (!Array.isArray(blocks) || blocks.length === 0) return { ok: false, message: 'Empty chain' };
  const sorted = [...blocks].sort((a, b) => a.height - b.height);
  for (let i = 0; i < sorted.length; i++) {
    const block = sorted[i];
    if (typeof block.height !== 'number' || !block.hash || !block.prev_hash) return { ok: false, message: 'Invalid block' };
    if (i > 0) {
      if (sorted[i].height !== sorted[i - 1].height + 1) return { ok: false, message: 'Height gap' };
      if (sorted[i].prev_hash !== sorted[i - 1].hash) return { ok: false, message: 'Prev hash mismatch' };
    }
  }
  return { ok: true, blocks: sorted };
}

function trustedCanonizeRemote(blocks = []) {
  const check = trustedValidateChain(blocks);
  if (!check.ok) return { ok: false, message: check.message };
  const sorted = check.blocks;
  const tip = db.getTrustedTip ? db.getTrustedTip() : null;
  if (tip && sorted[sorted.length - 1].height <= tip.height) {
    return { ok: true, imported: 0, tip };
  }
  const imported = db.upsertTrustedBlocks ? db.upsertTrustedBlocks(sorted) : 0;
  return { ok: true, imported, tip: db.getTrustedTip ? db.getTrustedTip() : null };
}
app.get('/api/trusted/chain', (req, res) => {
  try {
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit) || 1000));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const blocks = db.getTrustedBlocks ? db.getTrustedBlocks(limit, offset) : [];
    const tip = db.getTrustedTip ? db.getTrustedTip() : null;
    res.json({ status: 'success', blocks, tip, total: blocks.length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/api/trusted/sync', (req, res) => {
  try {
    const token = req.body?.token || req.headers['x-trusted-token'];
    if (token !== (process.env.TRUSTED_TOKEN || process.env.NODE_MASTER_TOKEN || 'trusted-global-token')) {
      return res.status(401).json({ status: 'error', message: 'Invalid trusted token' });
    }
    const blocks = Array.isArray(req.body?.blocks) ? req.body.blocks : [];
    const imported = db.upsertTrustedBlocks ? db.upsertTrustedBlocks(blocks) : 0;
    const tip = db.getTrustedTip ? db.getTrustedTip() : null;
    res.json({ status: 'success', imported, tip, received: blocks.length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), dbHash: getDbHash() });
});

app.post('/api/backup/register', (req, res) => {
  const { url, token, name, description, owner, platform, clientId, users, blocks, total_items } = req.body;
  if (!url || !token) return res.status(400).json({ status: 'error', message: 'Missing url or token' });
  if (!isAllowedBackupHost(url)) {
    return res.status(403).json({ status: 'error', message: 'URL not in allowed backup hosts' });
  }
  const providedToken = req.body.token || '';
  const isTokenValid = providedToken === (process.env.BACKUP_TOKEN || 'chocohub-default-token');
  const session = clientId ? dhSessions.get(clientId) : null;
  if (!isTokenValid && !session) return res.status(401).json({ status: 'error', message: 'Invalid token or no valid session' });
  registeredBackupNodes[url] = {
    name: name || 'Unknown',
    description: description || '',
    owner: owner || '',
    platform: platform || 'Unknown',
    last_seen: new Date().toISOString(),
    users: parseInt(users) || 0,
    blocks: parseInt(blocks) || 0,
    total_items: parseInt(total_items) || 0
  };
  console.log(`📡 Backup node registered: ${name || url} (${url}) — ${registeredBackupNodes[url].users} users, ${registeredBackupNodes[url].blocks} blocks`);
  res.json({ status: 'success', message: 'Node registered' });
});

app.get('/api/backup/nodes', (req, res) => {
  const now = Date.now();
  for (const [url, info] of Object.entries(registeredBackupNodes)) {
    if (now - new Date(info.last_seen).getTime() > 600000) delete registeredBackupNodes[url];
  }
  res.json({ status: 'success', nodes: registeredBackupNodes });
});

let bestSnapshotMetrics = { users: 0, blocks: 0, total_items: 0 };

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

      console.log(`📥 Receiving full DB snapshot from backup client (${incomingUsers} users, ${incomingBlockCount} blocks)...`);
      db.importFullState(data.state);
      console.log('✅ Full database restored from backup client');

      // Update best known snapshot metrics (prevents future downgrades in this session)
      const incomingTotal = incomingUsers + incomingBlockCount
        + (data.state.stakes || []).length
        + (data.state.snake_claims || []).length
        + (data.state.bounties || []).length;
      if (incomingUsers > bestSnapshotMetrics.users) bestSnapshotMetrics.users = incomingUsers;
      if (incomingBlockCount > bestSnapshotMetrics.blocks) bestSnapshotMetrics.blocks = incomingBlockCount;
      NodeFeesRouter.ensureHoldingAccount();
      NodeFeesRouter.ensureNodeFeesAccount();
      // swap_holding
      let swapHolding = db.getUser('swap_holding');
      if (!swapHolding) {
        const randomPin = crypto.randomBytes(16).toString('hex');
        db.authenticate('swap_holding', randomPin);
        console.log('🏦 Re-created swap_holding account after restore');
      }
      // swap_liquidity
      let swapLiquidity = db.getUser('swap_liquidity');
      if (!swapLiquidity) {
        const randomPin = crypto.randomBytes(16).toString('hex');
        db.authenticate('swap_liquidity', randomPin);
        console.log('🏊 Re-created swap_liquidity account after restore');
      }
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


app.post('/api/nodes/register', nodeRegisterLimit, (req, res) => {
  try {
    const { name, url, token, owner, location } = req.body;
    if (!name || !url || !token) {
      return res.status(400).json({ status: 'error', message: 'Missing name, url, or token' });
    }
    if (token !== NODE_MASTER_TOKEN) {
      return res.status(401).json({ status: 'error', message: 'Invalid master token' });
    }
    // Input sanitization
    const cleanName = String(name).trim().substring(0, 100);
    const cleanUrl = String(url).trim().substring(0, 500);
    const cleanOwner = String(owner || '').trim().substring(0, 100);
    const cleanLocation = String(location || '').trim().substring(0, 100);
    if (!cleanName || !cleanUrl) {
      return res.status(400).json({ status: 'error', message: 'Invalid name or url' });
    }
    if (!/^https?:\/\/.+/i.test(cleanUrl)) {
      return res.status(400).json({ status: 'error', message: 'URL must start with http:// or https://' });
    }
    const existing = db.getMiningNodeByUrl(cleanUrl);
    if (existing) {
      return res.json({ status: 'success', message: 'Node already registered', auth_token: existing.auth_token, id: existing.id });
    }
    // If same name exists with a different URL (tunnel restarted), update it — prevents duplicates
    const sameName = db.getMiningNodeByName(cleanName);
    if (sameName) {
      db.updateMiningNodeUrl(sameName.id, cleanUrl);
      console.log(`📡 Mining node URL updated: ${cleanName} (${cleanUrl})`);
      return res.json({ status: 'success', message: 'Node URL updated', auth_token: sameName.auth_token, id: sameName.id });
    }
    const node = db.registerMiningNode(cleanName, cleanUrl, cleanOwner, cleanLocation);
    console.log(`📡 Mining node registered: ${cleanName} (${cleanUrl})`);
    res.json({ status: 'success', message: 'Node registered', auth_token: node.auth_token, id: node.id });
  } catch (e) {
    console.error('Node register error:', e.message);
    res.status(500).json({ status: 'error', message: 'Registration failed' });
  }
});

app.post('/api/nodes/heartbeat', nodeRateLimit, (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ status: 'error', message: 'Missing auth token' });
    }
    const token = authHeader.split(' ')[1];
    const node = db.getMiningNodeByToken(token);
    if (!node) {
      return res.status(401).json({ status: 'error', message: 'Invalid node token' });
    }
    const { connected_miners, cpu_load, ping_ms, blockchain_height } = req.body;
    // Validate ranges
    const miners = Math.max(0, Math.min(10000, parseInt(connected_miners) || 0));
    const cpu = Math.max(0, Math.min(100, parseFloat(cpu_load) || 0));
    const ping = Math.max(0, Math.min(10000, parseFloat(ping_ms) || 0));
    const blockHeight = Math.max(0, parseInt(blockchain_height) || 0);
    db.updateMiningNodeHeartbeat(node.id, miners, cpu, ping, blockHeight);
    res.json({ status: 'success', message: 'Heartbeat received' });
  } catch (e) {
    console.error('Heartbeat error:', e.message);
    res.status(500).json({ status: 'error', message: 'Heartbeat failed' });
  }
});

app.get('/api/nodes', (req, res) => {
  try {
    const nodes = db.getActiveMiningNodes();
    const safeNodes = nodes.map(n => ({
      id: n.id,
      name: n.name,
      url: n.url,
      location: n.location,
      connected_miners: n.connected_miners,
      cpu_load: n.cpu_load,
      ping_ms: n.ping_ms,
      total_blocks_relayed: n.total_blocks_relayed,
      total_earned: n.total_earned,
      last_block_height: n.last_block_height || 0
    }));
    res.json({ status: 'success', nodes: safeNodes });
  } catch (e) {
    console.error('List nodes error:', e.message);
    res.status(500).json({ status: 'error', message: 'Failed to list nodes' });
  }
});

app.get('/api/nodes/discover', async (req, res) => {
  try {
    const nodes = db.getActiveMiningNodes();
    if (nodes.length === 0) {
      return res.json({ status: 'success', nodes: [] });
    }
    const results = await Promise.all(nodes.map(async (node) => {
      try {
        const start = Date.now();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const pingUrl = node.url.replace(/\/+$/, '') + '/ping';
        const resp = await fetch(pingUrl, { signal: controller.signal });
        clearTimeout(timeout);
        await resp.json();
        const latency = Date.now() - start;
        return { ...node, latency, reachable: true };
      } catch (e) {
        return { ...node, latency: Infinity, reachable: false };
      }
    }));
    // Sort by latency
    results.sort((a, b) => a.latency - b.latency);
    const safeResults = results.map(n => ({
      id: n.id,
      name: n.name,
      url: n.url,
      location: n.location,
      connected_miners: n.connected_miners,
      cpu_load: n.cpu_load,
      latency: n.latency,
      reachable: n.reachable,
      total_blocks_relayed: n.total_blocks_relayed,
      total_earned: n.total_earned
    }));
    res.json({ status: 'success', nodes: safeResults });
  } catch (e) {
    console.error('Node discover error:', e.message);
    res.status(500).json({ status: 'error', message: 'Discovery failed' });
  }
});

app.get('/api/miner-info', (req, res) => {
  try {
    const username = (req.query.username || '').trim();
    if (!username) {
      return res.status(400).json({ status: 'error', message: 'Missing username' });
    }
    const user = db.getUser(username);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    const ACTIVE_THRESHOLD = 86400;
    const now = Math.floor(Date.now() / 1000);

    const workers = db.getWorkersByUsername(username);
    const result = workers
      .filter(w => {
        if (w.last_solve_time && w.last_solve_time > 0) {
          return (now - Math.floor(w.last_solve_time / 1000)) < ACTIVE_THRESHOLD;
        }
        const updatedAt = w.updated_at ? Math.floor(new Date(w.updated_at).getTime() / 1000) : 0;
        return updatedAt > 0 && (now - updatedAt) < ACTIVE_THRESHOLD;
      })
      .map(w => {
        const flags = db.getWorkerFlags(w.worker_name);
        const boost = db.getMiningBoostMultiplier(w.worker_name);
        const lastShare = w.last_solve_time || 0;
        const uptime = lastShare > 0 ? now - Math.floor(lastShare / 1000) : 0;
        const perWorkerReward = db.prepare(`
          SELECT COALESCE(SUM(reward), 0) as total FROM blocks
          WHERE miner = ? AND timestamp >= ?
        `).get(w.worker_name, now - 600);

        return {
          name: w.worker_name,
          difficulty: w.difficulty,
          tier: w.tier || 'cpu',
          device_type: w.device_type || 'unknown',
          tier_changes: w.tier_changes || 0,
          last_share: lastShare,
          last_share_ago: lastShare > 0 ? now - Math.floor(lastShare / 1000) : null,
          uptime_seconds: uptime,
          boost_multiplier: boost,
          suspended: flags.suspended,
          warning_count: flags.warning_count,
          reward_10m: perWorkerReward ? perWorkerReward.total : 0
        };
      });

    const totalRow = db.prepare(`
      SELECT COALESCE(SUM(reward), 0) as total FROM blocks
      WHERE miner = ? AND timestamp >= ?
    `).get(username, now - 600);
    const totalReward = totalRow ? totalRow.total : 0;

    res.json({
      status: 'success',
      username,
      balance: user.balance,
      active_workers: result.length,
      workers: result,
      total_reward_10m: totalReward
    });
  } catch (e) {
    console.error('Miner info error:', e.message);
    res.status(500).json({ status: 'error', message: 'Failed to get miner info' });
  }
});

app.post('/api/proxy/get_job', nodeRateLimit, async (req, res) => {
  try {
    const { node_id, worker_name, instance_id, device_type } = req.body;
    if (!node_id || !worker_name) {
      return res.status(400).json({ status: 'error', message: 'Missing node_id or worker_name' });
    }
    const node = db.getMiningNodeById(parseInt(node_id));
    if (!node) {
      return res.status(404).json({ status: 'error', message: 'Node not found' });
    }
    const resp = await fetch(`${node.url}/get_job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker_name, instance_id, device_type })
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    console.error('Proxy get_job error:', e.message);
    res.status(502).json({ status: 'error', message: 'Node unreachable' });
  }
});

app.post('/api/proxy/submit_solution', nodeRateLimit, async (req, res) => {
  try {
    const { node_id, bounty_id, nonce, worker_name, instance_id, device_type } = req.body;
    if (!node_id || !bounty_id || nonce === undefined || !worker_name) {
      return res.status(400).json({ status: 'error', message: 'Missing required fields' });
    }
    const node = db.getMiningNodeById(parseInt(node_id));
    if (!node) {
      return res.status(404).json({ status: 'error', message: 'Node not found' });
    }
    const resp = await fetch(`${node.url}/submit_solution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bounty_id, nonce, worker_name, instance_id, device_type })
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    console.error('Proxy submit_solution error:', e.message);
    res.status(502).json({ status: 'error', message: 'Node unreachable' });
  }
});

app.post('/api/proxy/heartbeat', nodeRateLimit, async (req, res) => {
  try {
    const { node_id, miners } = req.body;
    if (!node_id) {
      return res.status(400).json({ status: 'error', message: 'Missing node_id' });
    }
    const node = db.getMiningNodeById(parseInt(node_id));
    if (!node) {
      return res.status(404).json({ status: 'error', message: 'Node not found' });
    }
    const resp = await fetch(`${node.url}/miner_heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ miners: miners || 1 })
    });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    console.error('Proxy heartbeat error:', e.message);
    res.status(502).json({ status: 'error', message: 'Node unreachable' });
  }
});

app.post('/api/nodes/get_job', nodeRateLimit, (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ status: 'error', message: 'Missing auth token' });
    }
    const token = authHeader.split(' ')[1];
    const node = db.getMiningNodeByToken(token);
    if (!node) {
      return res.status(401).json({ status: 'error', message: 'Invalid node token' });
    }
    const { worker_name, instance_id, device_type } = req.body;
    if (!worker_name || typeof worker_name !== 'string') {
      return res.status(400).json({ status: 'error', message: 'Missing or invalid worker_name' });
    }
    const cleanWorker = worker_name.trim().substring(0, 100);
    const cleanInstance = (instance_id || 'default').trim().substring(0, 50);
    const cleanDevice = (device_type || 'unknown').trim().substring(0, 50);
    const job = blockchain.getJobForWorker(cleanWorker, cleanInstance, cleanDevice);
    if (!job) {
      return res.status(404).json({ status: 'error', message: 'No job available' });
    }
    res.json(job);
  } catch (e) {
    console.error('get_job error:', e.message);
    res.status(500).json({ status: 'error', message: 'Failed to get job' });
  }
});

app.post('/api/nodes/submit_solution', nodeSubmitLimit, (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ status: 'error', message: 'Missing auth token' });
    }
    const token = authHeader.split(' ')[1];
    const node = db.getMiningNodeByToken(token);
    if (!node) {
      return res.status(401).json({ status: 'error', message: 'Invalid node token' });
    }
    const { bounty_id, nonce, worker_name, instance_id, device_type, hashrate_reported } = req.body;
    if (!bounty_id || nonce === undefined || !worker_name) {
      return res.status(400).json({ status: 'error', message: 'Missing bounty_id, nonce, or worker_name' });
    }
    // Validate nonce is a number
    const parsedNonce = parseInt(nonce);
    if (isNaN(parsedNonce) || parsedNonce < 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid nonce' });
    }
    const result = blockchain.submitSolution(bounty_id, parsedNonce, String(worker_name).trim().substring(0, 100), (device_type || 'unknown').trim().substring(0, 50), hashrate_reported, (instance_id || 'default').trim().substring(0, 50), node.id);
    res.json(result);
  } catch (e) {
    console.error('submit_solution error:', e.message);
    res.status(400).json({ status: 'error', message: 'Solution rejected' });
  }
});

app.get('/api/nodes/sync-blocks', nodeRateLimit, (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ status: 'error', message: 'Missing auth token' });
    }
    const token = authHeader.split(' ')[1];
    const node = db.getMiningNodeByToken(token);
    if (!node) {
      return res.status(401).json({ status: 'error', message: 'Invalid node token' });
    }
    const sinceHeight = Math.max(0, parseInt(req.query.since) || 0);
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit) || 5000));
    const blocks = sinceHeight > 0
      ? db.prepare('SELECT * FROM blocks WHERE height > ? ORDER BY height ASC LIMIT ?').all(sinceHeight, limit)
      : db.prepare('SELECT * FROM blocks ORDER BY height ASC LIMIT ?').all(limit);
    const lastBlock = db.getLastBlock();
    res.json({ status: 'success', blocks, last_block: lastBlock, total: db.getBlockCount() });
  } catch (e) {
    console.error('sync-blocks error:', e.message);
    res.status(500).json({ status: 'error', message: 'Sync failed' });
  }
});

app.post('/api/nodes/restore-blockchain', nodeRegisterLimit, (req, res) => {
  return res.status(503).json({ status: 'error', message: 'Archiver blockchain restore is disabled. Use backup node snapshot restore instead.' });
  try {
    const { token, blocks } = req.body;
    if (token !== NODE_MASTER_TOKEN) {
      return res.status(401).json({ status: 'error', message: 'Invalid master token' });
    }
    if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Missing or empty blocks array' });
    }
    if (blocks.length > 2000) {
      return res.status(400).json({ status: 'error', message: 'Too many blocks (max 2000)' });
    }
    if (blocks.length < 100) {
      return res.status(400).json({ status: 'error', message: `Too few blocks (${blocks.length}) — minimum 100 required` });
    }

    const currentCount = db.getBlockCount();
    if (currentCount > 0) {
      return res.json({ status: 'skipped', message: `Main server already has ${currentCount} blocks` });
    }

    // Validate chain integrity: sort ASC, check prev_hash continuity
    const sorted = [...blocks].sort((a, b) => a.height - b.height);
    if (sorted[0].height !== 0) {
      return res.status(400).json({ status: 'error', message: 'Chain must start at height 0' });
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].height !== sorted[i - 1].height + 1) {
        return res.status(400).json({ status: 'error', message: `Gap in chain at height ${sorted[i].height}: expected ${sorted[i - 1].height + 1}` });
      }
      if (sorted[i].prev_hash !== sorted[i - 1].hash) {
        return res.status(400).json({ status: 'error', message: `Hash chain broken at height ${sorted[i].height}: prev_hash mismatch` });
      }
      if (!sorted[i].hash || typeof sorted[i].hash !== 'string') {
        return res.status(400).json({ status: 'error', message: `Invalid hash at height ${sorted[i].height}` });
      }
    }

    // Validate and sanitize blocks
    const validBlocks = [];
    for (const block of sorted) {
      if (!block || typeof block !== 'object') continue;
      if (typeof block.height !== 'number' || block.height < 0) continue;
      if (!block.hash || typeof block.hash !== 'string') continue;
      if (!block.prev_hash || typeof block.prev_hash !== 'string') continue;
      if (!block.miner || typeof block.miner !== 'string') continue;
      validBlocks.push({
        height: block.height,
        hash: block.hash.substring(0, 128),
        prev_hash: block.prev_hash.substring(0, 128),
        miner: block.miner.substring(0, 200),
        nonce: String(block.nonce || '0').substring(0, 50),
        timestamp: block.timestamp || Math.floor(Date.now() / 1000),
        reward: Math.min(100, Math.max(0, parseFloat(block.reward) || 0)),
        difficulty: Math.max(1, parseFloat(block.difficulty) || 1),
        tx_count: parseInt(block.tx_count) || 0,
        total_fees: parseFloat(block.total_fees) || 0,
        device_type: (block.device_type || 'unknown').substring(0, 50),
        tier: (block.tier || 'unknown').substring(0, 20),
        pos_contribution: parseFloat(block.pos_contribution) || 0
      });
    }
    let imported = 0;
    for (const block of validBlocks) {
      try { db.insertBlock(block); imported++; } catch (e) { /* skip duplicates */ }
    }
    console.log(`📥 Blockchain restored from node: ${imported} blocks imported`);
    res.json({ status: 'success', message: `Restored ${imported} blocks`, last_height: validBlocks[validBlocks.length - 1]?.height });
  } catch (e) {
    console.error('restore-blockchain error:', e.message);
    res.status(500).json({ status: 'error', message: 'Restore failed' });
  }
});

app.post('/api/nodes/trigger-restore', nodeRegisterLimit, async (req, res) => {
  return res.status(503).json({ status: 'error', message: 'Archiver blockchain restore is disabled. Use backup node snapshot restore instead.' });
  try {
    const { token } = req.body;
    if (token !== NODE_MASTER_TOKEN) {
      return res.status(401).json({ status: 'error', message: 'Invalid master token' });
    }

    const currentCount = db.getBlockCount();
    const bestNode = db.getBestBackupNode();

    if (!bestNode) {
      return res.json({
        status: 'error',
        message: 'No backup nodes available with blockchain data',
        current_blocks: currentCount
      });
    }

    console.log(`🔄 Triggering restore from node: ${bestNode.name} (height: ${bestNode.last_block_height})`);

    // Fetch full chain from the backup node
    const nodeUrl = bestNode.url.replace(/\/+$/, '');
    const resp = await fetch(`${nodeUrl}/full-chain`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${NODE_MASTER_TOKEN}` },
      timeout: 30000
    });

    if (!resp.ok) {
      return res.json({ status: 'error', message: `Node returned HTTP ${resp.status}` });
    }

    const data = await resp.json();
    if (data.status !== 'success' || !data.blocks || data.blocks.length === 0) {
      return res.json({ status: 'error', message: 'Node returned empty chain' });
    }

    // Verify minimum block count
    if (data.blocks.length < 100) {
      return res.status(400).json({ status: 'error', message: `Node has only ${data.blocks.length} blocks (minimum 100 required)` });
    }

    // Validate chain integrity
    const sorted = [...data.blocks].sort((a, b) => a.height - b.height);
    if (sorted[0].height !== 0) {
      return res.status(400).json({ status: 'error', message: 'Chain must start at height 0' });
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].height !== sorted[i - 1].height + 1) {
        return res.status(400).json({ status: 'error', message: `Gap in chain at height ${sorted[i].height}` });
      }
      if (sorted[i].prev_hash !== sorted[i - 1].hash) {
        return res.status(400).json({ status: 'error', message: `Hash chain broken at height ${sorted[i].height}` });
      }
    }

    // Import blocks
    let imported = 0;
    for (const block of data.blocks) {
      try { db.insertBlock(block); imported++; } catch (e) { /* skip duplicates */ }
    }

    console.log(`✅ Restore complete: ${imported} blocks imported from ${bestNode.name}`);
    res.json({
      status: 'success',
      message: `Restored ${imported} blocks from ${bestNode.name}`,
      source_node: bestNode.name,
      source_height: bestNode.last_block_height,
      imported,
      total: db.getBlockCount()
    });
  } catch (e) {
    console.error('trigger-restore error:', e.message);
    res.status(500).json({ status: 'error', message: 'Restore failed: ' + e.message });
  }
});

app.delete('/api/nodes/:id', requireAdminSession, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    db.deleteMiningNode(id);
    res.json({ status: 'success', message: `Node ${id} deleted` });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

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

process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

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

  // ─── Startup blockchain restoration from mining nodes ──
  setTimeout(async () => {
    const blockCount = db.getBlockCount();
    if (blockCount === 0) {
      console.log('⚠️ Blockchain is empty, attempting restore from mining nodes...');
      try {
        const nodes = db.getActiveMiningNodes();
        if (nodes.length > 0) {
          for (const node of nodes) {
            try {
              const resp = await fetch(`${node.url}/full-chain`, {
                headers: { 'Authorization': `Bearer ${NODE_MASTER_TOKEN}` }
              });
              if (resp.ok) {
                const data = await resp.json();
                if (data.status === 'success' && data.blocks && data.blocks.length > 0) {
                  let imported = 0;
                  for (const block of data.blocks) {
                    try { db.insertBlock(block); imported++; } catch (e) { /* skip */ }
                  }
                  console.log(`📥 Restored ${imported} blocks from node: ${node.name} (height: ${data.last_height})`);
                  break;
                }
              }
            } catch (e) {
              console.warn(`⚠️ Could not restore from node ${node.name}: ${e.message}`);
            }
          }
        }
      } catch (e) {
        console.warn('⚠️ Blockchain restore failed:', e.message);
      }
    }
  }, 3000);

  // Prune dead mining nodes every 60 seconds
  setInterval(() => db.pruneMiningNodes(), 60000);
});

const http2Server = http2.createSecureServer({ key: tlsKey, cert: tlsCert, allowHTTP1: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }, app);
http2Server.listen(HTTPS_PORT, () => {
  console.log(`🔐 HTTP/2 server listening on port ${HTTPS_PORT}`);
});
