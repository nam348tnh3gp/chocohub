// blockchain.js - Real PoW with SHA256, target/difficulty, mempool, block times
const crypto = require('crypto');
const db = require('./db');
const Database = require('better-sqlite3');
const path = require('path');
const sqlite = new Database(path.join(__dirname, 'chocohub.db'));
sqlite.pragma('journal_mode = WAL');

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════
const BLOCK_TIME_TARGET = 30;            // 30 seconds per block
const DIFFICULTY_ADJUSTMENT_BLOCKS = 16; // Adjust every 16 blocks
const MIN_TARGET = 1n;                   // Hardest difficulty
const MAX_TARGET = (1n << 255n);         // Easiest difficulty
const BASE_BLOCK_REWARD = 0.01;          // Base reward
const MEMPOOL_MAX_SIZE = 1000;

// ═══════════════════════════════════════════════════
// INIT DB TABLES
// ═══════════════════════════════════════════════════
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY,
    hash TEXT UNIQUE,
    height INTEGER,
    timestamp INTEGER,
    miner TEXT,
    nonce INTEGER,
    target_hex TEXT,
    prev_hash TEXT,
    merkle_root TEXT,
    difficulty REAL,
    reward REAL
  );
  
  CREATE TABLE IF NOT EXISTS mempool (
    id TEXT PRIMARY KEY,
    from_user TEXT,
    to_user TEXT,
    amount REAL,
    timestamp INTEGER,
    added_at INTEGER
  );
`);

let currentTarget = MAX_TARGET;
let currentHeight = 0;
let lastAdjustmentHeight = 0;
let lastBlockTime = Date.now();
const blockTimes = [];

// ═══════════════════════════════════════════════════
// CORE POW FUNCTIONS
// ═══════════════════════════════════════════════════

function targetToDifficulty(target) {
  return Number((MAX_TARGET * 1n) / target);
}

function difficultyToTarget(difficulty) {
  if (difficulty <= 0) return MAX_TARGET;
  const target = MAX_TARGET / BigInt(Math.floor(difficulty));
  return target > MAX_TARGET ? MAX_TARGET : (target < MIN_TARGET ? MIN_TARGET : target);
}

function hashHeader(prevHash, nonce, timestamp, minerName) {
  const headerData = prevHash + nonce.toString().padStart(20, '0') + timestamp + minerName;
  return crypto.createHash('sha256').update(headerData).digest('hex');
}

function verifyProofOfWork(hash, target) {
  const hashBig = BigInt('0x' + hash);
  return hashBig <= target;
}

// ═══════════════════════════════════════════════════
// DIFFICULTY ADJUSTMENT
// ═══════════════════════════════════════════════════

function adjustDifficulty() {
  if (blockTimes.length < DIFFICULTY_ADJUSTMENT_BLOCKS) return;
  
  const recentTimes = blockTimes.slice(-DIFFICULTY_ADJUSTMENT_BLOCKS);
  const totalTime = recentTimes.reduce((a, b) => a + b, 0);
  const actualTime = totalTime / 1000; // ms to seconds
  const expectedTime = BLOCK_TIME_TARGET * DIFFICULTY_ADJUSTMENT_BLOCKS;
  
  const ratio = expectedTime / actualTime;
  const newTarget = BigInt(Number(currentTarget) * ratio);
  
  currentTarget = newTarget > MAX_TARGET ? MAX_TARGET : (newTarget < MIN_TARGET ? MIN_TARGET : newTarget);
  const newDiff = targetToDifficulty(currentTarget).toFixed(2);
  
  console.log(`📊 Difficulty adjusted: ${newDiff} (avg block time: ${(actualTime / DIFFICULTY_ADJUSTMENT_BLOCKS).toFixed(1)}s)`);
}

// ═══════════════════════════════════════════════════
// BLOCK CREATION & MINING
// ═══════════════════════════════════════════════════

function getLatestBlock() {
  const row = sqlite.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get();
  return row || null;
}

function createBlock(minerName, nonce) {
  const latest = getLatestBlock();
  const prevHash = latest ? latest.hash : '0'.repeat(64);
  const timestamp = Date.now();
  const hash = hashHeader(prevHash, nonce, timestamp, minerName);
  
  if (!verifyProofOfWork(hash, currentTarget)) {
    return { error: 'Invalid PoW', hash, target: currentTarget.toString(16) };
  }
  
  const newHeight = (latest ? latest.height : 0) + 1;
  const difficulty = targetToDifficulty(currentTarget);
  const reward = BASE_BLOCK_REWARD * Math.log(1 + difficulty);
  
  sqlite.prepare(`
    INSERT INTO blocks (hash, height, timestamp, miner, nonce, target_hex, prev_hash, difficulty, reward)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(hash, newHeight, timestamp, minerName, nonce, currentTarget.toString(16), prevHash, difficulty, reward);
  
  const blockTime = timestamp - lastBlockTime;
  blockTimes.push(blockTime);
  if (blockTimes.length > DIFFICULTY_ADJUSTMENT_BLOCKS * 2) blockTimes.shift();
  
  lastBlockTime = timestamp;
  currentHeight = newHeight;
  
  if (currentHeight - lastAdjustmentHeight >= DIFFICULTY_ADJUSTMENT_BLOCKS) {
    adjustDifficulty();
    lastAdjustmentHeight = currentHeight;
  }
  
  db.updateBalance(minerName, reward);
  sqlite.prepare('INSERT INTO blocks_mined (username, bounty_id, reward) VALUES (?, ?, ?)')
    .run(minerName, hash, reward);
  
  console.log(`⛏️  Block #${newHeight} mined by ${minerName} | Hash: ${hash.substring(0, 16)}... | Diff: ${difficulty.toFixed(2)} | Reward: ${reward.toFixed(4)} CC`);
  
  return { hash, height: newHeight, reward };
}

// ═══════════════════════════════════════════════════
// MINING JOBS
// ═══════════════════════════════════════════════════

function getMiningJob(minerName) {
  const latest = getLatestBlock();
  const prevHash = latest ? latest.hash : '0'.repeat(64);
  
  return {
    prev_hash: prevHash,
    height: (latest ? latest.height : 0) + 1,
    target_hex: currentTarget.toString(16),
    difficulty: Number(targetToDifficulty(currentTarget).toFixed(2)),
    timestamp: Date.now(),
    miner_name: minerName
  };
}

function submitWork(minerName, nonce) {
  const block = createBlock(minerName, nonce);
  if (block.error) {
    return { status: 'rejected', error: block.error };
  }
  return { status: 'accepted', block };
}

// ═══════════════════════════════════════════════════
// MEMPOOL
// ═══════════════════════════════════════════════════

function addToMempool(from, to, amount) {
  if (sqlite.prepare('SELECT COUNT(*) as c FROM mempool').get().c >= MEMPOOL_MAX_SIZE) {
    return { error: 'Mempool full' };
  }
  const txId = crypto.randomBytes(16).toString('hex');
  sqlite.prepare(`
    INSERT INTO mempool (id, from_user, to_user, amount, timestamp, added_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(txId, from, to, amount, Date.now(), Date.now());
  return { tx_id: txId };
}

function getMempool() {
  return sqlite.prepare('SELECT id, from_user, to_user, amount FROM mempool ORDER BY timestamp DESC LIMIT 100').all();
}

function clearMempool() {
  sqlite.prepare('DELETE FROM mempool').run();
}

// ═══════════════════════════════════════════════════
// BLOCKCHAIN INFO
// ═══════════════════════════════════════════════════

function getBlockchainInfo() {
  const latest = getLatestBlock();
  return {
    height: currentHeight,
    hash: latest ? latest.hash : null,
    difficulty: Number(targetToDifficulty(currentTarget).toFixed(2)),
    target: currentTarget.toString(16),
    block_time_target: BLOCK_TIME_TARGET,
    avg_block_time: blockTimes.length > 0 ? (blockTimes.reduce((a, b) => a + b, 0) / blockTimes.length / 1000).toFixed(1) : 'N/A'
  };
}

function getBlock(heightOrHash) {
  const isHeight = /^\d+$/.test(heightOrHash);
  const query = isHeight 
    ? 'SELECT * FROM blocks WHERE height = ?'
    : 'SELECT * FROM blocks WHERE hash = ?';
  return sqlite.prepare(query).get(heightOrHash);
}

function getBlocks(limit = 50, offset = 0) {
  return sqlite.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT ? OFFSET ?').all(limit, offset);
}

// ═══════════════════════════════════════════════════
// BACKWARD COMPATIBILITY - OLD MINER SUPPORT
// ═══════════════════════════════════════════════════

const jobAssignTime = new Map();

function startAutoBounty() {
  console.log(`🤖 Auto-bounty started (PoW mode)`);
}

function startPoSMinting() {
  console.log(`🏦 PoS minting started`);
}

function checkAndRefillBounties() {
  // No-op in new PoW system
}

function getCurrentValidator() {
  return null; // No PoS in real PoW mode
}

function getActiveBounties() {
  const rows = sqlite.prepare(`
    SELECT id, difficulty, reward, target_hex, hash as last_hash
    FROM blocks ORDER BY height DESC LIMIT 50
  `).all();
  const result = {};
  rows.forEach(r => {
    result[r.id] = {
      id: r.id,
      difficulty: r.difficulty,
      reward: r.reward,
      target_hex: r.target_hex,
      last_hash: r.last_hash
    };
  });
  return result;
}

function getJob(bountyId) {
  const block = sqlite.prepare('SELECT * FROM blocks WHERE id = ?').get(bountyId);
  if (!block) return null;
  return {
    last_hash: block.hash,
    target_hex: block.target_hex,
    difficulty: block.difficulty,
    bounty_id: block.id,
    reward: block.reward
  };
}

function getJobForWorker(workerName) {
  const latest = getLatestBlock();
  const prevHash = latest ? latest.hash : '0'.repeat(64);
  const difficulty = targetToDifficulty(currentTarget);
  const reward = BASE_BLOCK_REWARD * Math.log(1 + difficulty);
  
  jobAssignTime.set(workerName, Date.now());
  return {
    last_hash: prevHash,
    target_hex: currentTarget.toString(16),
    difficulty: difficulty,
    bounty_id: 'job_' + crypto.randomBytes(6).toString('hex'),
    reward: reward
  };
}

function submitSolution(bountyId, nonce, workerName, deviceType) {
  const latest = getLatestBlock();
  const prevHash = latest ? latest.hash : '0'.repeat(64);
  const timestamp = Date.now();
  const hash = hashHeader(prevHash, nonce, timestamp, workerName);
  
  if (!verifyProofOfWork(hash, currentTarget)) {
    return { status: 'error', reason: `Invalid nonce: hash ${hash.substring(0, 12)}... >= target` };
  }
  
  const result = createBlock(workerName, nonce);
  if (result.error) {
    return { status: 'error', reason: result.error };
  }
  
  return { status: 'success', message: `Block solved! You earned ${result.reward} CC.`, reward: result.reward };
}

// ═══════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════
module.exports = {
  getMiningJob,
  submitWork,
  getBlockchainInfo,
  getBlock,
  getBlocks,
  addToMempool,
  getMempool,
  clearMempool,
  getCurrentDifficulty: () => targetToDifficulty(currentTarget).toFixed(2),
  getCurrentHeight: () => currentHeight,
  getCurrentTarget: () => currentTarget.toString(16),
  getActiveBounties,
  getJob,
  getJobForWorker,
  submitSolution,
  startAutoBounty,
  startPoSMinting,
  checkAndRefillBounties,
  getCurrentValidator
};
