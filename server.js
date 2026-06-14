// server.js – Hybrid PoW + PoS + Diffie-Hellman + HTTP/2 + TLS 1.3 + Session Token (JWT) + Rate Limit + Trust Proxy + SWAP + Admin Web Interface (Full)
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

// Module Imports
const SwapRouter = require('./routes/swap');

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

// Session middleware (httpOnly cookie, prevents console access)
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,
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

// API proxy cho admin
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

app.get('/admin/api/all-users', requireAdminSession, async (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json({ status: 'success', users });
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
    const { request_id } = req.body;
    const token = req.session.adminToken;
    const response = await fetch(`http://localhost:${PORT}/swap/fulfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ request_id })
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

// Dashboard admin mở rộng
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
            .tabs { display: flex; gap: 1rem; margin-bottom: 2rem; border-bottom: 1px solid #2a2a36; }
            .tab-btn { background: none; border: none; color: #8b8296; padding: 0.75rem 1.5rem; font-size: 1rem; cursor: pointer; transition: 0.2s; }
            .tab-btn:hover { color: #f58a00; }
            .tab-btn.active { color: #f58a00; border-bottom: 2px solid #f58a00; }
            .tab-content { display: none; }
            .tab-content.active { display: block; }
            .card { background: #1e1e2a; border-radius: 24px; padding: 1.5rem; margin-bottom: 2rem; box-shadow: 0 8px 20px rgba(0,0,0,0.3); }
            .card h2 { margin-bottom: 1rem; color: #f58a00; font-weight: 500; }
            table { width: 100%; border-collapse: collapse; }
            th, td { padding: 14px 12px; text-align: left; border-bottom: 1px solid #2a2a36; }
            th { background: #2a2a36; font-weight: 600; color: #ffbf00; }
            .status-pending { background: #ffaa4433; color: #ffaa44; padding: 4px 10px; border-radius: 40px; font-size: 0.8rem; font-weight: bold; display: inline-block; }
            .status-completed { background: #44ff4433; color: #44ff44; padding: 4px 10px; border-radius: 40px; font-size: 0.8rem; font-weight: bold; display: inline-block; }
            .btn-complete { background: #f58a00; color: #0a0a12; border: none; padding: 6px 12px; border-radius: 30px; cursor: pointer; font-weight: bold; margin-right: 8px; transition: 0.2s; }
            .btn-complete:hover { background: #ff9e20; transform: scale(1.02); }
            .btn-delete { background: #ff4444; color: white; border: none; padding: 6px 12px; border-radius: 30px; cursor: pointer; font-weight: bold; transition: 0.2s; }
            .btn-delete:hover { background: #ff6666; transform: scale(1.02); }
            .btn-edit { background: #2a2a36; color: #f58a00; border: 1px solid #f58a00; padding: 6px 12px; border-radius: 30px; cursor: pointer; font-weight: bold; transition: 0.2s; }
            .btn-edit:hover { background: #f58a00; color: #0a0a12; }
            .empty-row td { text-align: center; color: #888; padding: 2rem; }
            .refresh { float: right; font-size: 0.8rem; color: #888; margin-top: 0.5rem; cursor: pointer; }
            .refresh:hover { color: #f58a00; }
            .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); z-index: 1000; justify-content: center; align-items: center; }
            .modal-content { background: #1e1e2a; border-radius: 24px; padding: 2rem; width: 400px; max-width: 90%; }
            .modal-content h3 { margin-bottom: 1rem; color: #f58a00; }
            .modal-content input { width: 100%; padding: 12px; margin: 10px 0; background: #2a2a36; border: 1px solid #3a3a46; border-radius: 12px; color: white; }
            .modal-buttons { display: flex; gap: 1rem; margin-top: 1rem; }
            .modal-buttons button { flex: 1; padding: 10px; border-radius: 30px; cursor: pointer; }
            .btn-save { background: #f58a00; color: #0a0a12; border: none; }
            .btn-cancel { background: #2a2a36; color: #eee4d8; border: 1px solid #ff4444; }
            .search-box { margin-bottom: 1rem; display: flex; gap: 0.5rem; }
            .search-box input { flex: 1; padding: 10px; background: #2a2a36; border: 1px solid #3a3a46; border-radius: 12px; color: white; }
            .search-box button { background: #f58a00; color: #0a0a12; border: none; padding: 10px 20px; border-radius: 30px; cursor: pointer; }
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
            
            <!-- Swaps Tab -->
            <div id="swaps-tab" class="tab-content active">
                <div class="card">
                    <h2>⏳ Pending Swaps</h2>
                    <div style="overflow-x: auto;">
                        <table id="pendingTable">
                            <thead><tr><th>ID</th><th>From</th><th>Amount</th><th>Type</th><th>Receiver</th><th>Status</th><th>Actions</th></tr></thead>
                            <tbody id="pendingBody"><tr class="empty-row"><td colspan="7">Loading...</td></tr></tbody>
                        </table>
                    </div>
                </div>
                <div class="card">
                    <h2>✅ Completed Swaps</h2>
                    <div style="overflow-x: auto;">
                        <table id="completedTable">
                            <thead><tr><th>ID</th><th>From</th><th>Amount</th><th>Type</th><th>Receiver</th><th>Status</th><th>Completed At</th></tr></thead>
                            <tbody id="completedBody"><tr class="empty-row"><td colspan="7">Loading...</td></tr></tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            <!-- Users Tab -->
            <div id="users-tab" class="tab-content">
                <div class="card">
                    <h2>👥 User Management</h2>
                    <div class="search-box">
                        <input type="text" id="userSearch" placeholder="Search username...">
                        <button onclick="searchUsers()">🔍 Search</button>
                    </div>
                    <div style="overflow-x: auto;">
                        <table id="usersTable">
                            <thead><tr><th>Username</th><th>Balance (CC)</th><th>Actions</th></tr></thead>
                            <tbody id="usersBody"><tr class="empty-row"><td colspan="3">Loading...</td></tr></tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            <!-- Stats Tab -->
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

        <script>
            let allSwaps = [];
            let allUsers = [];
            let currentEditUser = null;
            
            // Tab switching
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
                    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">✨ No pending swaps</td></tr>';
                    return;
                }
                tbody.innerHTML = '';
                for (const swap of swaps) {
                    const row = tbody.insertRow();
                    row.insertCell(0).innerText = swap.id;
                    row.insertCell(1).innerText = swap.from_user;
                    row.insertCell(2).innerText = swap.amount_cc;
                    row.insertCell(3).innerText = swap.swap_type;
                    row.insertCell(4).innerText = swap.receiver;
                    row.insertCell(5).innerHTML = '<span class="status-pending">pending</span>';
                    const actions = row.insertCell(6);
                    const completeBtn = document.createElement('button');
                    completeBtn.innerText = '✅ Complete';
                    completeBtn.className = 'btn-complete';
                    completeBtn.onclick = () => completeSwap(swap.id);
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
                    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">📭 No completed swaps yet</td></tr>';
                    return;
                }
                tbody.innerHTML = '';
                for (const swap of swaps) {
                    const row = tbody.insertRow();
                    row.insertCell(0).innerText = swap.id;
                    row.insertCell(1).innerText = swap.from_user;
                    row.insertCell(2).innerText = swap.amount_cc;
                    row.insertCell(3).innerText = swap.swap_type;
                    row.insertCell(4).innerText = swap.receiver;
                    row.insertCell(5).innerHTML = '<span class="status-completed">completed</span>';
                    row.insertCell(6).innerText = swap.completed_at ? new Date(swap.completed_at).toLocaleString() : '-';
                }
            }
            
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
                    tbody.innerHTML = '<tr class="empty-row"><td colspan="3">👻 No users found</td></tr>';
                    return;
                }
                tbody.innerHTML = '';
                for (const user of users) {
                    const row = tbody.insertRow();
                    row.insertCell(0).innerText = user.username;
                    row.insertCell(1).innerHTML = `<span style="color:#f58a00">${user.balance.toFixed(4)} CC</span>`;
                    const actions = row.insertCell(2);
                    const editBtn = document.createElement('button');
                    editBtn.innerText = '✏️ Edit Balance';
                    editBtn.className = 'btn-edit';
                    editBtn.onclick = () => openEditModal(user.username, user.balance);
                    actions.appendChild(editBtn);
                }
            }
            
            function searchUsers() {
                const searchTerm = document.getElementById('userSearch').value.toLowerCase();
                const filtered = allUsers.filter(u => u.username.toLowerCase().includes(searchTerm));
                renderUsers(filtered);
            }
            
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
                        const totalUsers = usersData.users.length;
                        const totalBalance = usersData.users.reduce((sum, u) => sum + u.balance, 0);
                        
                        document.getElementById('statsContent').innerHTML = \`
                            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;">
                                <div style="background: #2a2a36; padding: 1rem; border-radius: 16px;"><strong>📊 Total Swaps</strong><br>\${totalSwaps}</div>
                                <div style="background: #2a2a36; padding: 1rem; border-radius: 16px;"><strong>⏳ Pending Swaps</strong><br>\${pendingSwaps}</div>
                                <div style="background: #2a2a36; padding: 1rem; border-radius: 16px;"><strong>✅ Completed Swaps</strong><br>\${completedSwaps}</div>
                                <div style="background: #2a2a36; padding: 1rem; border-radius: 16px;"><strong>👥 Total Users</strong><br>\${totalUsers}</div>
                                <div style="background: #2a2a36; padding: 1rem; border-radius: 16px;"><strong>💰 Total CC Supply</strong><br>\${totalBalance.toFixed(4)} CC</div>
                            </div>
                        \`;
                    }
                } catch(e) { console.error(e); }
            }
            
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
                        alert(\`Balance updated! New balance: \${data.new_balance.toFixed(4)} CC\`);
                        closeModal();
                        loadUsers();
                    } else {
                        alert('Error: ' + data.message);
                    }
                } catch(e) { alert(e.message); }
            }
            
            async function completeSwap(id) {
                if (!confirm('Mark this swap as completed?')) return;
                try {
                    const resp = await fetch('/admin/api/fulfill', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ request_id: id })
                    });
                    const data = await resp.json();
                    if (data.status === 'success') {
                        alert('✅ Swap completed!');
                        loadAllSwaps();
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
                    } else {
                        alert('❌ Error: ' + (data.message || 'Unknown error'));
                    }
                } catch(e) { alert(e.message); }
            }
            
            loadAllSwaps();
            setInterval(loadAllSwaps, 30000);
        </script>
    </body>
    </html>
  `);
});

// ════════════════════════════════════════════════════
//  PUBLIC ENDPOINTS (giữ nguyên)
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

// AUTH endpoint
app.post('/auth', authLimiter, (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
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

// Các route công khai
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

// CÁC ROUTE YÊU CẦU TOKEN
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
    const currentStake = db.getStake(username);
    db.unstake(username);
    res.json({ status: 'success', message: 'Unstaked successfully. All funds returned.', staked: 0 });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// MINING ROUTES
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

// BACKUP ENDPOINTS
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
  console.log(`║  HTTP/1.1  : http://localhost:${PORT} ║`);
  console.log(`║  HTTP/2 TLS: https://localhost:${HTTPS_PORT} ║`);
  console.log('║  Admin web : http://localhost:' + PORT + '/admin ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  backupClient.start();
});

const http2Server = http2.createSecureServer({ key: tlsKey, cert: tlsCert, allowHTTP1: true, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.3' }, app);
http2Server.listen(HTTPS_PORT, () => {
  console.log(`🔐 HTTP/2 server listening on port ${HTTPS_PORT}`);
});
