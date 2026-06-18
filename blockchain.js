// blockchain.js - PoW + fee-funded PoS reward distribution + job assignment
const crypto = require('crypto');
const db = require('./db');

const Database = require('better-sqlite3');
const path = require('path');
const sqlite = new Database(path.join(__dirname, 'chocohub.db'));
sqlite.pragma('journal_mode = WAL');

try {
  sqlite.exec(`ALTER TABLE bounties ADD COLUMN worker_name TEXT DEFAULT NULL`);
} catch (e) {
  // Column already exists
}

const BLOCK_TIME_TARGET = 10;
const DEFAULT_DIFFICULTY = 1;
const MIN_DIFFICULTY = 1.0;
const MAX_DIFFICULTY = 1000000.0;
const MAX_DIFFICULTY_CHANGE = 0.25;

const jobAssignTime = new Map();

const AUTO_BOUNTY_MIN = 0.0001;
const AUTO_BOUNTY_MAX = 0.01;
const MIN_ACTIVE_BOUNTIES = 30;
const MAX_ACTIVE_BOUNTIES = 100;
const AUTO_BOUNTY_INTERVAL = 3000;

function difficultyToTarget(difficulty) {
  const maxTarget = (1n << 256n) - 1n;
  const diffScaled = BigInt(Math.floor(difficulty * 1000));
  if (diffScaled === 0n) return 'f'.repeat(64);
  const targetValue = maxTarget / diffScaled;
  return targetValue.toString(16).padStart(64, '0');
}

function createAutoBounty() {
  const variation = (Math.random() - 0.5) * 0.4;
  let difficulty = DEFAULT_DIFFICULTY * (1 + variation);
  difficulty = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, difficulty));
  difficulty = Math.round(difficulty * 10) / 10;

  const reward = parseFloat((AUTO_BOUNTY_MIN + Math.random() * (AUTO_BOUNTY_MAX - AUTO_BOUNTY_MIN)).toFixed(3));
  const bountyId = 'auto_' + crypto.randomBytes(6).toString('hex');
  const targetHex = difficultyToTarget(difficulty);
  const lastHash = crypto.randomBytes(32).toString('hex');

  sqlite.prepare(`
    INSERT INTO bounties (id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, status, worker_name)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active', NULL)
  `).run(bountyId, 'server', 'all', difficulty, reward, targetHex, lastHash);
}

function cleanupOldBounties() {
  try {
    const activeCount = sqlite.prepare('SELECT COUNT(*) as count FROM bounties WHERE status=?').get('active').count;
    if (activeCount > MAX_ACTIVE_BOUNTIES) {
      const toDelete = activeCount - MAX_ACTIVE_BOUNTIES;
      sqlite
        .prepare(`DELETE FROM bounties WHERE id IN (SELECT id FROM bounties WHERE status = 'active' ORDER BY created_at ASC LIMIT ?)`)
        .run(toDelete);
      console.log(`🧹 Cleaned up ${toDelete} old bounties`);
    }
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

function checkAndRefillBounties() {
  try {
    cleanupOldBounties();
    const activeCount = sqlite.prepare('SELECT COUNT(*) as count FROM bounties WHERE status=?').get('active').count;
    if (activeCount < MIN_ACTIVE_BOUNTIES) {
      const needed = MIN_ACTIVE_BOUNTIES - activeCount;
      for (let i = 0; i < needed; i++) createAutoBounty();
      console.log(`📊 Bounties refilled: ${activeCount} → ${MIN_ACTIVE_BOUNTIES}`);
    }
  } catch (e) {
    console.error('Auto-bounty error:', e.message);
  }
}

function startAutoBounty() {
  checkAndRefillBounties();
  setInterval(checkAndRefillBounties, AUTO_BOUNTY_INTERVAL);
  console.log('🤖 Auto-bounty started');
}

const POS_BLOCK_INTERVAL = 30000;
const MIN_STAKE = 10;
let currentValidator = null;

function getTopValidator() {
  const validators = db.getValidators(MIN_STAKE);
  return validators.length ? validators[0] : null;
}

function getCurrentValidator() {
  return currentValidator;
}

function distributePoSRewards() {
  const validator = getTopValidator();
  currentValidator = validator ? validator.username : null;

  const result = db.distributePosRewards(MIN_STAKE);
  if (!result || result.distributed <= 0) {
    const pool = db.getPosRewardPool ? db.getPosRewardPool() : { balance: 0 };
    if (!validator) {
      console.log('🔒 No eligible validator (no one has staked >= 10 CC)');
    } else if ((pool.balance || 0) <= 0) {
      console.log(`💤 PoS pool empty. Top validator: ${validator.username} (stake: ${validator.amount} CC)`);
    } else {
      console.log(`💤 PoS rewards pending. Pool available: ${(pool.balance || 0).toFixed(4)} CC`);
    }
    return;
  }

  console.log(
    `🏦 Distributed ${(result.distributed || 0).toFixed(8)} CC PoS rewards ` +
    `to ${result.recipients} stakers (total stake: ${Number(result.totalStake || 0).toFixed(4)} CC)`
  );
}

function startPoSMinting() {
  distributePoSRewards();
  setInterval(distributePoSRewards, POS_BLOCK_INTERVAL);
  console.log('🏦 PoS reward distribution started (fee-funded pool, proportional stake share)');
}

function adjustWorkerDifficulty(workerName, solveTime) {
  const currentDiff = db.getWorkerDifficulty(workerName) || DEFAULT_DIFFICULTY;
  const targetTime = BLOCK_TIME_TARGET;

  let idealDiff = currentDiff * (targetTime / solveTime);
  let newDiff = currentDiff + (idealDiff - currentDiff) * 0.5;
  const maxChange = currentDiff * MAX_DIFFICULTY_CHANGE;
  newDiff = Math.max(currentDiff - maxChange, Math.min(currentDiff + maxChange, newDiff));
  newDiff = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, newDiff));
  newDiff = Math.round(newDiff * 10) / 10;

  db.setWorkerDifficulty(workerName, newDiff, Date.now());
  console.log(`👷 Worker ${workerName}: difficulty ${currentDiff.toFixed(1)} → ${newDiff.toFixed(1)} (solve time ${solveTime.toFixed(1)}s)`);
}

function getActiveBounties() {
  const rows = sqlite.prepare('SELECT id, creator_username, target_device, difficulty, reward, binary_target, last_hash FROM bounties WHERE status=? ORDER BY created_at DESC LIMIT 50').all('active');
  const result = {};
  rows.forEach(r => {
    result[r.id] = {
      id: r.id,
      creator: r.creator_username,
      target_device: r.target_device,
      difficulty: r.difficulty,
      reward: r.reward,
      target_hex: r.binary_target,
      last_hash: r.last_hash
    };
  });
  return result;
}

function getJob(bountyId) {
  const bounty = sqlite.prepare('SELECT * FROM bounties WHERE id=? AND status=?').get(bountyId, 'active');
  if (!bounty) return null;
  return {
    last_hash: bounty.last_hash,
    target_hex: bounty.binary_target,
    difficulty: bounty.difficulty,
    bounty_id: bounty.id,
    reward: bounty.reward
  };
}

function getJobForWorker(workerName) {
  let bounty = sqlite.prepare("SELECT * FROM bounties WHERE worker_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(workerName);
  if (!bounty) {
    let diff = db.getWorkerDifficulty(workerName);
    if (!diff) diff = DEFAULT_DIFFICULTY;

    const bountyId = 'wrk_' + crypto.randomBytes(6).toString('hex');
    const targetHex = difficultyToTarget(diff);
    const lastHash = crypto.randomBytes(32).toString('hex');
    const reward = parseFloat((AUTO_BOUNTY_MIN + Math.random() * (AUTO_BOUNTY_MAX - AUTO_BOUNTY_MIN)).toFixed(3));

    sqlite.prepare(`
      INSERT INTO bounties (id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, status, worker_name)
      VALUES (?, 'server', 'all', ?, ?, 0, ?, ?, 'active', ?)
    `).run(bountyId, diff, reward, targetHex, lastHash, workerName);
    bounty = sqlite.prepare('SELECT * FROM bounties WHERE id = ?').get(bountyId);
  }

  jobAssignTime.set(workerName, Date.now());
  return {
    last_hash: bounty.last_hash,
    target_hex: bounty.binary_target,
    difficulty: bounty.difficulty,
    bounty_id: bounty.id,
    reward: bounty.reward
  };
}

function submitSolution(bountyId, nonce, workerName, deviceType) {
  const bounty = sqlite.prepare('SELECT * FROM bounties WHERE id=? AND status=?').get(bountyId, 'active');
  if (!bounty) throw new Error('Bounty not found or already solved');
  if (bounty.worker_name && bounty.worker_name !== workerName) throw new Error('This bounty is assigned to another worker');

  const noncePadded = String(nonce).padStart(20, '0');
  const input = bounty.last_hash + noncePadded + workerName;
  const hashHex = crypto.createHash('sha256').update(input).digest('hex');

  if (hashHex >= bounty.binary_target) {
    return { status: 'error', reason: `Invalid nonce: hash ${hashHex.substring(0, 12)}... >= target` };
  }

  sqlite.prepare('UPDATE bounties SET status=?, nonce=?, solver_username=? WHERE id=?').run('solved', String(nonce), workerName, bountyId);
  const reward = bounty.reward || 0.006;
  db.updateBalance(workerName, reward);
  sqlite.prepare('INSERT INTO blocks_mined (username, bounty_id, reward) VALUES (?, ?, ?)').run(workerName, bountyId, reward);

  const assignTime = jobAssignTime.get(workerName);
  if (assignTime) {
    const solveTime = (Date.now() - assignTime) / 1000;
    adjustWorkerDifficulty(workerName, solveTime);
    jobAssignTime.delete(workerName);
  }

  cleanupOldBounties();
  return { status: 'success', message: `Block solved! You earned ${reward} CC.`, reward };
}

module.exports = {
  getActiveBounties,
  getJob,
  getJobForWorker,
  submitSolution,
  startAutoBounty,
  checkAndRefillBounties,
  cleanupOldBounties,
  startPoSMinting,
  distributePoSRewards,
  getCurrentValidator,
  getCurrentDifficulty: () => DEFAULT_DIFFICULTY
};
