// server.js - Full fix
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const db = require('./db');
const blockchain = require('./blockchain');
const snake = require('./snake');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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

// ─── Network status ────────────────────────────────────
app.get('/network_status', (req, res) => {
  try {
    const recent = db.getRecentBlocks(10);
    const miners = db.getActiveMiners(5);
    res.json({ recent_blocks: recent, active_miners: miners });
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

// ─── Bounty endpoints ─────────────────────────────────
app.post('/create_bounty', (req, res) => {
  const { username, pin, difficulty, reward, target_device } = req.body;
  if (!username || !pin || !difficulty) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    const result = blockchain.createBounty(username, pin, difficulty, reward, target_device);
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

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
    // Đọc từ cả query params và body
    const bounty_id = req.query.bounty_id || req.body.bounty_id;
    const nonce = req.query.nonce || req.body.nonce;
    const worker_name = req.query.worker_name || req.body.worker_name;
    const device_type = req.query.device_type || req.body.device_type || 'web';

    // Validate
    if (!bounty_id || !nonce || !worker_name) {
      return res.status(400).json({ 
        status: 'error', 
        message: 'Missing required parameters: bounty_id, nonce, worker_name' 
      });
    }

    const result = blockchain.submitSolution(bounty_id, nonce, worker_name, device_type);
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
    message: 'ChocoHub API is running'
  });
});

// ─── SPA fallback ─────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  // Kiểm tra file tồn tại
  try {
    if (require('fs').existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(200).send(`
        <html>
        <head><title>ChocoHub</title></head>
        <body style="background:#0a0a12;color:#eee4d8;font-family:sans-serif;text-align:center;padding:50px;">
          <h1>🍫 ChocoHub</h1>
          <p>Server running. Upload your HTML files to the public folder.</p>
        </body>
        </html>
      `);
    }
  } catch(e) {
    res.status(500).send('Server error');
  }
});

// ─── Error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🍫 ChocoHub running on port ${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
});
