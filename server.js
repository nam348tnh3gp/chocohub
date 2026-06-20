// server.js – Hybrid PoW + PoS + Diffie-Hellman + HTTP/2 + TLS 1.3 + Session Token (JWT) + Rate Limit + Trust Proxy + SWAP + Admin Web Interface (Full)
// 🆕 Tích hợp mempool và phí giao dịch tự động (node_fees)
// 🆕 Quản lý user (thêm, xoá, ban) trong admin dashboard
// 🆕 Sửa lỗi lịch sử giao dịch (hiển thị cả confirmed và pending)

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

// ─── Thêm cột banned vào bảng users nếu chưa có ──────
try {
  const hasBanned = db.db.prepare("PRAGMA table_info(users)").all().some(col => col.name === 'banned');
  if (!hasBanned) {
    db.db.exec("ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0");
    console.log('✅ Added banned column to users table');
  }
} catch (e) {
  console.warn('Could not add banned column:', e.message);
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
    const user = db.getUser(username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    // Xóa user khỏi bảng users
    db.db.prepare('DELETE FROM users WHERE username = ?').run(username);
    // Cũng xóa các dữ liệu liên quan (stakes, transactions, snake_claims, mempool, blocks_mined)
    db.db.prepare('DELETE FROM stakes WHERE username = ?').run(username);
    db.db.prepare('DELETE FROM transactions WHERE from_username = ? OR to_username = ?').run(username, username);
    db.db.prepare('DELETE FROM snake_claims WHERE username = ?').run(username);
    db.db.prepare('DELETE FROM mempool WHERE from_username = ? OR to_username = ?').run(username, username);
    // blocks_mined giữ lại để thống kê (không xóa)
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
    const user = db.getUser(username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    // Cập nhật trạng thái banned
    db.db.prepare('UPDATE users SET banned = ? WHERE username = ?').run(banned ? 1 : 0, username);
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

// ─── Admin Dashboard (đã cập nhật giao diện quản lý user) ───
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
                    const actions = row.insertCell(2);
                    const editBtn = document.createElement('button');
                    editBtn.innerText = '✏️ Balance';
                    editBtn.className = 'btn-edit';
                    editBtn.onclick = () => openEditModal(user.username, user.balance);
                    actions.appendChild(editBtn);
                    
                    if (!isAdmin(user.username)) {
                        const banBtn = document.createElement('button');
                        banBtn.innerText = user.banned ? '🔓 Unban' : '🚫 Ban';
                        banBtn.className = user.banned ? 'btn-unban' : 'btn-ban';
                        banBtn.onclick = () => toggleBan(user.username, !user.banned);
                        actions.appendChild(banBtn);
                        
                        const deleteBtn = document.createElement('button');
                        deleteBtn.innerText = '🗑️ Delete';
                        deleteBtn.className = 'btn-delete';
                        deleteBtn.onclick = () => deleteUser(user.username);
                        actions.appendChild(deleteBtn);
                    }
                }
            }
            
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

app.post('/snake/claim', snakeLimiter, (req, res) => {
  const { username, pin, apples, mode } = req.body;
  if (!username || !pin) {
    return res.status(401).json({ status: 'error', message: 'Missing username or pin' });
  }
  if (apples == null) {
    return res.status(400).json({ status: 'error', message: 'Missing apples' });
  }
  try {
    const authResult = db.authenticate(username, pin);
    if (authResult.status !== 'success') {
      return res.status(401).json({ status: 'error', message: 'Invalid username or pin' });
    }
    // Kiểm tra banned
    const user = db.getUser(username);
    if (user && user.banned) {
      return res.status(403).json({ status: 'error', message: 'Account is banned' });
    }
    const result = snake.processClaim(username, null, apples, mode);
    res.json(result);
  } catch (e) {
    res.status(401).json({ status: 'error', message: 'Invalid username or pin' });
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
//  MINING ROUTES – SỬ DỤNG BLOCKCHAIN MỚI
// ════════════════════════════════════════════════════

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
    const worker_name = req.query.worker_name || req.body.worker_name;
    const device_type = req.query.device_type || req.body.device_type || 'web';

    if (!bounty_id || !nonce || !worker_name) {
      return res.status(400).json({ status: 'error', message: 'Missing required parameters: bounty_id, nonce, worker_name' });
    }

    const result = blockchain.submitSolution(bounty_id, nonce, worker_name, device_type);
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
});

const http2Server = http2.createSecureServer({ key: tlsKey, cert: tlsCert, allowHTTP1: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }, app);
http2Server.listen(HTTPS_PORT, () => {
  console.log(`🔐 HTTP/2 server listening on port ${HTTPS_PORT}`);
});
