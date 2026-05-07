// blockchain.js
const crypto = require('crypto');
const db = require('./db');

// Kết nối DB nội bộ (không export)
const Database = require('better-sqlite3');
const path = require('path');
const sqlite = new Database(path.join(__dirname, 'chocohub.db'));

function createBounty(username, pin, difficulty, reward, targetDevice) {
  username = username.toLowerCase().trim();

  db.authenticate(username, pin);

  const user = db.getUser(username);
  if (!user) throw new Error('User not found');

  const cost = 8.0;
  if (user.balance < cost) throw new Error(`Insufficient balance (need ${cost} CC)`);

  const bountyId = crypto.randomBytes(8).toString('hex');
  const difficultyBits = parseInt(difficulty) || 8;
  const binaryTarget = '0'.repeat(difficultyBits);
  const lastHash = crypto.randomBytes(32).toString('hex');

  db.updateBalance(username, -cost);

  sqlite.prepare(`
    INSERT INTO bounties (id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(bountyId, username, targetDevice || 'any', difficultyBits, reward || 1.0, cost, binaryTarget, lastHash);

  const burned = cost - (reward || 1.0);
  return {
    status: 'success',
    bounty_id: bountyId,
    message: `Bounty created! ${cost} CC deducted (${reward || 1.0} CC reward, ${burned.toFixed(1)} CC burned)`,
    new_balance: db.getUser(username).balance
  };
}

function getActiveBounties() {
  const rows = sqlite.prepare(
    'SELECT id, creator_username, target_device, difficulty, reward, binary_target, last_hash FROM bounties WHERE status=?'
  ).all('active');

  const result = {};
  rows.forEach(r => {
    result[r.id] = {
      id: r.id,
      creator: r.creator_username,
      target_device: r.target_device,
      difficulty_bits: r.difficulty,
      reward: r.reward,
      binary_target: r.binary_target,
      last_hash: r.last_hash
    };
  });
  return result;
}

function getJob(bountyId) {
  const bounty = sqlite.prepare(
    'SELECT * FROM bounties WHERE id=? AND status=?'
  ).get(bountyId, 'active');

  if (!bounty) return null;

  return {
    last_hash: bounty.last_hash,
    target_bin: bounty.binary_target,
    difficulty_bits: bounty.difficulty,
    bounty_id: bounty.id
  };
}

function submitSolution(bountyId, nonce, workerName, deviceType) {
  const bounty = sqlite.prepare(
    'SELECT * FROM bounties WHERE id=? AND status=?'
  ).get(bountyId, 'active');

  if (!bounty) throw new Error('Bounty not found or already solved');

  const input = bounty.last_hash + nonce + workerName;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  const binary = hexToBinary(hash);

  if (!binary.startsWith(bounty.binary_target)) {
    return { status: 'error', reason: `Invalid nonce: hash ${binary.substring(0, 10)}... does not meet target` };
  }

  sqlite.prepare('UPDATE bounties SET status=?, nonce=?, solver_username=? WHERE id=?')
    .run('solved', nonce, workerName, bountyId);

  db.updateBalance(workerName, 1.0);

  sqlite.prepare('INSERT INTO blocks_mined (username, bounty_id, reward) VALUES (?, ?, 1.0)')
    .run(workerName, bountyId);

  return { status: 'success', message: 'Block solved! You earned 1 CC.' };
}

function hexToBinary(hex) {
  return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

module.exports = { createBounty, getActiveBounties, getJob, submitSolution };
