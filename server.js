// server.js – Hybrid PoW + PoS + Diffie-Hellman + HTTP/2 + TLS 1.3 + Session Token (JWT) + Rate Limit + Trust Proxy + SWAP + Admin Web Interface (Full)
// 🆕 Tích hợp mempool và phí giao dịch tự động (node_fees)
// 🆕 Quản lý user (thêm, xoá, ban) trong admin dashboard
// 🆕 Sửa lỗi lịch sử giao dịch (hiển thị cả confirmed và pending)
// 🆕 Sử dụng các hàm admin từ db.js (deleteUser, setUserBanned)
// 🆕 Cải thiện giao diện admin: icon bánh răng với dropdown, hiển thị Unban/Ban đúng trạng thái

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

// admin users
const ADMIN_USERS = ['chocoetom', 'Nam2010'];
const NODE_MASTER_TOKEN = process.env.NODE_MASTER_TOKEN || 'null';
if (!process.env.NODE_MASTER_TOKEN || NODE_MASTER_TOKEN === 'null') {
  console.warn('⚠️ WARNING: NODE_MASTER_TOKEN is default/weak. Set a real token in Render dashboard!');
}

// ─── Rate limiters for node endpoints ──────────
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

// ─── Helper: canonical JSON ─────────────
function canonicalStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalStringify).join(',') + ']';
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(k => `"${k}":${canonicalStringify(obj[k])}`);
  return '{' + pairs.join(',') + '}';
}

//  RATE LIMITERS
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

// ─── Allowed backup hostnames (URL-only, no IP) ───────
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

// Session middleware (httpOnly cookie, prevents console access)
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

// ════════════════════════════════════════════════════
//  MIDDLEWARE: Verify JWT token (cho API client)
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
//  ADMIN WEB INTERFACE (SESSION-BASED)
// ════════════════════════════════════════════════════
app.get('/admin', (req, res) => {
  if (req.session.admin) {
    return res.redirect('/admin/dashboard');
  }
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <title>Admin Login - ChocoHub</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { background: linear-gradient(135deg, #0a0a12 0%, #1a1a2a 100%); color: #eee4d8; font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .login-box { background: rgba(30,30,42,0.9); backdrop-filter: blur(10px); padding: 2.5rem; border-radius: 32px; box-shadow: 0 20px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05); width: 360px; text-align: center; transition: transform 0.3s; }
            .login-box:hover { transform: translateY(-5px); }
            h1 { background: linear-gradient(135deg, #f58a00, #ffbf00); -webkit-background-clip: text; background-clip: text; color: transparent; margin-bottom: 1.5rem; font-size: 2rem; letter-spacing: -0.5px; }
            .input-group { margin-bottom: 1.2rem; text-align: left; }
            .input-group label { display: block; margin-bottom: 0.4rem; font-size: 0.85rem; color: #aaa; letter-spacing: 0.5px; }
            input { width: 100%; padding: 12px 16px; background: #2a2a36; border: 1px solid #3a3a46; border-radius: 16px; color: white; font-size: 1rem; transition: all 0.2s; outline: none; }
            input:focus { border-color: #f58a00; box-shadow: 0 0 0 2px rgba(245,138,0,0.2); }
            button { background: linear-gradient(135deg, #f58a00, #ff7e00); color: #0a0a12; border: none; padding: 12px 20px; border-radius: 40px; cursor: pointer; font-weight: bold; font-size: 1rem; width: 100%; transition: all 0.2s; margin-top: 0.5rem; }
            button:hover { transform: scale(1.02); filter: brightness(1.05); }
            .error { color: #ff6b6b; margin-top: 1rem; font-size: 0.85rem; }
            .footer { margin-top: 1.5rem; font-size: 0.7rem; color: #555; }
        </style>
    </head>
    <body>
        <div class="login-box">
            <h1>🍫 ChocoHub Admin</h1>
            <form id="loginForm">
                <div class="input-group">
                    <label>Username</label>
                    <input type="text" id="username" placeholder="chocoetom / Nam2010" required autocomplete="off">
                </div>
                <div class="input-group">
                    <label>PIN</label>
                    <input type="password" id="pin" placeholder="••••••" required autocomplete="off">
                </div>
                <button type="submit">🔐 Sign in</button>
                <div id="errorMsg" class="error"></div>
            </form>
            <div class="footer">Secure session • HttpOnly cookie</div>
        </div>
        <script>
            document.getElementById('loginForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const username = document.getElementById('username').value.trim();
                const pin = document.getElementById('pin').value;
                try {
                    const resp = await fetch('/admin/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, pin })
                    });
                    const data = await resp.json();
                    if (resp.ok && data.status === 'success') {
                        window.location.href = '/admin/dashboard';
                    } else {
                        document.getElementById('errorMsg').innerText = data.message || 'Authentication failed';
                    }
                } catch(err) {
                    document.getElementById('errorMsg').innerText = 'Network error';
                }
            });
        </script>
    </body>
    </html>
  `);
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

// ─── Các API admin quản lý user ──────────────────────

// Lấy danh sách user (đã có)
app.get('/admin/api/all-users', requireAdminSession, async (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json({ status: 'success', users });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Thêm user mới (admin)
app.post('/admin/api/users', requireAdminSession, async (req, res) => {
  try {
    const { username, pin } = req.body;
    if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing username or pin' });
    if (username.length < 3 || pin.length < 4) return res.status(400).json({ status: 'error', message: 'Username min 3, PIN min 4' });
    // Kiểm tra user đã tồn tại
    const existing = db.getUser(username);
    if (existing) return res.status(400).json({ status: 'error', message: 'User already exists' });
    // Tạo user bằng authenticate (sẽ tạo mới nếu chưa có)
    const result = db.authenticate(username, pin);
    res.json({ status: 'success', message: `User ${username} created`, user: { username, balance: result.balance || 0 } });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Xoá user (admin) - chỉ cho phép xóa user thường, không xóa admin
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

// Ban/Unban user (admin)
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

// User detail (drawer: balance + stake + recent transactions)
app.get('/admin/api/users/:username/detail', requireAdminSession, async (req, res) => {
  try {
    const username = req.params.username;
    const user = db.getUser(username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    const stake = db.getStake(username) || { staked: 0, pending_reward: 0 };
    const transactions = db.getTransactions(username, 20) || [];
    res.json({ status: 'success', user, stake, transactions });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Các API admin cũ ────────────────────────────────

// API proxy cho admin (giữ nguyên)
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

// ─── Admin APIs: worker flags ──────────────────────────

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

// ─── Admin Dashboard ───
app.get('/admin/dashboard', requireAdminSession, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Admin Dashboard - ChocoHub</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
        <style>
            :root {
                --bg: #0b0a10;
                --bg-elev: #14121c;
                --card: #1a1826;
                --card-hover: #201d2e;
                --border: rgba(255,255,255,0.07);
                --border-strong: rgba(255,255,255,0.14);
                --gold: #f5a623;
                --gold-bright: #ffc857;
                --gold-dim: rgba(245,166,35,0.14);
                --choco: #6b3f1d;
                --cream: #f3e9d8;
                --text: #ece5f2;
                --text-dim: #9691a8;
                --text-faint: #635f74;
                --green: #4ade80;
                --red: #ff6b6b;
                --blue: #5b9dff;
                --radius: 20px;
                --radius-sm: 12px;
                --shadow: 0 12px 40px rgba(0,0,0,0.45);
            }
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                background:
                    radial-gradient(1100px 500px at 15% -10%, rgba(245,166,35,0.10), transparent 60%),
                    radial-gradient(900px 500px at 90% 0%, rgba(107,63,29,0.20), transparent 55%),
                    var(--bg);
                color: var(--text);
                font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                padding: 2.5rem;
                min-height: 100vh;
            }
            ::selection { background: var(--gold-dim); color: var(--gold-bright); }
            ::-webkit-scrollbar { width: 8px; height: 8px; }
            ::-webkit-scrollbar-thumb { background: #2a2736; border-radius: 8px; }
            .container { max-width: 1440px; margin: 0 auto; }

            .header {
                display: flex; justify-content: space-between; align-items: center;
                margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem;
                padding-bottom: 1.5rem; border-bottom: 1px solid var(--border);
            }
            .brand { display: flex; align-items: center; gap: 0.9rem; }
            .brand-icon {
                width: 46px; height: 46px; border-radius: 14px; display: flex; align-items: center; justify-content: center;
                font-size: 1.4rem; background: linear-gradient(145deg, var(--gold), #c9791a);
                box-shadow: 0 6px 18px rgba(245,166,35,0.35);
            }
            .brand-text h1 { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.3px; color: var(--cream); }
            .brand-text span { font-size: 0.78rem; color: var(--text-dim); font-weight: 500; }
            .header-right { display: flex; align-items: center; gap: 0.9rem; }
            .session-pill {
                font-size: 0.78rem; color: var(--text-dim); background: var(--card);
                border: 1px solid var(--border); padding: 0.45rem 0.9rem; border-radius: 40px;
                display: flex; align-items: center; gap: 0.4rem;
            }
            .session-pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
            .logout-btn {
                background: transparent; border: 1px solid var(--red); color: var(--red);
                padding: 0.55rem 1.3rem; border-radius: 40px; text-decoration: none; font-size: 0.85rem; font-weight: 600;
                transition: 0.2s;
            }
            .logout-btn:hover { background: var(--red); color: #0a0a12; }

            .tabs { display: flex; gap: 0.4rem; margin-bottom: 1.8rem; flex-wrap: wrap; background: var(--bg-elev); padding: 0.4rem; border-radius: 40px; width: fit-content; border: 1px solid var(--border); }
            .tab-btn {
                background: none; border: none; color: var(--text-dim); padding: 0.6rem 1.3rem; font-size: 0.9rem;
                font-weight: 600; cursor: pointer; border-radius: 40px; transition: 0.2s; font-family: inherit;
                display: flex; align-items: center; gap: 0.4rem;
            }
            .tab-btn:hover { color: var(--cream); }
            .tab-btn.active { color: #0a0a12; background: linear-gradient(135deg, var(--gold-bright), var(--gold)); box-shadow: 0 4px 14px rgba(245,166,35,0.3); }
            .tab-content { display: none; animation: fadeIn 0.25s ease; }
            .tab-content.active { display: block; }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(6px);} to { opacity:1; transform: translateY(0);} }

            .card {
                background: linear-gradient(180deg, var(--card), var(--bg-elev));
                border: 1px solid var(--border); border-radius: var(--radius); padding: 1.6rem; margin-bottom: 1.6rem;
                box-shadow: var(--shadow);
            }
            .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.2rem; flex-wrap: wrap; gap: 0.6rem; }
            .card-head h2 { font-size: 1.05rem; font-weight: 700; color: var(--cream); display: flex; align-items: center; gap: 0.5rem; }
            .refresh-btn {
                font-size: 0.78rem; color: var(--text-dim); cursor: pointer; background: rgba(255,255,255,0.04);
                border: 1px solid var(--border); padding: 0.4rem 0.9rem; border-radius: 40px; transition: 0.2s;
                display: flex; align-items: center; gap: 0.35rem;
            }
            .refresh-btn:hover { color: var(--gold); border-color: var(--gold); }
            .refresh-btn.spin svg { animation: spin 0.6s linear; }
            @keyframes spin { to { transform: rotate(360deg); } }

            table { width: 100%; border-collapse: collapse; }
            th, td { padding: 13px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 0.84rem; }
            th { color: var(--text-faint); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.6px; }
            tbody tr { transition: background 0.15s; }
            tbody tr:hover { background: rgba(255,255,255,0.02); }
            .mono { font-family: 'JetBrains Mono', monospace; }

            .status-pending { background: rgba(245,166,35,0.16); color: var(--gold-bright); padding: 4px 11px; border-radius: 40px; font-size: 0.72rem; font-weight: 700; display: inline-block; }
            .status-completed { background: rgba(74,222,128,0.14); color: var(--green); padding: 4px 11px; border-radius: 40px; font-size: 0.72rem; font-weight: 700; display: inline-block; }
            .badge-xno { background: rgba(91,157,255,0.16); color: var(--blue); padding: 3px 9px; border-radius: 12px; font-size: 0.68rem; font-weight: 600; }
            .badge-duco { background: rgba(245,166,35,0.16); color: var(--gold-bright); padding: 3px 9px; border-radius: 12px; font-size: 0.68rem; font-weight: 600; }
            .badge-cc { background: rgba(107,63,29,0.35); color: var(--cream); padding: 3px 9px; border-radius: 12px; font-size: 0.68rem; font-weight: 600; }

            button { font-family: inherit; }
            .btn { border: none; padding: 7px 14px; border-radius: 30px; cursor: pointer; font-weight: 600; font-size: 0.78rem; transition: 0.2s; }
            .btn:active { transform: scale(0.96); }
            .btn-complete { background: linear-gradient(135deg, var(--gold-bright), var(--gold)); color: #0a0a12; margin-right: 6px; }
            .btn-complete:hover { filter: brightness(1.08); }
            .btn-delete { background: rgba(255,107,107,0.15); color: var(--red); border: 1px solid rgba(255,107,107,0.3); }
            .btn-delete:hover { background: var(--red); color: #0a0a12; }
            .btn-ghost { background: rgba(255,255,255,0.05); color: var(--text); border: 1px solid var(--border); }
            .btn-ghost:hover { border-color: var(--gold); color: var(--gold-bright); }
            .btn-primary { background: linear-gradient(135deg, var(--gold-bright), var(--gold)); color: #0a0a12; }
            .btn-primary:hover { filter: brightness(1.08); }
            .btn-success { background: rgba(74,222,128,0.15); color: var(--green); border: 1px solid rgba(74,222,128,0.3); }
            .btn-success:hover { background: var(--green); color: #0a0a12; }

            .avatar {
                width: 34px; height: 34px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center;
                background: linear-gradient(145deg, var(--choco), #3a2210); color: var(--gold-bright); font-weight: 700;
                font-size: 0.9rem; margin-right: 10px; vertical-align: middle;
            }
            .user-cell { display: flex; align-items: center; }

            .gear-icon {
                font-size: 1.1rem; cursor: pointer; padding: 6px 10px; border-radius: 8px; transition: 0.2s;
                display: inline-block; user-select: none; border: 1px solid transparent;
            }
            .gear-icon:hover { background: rgba(255,255,255,0.06); border-color: var(--border); }
            .empty-row td { text-align: center; color: var(--text-faint); padding: 2.5rem; }

            .dropdown { position: relative; display: inline-block; }
            .dropdown-content {
                display: none; position: absolute; right: 0; top: calc(100% + 6px); background: #211f2e;
                min-width: 190px; box-shadow: 0 12px 30px rgba(0,0,0,0.6); z-index: 1000; border-radius: 14px;
                border: 1px solid var(--border-strong); padding: 6px; backdrop-filter: blur(10px);
            }
            .dropdown-content a {
                color: var(--text); padding: 9px 12px; text-decoration: none; display: flex; align-items: center; gap: 8px;
                font-size: 0.82rem; cursor: pointer; transition: background 0.15s; border-radius: 8px; font-weight: 500;
            }
            .dropdown-content a:hover { background: rgba(255,255,255,0.06); }
            .dropdown-content .danger { color: var(--red); }
            .dropdown-content .danger:hover { background: rgba(255,107,107,0.12); }
            .dropdown-content .success { color: var(--green); }
            .dropdown-content .success:hover { background: rgba(74,222,128,0.12); }
            .dropdown-content .divider { height: 1px; background: var(--border); margin: 4px 6px; }
            .dropdown.show .dropdown-content { display: block; }

            .search-box { display: flex; gap: 0.6rem; flex-wrap: wrap; flex: 1; }
            .search-box input {
                flex: 1; min-width: 180px; padding: 10px 14px; background: rgba(255,255,255,0.03);
                border: 1px solid var(--border); border-radius: var(--radius-sm); color: white; font-size: 0.85rem; outline: none; transition: 0.2s;
            }
            .search-box input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-dim); }

            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 1rem; }
            .stat-card {
                background: linear-gradient(160deg, rgba(255,255,255,0.03), rgba(255,255,255,0));
                border: 1px solid var(--border); padding: 1.3rem; border-radius: 16px; transition: 0.2s;
            }
            .stat-card:hover { border-color: var(--border-strong); transform: translateY(-2px); }
            .stat-label { font-size: 0.78rem; color: var(--text-dim); display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.5rem; }
            .stat-card strong { display: block; font-size: 1.7rem; color: var(--gold-bright); font-weight: 800; letter-spacing: -0.5px; }

            /* Modal */
            .modal { display: none; position: fixed; inset: 0; background: rgba(6,5,10,0.72); backdrop-filter: blur(4px); z-index: 2000; justify-content: center; align-items: center; }
            .modal-content {
                background: linear-gradient(180deg, #201d2c, #17141f); border: 1px solid var(--border-strong); border-radius: 24px;
                padding: 1.8rem; width: 420px; max-width: 90%; box-shadow: 0 30px 70px rgba(0,0,0,0.6); animation: pop 0.18s ease;
            }
            @keyframes pop { from { transform: scale(0.94); opacity: 0; } to { transform: scale(1); opacity: 1; } }
            .modal-content h3 { margin-bottom: 1rem; color: var(--cream); font-size: 1.15rem; font-weight: 700; display: flex; align-items: center; gap: 0.5rem; }
            .modal-content label { font-size: 0.78rem; color: var(--text-dim); display: block; margin: 0.8rem 0 0.3rem; font-weight: 600; }
            .modal-content input {
                width: 100%; padding: 11px 14px; background: rgba(255,255,255,0.04); border: 1px solid var(--border);
                border-radius: var(--radius-sm); color: white; font-size: 0.9rem; outline: none; transition: 0.2s;
            }
            .modal-content input:focus { border-color: var(--gold); box-shadow: 0 0 0 3px var(--gold-dim); }
            .modal-buttons { display: flex; gap: 0.6rem; margin-top: 1.4rem; }
            .modal-buttons button { flex: 1; padding: 11px; border-radius: 30px; }
            .balance-actions { display: flex; gap: 0.5rem; margin-top: 1rem; }
            .balance-actions button { flex: 1; padding: 10px; border-radius: 14px; font-size: 0.8rem; }
            .btn-add-bal { background: rgba(74,222,128,0.14); color: var(--green); border: 1px solid rgba(74,222,128,0.3); }
            .btn-add-bal:hover { background: var(--green); color: #0a0a12; }
            .btn-remove-bal { background: rgba(255,107,107,0.14); color: var(--red); border: 1px solid rgba(255,107,107,0.3); }
            .btn-remove-bal:hover { background: var(--red); color: #0a0a12; }
            .btn-set-bal { background: rgba(91,157,255,0.14); color: var(--blue); border: 1px solid rgba(91,157,255,0.3); }
            .btn-set-bal:hover { background: var(--blue); color: #0a0a12; }
            .current-balance-tag { font-size: 0.85rem; color: var(--text-dim); background: rgba(255,255,255,0.04); padding: 0.6rem 0.9rem; border-radius: 12px; margin-top: 0.4rem; }
            .current-balance-tag b { color: var(--gold-bright); }

            /* User detail drawer */
            .drawer-overlay { display: none; position: fixed; inset: 0; background: rgba(6,5,10,0.6); z-index: 1900; }
            .drawer {
                position: fixed; top: 0; right: -420px; width: 400px; max-width: 90%; height: 100%; background: #17141f;
                border-left: 1px solid var(--border-strong); z-index: 1950; transition: right 0.25s ease; padding: 1.8rem; overflow-y: auto;
            }
            .drawer.open { right: 0; }
            .drawer-overlay.open { display: block; }
            .drawer-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.4rem; }
            .drawer-close { cursor: pointer; color: var(--text-dim); font-size: 1.3rem; background:none; border:none; }
            .drawer-close:hover { color: var(--red); }
            .drawer-section { margin-bottom: 1.4rem; }
            .drawer-section h4 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-faint); margin-bottom: 0.6rem; }
            .tx-item { display: flex; justify-content: space-between; font-size: 0.8rem; padding: 8px 0; border-bottom: 1px solid var(--border); }
            .tx-item:last-child { border-bottom: none; }

            /* Toasts */
            #toastWrap { position: fixed; bottom: 24px; right: 24px; z-index: 3000; display: flex; flex-direction: column; gap: 10px; }
            .toast {
                background: #201d2c; border: 1px solid var(--border-strong); border-left: 4px solid var(--gold);
                padding: 13px 18px; border-radius: 12px; font-size: 0.85rem; box-shadow: 0 12px 30px rgba(0,0,0,0.5);
                min-width: 260px; animation: slideIn 0.25s ease; display: flex; align-items: center; gap: 8px;
            }
            .toast.success { border-left-color: var(--green); }
            .toast.error { border-left-color: var(--red); }
            @keyframes slideIn { from { transform: translateX(30px); opacity:0; } to { transform: translateX(0); opacity:1; } }

            .pagination { display: flex; justify-content: flex-end; gap: 0.4rem; margin-top: 1rem; }
            .pagination button {
                background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--text-dim);
                padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 0.78rem;
            }
            .pagination button.active { background: var(--gold); color: #0a0a12; border-color: var(--gold); font-weight: 700; }
            .pagination button:hover:not(.active) { border-color: var(--gold); color: var(--gold-bright); }

            @media (max-width: 768px) {
                body { padding: 1rem; }
                th, td { font-size: 0.7rem; padding: 9px 7px; }
                .tab-btn { padding: 0.5rem 0.9rem; font-size: 0.8rem; }
                .drawer { width: 100%; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <div class="brand">
                    <div class="brand-icon">🍫</div>
                    <div class="brand-text">
                        <h1>ChocoHub Admin</h1>
                        <span>Control center</span>
                    </div>
                </div>
                <div class="header-right">
                    <div class="session-pill"><span class="dot"></span> ${req.session.adminUsername}</div>
                    <a href="/admin/logout" class="logout-btn">Logout</a>
                </div>
            </div>

            <div class="tabs">
                <button class="tab-btn active" data-tab="swaps">🔄 Swaps</button>
                <button class="tab-btn" data-tab="users">👥 Users</button>
                <button class="tab-btn" data-tab="miners">⛏️ Miners</button>
                <button class="tab-btn" data-tab="nodes">🌐 Nodes</button>
                <button class="tab-btn" data-tab="stats">📊 Statistics</button>
            </div>

            <div id="swaps-tab" class="tab-content active">
                <div class="card">
                    <div class="card-head">
                        <h2>⏳ Pending Swaps</h2>
                        <span class="refresh-btn" onclick="loadAllSwaps(this)">🔄 Refresh</span>
                    </div>
                    <div style="overflow-x: auto;">
                        <table id="pendingTable">
                            <thead><tr><th>ID</th><th>From</th><th>Amount</th><th>Type</th><th>Receiver</th><th>Details</th><th>Status</th><th>Actions</th></tr></thead>
                            <tbody id="pendingBody"><tr class="empty-row"><td colspan="8">Loading…</td></tr></tbody>
                        </table>
                    </div>
                </div>
                <div class="card">
                    <div class="card-head"><h2>✅ Completed Swaps</h2></div>
                    <div style="overflow-x: auto;">
                        <table id="completedTable">
                            <thead><tr><th>ID</th><th>From</th><th>Amount</th><th>Type</th><th>Receiver</th><th>XNO TxID</th><th>Status</th><th>Completed At</th></tr></thead>
                            <tbody id="completedBody"><tr class="empty-row"><td colspan="8">Loading…</td></tr></tbody>
                        </table>
                    </div>
                    <div class="pagination" id="completedPagination"></div>
                </div>
            </div>

            <div id="users-tab" class="tab-content">
                <div class="card">
                    <div class="card-head">
                        <h2>👥 User Management</h2>
                        <div style="display:flex;gap:0.6rem;">
                            <button class="btn btn-ghost" onclick="exportUsers()">⬇️ Export CSV</button>
                            <button class="btn btn-primary" onclick="openAddUserModal()">➕ Add User</button>
                        </div>
                    </div>
                    <div class="search-box" style="margin-bottom:1rem;">
                        <input type="text" id="userSearch" placeholder="Search by username…" oninput="searchUsers()">
                    </div>
                    <div style="overflow-x: auto;">
                        <table id="usersTable">
                            <thead><tr><th>User</th><th>Balance</th><th>Status</th><th>Actions</th></tr></thead>
                            <tbody id="usersBody"><tr class="empty-row"><td colspan="4">Loading…</td></tr></tbody>
                        </table>
                    </div>
                    <div class="pagination" id="usersPagination"></div>
                </div>
            </div>

            <div id="stats-tab" class="tab-content">
                <div class="card">
                    <div class="card-head"><h2>📊 System Statistics</h2></div>
                    <div id="statsContent">Loading…</div>
                </div>
            </div>

            <div id="miners-tab" class="tab-content">
                <div class="card">
                    <div class="card-head">
                        <h2>🚩 Flagged & Suspended Workers</h2>
                        <span class="refresh-btn" onclick="loadFlaggedWorkers(this)">🔄 Refresh</span>
                    </div>
                    <div style="overflow-x: auto;">
                        <table id="flaggedTable">
                            <thead><tr><th>Worker</th><th>Tier</th><th>Warnings (24h)</th><th>Status</th><th>Suspended At</th><th>Reason</th><th>Actions</th></tr></thead>
                            <tbody id="flaggedBody"><tr class="empty-row"><td colspan="7">Loading…</td></tr></tbody>
                        </table>
                    </div>
                </div>
                <div class="card">
                    <div class="card-head"><h2>🔧 Manual Worker Control</h2></div>
                    <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end;">
                        <div>
                            <label style="display:block;margin-bottom:4px;font-size:0.78rem;color:var(--text-dim);">Worker name</label>
                            <input type="text" id="manualWorkerName" placeholder="worker_name" style="padding:10px 14px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:12px;color:white;width:200px;">
                        </div>
                        <div>
                            <label style="display:block;margin-bottom:4px;font-size:0.78rem;color:var(--text-dim);">Reason</label>
                            <input type="text" id="manualReason" placeholder="Reason for suspension" style="padding:10px 14px;background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:12px;color:white;width:250px;">
                        </div>
                        <button onclick="manualSuspend()" class="btn btn-delete" style="padding:10px 20px;">🚫 Suspend</button>
                        <button onclick="manualClear()" class="btn btn-success" style="padding:10px 20px;">✅ Clear</button>
                    </div>
                </div>
            </div>

            <div id="nodes-tab" class="tab-content">
                <div class="card">
                    <div class="card-head">
                        <h2>🌐 Mining Nodes</h2>
                        <span class="refresh-btn" onclick="loadNodes(this)">🔄 Refresh</span>
                    </div>
                    <div style="overflow-x: auto;">
                        <table id="nodesTable">
                            <thead><tr><th>Name</th><th>URL</th><th>Miners</th><th>CPU</th><th>Ping</th><th>Blocks Relayed</th><th>Actions</th></tr></thead>
                            <tbody id="nodesBody"><tr class="empty-row"><td colspan="7">Loading…</td></tr></tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>

        <!-- Edit Balance Modal -->
        <div id="editModal" class="modal">
            <div class="modal-content">
                <h3>✏️ Edit Balance</h3>
                <p style="font-size:0.85rem;color:var(--text-dim);">User: <strong id="editUsername" style="color:var(--cream);"></strong></p>
                <div class="current-balance-tag">Current balance: <b id="currentBalance"></b> CC</div>
                <label>Amount</label>
                <input type="number" id="editAmount" placeholder="0.0000" step="any">
                <div class="balance-actions">
                    <button class="btn-add-bal" onclick="saveBalance('add')">➕ Add</button>
                    <button class="btn-remove-bal" onclick="saveBalance('remove')">➖ Remove</button>
                    <button class="btn-set-bal" onclick="saveBalance('set')">📝 Set</button>
                </div>
                <div class="modal-buttons">
                    <button class="btn btn-ghost" onclick="closeModal()" style="flex:1;">Cancel</button>
                </div>
            </div>
        </div>

        <!-- Add User Modal -->
        <div id="addUserModal" class="modal">
            <div class="modal-content">
                <h3>➕ Add New User</h3>
                <label>Username</label>
                <input type="text" id="newUsername" placeholder="Username (min 3 chars)">
                <label>PIN (4-8 digits)</label>
                <input type="password" id="newPin" placeholder="PIN" maxlength="8">
                <div class="modal-buttons">
                    <button class="btn btn-primary" onclick="addUser()">Create</button>
                    <button class="btn btn-ghost" onclick="closeAddUserModal()">Cancel</button>
                </div>
            </div>
        </div>

        <!-- Fulfill XNO Modal -->
        <div id="fulfillXnoModal" class="modal">
            <div class="modal-content">
                <h3>🟦 Complete XNO Swap</h3>
                <p style="font-size:0.85rem;color:var(--text-dim);">Swap ID: <strong id="fulfillSwapId" style="color:var(--cream);"></strong></p>
                <p style="font-size:0.85rem;color:var(--text-dim);">Receiver: <strong id="fulfillReceiver" style="color:var(--cream);"></strong></p>
                <p style="font-size:0.85rem;color:var(--text-dim);">Amount XNO: <strong id="fulfillAmount"></strong></p>
                <label>XNO Transaction Hash (optional)</label>
                <input type="text" id="xnoTxid" placeholder="nano_tx_hash…">
                <div class="modal-buttons">
                    <button class="btn btn-primary" onclick="confirmCompleteWithXno()">✅ Complete</button>
                    <button class="btn btn-ghost" onclick="closeXnoModal()">Cancel</button>
                </div>
            </div>
        </div>

        <!-- Generic Confirm Modal -->
        <div id="confirmModal" class="modal">
            <div class="modal-content">
                <h3 id="confirmTitle">⚠️ Are you sure?</h3>
                <p id="confirmMessage" style="font-size:0.88rem;color:var(--text-dim);line-height:1.5;"></p>
                <div class="modal-buttons">
                    <button class="btn btn-delete" id="confirmYesBtn" style="flex:1;">Confirm</button>
                    <button class="btn btn-ghost" onclick="closeConfirm()" style="flex:1;">Cancel</button>
                </div>
            </div>
        </div>

        <!-- User Detail Drawer -->
        <div class="drawer-overlay" id="drawerOverlay" onclick="closeDrawer()"></div>
        <div class="drawer" id="userDrawer">
            <div class="drawer-header">
                <h3 id="drawerUsername" style="color:var(--cream);"></h3>
                <button class="drawer-close" onclick="closeDrawer()">✕</button>
            </div>
            <div class="drawer-section">
                <h4>Balance</h4>
                <div class="current-balance-tag" id="drawerBalance">-</div>
            </div>
            <div class="drawer-section">
                <h4>Staking</h4>
                <div class="current-balance-tag" id="drawerStake">-</div>
            </div>
            <div class="drawer-section">
                <h4>Recent Transactions</h4>
                <div id="drawerTx">Loading…</div>
            </div>
        </div>

        <div id="toastWrap"></div>

        <script>
            let allSwaps = [];
            let allUsers = [];
            let currentEditUser = null;
            let currentPendingSwap = null;
            let usersPage = 1, completedPage = 1;
            const PAGE_SIZE = 12;

            // ─── Toast + Confirm (replaces alert/confirm) ─────────────
            function toast(message, type = 'info') {
                const wrap = document.getElementById('toastWrap');
                const el = document.createElement('div');
                el.className = 'toast ' + type;
                const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
                el.innerHTML = '<span>' + icon + '</span><span>' + message + '</span>';
                wrap.appendChild(el);
                setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, 3800);
            }

            function askConfirm(message, onYes, title) {
                document.getElementById('confirmTitle').innerText = title || '⚠️ Are you sure?';
                document.getElementById('confirmMessage').innerText = message;
                const modal = document.getElementById('confirmModal');
                modal.style.display = 'flex';
                const yesBtn = document.getElementById('confirmYesBtn');
                const newYes = yesBtn.cloneNode(true);
                yesBtn.parentNode.replaceChild(newYes, yesBtn);
                newYes.addEventListener('click', () => { modal.style.display = 'none'; onYes(); });
            }
            function closeConfirm() { document.getElementById('confirmModal').style.display = 'none'; }

            // ─── Tabs ──────────────────────────────────────────────────
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                    btn.classList.add('active');
                    document.getElementById(btn.dataset.tab + '-tab').classList.add('active');
                    if (btn.dataset.tab === 'users') loadUsers();
                    if (btn.dataset.tab === 'stats') loadStats();
                    if (btn.dataset.tab === 'miners') loadFlaggedWorkers();
                    if (btn.dataset.tab === 'nodes') loadNodes();
                });
            });

            function spinBtn(btn) {
                if (!btn) return;
                btn.classList.add('spin');
                setTimeout(() => btn.classList.remove('spin'), 600);
            }

            function getSwapTypeBadge(type) {
                const badges = {
                    'duco': '<span class="badge-duco">💰 DUCO</span>',
                    'duco_to_cc': '<span class="badge-duco">🔄 DUCO→CC</span>',
                    'xno_to_cc': '<span class="badge-xno">🟦 XNO→CC</span>',
                    'cc_to_xno': '<span class="badge-xno">➡️ CC→XNO</span>',
                    'ccpoc': '<span class="badge-cc">🍫 CC PoC</span>'
                };
                return badges[type] || '<span class="badge-cc">🍫 CC</span>';
            }

            function formatSwapDetails(swap) {
                if (swap.swap_type === 'xno_to_cc') return 'XNO: ' + (swap.amount_xno?.toFixed(8) || '?') + ' XNO → ' + swap.amount_cc + ' CC';
                if (swap.swap_type === 'cc_to_xno') return swap.amount_cc + ' CC → ' + (swap.amount_cc * 0.000002).toFixed(8) + ' XNO';
                if (swap.swap_type === 'duco') return swap.amount_cc + ' CC → ' + (swap.amount_cc/10) + ' DUCO';
                if (swap.swap_type === 'duco_to_cc') return (swap.amount_duco || swap.amount_cc/10) + ' DUCO → ' + swap.amount_cc + ' CC';
                return swap.amount_cc + ' CC';
            }

            async function loadAllSwaps(btn) {
                spinBtn(btn);
                try {
                    const resp = await fetch('/admin/api/all-swaps');
                    const data = await resp.json();
                    if (data.status === 'success' && Array.isArray(data.swaps)) {
                        allSwaps = data.swaps;
                        renderPending(allSwaps.filter(s => s.status === 'pending'));
                        renderCompleted(allSwaps.filter(s => s.status === 'completed'));
                    }
                } catch(e) { console.error(e); }
            }

            function renderPending(swaps) {
                const tbody = document.getElementById('pendingBody');
                if (swaps.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="8">✨ No pending swaps</td></tr>'; return; }
                tbody.innerHTML = '';
                for (const swap of swaps) {
                    const row = tbody.insertRow();
                    row.insertCell(0).innerHTML = '<span class="mono">' + swap.id + '</span>';
                    row.insertCell(1).innerText = swap.from_user;
                    row.insertCell(2).innerText = swap.amount_cc;
                    row.insertCell(3).innerHTML = getSwapTypeBadge(swap.swap_type);
                    row.insertCell(4).innerText = swap.receiver;
                    row.insertCell(5).innerHTML = '<small>' + formatSwapDetails(swap) + '</small>';
                    row.insertCell(6).innerHTML = '<span class="status-pending">pending</span>';
                    const actions = row.insertCell(7);
                    const completeBtn = document.createElement('button');
                    completeBtn.innerText = '✅ Complete'; completeBtn.className = 'btn btn-complete';
                    completeBtn.onclick = () => swap.swap_type === 'cc_to_xno' ? openXnoModal(swap) : completeSwap(swap.id);
                    const deleteBtn = document.createElement('button');
                    deleteBtn.innerText = '🗑️'; deleteBtn.className = 'btn btn-delete';
                    deleteBtn.onclick = () => deleteSwap(swap.id);
                    actions.appendChild(completeBtn); actions.appendChild(deleteBtn);
                }
            }

            function renderCompleted(swaps) {
                const tbody = document.getElementById('completedBody');
                const totalPages = Math.max(1, Math.ceil(swaps.length / PAGE_SIZE));
                if (completedPage > totalPages) completedPage = totalPages;
                if (swaps.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="8">📭 No completed swaps yet</td></tr>'; document.getElementById('completedPagination').innerHTML = ''; return; }
                const pageSwaps = swaps.slice((completedPage-1)*PAGE_SIZE, completedPage*PAGE_SIZE);
                tbody.innerHTML = '';
                for (const swap of pageSwaps) {
                    const row = tbody.insertRow();
                    row.insertCell(0).innerHTML = '<span class="mono">' + swap.id + '</span>';
                    row.insertCell(1).innerText = swap.from_user;
                    row.insertCell(2).innerText = swap.amount_cc;
                    row.insertCell(3).innerHTML = getSwapTypeBadge(swap.swap_type);
                    row.insertCell(4).innerText = swap.receiver;
                    row.insertCell(5).innerHTML = swap.xno_txid ? '<span style="color:#5b9dff;font-size:0.7rem;" class="mono">' + swap.xno_txid.substring(0, 18) + '…</span>' : '-';
                    row.insertCell(6).innerHTML = '<span class="status-completed">completed</span>';
                    row.insertCell(7).innerText = swap.completed_at ? new Date(swap.completed_at).toLocaleString() : '-';
                }
                renderPagination('completedPagination', totalPages, completedPage, (p) => { completedPage = p; renderCompleted(swaps); });
            }

            function renderPagination(containerId, totalPages, current, onClick) {
                const el = document.getElementById(containerId);
                if (totalPages <= 1) { el.innerHTML = ''; return; }
                el.innerHTML = '';
                for (let i = 1; i <= totalPages; i++) {
                    const b = document.createElement('button');
                    b.innerText = i;
                    if (i === current) b.classList.add('active');
                    b.onclick = () => onClick(i);
                    el.appendChild(b);
                }
            }

            function openXnoModal(swap) {
                currentPendingSwap = swap;
                document.getElementById('fulfillSwapId').innerText = swap.id;
                document.getElementById('fulfillReceiver').innerText = swap.receiver;
                document.getElementById('fulfillAmount').innerHTML = '<span style="color:#5b9dff">' + (swap.amount_cc * 0.000002).toFixed(8) + ' XNO</span>';
                document.getElementById('xnoTxid').value = '';
                document.getElementById('fulfillXnoModal').style.display = 'flex';
            }
            function closeXnoModal() { document.getElementById('fulfillXnoModal').style.display = 'none'; currentPendingSwap = null; }
            async function confirmCompleteWithXno() {
                if (!currentPendingSwap) return;
                await completeSwap(currentPendingSwap.id, document.getElementById('xnoTxid').value.trim());
                closeXnoModal();
            }

            // ─── Users ─────────────────────────────────────────────────
            async function loadUsers() {
                try {
                    const resp = await fetch('/admin/api/all-users');
                    const data = await resp.json();
                    if (data.status === 'success') { allUsers = data.users; renderUsers(allUsers); }
                } catch(e) { console.error(e); }
            }

            function initials(name) { return name.substring(0, 2).toUpperCase(); }

            function renderUsers(users) {
                const tbody = document.getElementById('usersBody');
                const totalPages = Math.max(1, Math.ceil(users.length / PAGE_SIZE));
                if (usersPage > totalPages) usersPage = totalPages;
                if (users.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="4">👻 No users found</td></tr>'; document.getElementById('usersPagination').innerHTML=''; return; }
                const pageUsers = users.slice((usersPage-1)*PAGE_SIZE, usersPage*PAGE_SIZE);
                tbody.innerHTML = '';
                for (const user of pageUsers) {
                    const row = tbody.insertRow();
                    const userCell = row.insertCell(0);
                    userCell.innerHTML = '<div class="user-cell"><span class="avatar">' + initials(user.username) + '</span>' + user.username + (window.isAdmin(user.username) ? ' <small style="color:var(--gold-bright);margin-left:6px;">★ admin</small>' : '') + '</div>';
                    userCell.style.cursor = 'pointer';
                    userCell.onclick = () => openDrawer(user.username);
                    row.insertCell(1).innerHTML = '<span style="color:var(--gold-bright)" class="mono">' + user.balance.toFixed(4) + ' CC</span>';
                    row.insertCell(2).innerHTML = user.banned ? '<span style="color:var(--red);">🚫 Banned</span>' : '<span style="color:var(--green);">✅ Active</span>';
                    const actions = row.insertCell(3);

                    const dropdownDiv = document.createElement('div'); dropdownDiv.className = 'dropdown';
                    const gearSpan = document.createElement('span'); gearSpan.className = 'gear-icon'; gearSpan.innerHTML = '⚙️';
                    gearSpan.onclick = function(e) { e.stopPropagation(); this.parentElement.classList.toggle('show'); };
                    dropdownDiv.appendChild(gearSpan);

                    const dropdownContent = document.createElement('div'); dropdownContent.className = 'dropdown-content';

                    const viewLink = document.createElement('a');
                    viewLink.innerHTML = '👁️ View Details';
                    viewLink.onclick = (e) => { e.stopPropagation(); openDrawer(user.username); this_close(e); };
                    dropdownContent.appendChild(viewLink);

                    const editLink = document.createElement('a');
                    editLink.innerHTML = '✏️ Edit Balance';
                    editLink.onclick = (e) => { e.stopPropagation(); openEditModal(user.username, user.balance); this_close(e); };
                    dropdownContent.appendChild(editLink);

                    const isAdminUser = window.isAdmin(user.username);
                    if (!isAdminUser) {
                        const divider = document.createElement('div'); divider.className = 'divider';
                        dropdownContent.appendChild(divider);

                        const banLink = document.createElement('a');
                        const isBanned = user.banned;
                        banLink.innerHTML = isBanned ? '🔓 Unban' : '🚫 Ban';
                        banLink.className = isBanned ? 'success' : 'danger';
                        banLink.onclick = (e) => { e.stopPropagation(); toggleBan(user.username, !isBanned); this_close(e); };
                        dropdownContent.appendChild(banLink);

                        const deleteLink = document.createElement('a');
                        deleteLink.innerHTML = '🗑️ Delete';
                        deleteLink.className = 'danger';
                        deleteLink.onclick = (e) => { e.stopPropagation(); deleteUser(user.username); this_close(e); };
                        dropdownContent.appendChild(deleteLink);
                    }

                    function this_close(e) { e.target.closest('.dropdown').classList.remove('show'); }

                    dropdownDiv.appendChild(dropdownContent);
                    actions.appendChild(dropdownDiv);
                }
                renderPagination('usersPagination', totalPages, usersPage, (p) => { usersPage = p; renderUsers(users); });

                document.addEventListener('click', function() {
                    document.querySelectorAll('.dropdown.show').forEach(d => d.classList.remove('show'));
                }, { once: true });
            }

            window.isAdmin = function(username) {
                const adminUsers = ['chocoetom', 'Nam2010'];
                return adminUsers.includes(username);
            };

            function searchUsers() {
                const term = document.getElementById('userSearch').value.toLowerCase();
                usersPage = 1;
                renderUsers(allUsers.filter(u => u.username.toLowerCase().includes(term)));
            }

            function exportUsers() { window.open('/admin/api/users/export/csv', '_blank'); }

            // ─── User detail drawer ───────────────────────────────────
            async function openDrawer(username) {
                document.getElementById('drawerUsername').innerText = username;
                document.getElementById('drawerBalance').innerHTML = 'Loading…';
                document.getElementById('drawerStake').innerHTML = 'Loading…';
                document.getElementById('drawerTx').innerHTML = 'Loading…';
                document.getElementById('userDrawer').classList.add('open');
                document.getElementById('drawerOverlay').classList.add('open');
                try {
                    const resp = await fetch('/admin/api/users/' + encodeURIComponent(username) + '/detail');
                    const data = await resp.json();
                    if (data.status !== 'success') { toast(data.message || 'Failed to load user', 'error'); return; }
                    document.getElementById('drawerBalance').innerHTML = '<b>' + data.user.balance.toFixed(4) + '</b> CC &nbsp; ' + (data.user.banned ? '<span style="color:var(--red);">🚫 Banned</span>' : '<span style="color:var(--green);">✅ Active</span>');
                    document.getElementById('drawerStake').innerHTML = '<b>' + data.stake.staked.toFixed(4) + '</b> CC staked · <b>' + data.stake.pending_reward.toFixed(4) + '</b> CC pending reward';
                    const txHtml = data.transactions && data.transactions.length
                        ? data.transactions.map(t => '<div class="tx-item"><span>' + (t.type || t.description || 'tx') + '</span><span class="mono">' + (t.amount !== undefined ? t.amount : '') + '</span></div>').join('')
                        : '<div style="color:var(--text-faint);font-size:0.85rem;">No transactions found</div>';
                    document.getElementById('drawerTx').innerHTML = txHtml;
                } catch(e) { toast(e.message, 'error'); }
            }
            function closeDrawer() {
                document.getElementById('userDrawer').classList.remove('open');
                document.getElementById('drawerOverlay').classList.remove('open');
            }

            // ─── Add / Delete / Ban ───────────────────────────────────
            function openAddUserModal() {
                document.getElementById('newUsername').value = '';
                document.getElementById('newPin').value = '';
                document.getElementById('addUserModal').style.display = 'flex';
            }
            function closeAddUserModal() { document.getElementById('addUserModal').style.display = 'none'; }

            async function addUser() {
                const username = document.getElementById('newUsername').value.trim();
                const pin = document.getElementById('newPin').value.trim();
                if (username.length < 3) return toast('Username must be at least 3 characters', 'error');
                if (pin.length < 4) return toast('PIN must be at least 4 characters', 'error');
                try {
                    const resp = await fetch('/admin/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, pin }) });
                    const data = await resp.json();
                    if (data.status === 'success') { toast('User created successfully', 'success'); closeAddUserModal(); loadUsers(); }
                    else toast(data.message, 'error');
                } catch(e) { toast(e.message, 'error'); }
            }

            function deleteUser(username) {
                askConfirm('Delete user "' + username + '"? This cannot be undone.', async () => {
                    try {
                        const resp = await fetch('/admin/api/users/' + encodeURIComponent(username), { method: 'DELETE' });
                        const data = await resp.json();
                        if (data.status === 'success') { toast('User deleted', 'success'); loadUsers(); }
                        else toast(data.message, 'error');
                    } catch(e) { toast(e.message, 'error'); }
                }, '🗑️ Delete user?');
            }

            function toggleBan(username, banned) {
                askConfirm((banned ? 'Ban' : 'Unban') + ' user "' + username + '"?', async () => {
                    try {
                        const resp = await fetch('/admin/api/users/' + encodeURIComponent(username) + '/ban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ banned }) });
                        const data = await resp.json();
                        if (data.status === 'success') { toast(data.message, 'success'); loadUsers(); }
                        else toast(data.message, 'error');
                    } catch(e) { toast(e.message, 'error'); }
                }, banned ? '🚫 Ban user?' : '🔓 Unban user?');
            }

            // ─── Edit Balance (add / remove / set) ────────────────────
            function openEditModal(username, currentBalance) {
                currentEditUser = username;
                document.getElementById('editUsername').innerText = username;
                document.getElementById('currentBalance').innerText = currentBalance.toFixed(4);
                document.getElementById('editAmount').value = '';
                document.getElementById('editModal').style.display = 'flex';
            }
            function closeModal() { document.getElementById('editModal').style.display = 'none'; currentEditUser = null; }

            async function saveBalance(action) {
                const amount = parseFloat(document.getElementById('editAmount').value);
                if (isNaN(amount) || amount < 0) return toast('Please enter a valid amount', 'error');
                try {
                    const resp = await fetch('/admin/api/update-balance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: currentEditUser, amount, action }) });
                    const data = await resp.json();
                    if (data.status === 'success') {
                        toast('Balance updated → ' + data.new_balance.toFixed(4) + ' CC', 'success');
                        closeModal(); loadUsers();
                    } else toast(data.message, 'error');
                } catch(e) { toast(e.message, 'error'); }
            }

            // ─── Swap Actions ──────────────────────────────────────────
            function completeSwap(id, xnoTxid = null) {
                askConfirm('Mark swap #' + id + ' as completed?', async () => {
                    try {
                        const body = xnoTxid ? { request_id: id, xno_txid: xnoTxid } : { request_id: id };
                        const resp = await fetch('/admin/api/fulfill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                        const data = await resp.json();
                        if (data.status === 'success') { toast('Swap completed' + (xnoTxid ? ' — XNO txid saved' : ''), 'success'); loadAllSwaps(); loadStats(); }
                        else toast(data.message || 'Unknown error', 'error');
                    } catch(e) { toast(e.message, 'error'); }
                }, '✅ Complete swap?');
            }

            function deleteSwap(id) {
                askConfirm('Delete swap request #' + id + '?', async () => {
                    try {
                        const resp = await fetch('/admin/api/delete/' + id, { method: 'DELETE' });
                        const data = await resp.json();
                        if (data.status === 'success') { toast('Swap deleted', 'success'); loadAllSwaps(); loadStats(); }
                        else toast(data.message || 'Unknown error', 'error');
                    } catch(e) { toast(e.message, 'error'); }
                }, '🗑️ Delete swap?');
            }

            // ─── Statistics ────────────────────────────────────────────
            async function loadStats() {
                try {
                    const resp = await fetch('/admin/api/all-swaps');
                    const data = await resp.json();
                    const usersResp = await fetch('/admin/api/all-users');
                    const usersData = await usersResp.json();
                    if (data.status === 'success' && usersData.status === 'success') {
                        const totalSwaps = data.swaps.length;
                        const pendingSwaps = data.swaps.filter(s => s.status === 'pending').length;
                        const completedSwaps = data.swaps.filter(s => s.status === 'completed').length;
                        const xnoSwaps = data.swaps.filter(s => s.swap_type === 'xno_to_cc' || s.swap_type === 'cc_to_xno').length;
                        const totalUsers = usersData.users.length;
                        const bannedUsers = usersData.users.filter(u => u.banned).length;
                        const totalBalance = usersData.users.reduce((sum, u) => sum + u.balance, 0);
                        const avgBalance = totalUsers > 0 ? totalBalance / totalUsers : 0;
                        const topHolder = usersData.users.slice().sort((a,b) => b.balance - a.balance)[0];

                        document.getElementById('statsContent').innerHTML =
                            '<div class="stats-grid">' +
                            statCard('📊', 'Total Swaps', totalSwaps) +
                            statCard('⏳', 'Pending Swaps', pendingSwaps) +
                            statCard('✅', 'Completed Swaps', completedSwaps) +
                            statCard('🟦', 'XNO Swaps', xnoSwaps) +
                            statCard('👥', 'Total Users', totalUsers) +
                            statCard('🚫', 'Banned Users', bannedUsers) +
                            statCard('💰', 'Total CC Supply', totalBalance.toFixed(4) + ' CC') +
                            statCard('📈', 'Average Balance', avgBalance.toFixed(4) + ' CC') +
                            statCard('👑', 'Top Holder', topHolder ? topHolder.username + ' (' + topHolder.balance.toFixed(2) + ' CC)' : '-') +
                            '</div>';
                    }
                } catch(e) { console.error(e); }
            }
            function statCard(icon, label, value) {
                return '<div class="stat-card"><div class="stat-label">' + icon + ' ' + label + '</div><strong>' + value + '</strong></div>';
            }

            // ─── Flagged Workers ───────────────────────────────────────
            async function loadFlaggedWorkers(btn) {
                spinBtn(btn);
                try {
                    const resp = await fetch('/admin/api/flagged-workers');
                    const data = await resp.json();
                    const tbody = document.getElementById('flaggedBody');
                    if (!data.workers || data.workers.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="7">✅ No flagged workers</td></tr>'; return; }
                    tbody.innerHTML = '';
                    for (const w of data.workers) {
                        const row = tbody.insertRow();
                        row.insertCell(0).innerHTML = '<code style="color:var(--gold-bright)">' + w.worker_name + '</code>';
                        row.insertCell(1).innerHTML = '<span style="color:var(--text-dim);font-size:0.8rem">' + (w.tier || 'cpu') + '</span>';
                        const warnCount = w.warning_count || 0;
                        row.insertCell(2).innerHTML = warnCount >= 3 ? '<span style="color:var(--red);font-weight:bold">' + warnCount + ' ⚠️</span>' : '<span style="color:var(--gold-bright)">' + warnCount + '</span>';
                        row.insertCell(3).innerHTML = w.suspended ? '<span class="status-pending">🚫 Suspended</span>' : '<span class="status-completed">⚠️ Warned</span>';
                        row.insertCell(4).innerText = w.suspended_at ? new Date(w.suspended_at * 1000).toLocaleString() : '-';
                        row.insertCell(5).innerHTML = '<small style="color:var(--text-dim)">' + (w.suspension_reason || '-') + '</small>';
                        const actions = row.insertCell(6);
                        const clearBtn = document.createElement('button'); clearBtn.className = 'btn btn-complete'; clearBtn.textContent = '✅ Clear';
                        clearBtn.onclick = () => clearWorkerSuspension(w.worker_name);
                        actions.appendChild(clearBtn);
                        if (!w.suspended) {
                            const suspBtn = document.createElement('button'); suspBtn.className = 'btn btn-delete'; suspBtn.textContent = '🚫 Suspend'; suspBtn.style.marginLeft = '6px';
                            suspBtn.onclick = () => { document.getElementById('manualWorkerName').value = w.worker_name; };
                            actions.appendChild(suspBtn);
                        }
                    }
                } catch(e) { console.error(e); }
            }

            function clearWorkerSuspension(workerName) {
                askConfirm('Clear all warnings and suspension for "' + workerName + '"?', async () => {
                    try {
                        const resp = await fetch('/admin/api/workers/' + encodeURIComponent(workerName) + '/clear', { method: 'POST' });
                        const data = await resp.json();
                        if (data.status === 'success') { toast(data.message, 'success'); loadFlaggedWorkers(); }
                        else toast(data.message, 'error');
                    } catch(e) { toast(e.message, 'error'); }
                }, '✅ Clear suspension?');
            }

            function manualSuspend() {
                const workerName = document.getElementById('manualWorkerName').value.trim();
                const reason = document.getElementById('manualReason').value.trim();
                if (!workerName) return toast('Enter a worker name', 'error');
                askConfirm('Suspend worker "' + workerName + '"?', async () => {
                    try {
                        const resp = await fetch('/admin/api/workers/' + encodeURIComponent(workerName) + '/suspend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason || 'Manual suspension by admin' }) });
                        const data = await resp.json();
                        if (data.status === 'success') { toast(data.message, 'success'); loadFlaggedWorkers(); }
                        else toast(data.message, 'error');
                    } catch(e) { toast(e.message, 'error'); }
                }, '🚫 Suspend worker?');
            }

            function manualClear() {
                const workerName = document.getElementById('manualWorkerName').value.trim();
                if (!workerName) return toast('Enter a worker name', 'error');
                clearWorkerSuspension(workerName);
            }

            // ─── Mining Nodes ──────────────────────────────────────────
            async function loadNodes(btn) {
                spinBtn(btn);
                try {
                    const resp = await fetch('/api/nodes');
                    const data = await resp.json();
                    const tbody = document.getElementById('nodesBody');
                    if (!data.nodes || data.nodes.length === 0) { tbody.innerHTML = '<tr class="empty-row"><td colspan="7">🌐 No nodes registered</td></tr>'; return; }
                    tbody.innerHTML = '';
                    for (const n of data.nodes) {
                        const row = tbody.insertRow();
                        row.insertCell(0).innerText = n.name;
                        row.insertCell(1).innerHTML = '<small class="mono" style="color:var(--text-dim)">' + n.url + '</small>';
                        row.insertCell(2).innerText = n.connected_miners;
                        row.insertCell(3).innerText = (n.cpu_load || 0).toFixed(1) + '%';
                        row.insertCell(4).innerText = (n.ping_ms || 0) + 'ms';
                        row.insertCell(5).innerText = n.total_blocks_relayed || 0;
                        const actions = row.insertCell(6);
                        const delBtn = document.createElement('button'); delBtn.className = 'btn btn-delete'; delBtn.textContent = '🗑️ Delete';
                        delBtn.onclick = () => deleteNode(n.id);
                        actions.appendChild(delBtn);
                    }
                } catch(e) { console.error(e); }
            }

            function deleteNode(id) {
                askConfirm('Delete mining node #' + id + '?', async () => {
                    try {
                        const resp = await fetch('/api/nodes/' + id, { method: 'DELETE' });
                        const data = await resp.json();
                        if (data.status === 'success') { toast(data.message, 'success'); loadNodes(); }
                        else toast(data.message, 'error');
                    } catch(e) { toast(e.message, 'error'); }
                }, '🗑️ Delete node?');
            }

            // ─── Init ──────────────────────────────────────────────────
            loadAllSwaps();
            loadUsers();
            loadStats();
            setInterval(() => { loadAllSwaps(); loadStats(); }, 30000);
        </script>
    </body>
    </html>
  `);
});

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

// Swap Module
app.use('/swap', SwapRouter);

// 🆕 Node Fees Module (quản lý phí giao dịch)
app.use('/node_fees', NodeFeesRouter.router);

// AUTH endpoint (kiểm tra banned)
app.post('/auth', authLimiter, (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    // Kiểm tra user có bị ban không
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

// ─── Các route công khai ─────────────────────────────
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
    // Nếu bị ban vẫn có thể xem lịch sử? Tùy chọn, tôi vẫn cho phép.
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

// ─── Các route yêu cầu token ─────────────────────────
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
    // Kiểm tra người gửi
    const sender = db.getUser(from_username);
    if (!sender) return res.status(404).json({ status: 'error', message: 'Sender not found' });
    if (sender.banned) {
      return res.status(403).json({ status: 'error', message: 'Account is banned' });
    }
    // Kiểm tra người nhận
    const receiver = db.getUser(to_username);
    if (!receiver) return res.status(404).json({ status: 'error', message: 'Receiver not found' });
    if (receiver.banned) {
      return res.status(403).json({ status: 'error', message: 'Cannot send to banned account' });
    }

    // Tính phí (lấy từ node_fees config – mặc định 1%)
    const feePercent = NodeFeesRouter.TRANSACTION_FEE_PERCENT || 1;
    const fee = parseFloat((sendAmount * feePercent / 100).toFixed(8));
    const totalDeducted = parseFloat((sendAmount + fee).toFixed(8));

    // Kiểm tra số dư
    if (sender.balance < totalDeducted) {
      return res.status(400).json({ status: 'error', message: `Insufficient balance. Need ${totalDeducted} CC (including ${fee} CC fee)` });
    }

    // Trừ tiền người gửi (chuyển vào mempool_holding)
    db.updateBalance(from_username, -totalDeducted);
    db.updateBalance('mempool_holding', totalDeducted);

    // Tạo giao dịch mempool
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

// ════════════════════════════════════════════════════
//  MINING BOOST (ad-click boost with view verification)
// ════════════════════════════════════════════════════

// In-memory challenges: { challenge_id: { username, issued_at, used } }
const boostChallenges = new Map();
const BOOST_CHALLENGE_TTL = 120; // segundos
const BOOST_MIN_VIEW_SECONDS = 10; // mínimo de segundos entre challenge e activate

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
    // Valida challenge (autenticação implícita)
    const challenge = boostChallenges.get(challenge_id);
    if (!challenge) return res.status(400).json({ status: 'error', message: 'Invalid or expired challenge' });
    if (challenge.username !== username.trim()) return res.status(400).json({ status: 'error', message: 'Challenge belongs to another user' });
    if (challenge.used) return res.status(400).json({ status: 'error', message: 'Challenge already used' });

    // Valida tempo mínimo de visualização
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

    // Marca challenge usado e ativa boost
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

// ════════════════════════════════════════════════════
//  MINING ROUTES – SỬ DỤNG BLOCKCHAIN MỚI
// ════════════════════════════════════════════════════

// 🆕 Register worker tier (once per 24h, requires JWT)
app.post('/mining/register-tier', verifyToken, (req, res) => {
  try {
    const workerName = req.user.username;
    const { tier, instance_id } = req.body;
    const tierKey = instance_id ? `${workerName}:${instance_id}` : workerName;

    if (!tier) {
      return res.status(400).json({ status: 'error', message: 'Missing tier. Valid tiers: embedded_avr, embedded_arm, embedded_esp, embedded_esp32, mobile, cpu, gpu' });
    }

    db.setWorkerTier(tierKey, tier);

    const tierInfo = blockchain.TIER_CONFIG ? blockchain.TIER_CONFIG[tier] : null;

    res.json({
      status: 'success',
      message: `Tier registered as ${tier}`,
      worker: tierKey,
      tier,
      multiplier: tierInfo ? tierInfo.multiplier : null,
      max_difficulty: tierInfo ? tierInfo.maxDifficulty : null,
      description: tierInfo ? tierInfo.description : null
    });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// 🆕 Get current worker tier info
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

// Lấy danh sách blocks gần đây
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

// Lấy thông tin một block theo height
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

// Lấy job cho miner
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

// Lấy job theo ID
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

// Submit solution
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

// Heartbeat
app.get('/miner_heartbeat', (req, res) => {
  res.json({ status: 'ok', time: Date.now() });
});

// /active_bounties_list – giữ để tương thích
app.get('/active_bounties_list', (req, res) => {
  try {
    const blocks = db.getBlocks(20);
    const last = db.getLastBlock();
    res.json({ status: 'success', blocks, last_block: last });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── Mining user stats ─────────────────────────────────
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

// ─── TEST / HEALTH ──────────────────────────────────────
app.get('/api/test', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), message: 'ChocoHub API is running', uptime: process.uptime() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), dbHash: getDbHash() });
});

// ─── BACKUP ENDPOINTS ──────────────────────────────────
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

// Track best snapshot seen globally (reset on server restart, but prevents back-to-back downgrades)
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

      // Đảm bảo các tài khoản đặc biệt tồn tại sau khi restore
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

// ════════════════════════════════════════════════════
//  MINING NODE MANAGEMENT
// ════════════════════════════════════════════════════

// Register a new mining node (requires master token)
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

// Node heartbeat (requires node auth token)
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

// List active nodes (public — for miner discovery)
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

// Server-side node discovery (pings nodes from server, not browser)
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

// Miner info endpoint — returns active workers with full details: tier, flags, boost, difficulty, rewards
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
          return (now - w.last_solve_time) < ACTIVE_THRESHOLD;
        }
        const updatedAt = w.updated_at ? Math.floor(new Date(w.updated_at).getTime() / 1000) : 0;
        return updatedAt > 0 && (now - updatedAt) < ACTIVE_THRESHOLD;
      })
      .map(w => {
        const flags = db.getWorkerFlags(w.worker_name);
        const boost = db.getMiningBoostMultiplier(w.worker_name);
        const lastShare = w.last_solve_time || 0;
        const uptime = w.updated_at ? now - Math.floor(new Date(w.updated_at).getTime() / 1000) : 0;
        const perWorkerReward = db.prepare(`
          SELECT COALESCE(SUM(reward), 0) as total FROM blocks
          WHERE miner = ? AND timestamp >= ?
        `).get(w.worker_name, now - 600);

        return {
          name: w.worker_name,
          difficulty: w.difficulty,
          tier: w.tier || 'cpu',
          tier_changes: w.tier_changes || 0,
          last_share: lastShare,
          last_share_ago: lastShare > 0 ? now - lastShare : null,
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

// Public proxy: miner sends job request here, server forwards to node
// (bypasses localtunnel interstitial that blocks browser requests)
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

// Public proxy: miner sends solution here, server forwards to node
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

// Public proxy: miner sends heartbeat through main server (bypasses 511)
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

// Internal: Node gets job (proxied from main server)
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

// Internal: Node submits solution (tagged with node_id)
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

// Node sync blocks (for node to sync blockchain from main server)
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

// Node restore blockchain to main server (emergency recovery)
// 🚫 DISABLED — archiver restores can conflict with backup-node full-snapshot restores.
// Re-enable by removing the early return below in case of total data loss.
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

// Admin: trigger restore from best backup node
// 🚫 DISABLED — archiver restores can conflict with backup-node full-snapshot restores.
// Re-enable by removing the early return below in case of total data loss.
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

// Admin: delete a node
app.delete('/api/nodes/:id', requireAdminSession, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    db.deleteMiningNode(id);
    res.json({ status: 'success', message: `Node ${id} deleted` });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── SPA fallback ──────────────────────────────────────
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

// ─── KHỞI ĐỘNG CÁC DỊCH VỤ ──────────────────────────
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
