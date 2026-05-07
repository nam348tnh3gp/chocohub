// blockchain.js
const crypto = require('crypto');
const db = require('./db');

function createBounty(username, pin, difficulty, reward, targetDevice) {
  username = username.toLowerCase().trim();
  
  // Verify credentials
  db.authenticate(username, pin); // throws if invalid
  
  const user = db.getUser(username);
  if (!user) throw new Error('User not found');
  
  const cost = 8.0;
  if (user.balance < cost) throw new Error('Insufficient balance (need 8 CC)');
  
  const bountyId = crypto.randomBytes(8).toString('hex');
  const difficultyBits = parseInt(difficulty);
  const binaryTarget = '0'.repeat(difficultyBits);
  const lastHash = crypto.randomBytes(32).toString('hex');
  
  // Deduct 8 CC
  db.updateBalance(username, -cost);
  
  // Insert bounty
  const stmt = db.db.prepare(
    `INSERT INTO bounties (id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  );
  stmt.run(bountyId, username, targetDevice, difficultyBits, reward || 1.0, cost, binaryTarget, lastHash);
  
  return {
    status: 'success',
    bounty_id: bountyId,
    message: `Bounty created! 8 CC deducted (${reward || 1.0} CC reward, ${(7 - (reward || 1.0) + 1).toFixed(1)} CC burned)`,
    new_balance: db.getUser(username).balance
  };
}

function getActiveBounties() {
  const rows = db.db.prepare(
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
  const bounty = db.db.prepare(
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
  const bounty = db.db.prepare(
    'SELECT * FROM bounties WHERE id=? AND status=?'
  ).get(bountyId, 'active');
  
  if (!bounty) throw new Error('Bounty not found or already solved');
  
  // Verify hash
  const input = bounty.last_hash + nonce + workerName;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  const binary = hexToBinary(hash);
  
  if (!binary.startsWith(bounty.binary_target)) {
    return { status: 'error', reason: 'Invalid nonce: hash does not meet target' };
  }
  
  // Mark as solved
  db.db.prepare('UPDATE bounties SET status=?, nonce=?, solver_username=? WHERE id=?')
    .run('solved', nonce, workerName, bountyId);
  
  // Reward miner 1 CC
  db.updateBalance(workerName, 1.0);
  
  // Log block
  db.db.prepare('INSERT INTO blocks_mined (username, bounty_id, reward) VALUES (?, ?, 1.0)')
    .run(workerName, bountyId);
  
  return { status: 'success', message: 'Block solved! You earned 1 CC.' };
}

function hexToBinary(hex) {
  return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

module.exports = { createBounty, getActiveBounties, getJob, submitSolution };
