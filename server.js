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
const NODE_MASTER_TOKEN = process.env.NODE_MASTER_TOKEN || 'chocohub-node-master';

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

// ─── Các API admin cũ ────────────────────────────────

// API proxy cho admin (giữ nguyên)
app.get('/admin/api/all-swaps', requireAdminSession, async (req, res) => {
  try {
    const token = req.session.adminToken;
    const response = await fetch(`http://localhost:${PORT}/swap/admin/swaps`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    res.json(data);
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
    const token = req.session.adminToken;
    const response = await fetch(`http://localhost:${PORT}/swap/admin/swaps/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await response.json();
    res.json(data);
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
        <title>Admin Dashboard - ChocoHub</title>
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { background: #0a0a12; color: #eee4d8; font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif; padding: 2rem; }
            .container { max-width: 1400px; margin: 0 auto; }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; flex-wrap: wrap; gap: 1rem; }
            h1 { background: linear-gradient(135deg, #f58a00, #ffbf00); -webkit-background-clip: text; background-clip: text; color: transparent; font-size: 2rem; }
            .logout-btn { background: #2a2a36; border: 1px solid #ff4444; color: #ff4444; padding: 0.5rem 1.2rem; border-radius: 40px; text-decoration: none; transition: 0.2s; }
            .logout-btn:hover { background: #ff4444; color: white; }
            .tabs { display: flex; gap: 1rem; margin-bottom: 2rem; border-bottom: 1px solid #2a2a36; flex-wrap: wrap; }
            .tab-btn { background: none; border: none; color: #8b8296; padding: 0.75rem 1.5rem; font-size: 1rem; cursor: pointer; transition: 0.2s; }
            .tab-btn:hover { color: #f58a00; }
            .tab-btn.active { color: #f58a00; border-bottom: 2px solid #f58a00; }
            .tab-content { display: none; }
            .tab-content.active { display: block; }
            .card { background: #1e1e2a; border-radius: 24px; padding: 1.5rem; margin-bottom: 2rem; box-shadow: 0 8px 20px rgba(0,0,0,0.3); }
            .card h2 { margin-bottom: 1rem; color: #f58a00; font-weight: 500; }
            table { width: 100%; border-collapse: collapse; }
            th, td { padding: 12px 10px; text-align: left; border-bottom: 1px solid #2a2a36; font-size: 0.85rem; }
            th { background: #2a2a36; font-weight: 600; color: #ffbf00; }
            .status-pending { background: #ffaa4433; color: #ffaa44; padding: 4px 10px; border-radius: 40px; font-size: 0.75rem; font-weight: bold; display: inline-block; }
            .status-completed { background: #44ff4433; color: #44ff44; padding: 4px 10px; border-radius: 40px; font-size: 0.75rem; font-weight: bold; display: inline-block; }
            .badge-xno { background: #2a6eff33; color: #2a6eff; padding: 2px 8px; border-radius: 12px; font-size: 0.7rem; }
            .badge-duco { background: #ffaa4433; color: #ffaa44; padding: 2px 8px; border-radius: 12px; font-size: 0.7rem; }
            .badge-cc { background: #f58a0033; color: #f58a00; padding: 2px 8px; border-radius: 12px; font-size: 0.7rem; }
            .btn-complete { background: #f58a00; color: #0a0a12; border: none; padding: 6px 12px; border-radius: 30px; cursor: pointer; font-weight: bold; margin-right: 8px; transition: 0.2s; }
            .btn-complete:hover { background: #ff9e20; transform: scale(1.02); }
            .btn-delete { background: #ff4444; color: white; border: none; padding: 6px 12px; border-radius: 30px; cursor: pointer; font-weight: bold; transition: 0.2s; }
            .btn-delete:hover { background: #ff6666; transform: scale(1.02); }
            .btn-edit { background: #2a2a36; color: #f58a00; border: 1px solid #f58a00; padding: 6px 12px; border-radius: 30px; cursor: pointer; font-weight: bold; transition: 0.2s; }
            .btn-edit:hover { background: #f58a00; color: #0a0a12; }
            .btn-ban { background: #ff4444; color: white; border: none; padding: 6px 12px; border-radius: 30px; cursor: pointer; font-weight: bold; transition: 0.2s; }
            .btn-ban:hover { background: #ff6666; }
            .btn-unban { background: #40c057; color: white; border: none; padding: 6px 12px; border-radius: 30px; cursor: pointer; font-weight: bold; transition: 0.2s; }
            .btn-unban:hover { background: #5ce06e; }
            .btn-add-user { background: #f58a00; color: #0a0a12; border: none; padding: 8px 16px; border-radius: 30px; cursor: pointer; font-weight: bold; transition: 0.2s; }
            .btn-add-user:hover { background: #ff9e20; transform: scale(1.02); }
            .gear-icon {
                font-size: 1.2rem;
                cursor: pointer;
                padding: 4px 8px;
                border-radius: 6px;
                transition: background 0.2s, transform 0.2s;
                display: inline-block;
                user-select: none;
            }
            .gear-icon:hover {
                background: rgba(255,255,255,0.08);
                transform: scale(1.05);
            }
            .empty-row td { text-align: center; color: #888; padding: 2rem; }
            .refresh { float: right; font-size: 0.8rem; color: #888; margin-top: 0.5rem; cursor: pointer; }
            .refresh:hover { color: #f58a00; }
            .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; justify-content: center; align-items: center; }
            .modal-content { background: #1e1e2a; border-radius: 24px; padding: 2rem; width: 450px; max-width: 90%; }
            .modal-content h3 { margin-bottom: 1rem; color: #f58a00; }
            .modal-content input { width: 100%; padding: 12px; margin: 10px 0; background: #2a2a36; border: 1px solid #3a3a46; border-radius: 12px; color: white; }
            .modal-buttons { display: flex; gap: 1rem; margin-top: 1rem; }
            .modal-buttons button { flex: 1; padding: 10px; border-radius: 30px; cursor: pointer; }
            .btn-save { background: #f58a00; color: #0a0a12; border: none; }
            .btn-cancel { background: #2a2a36; color: #eee4d8; border: 1px solid #ff4444; }
            .search-box { margin-bottom: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
            .search-box input { flex: 1; padding: 10px; background: #2a2a36; border: 1px solid #3a3a46; border-radius: 12px; color: white; }
            .search-box button { background: #f58a00; color: #0a0a12; border: none; padding: 10px 20px; border-radius: 30px; cursor: pointer; }
            .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; }
            .stat-card { background: #2a2a36; padding: 1rem; border-radius: 16px; text-align: center; }
            .stat-card strong { display: block; font-size: 1.5rem; color: #f58a00; margin-top: 0.5rem; }
            .dropdown {
                position: relative;
                display: inline-block;
            }
            .dropdown-content {
                display: none;
                position: absolute;
                right: 0;
                background: #1e1e2a;
                min-width: 180px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.6);
                z-index: 1000;
                border-radius: 12px;
                border: 1px solid rgba(255,255,255,0.08);
                padding: 4px 0;
                backdrop-filter: blur(8px);
            }
            .dropdown-content a {
                color: #eee4d8;
                padding: 10px 16px;
                text-decoration: none;
                display: block;
                font-size: 0.85rem;
                cursor: pointer;
                transition: background 0.15s;
                border-radius: 6px;
                margin: 2px 4px;
            }
            .dropdown-content a:hover {
                background: rgba(255,255,255,0.06);
            }
            .dropdown-content .danger {
                color: #ff6b6b;
            }
            .dropdown-content .danger:hover {
                background: rgba(255,70,70,0.12);
            }
            .dropdown-content .success {
                color: #40c057;
            }
            .dropdown-content .success:hover {
                background: rgba(64,192,87,0.12);
            }
            .dropdown.show .dropdown-content {
                display: block;
            }
            @media (max-width: 768px) {
                body { padding: 1rem; }
                th, td { font-size: 0.7rem; padding: 8px 6px; }
                .tab-btn { padding: 0.5rem 1rem; font-size: 0.8rem; }
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🍫 ChocoHub Admin Panel</h1>
                <a href="/admin/logout" class="logout-btn">🚪 Logout</a>
            </div>
            
            <div class="tabs">
                <button class="tab-btn active" data-tab="swaps">🔄 Swaps</button>
                <button class="tab-btn" data-tab="users">👥 Users</button>
                <button class="tab-btn" data-tab="miners">⛏️ Miners</button>
                <button class="tab-btn" data-tab="stats">📊 Statistics</button>
            </div>
            
            <div id="swaps-tab" class="tab-content active">
                <div class="card">
                    <h2>⏳ Pending Swaps <span class="refresh" onclick="loadAllSwaps()">🔄 Refresh</span></h2>
                    <div style="overflow-x: auto;">
                        <table id="pendingTable">
                            <thead>
                                <tr><th>ID</th><th>From</th><th>Amount (CC)</th><th>Type</th><th>Receiver</th><th>Details</th><th>Status</th><th>Actions</th></tr></thead>
                            <tbody id="pendingBody"><tr class="empty-row"><td colspan="8">Loading...</td></tr></tbody>
                        </table>
                    </div>
                </div>
                <div class="card">
                    <h2>✅ Completed Swaps</h2>
                    <div style="overflow-x: auto;">
                        <table id="completedTable">
                            <thead>
                                <tr><th>ID</th><th>From</th><th>Amount (CC)</th><th>Type</th><th>Receiver</th><th>XNO TxID</th><th>Status</th><th>Completed At</th></tr>
                            </thead>
                            <tbody id="completedBody"><tr class="empty-row"><td colspan="8">Loading...</td></tr></tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            <div id="users-tab" class="tab-content">
                <div class="card">
                    <h2>👥 User Management</h2>
                    <div style="display: flex; justify-content: space-between; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem;">
                        <div class="search-box">
                            <input type="text" id="userSearch" placeholder="Search username...">
                            <button onclick="searchUsers()">🔍 Search</button>
                        </div>
                        <button class="btn-add-user" onclick="openAddUserModal()">➕ Add User</button>
                    </div>
                    <div style="overflow-x: auto;">
                        <table id="usersTable">
                            <thead><tr><th>Username</th><th>Balance (CC)</th><th>Banned</th><th>Actions</th></tr></thead>
                            <tbody id="usersBody"><tr class="empty-row"><td colspan="4">Loading...</td></tr></tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            <div id="stats-tab" class="tab-content">
                <div class="card">
                    <h2>📊 System Statistics</h2>
                    <div id="statsContent">Loading...</div>
                </div>
            </div>
            
            <div id="miners-tab" class="tab-content">
                <div class="card">
                    <h2>🚩 Flagged & Suspended Workers <span class="refresh" onclick="loadFlaggedWorkers()">🔄 Refresh</span></h2>
                    <div style="overflow-x: auto;">
                        <table id="flaggedTable">
                            <thead><tr><th>Worker</th><th>Tier</th><th>Warnings (24h)</th><th>Status</th><th>Suspended At</th><th>Reason</th><th>Actions</th></tr></thead>
                            <tbody id="flaggedBody"><tr class="empty-row"><td colspan="7">Loading...</td></tr></tbody>
                        </table>
                    </div>
                </div>
                <div class="card">
                    <h2>🔧 Manual Worker Control</h2>
                    <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:flex-end;">
                        <div>
                            <label style="display:block;margin-bottom:4px;font-size:0.8rem;color:#aaa;">Worker name</label>
                            <input type="text" id="manualWorkerName" placeholder="worker_name" style="padding:10px;background:#2a2a36;border:1px solid #3a3a46;border-radius:12px;color:white;width:200px;">
                        </div>
                        <div>
                            <label style="display:block;margin-bottom:4px;font-size:0.8rem;color:#aaa;">Reason</label>
                            <input type="text" id="manualReason" placeholder="Reason for suspension" style="padding:10px;background:#2a2a36;border:1px solid #3a3a46;border-radius:12px;color:white;width:250px;">
                        </div>
                        <button onclick="manualSuspend()" style="background:#ff4444;color:white;border:none;padding:10px 20px;border-radius:30px;cursor:pointer;font-weight:bold;">🚫 Suspend</button>
                        <button onclick="manualClear()" style="background:#40c057;color:white;border:none;padding:10px 20px;border-radius:30px;cursor:pointer;font-weight:bold;">✅ Clear</button>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Edit Balance Modal -->
        <div id="editModal" class="modal">
            <div class="modal-content">
                <h3>✏️ Edit User Balance</h3>
                <p>Username: <strong id="editUsername"></strong></p>
                <label>Current Balance: <span id="currentBalance"></span> CC</label>
                <input type="number" id="editAmount" placeholder="Amount">
                <div class="modal-buttons">
                    <button class="btn-save" onclick="saveBalance('add')">➕ Add</button>
                    <button class="btn-save" onclick="saveBalance('set')">📝 Set</button>
                    <button class="btn-cancel" onclick="closeModal()">Cancel</button>
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
                    <button class="btn-save" onclick="addUser()">➕ Create</button>
                    <button class="btn-cancel" onclick="closeAddUserModal()">Cancel</button>
                </div>
            </div>
        </div>
        
        <!-- Fulfill XNO Modal -->
        <div id="fulfillXnoModal" class="modal">
            <div class="modal-content">
                <h3>🟦 Complete XNO Swap</h3>
                <p>Swap ID: <strong id="fulfillSwapId"></strong></p>
                <p>Receiver: <strong id="fulfillReceiver"></strong></p>
                <p>Amount XNO: <strong id="fulfillAmount"></strong></p>
                <label>XNO Transaction Hash (optional):</label>
                <input type="text" id="xnoTxid" placeholder="nano_tx_hash...">
                <div class="modal-buttons">
                    <button class="btn-save" onclick="confirmCompleteWithXno()">✅ Complete</button>
                    <button class="btn-cancel" onclick="closeXnoModal()">Cancel</button>
                </div>
            </div>
        </div>

        <script>
            let allSwaps = [];
            let allUsers = [];
            let currentEditUser = null;
            let currentPendingSwap = null;
            
            document.querySelectorAll('.tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                    btn.classList.add('active');
                    document.getElementById(btn.dataset.tab + '-tab').classList.add('active');
                    if (btn.dataset.tab === 'users') loadUsers();
                    if (btn.dataset.tab === 'stats') loadStats();
                    if (btn.dataset.tab === 'miners') loadFlaggedWorkers();
                });
            });
            
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
                if (swap.swap_type === 'xno_to_cc') {
                    return 'XNO: ' + (swap.amount_xno?.toFixed(8) || '?') + ' XNO → ' + swap.amount_cc + ' CC';
                }
                if (swap.swap_type === 'cc_to_xno') {
                    return swap.amount_cc + ' CC → ' + (swap.amount_cc * 0.000002).toFixed(8) + ' XNO';
                }
                if (swap.swap_type === 'duco') {
                    return swap.amount_cc + ' CC → ' + (swap.amount_cc/10) + ' DUCO';
                }
                if (swap.swap_type === 'duco_to_cc') {
                    return (swap.amount_duco || swap.amount_cc/10) + ' DUCO → ' + swap.amount_cc + ' CC';
                }
                return swap.amount_cc + ' CC';
            }
            
            async function loadAllSwaps() {
                try {
                    const resp = await fetch('/admin/api/all-swaps');
                    const data = await resp.json();
                    if (data.status === 'success' && Array.isArray(data.swaps)) {
                        allSwaps = data.swaps;
                        const pending = allSwaps.filter(s => s.status === 'pending');
                        const completed = allSwaps.filter(s => s.status === 'completed');
                        renderPending(pending);
                        renderCompleted(completed);
                    }
                } catch(e) { console.error(e); }
            }
            
            function renderPending(swaps) {
                const tbody = document.getElementById('pendingBody');
                if (swaps.length === 0) {
                    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">✨ No pending swaps</td></tr>';
                    return;
                }
                tbody.innerHTML = '';
                for (const swap of swaps) {
                    const row = tbody.insertRow();
                    row.insertCell(0).innerText = swap.id;
                    row.insertCell(1).innerText = swap.from_user;
                    row.insertCell(2).innerText = swap.amount_cc;
                    row.insertCell(3).innerHTML = getSwapTypeBadge(swap.swap_type);
                    row.insertCell(4).innerText = swap.receiver;
                    row.insertCell(5).innerHTML = '<small>' + formatSwapDetails(swap) + '</small>';
                    row.insertCell(6).innerHTML = '<span class="status-pending">pending</span>';
                    const actions = row.insertCell(7);
                    
                    const completeBtn = document.createElement('button');
                    completeBtn.innerText = '✅ Complete';
                    completeBtn.className = 'btn-complete';
                    completeBtn.onclick = () => {
                        if (swap.swap_type === 'cc_to_xno') {
                            openXnoModal(swap);
                        } else {
                            completeSwap(swap.id);
                        }
                    };
                    
                    const deleteBtn = document.createElement('button');
                    deleteBtn.innerText = '🗑️ Delete';
                    deleteBtn.className = 'btn-delete';
                    deleteBtn.onclick = () => deleteSwap(swap.id);
                    
                    actions.appendChild(completeBtn);
                    actions.appendChild(deleteBtn);
                }
            }
            
            function renderCompleted(swaps) {
                const tbody = document.getElementById('completedBody');
                if (swaps.length === 0) {
                    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">📭 No completed swaps yet</td></tr>';
                    return;
                }
                tbody.innerHTML = '';
                for (const swap of swaps) {
                    const row = tbody.insertRow();
                    row.insertCell(0).innerText = swap.id;
                    row.insertCell(1).innerText = swap.from_user;
                    row.insertCell(2).innerText = swap.amount_cc;
                    row.insertCell(3).innerHTML = getSwapTypeBadge(swap.swap_type);
                    row.insertCell(4).innerText = swap.receiver;
                    let xnoDisplay = '-';
                    if (swap.xno_txid) {
                        xnoDisplay = '<span style="color:#2a6eff;font-size:0.7rem;">' + swap.xno_txid.substring(0, 20) + '...</span>';
                    }
                    row.insertCell(5).innerHTML = xnoDisplay;
                    row.insertCell(6).innerHTML = '<span class="status-completed">completed</span>';
                    row.insertCell(7).innerText = swap.completed_at ? new Date(swap.completed_at).toLocaleString() : '-';
                }
            }
            
            function openXnoModal(swap) {
                currentPendingSwap = swap;
                document.getElementById('fulfillSwapId').innerText = swap.id;
                document.getElementById('fulfillReceiver').innerText = swap.receiver;
                const xnoAmount = (swap.amount_cc * 0.000002).toFixed(8);
                document.getElementById('fulfillAmount').innerHTML = '<span style="color:#2a6eff">' + xnoAmount + ' XNO</span>';
                document.getElementById('xnoTxid').value = '';
                document.getElementById('fulfillXnoModal').style.display = 'flex';
            }
            
            function closeXnoModal() {
                document.getElementById('fulfillXnoModal').style.display = 'none';
                currentPendingSwap = null;
            }
            
            async function confirmCompleteWithXno() {
                if (!currentPendingSwap) return;
                const xnoTxid = document.getElementById('xnoTxid').value.trim();
                await completeSwap(currentPendingSwap.id, xnoTxid);
                closeXnoModal();
            }
            
            // ─── Users Management ─────────────────────────────────────
            async function loadUsers() {
                try {
                    const resp = await fetch('/admin/api/all-users');
                    const data = await resp.json();
                    if (data.status === 'success') {
                        allUsers = data.users;
                        renderUsers(allUsers);
                    }
                } catch(e) { console.error(e); }
            }
            
            function renderUsers(users) {
                const tbody = document.getElementById('usersBody');
                if (users.length === 0) {
                    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">👻 No users found</td></tr>';
                    return;
                }
                tbody.innerHTML = '';
                for (const user of users) {
                    const row = tbody.insertRow();
                    row.insertCell(0).innerText = user.username;
                    row.insertCell(1).innerHTML = '<span style="color:#f58a00">' + user.balance.toFixed(4) + ' CC</span>';
                    row.insertCell(2).innerHTML = user.banned ? '<span style="color:#ff4444;">🚫 Banned</span>' : '<span style="color:#40c057;">✅ Active</span>';
                    const actions = row.insertCell(3);
                    
                    // Gear icon with dropdown
                    const dropdownDiv = document.createElement('div');
                    dropdownDiv.className = 'dropdown';
                    const gearSpan = document.createElement('span');
                    gearSpan.className = 'gear-icon';
                    gearSpan.innerHTML = '⚙️';
                    gearSpan.onclick = function(e) {
                        e.stopPropagation();
                        const parent = this.parentElement;
                        parent.classList.toggle('show');
                    };
                    dropdownDiv.appendChild(gearSpan);
                    
                    const dropdownContent = document.createElement('div');
                    dropdownContent.className = 'dropdown-content';
                    
                    // Edit Balance
                    const editLink = document.createElement('a');
                    editLink.textContent = '✏️ Edit Balance';
                    editLink.onclick = function(e) {
                        e.stopPropagation();
                        openEditModal(user.username, user.balance);
                        this.closest('.dropdown').classList.remove('show');
                    };
                    dropdownContent.appendChild(editLink);
                    
                    // Only show ban/unban and delete for non-admin users
                    const isAdminUser = window.isAdmin ? window.isAdmin(user.username) : false;
                    if (!isAdminUser) {
                        const banLink = document.createElement('a');
                        const isBanned = user.banned;
                        banLink.textContent = isBanned ? '🔓 Unban' : '🚫 Ban';
                        banLink.className = isBanned ? 'success' : 'danger';
                        banLink.onclick = function(e) {
                            e.stopPropagation();
                            toggleBan(user.username, !isBanned);
                            this.closest('.dropdown').classList.remove('show');
                        };
                        dropdownContent.appendChild(banLink);
                        
                        const deleteLink = document.createElement('a');
                        deleteLink.textContent = '🗑️ Delete';
                        deleteLink.className = 'danger';
                        deleteLink.onclick = function(e) {
                            e.stopPropagation();
                            deleteUser(user.username);
                            this.closest('.dropdown').classList.remove('show');
                        };
                        dropdownContent.appendChild(deleteLink);
                    }
                    
                    dropdownDiv.appendChild(dropdownContent);
                    actions.appendChild(dropdownDiv);
                }
                
                // Close dropdown when clicking outside
                document.addEventListener('click', function() {
                    document.querySelectorAll('.dropdown.show').forEach(d => d.classList.remove('show'));
                });
            }
            
            // Helper to check admin (from server)
            window.isAdmin = function(username) {
                const adminUsers = ['chocoetom', 'Nam2010'];
                return adminUsers.includes(username);
            };
            
            function searchUsers() {
                const searchTerm = document.getElementById('userSearch').value.toLowerCase();
                const filtered = allUsers.filter(u => u.username.toLowerCase().includes(searchTerm));
                renderUsers(filtered);
            }
            
            // ─── Add User ─────────────────────────────────────────────
            function openAddUserModal() {
                document.getElementById('newUsername').value = '';
                document.getElementById('newPin').value = '';
                document.getElementById('addUserModal').style.display = 'flex';
            }
            
            function closeAddUserModal() {
                document.getElementById('addUserModal').style.display = 'none';
            }
            
            async function addUser() {
                const username = document.getElementById('newUsername').value.trim();
                const pin = document.getElementById('newPin').value.trim();
                if (username.length < 3) return alert('Username must be at least 3 characters');
                if (pin.length < 4) return alert('PIN must be at least 4 characters');
                try {
                    const resp = await fetch('/admin/api/users', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, pin })
                    });
                    const data = await resp.json();
                    if (data.status === 'success') {
                        alert('User created successfully');
                        closeAddUserModal();
                        loadUsers();
                    } else {
                        alert('Error: ' + data.message);
                    }
                } catch(e) { alert(e.message); }
            }
            
            // ─── Delete User ──────────────────────────────────────────
            async function deleteUser(username) {
                if (!confirm('Delete user ' + username + '? This cannot be undone!')) return;
                try {
                    const resp = await fetch('/admin/api/users/' + encodeURIComponent(username), { method: 'DELETE' });
                    const data = await resp.json();
                    if (data.status === 'success') {
                        alert('User deleted');
                        loadUsers();
                    } else {
                        alert('Error: ' + data.message);
                    }
                } catch(e) { alert(e.message); }
            }
            
            // ─── Toggle Ban ───────────────────────────────────────────
            async function toggleBan(username, banned) {
                try {
                    const resp = await fetch('/admin/api/users/' + encodeURIComponent(username) + '/ban', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ banned })
                    });
                    const data = await resp.json();
                    if (data.status === 'success') {
                        alert(data.message);
                        loadUsers();
                    } else {
                        alert('Error: ' + data.message);
                    }
                } catch(e) { alert(e.message); }
            }
            
            // ─── Edit Balance ─────────────────────────────────────────
            function openEditModal(username, currentBalance) {
                currentEditUser = username;
                document.getElementById('editUsername').innerText = username;
                document.getElementById('currentBalance').innerText = currentBalance.toFixed(4);
                document.getElementById('editAmount').value = '';
                document.getElementById('editModal').style.display = 'flex';
            }
            
            function closeModal() {
                document.getElementById('editModal').style.display = 'none';
                currentEditUser = null;
            }
            
            async function saveBalance(action) {
                const amount = parseFloat(document.getElementById('editAmount').value);
                if (isNaN(amount) || amount < 0) {
                    alert('Please enter a valid amount');
                    return;
                }
                try {
                    const resp = await fetch('/admin/api/update-balance', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username: currentEditUser, amount, action })
                    });
                    const data = await resp.json();
                    if (data.status === 'success') {
                        alert('Balance updated! New balance: ' + data.new_balance.toFixed(4) + ' CC');
                        closeModal();
                        loadUsers();
                    } else {
                        alert('Error: ' + data.message);
                    }
                } catch(e) { alert(e.message); }
            }
            
            // ─── Swap Actions ────────────────────────────────────────
            async function completeSwap(id, xnoTxid = null) {
                if (!confirm('Mark this swap as completed?')) return;
                try {
                    const body = xnoTxid ? { request_id: id, xno_txid: xnoTxid } : { request_id: id };
                    const resp = await fetch('/admin/api/fulfill', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const data = await resp.json();
                    if (data.status === 'success') {
                        alert('✅ Swap completed!' + (xnoTxid ? ' XNO txid saved.' : ''));
                        loadAllSwaps();
                        loadStats();
                    } else {
                        alert('❌ Error: ' + (data.message || 'Unknown error'));
                    }
                } catch(e) { alert(e.message); }
            }
            
            async function deleteSwap(id) {
                if (!confirm('⚠️ Delete this swap request?')) return;
                try {
                    const resp = await fetch('/admin/api/delete/' + id, { method: 'DELETE' });
                    const data = await resp.json();
                    if (data.status === 'success') {
                        alert('🗑️ Swap deleted.');
                        loadAllSwaps();
                        loadStats();
                    } else {
                        alert('❌ Error: ' + (data.message || 'Unknown error'));
                    }
                } catch(e) { alert(e.message); }
            }
            
            // ─── Statistics ──────────────────────────────────────────
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
                        const totalBalance = usersData.users.reduce((sum, u) => sum + u.balance, 0);
                        
                        document.getElementById('statsContent').innerHTML = 
                            '<div class="stats-grid">' +
                            '<div class="stat-card">📊 Total Swaps<br><strong>' + totalSwaps + '</strong></div>' +
                            '<div class="stat-card">⏳ Pending Swaps<br><strong>' + pendingSwaps + '</strong></div>' +
                            '<div class="stat-card">✅ Completed Swaps<br><strong>' + completedSwaps + '</strong></div>' +
                            '<div class="stat-card">🟦 XNO Swaps<br><strong>' + xnoSwaps + '</strong></div>' +
                            '<div class="stat-card">👥 Total Users<br><strong>' + totalUsers + '</strong></div>' +
                            '<div class="stat-card">💰 Total CC Supply<br><strong>' + totalBalance.toFixed(4) + ' CC</strong></div>' +
                            '</div>';
                    }
                } catch(e) { console.error(e); }
            }
            
            // ─── Flagged Workers ─────────────────────────────────────
            async function loadFlaggedWorkers() {
                try {
                    const resp = await fetch('/admin/api/flagged-workers');
                    const data = await resp.json();
                    const tbody = document.getElementById('flaggedBody');
                    if (!data.workers || data.workers.length === 0) {
                        tbody.innerHTML = '<tr class="empty-row"><td colspan="7">✅ No flagged workers</td></tr>';
                        return;
                    }
                    tbody.innerHTML = '';
                    for (const w of data.workers) {
                        const row = tbody.insertRow();
                        row.insertCell(0).innerHTML = '<code style="color:#f58a00">' + w.worker_name + '</code>';
                        row.insertCell(1).innerHTML = '<span style="color:#aaa;font-size:0.8rem">' + (w.tier || 'cpu') + '</span>';
                        const warnCount = w.warning_count || 0;
                        row.insertCell(2).innerHTML = warnCount >= 3
                            ? '<span style="color:#ff4444;font-weight:bold">' + warnCount + ' ⚠️</span>'
                            : '<span style="color:#ffbf00">' + warnCount + '</span>';
                        row.insertCell(3).innerHTML = w.suspended
                            ? '<span class="status-pending">🚫 Suspended</span>'
                            : '<span class="status-completed">⚠️ Warned</span>';
                        row.insertCell(4).innerText = w.suspended_at
                            ? new Date(w.suspended_at * 1000).toLocaleString()
                            : '-';
                        row.insertCell(5).innerHTML = '<small style="color:#aaa">' + (w.suspension_reason || '-') + '</small>';
                        const actions = row.insertCell(6);
                        const clearBtn = document.createElement('button');
                        clearBtn.className = 'btn-complete';
                        clearBtn.textContent = '✅ Clear';
                        clearBtn.onclick = () => clearWorkerSuspension(w.worker_name);
                        actions.appendChild(clearBtn);
                        if (!w.suspended) {
                            const suspBtn = document.createElement('button');
                            suspBtn.className = 'btn-delete';
                            suspBtn.textContent = '🚫 Suspend';
                            suspBtn.style.marginLeft = '6px';
                            suspBtn.onclick = () => { document.getElementById('manualWorkerName').value = w.worker_name; };
                            actions.appendChild(suspBtn);
                        }
                    }
                } catch(e) { console.error(e); }
            }

            async function clearWorkerSuspension(workerName) {
                if (!confirm('Clear all warnings and suspension for ' + workerName + '?')) return;
                try {
                    const resp = await fetch('/admin/api/workers/' + encodeURIComponent(workerName) + '/clear', { method: 'POST' });
                    const data = await resp.json();
                    if (data.status === 'success') { alert('✅ ' + data.message); loadFlaggedWorkers(); }
                    else alert('Error: ' + data.message);
                } catch(e) { alert(e.message); }
            }

            async function manualSuspend() {
                const workerName = document.getElementById('manualWorkerName').value.trim();
                const reason = document.getElementById('manualReason').value.trim();
                if (!workerName) return alert('Enter a worker name');
                if (!confirm('Suspend worker ' + workerName + '?')) return;
                try {
                    const resp = await fetch('/admin/api/workers/' + encodeURIComponent(workerName) + '/suspend', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reason: reason || 'Manual suspension by admin' })
                    });
                    const data = await resp.json();
                    if (data.status === 'success') { alert('🚫 ' + data.message); loadFlaggedWorkers(); }
                    else alert('Error: ' + data.message);
                } catch(e) { alert(e.message); }
            }

            async function manualClear() {
                const workerName = document.getElementById('manualWorkerName').value.trim();
                if (!workerName) return alert('Enter a worker name');
                clearWorkerSuspension(workerName);
            }
            
            // ─── Init ──────────────────────────────────────────────────
            loadAllSwaps();
            loadUsers();
            loadStats();
            setInterval(() => {
                loadAllSwaps();
                loadStats();
            }, 30000);
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
    if (!worker_name) {
      return res.status(400).json({ status: 'error', message: 'Missing worker_name' });
    }
    const job = blockchain.getJobForWorker(worker_name, instance_id, device_type);
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
      if (!worker_name) {
        return res.status(400).json({ status: 'error', message: 'Missing worker_name. Authenticate with JWT or provide worker_name in body.' });
      }
    }

    const result = blockchain.submitSolution(bounty_id, nonce, worker_name, device_type, hashrate_reported, instance_id);
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
app.post('/api/nodes/register', (req, res) => {
  try {
    const { name, url, token, owner, location } = req.body;
    if (!name || !url || !token) {
      return res.status(400).json({ status: 'error', message: 'Missing name, url, or token' });
    }
    if (token !== NODE_MASTER_TOKEN) {
      return res.status(401).json({ status: 'error', message: 'Invalid master token' });
    }
    const existing = db.getMiningNodeByUrl(url);
    if (existing) {
      return res.json({ status: 'success', message: 'Node already registered', auth_token: existing.auth_token, id: existing.id });
    }
    const node = db.registerMiningNode(name, url, owner || '', location || '');
    console.log(`📡 Mining node registered: ${name} (${url})`);
    res.json({ status: 'success', message: 'Node registered', auth_token: node.auth_token, id: node });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Node heartbeat (requires node auth token)
app.post('/api/nodes/heartbeat', (req, res) => {
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
    const { connected_miners, cpu_load, ping_ms } = req.body;
    db.updateMiningNodeHeartbeat(node.id, connected_miners || 0, cpu_load || 0, ping_ms || 0);
    res.json({ status: 'success', message: 'Heartbeat received' });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
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
      total_earned: n.total_earned
    }));
    res.json({ status: 'success', nodes: safeNodes });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Internal: Node gets job (proxied from main server)
app.post('/api/nodes/get_job', (req, res) => {
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
    if (!worker_name) {
      return res.status(400).json({ status: 'error', message: 'Missing worker_name' });
    }
    const job = blockchain.getJobForWorker(worker_name, instance_id, device_type);
    if (!job) {
      return res.status(404).json({ status: 'error', message: 'No job available' });
    }
    res.json(job);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Internal: Node submits solution (tagged with node_id)
app.post('/api/nodes/submit_solution', (req, res) => {
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
    if (!bounty_id || !nonce || !worker_name) {
      return res.status(400).json({ status: 'error', message: 'Missing bounty_id, nonce, or worker_name' });
    }
    const result = blockchain.submitSolution(bounty_id, nonce, worker_name, device_type, hashrate_reported, instance_id, node.id);
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// Node sync blocks (for node to sync blockchain from main server)
app.get('/api/nodes/sync-blocks', (req, res) => {
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
    const sinceHeight = parseInt(req.query.since) || 0;
    const allBlocks = db.getBlocks(1000);
    const blocks = sinceHeight > 0 ? allBlocks.filter(b => b.height > sinceHeight) : allBlocks;
    const lastBlock = db.getLastBlock();
    res.json({ status: 'success', blocks, last_block: lastBlock, total: db.getBlockCount() });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Node restore blockchain to main server (emergency recovery)
app.post('/api/nodes/restore-blockchain', (req, res) => {
  try {
    const { token, blocks } = req.body;
    if (token !== NODE_MASTER_TOKEN) {
      return res.status(401).json({ status: 'error', message: 'Invalid master token' });
    }
    if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
      return res.status(400).json({ status: 'error', message: 'Missing or empty blocks array' });
    }
    const currentCount = db.getBlockCount();
    if (currentCount > 0) {
      return res.json({ status: 'skipped', message: `Main server already has ${currentCount} blocks` });
    }
    blocks.sort((a, b) => a.height - b.height);
    for (const block of blocks) {
      try { db.insertBlock(block); } catch (e) { /* skip duplicates */ }
    }
    console.log(`📥 Blockchain restored from node: ${blocks.length} blocks imported`);
    res.json({ status: 'success', message: `Restored ${blocks.length} blocks`, last_height: blocks[blocks.length - 1]?.height });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
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
              const resp = await fetch(`${node.url}/api/nodes/sync-blocks?since=0`, {
                headers: { 'Authorization': `Bearer ${node.auth_token}` }
              });
              if (resp.ok) {
                const data = await resp.json();
                if (data.blocks && data.blocks.length > 0) {
                  for (const block of data.blocks) {
                    try { db.insertBlock(block); } catch (e) { /* skip */ }
                  }
                  console.log(`📥 Restored ${data.blocks.length} blocks from node: ${node.name}`);
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
});

const http2Server = http2.createSecureServer({ key: tlsKey, cert: tlsCert, allowHTTP1: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }, app);
http2Server.listen(HTTPS_PORT, () => {
  console.log(`🔐 HTTP/2 server listening on port ${HTTPS_PORT}`);
});
