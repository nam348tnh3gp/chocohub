// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const db = require('./db');
const blockchain = require('./blockchain');
const snake = require('./snake');
const auth = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Auth
app.post('/auth', async (req, res) => {
  const { username, pin } = req.body;
  if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing fields' });
  try {
    const result = await db.authenticate(username, pin);
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// User info
app.get('/get_user/:username', auth, async (req, res) => {
  try {
    const user = db.getUser(req.params.username);
    if (!user) return res.status(404).json({ status: 'error', message: 'User not found' });
    res.json({ status: 'success', balance: user.balance });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Network status
app.get('/network_status', async (req, res) => {
  try {
    const recent = db.getRecentBlocks(10);
    const miners = db.getActiveMiners(5);
    res.json({ recent_blocks: recent, active_miners: miners });
  } catch (e) {
    res.status(500).json({ status: 'error' });
  }
});

// Snake claim
app.post('/snake/claim', async (req, res) => {
  const { username, pin, apples, mode } = req.body;
  if (!username || !pin || apples == null) return res.status(400).json({ status: 'error' });
  try {
    const result = await snake.processClaim(username, pin, apples, mode);
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// Bounty endpoints
app.post('/create_bounty', async (req, res) => {
  const { username, pin, difficulty, reward, target_device } = req.body;
  if (!username || !pin || !difficulty) return res.status(400).json({ status: 'error' });
  try {
    const result = await blockchain.createBounty(username, pin, difficulty, reward, target_device);
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/active_bounties_list', (req, res) => {
  const bounties = blockchain.getActiveBounties();
  res.json(bounties);
});

app.get('/get_job/:id', (req, res) => {
  const job = blockchain.getJob(req.params.id);
  if (!job) return res.status(404).json({ status: 'error', message: 'Bounty not found' });
  res.json(job);
});

app.post('/submit_solution', async (req, res) => {
  const { bounty_id, nonce, worker_name, device_type } = req.query;
  if (!bounty_id || !nonce || !worker_name) return res.status(400).json({ status: 'error' });
  try {
    const result = await blockchain.submitSolution(bounty_id, nonce, worker_name, device_type);
    res.json(result);
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`ChocoHub running on port ${PORT}`);
});
