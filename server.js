// server.js
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
app.use(express.static(path.join(__dirname, 'public')));

// ─── Auth ─────────────────────────────────────────────
app.post('/auth', async (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    await db.getDb(); // đảm bảo DB đã sẵn sàng
    const result = db.authenticate(username, pin);
    res.json(result);
  } catch (e) {
    res.status(401).json({ status: 'error', message: e.message });
  }
});

// ─── User info (không cần auth middleware vì frontend dùng localStorage) ─────
app.get('/get_user/:username', async (req, res) => {
  try {
    await db.getDb();
    const user = db.getUser(req.params.username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ status: 'success', balance: user.balance, username: user.username });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── Network status ────────────────────────────────────
app.get('/network_status', async (req, res) => {
  try {
    await db.getDb();
    const recent = db.getRecentBlocks(10);
    const miners = db.getActiveMiners(5);
    res.json({ recent_blocks: recent, active_miners: miners });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── Snake claim ──────────────────────────────────────
app.post('/snake/claim', async (req, res) => {
  const { username, pin, apples, mode } = req.body;
  if (!username || !pin || apples == null) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    const result = await snake.processClaim(username, pin, apples, mode);
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// ─── Bounty endpoints ─────────────────────────────────
app.post('/create_bounty', async (req, res) => {
  const { username, pin, difficulty, reward, target_device } = req.body;
  if (!username || !pin || !difficulty) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    const result = await blockchain.createBounty(username, pin, difficulty, reward, target_device);
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

app.get('/active_bounties_list', async (req, res) => {
  try {
    const bounties = await blockchain.getActiveBounties(); // ← thêm await
    res.json(bounties);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/get_job/:id', async (req, res) => {
  try {
    const job = await blockchain.getJob(req.params.id); // ← thêm await
    if (!job) return res.status(404).json({ status: 'error', message: 'Bounty not found' });
    res.json(job);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/submit_solution', async (req, res) => {
  const { bounty_id, nonce, worker_name, device_type } = req.query;
  if (!bounty_id || !nonce || !worker_name) return res.status(400).json({ status: 'error', message: 'Missing params' });
  try {
    const result = await blockchain.submitSolution(bounty_id, nonce, worker_name, device_type);
    res.json(result);
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// ─── Miner heartbeat (giữ kết nối) ────────────────────
app.get('/miner_heartbeat', (req, res) => {
  res.json({ status: 'ok' });
});

// ─── SPA fallback ─────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🍫 ChocoHub running on port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
});
