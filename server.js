// server.js – Hybrid PoW + PoS (case-sensitive fix + all features + backup broadcast)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');
const blockchain = require('./blockchain');
const snake = require('./snake');
const backupClient = require('./backupSync');

// Hàm tạo hash nhẹ cho DB state (để backup server verify)
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
    
    // 🟢 Broadcast user mới nếu vừa tạo
    if (result.message === 'Account created') {
      backupClient.broadcast({
        type: 'DELTA',
        seq: db.incrementSeq(),
        action: 'user_created',
        username: username,
        dbHash: getDbHash()
      });
    }
    
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
    const validators = db.getValidators(10).map(v => ({
      username: v.username,
      stake: v.amount
    }));
    res.json({ recent_blocks: recent, active_validators: validators });
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
    
    // 🟢 Broadcast claim
    backupClient.broadcast({
      type: 'DELTA',
      seq: db.incrementSeq(),
      action: 'snake_claim',
      username: username,
      payload: { apples, mode, reward: result.reward },
      dbHash: getDbHash()
    });
    
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

// ═══════════════════════════════════════════════════════
// LEADERBOARD ROUTE
// ═══════════════════════════════════════════════════════
app.get('/leaderboard', (req, res) => {
  try {
    const normal = db.getLeaderboard('normal', 10);
    const hardcore = db.getLeaderboard('hardcore', 10);
    res.json({ normal, hardcore });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ═══════════════════════════════════════════════════════
// PROOF OF STAKE (PoS) ROUTES
// ═══════════════════════════════════════════════════════
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
    const isValidator = (username === currentVal);

    res.json({
      status: 'success',
      balance,
      staked,
      is_validator: isValidator,
      pending_reward: pending,
      current_validator: currentVal || null
    });
  } catch (e) {
    console.error('/pos/info error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

app.post('/pos/stake', (req, res) => {
  try {
    const { username, pin, amount } = req.body;
    if (!username || !pin || !amount) return res.status(400).json({ status: 'error', message: 'Missing fields' });

    db.authenticate(username, pin);
    const stakeAmount = parseFloat(amount);
    if (isNaN(stakeAmount) || stakeAmount < 10) throw new Error('Minimum stake is 10 CC');

    const result = db.stake(username, stakeAmount);
    
    // 🟢 Broadcast stake
    backupClient.broadcast({
      type: 'DELTA',
      seq: db.incrementSeq(),
      action: 'stake',
      username: username,
      payload: { amount: stakeAmount, staked: Number(result.amount) || 0 },
      dbHash: getDbHash()
    });
    
    res.json({ status: 'success', message: 'Staked ' + stakeAmount + ' CC', staked: Number(result.amount) || 0 });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

app.post('/pos/unstake', (req, res) => {
  try {
    const { username, pin } = req.body;
    if (!username || !pin) return res.status(400).json({ status: 'error', message: 'Missing fields' });

    db.authenticate(username, pin);
    
    // Lấy thông tin stake trước khi unstake để broadcast chính xác
    const currentStake = db.getStake(username);
    const totalAmount = (currentStake.amount || 0) + (currentStake.pending_reward || 0);
    
    db.unstake(username);

    // 🟢 Broadcast unstake với amount thực tế
    backupClient.broadcast({
      type: 'DELTA',
      seq: db.incrementSeq(),
      action: 'unstake',
      username: username,
      payload: { amount: totalAmount },
      dbHash: getDbHash()
    });
    
    res.json({ status: 'success', message: 'Unstaked successfully. All funds returned.', staked: 0 });
  } catch (e) {
    res.status(400).json({ status: 'error', message: e.message });
  }
});

// ─── Bounty endpoints (PoW) ──────────────────────────
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
    const bounty_id = req.query.bounty_id || req.body.bounty_id;
    const nonce = req.query.nonce || req.body.nonce;
    const worker_name = req.query.worker_name || req.body.worker_name;
    const device_type = req.query.device_type || req.body.device_type || 'web';

    if (!bounty_id || !nonce || !worker_name) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required parameters: bounty_id, nonce, worker_name'
      });
    }

    const result = blockchain.submitSolution(bounty_id, nonce, worker_name, device_type);

    if (result && result.status === 'success') {
      sendMinerWebhook(worker_name, bounty_id, device_type);
      
      // 🟢 Broadcast block mined
      backupClient.broadcast({
        type: 'DELTA',
        seq: db.incrementSeq(),
        action: 'block_mined',
        username: worker_name,
        payload: { 
          bounty_id: bounty_id, 
          reward: result.reward || 0,
          device: device_type 
        },
        dbHash: getDbHash()
      });
    }

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
    message: 'ChocoHub API is running',
    uptime: process.uptime()
  });
});

// 🟢 Health endpoint cho Backup Server
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    dbHash: getDbHash()
  });
});

// ═══════════════════════════════════════════════════════
// BACKUP RECEIVE ENDPOINT - Nhận backup từ backup server
// ═══════════════════════════════════════════════════════
app.post('/api/backup/sync', (req, res) => {
  try {
    const data = req.body;
    const token = data.token || '';
    
    if (token !== (process.env.BACKUP_TOKEN || 'chocohub-default-token')) {
      return res.status(401).json({ status: 'error', message: 'Invalid token' });
    }
    
    console.log(`📥 Received from backup: type=${data.type}, seq=${data.seq}`);
    
    if (data.type === 'FULL_BACKUP') {
      console.log(`📥 Receiving full backup (${data.rows ? data.rows.length : 0} items)...`);
      
      if (data.rows && Array.isArray(data.rows)) {
        // 🔄 THỰC SỰ RESTORE DỮ LIỆU VÀO DB
        backupClient.restoreFromBackup(data.rows);
        console.log('✅ Full backup restored from backup server');
      } else {
        console.log('⚠️ FULL_BACKUP received but no rows found');
      }
      
      return res.json({
        type: 'BACKUP_ACK',
        seq: data.seq,
        status: 'success',
        message: 'Backup restored'
      });
    }
    
    res.json({
      type: 'ACK',
      seq: data.seq || 0,
      status: 'received'
    });
    
  } catch (e) {
    console.error('❌ Error receiving backup:', e.message);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

// ─── SPA fallback ─────────────────────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  try {
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(200).send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ChocoHub</title><style>body{background:#0a0a12;color:#eee4d8;font-family:"Outfit",sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;text-align:center}h1{color:#f58a00;font-size:2.5rem}p{color:#8b8296;margin-top:10px}</style></head><body><div><h1>ChocoHub</h1><p>Server is running. Please upload frontend files to continue.</p><p style="font-size:0.8rem;margin-top:20px;">API: <code style="color:#f58a00;">/api/test</code></p></div></body></html>');
    }
  } catch(e) {
    res.status(500).send('Server error');
  }
});

// ─── Error handler ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ status: 'error', message: 'Internal server error' });
});

// ═══════════════════════════════════════════════════════
// START AUTO-BOUNTY (PoW) + PoS MINTING
// ═══════════════════════════════════════════════════════
blockchain.startAutoBounty();
blockchain.startPoSMinting();

// ═══════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║     CHOCO HUB - PoW+PoS            ║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  Dashboard: http://localhost:' + PORT + '    ║');
  console.log('║  API Test:  /api/test               ║');
  console.log('║  Leaderboard: /leaderboard          ║');
  console.log('║  PoW Auto-Bounty: active            ║');
  console.log('║  PoS Minting: active (30s blocks)   ║');
  console.log('║  Backup Sync: active                ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  backupClient.start();
});
