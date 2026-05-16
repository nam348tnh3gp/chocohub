// blockchain.js - PoW + PoS hybrid + dynamic difficulty + per-worker job assignment
const crypto = require('crypto');
const db = require('./db');

const Database = require('better-sqlite3');
const path = require('path');
const sqlite = new Database(path.join(__dirname, 'chocohub.db'));
sqlite.pragma('journal_mode = WAL');

// Đảm bảo bảng bounties có cột worker_name (cho per-worker job)
try {
  sqlite.exec(`ALTER TABLE bounties ADD COLUMN worker_name TEXT DEFAULT NULL`);
} catch (e) {
  // Cột đã tồn tại hoặc lỗi khác, bỏ qua
}

// ═══════════════════════════════════════════════════
// CẤU HÌNH ĐỘ KHÓ TỰ ĐỘNG (Dynamic Difficulty)
// ═══════════════════════════════════════════════════
const BLOCK_TIME_TARGET = 30;           // Thời gian mục tiêu giữa 2 block PoW (giây)
const DIFFICULTY_ADJUST_INTERVAL = 5;   // Số block giải được trước khi điều chỉnh độ khó toàn mạng
const MIN_DIFFICULTY = 4;              // Độ khó thấp nhất (bits)
const MAX_DIFFICULTY = 20;             // Độ khó cao nhất (bits)
const MAX_DIFFICULTY_CHANGE = 0.5;     // Tối đa thay đổi 50% mỗi lần điều chỉnh

let currentDifficulty = 10;             // Độ khó khởi điểm
let blockSolveCount = 0;
let recentBlockTimes = [];              // Lưu thời gian (giây) của các block gần đây
let lastBlockTimestamp = Date.now();    // Thời điểm block cuối cùng được giải

// Map lưu thời điểm giao job cho từng worker (để tính thời gian giải)
const jobAssignTime = new Map(); // key: workerName, value: timestamp (ms)

// ═══════════════════════════════════════════════════
// AUTO-BOUNTY: Server tạo block miễn phí (PoW) – bounty chung (worker_name = NULL)
// ═══════════════════════════════════════════════════
const AUTO_BOUNTY_MIN = 0.0001;
const AUTO_BOUNTY_MAX = 0.01;
const MIN_ACTIVE_BOUNTIES = 30;
const MAX_ACTIVE_BOUNTIES = 100;
const AUTO_BOUNTY_INTERVAL = 1000;        // 1 giây

function createAutoBounty() {
  const variation = Math.floor(Math.random() * 5) - 2; // -2..+2
  let difficulty = currentDifficulty + variation;
  difficulty = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, difficulty));
  
  const reward = parseFloat((AUTO_BOUNTY_MIN + Math.random() * (AUTO_BOUNTY_MAX - AUTO_BOUNTY_MIN)).toFixed(3));
  
  const bountyId = 'auto_' + crypto.randomBytes(6).toString('hex');
  const binaryTarget = '0'.repeat(difficulty);
  const lastHash = crypto.randomBytes(32).toString('hex');
  
  sqlite.prepare(`
    INSERT INTO bounties (id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, status, worker_name)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active', NULL)
  `).run(bountyId, 'server', 'all', difficulty, reward, binaryTarget, lastHash);
  
  // console.log(`🤖 Auto-bounty: #${bountyId.substring(0,12)} | ${difficulty}bits | ${reward} CC`);
}

function cleanupOldBounties() {
  try {
    const activeCount = sqlite.prepare(
      'SELECT COUNT(*) as count FROM bounties WHERE status=?'
    ).get('active').count;
    
    if (activeCount > MAX_ACTIVE_BOUNTIES) {
      const toDelete = activeCount - MAX_ACTIVE_BOUNTIES;
      sqlite.prepare(`
        DELETE FROM bounties WHERE id IN (
          SELECT id FROM bounties WHERE status = 'active'
          ORDER BY created_at ASC LIMIT ?
        )
      `).run(toDelete);
      console.log(`🧹 Cleaned up ${toDelete} old bounties (${activeCount} → ${MAX_ACTIVE_BOUNTIES})`);
    }
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

function checkAndRefillBounties() {
  try {
    cleanupOldBounties();
    
    const activeCount = sqlite.prepare(
      'SELECT COUNT(*) as count FROM bounties WHERE status=?'
    ).get('active').count;
    
    if (activeCount < MIN_ACTIVE_BOUNTIES) {
      const needed = MIN_ACTIVE_BOUNTIES - activeCount;
      for (let i = 0; i < needed; i++) {
        createAutoBounty();
      }
      console.log(`📊 Bounties refilled: ${activeCount} → ${MIN_ACTIVE_BOUNTIES} (current difficulty: ${currentDifficulty} bits)`);
    }
    
  } catch (e) {
    console.error('Auto-bounty error:', e.message);
  }
}

function startAutoBounty() {
  checkAndRefillBounties();
  setInterval(checkAndRefillBounties, AUTO_BOUNTY_INTERVAL);
  console.log(`🤖 Auto-bounty started (${AUTO_BOUNTY_MIN}-${AUTO_BOUNTY_MAX} CC, min ${MIN_ACTIVE_BOUNTIES} max ${MAX_ACTIVE_BOUNTIES} blocks, dynamic difficulty)`);
}

// ═══════════════════════════════════════════════════
// PROOF OF STAKE (PoS) MINTING
// ═══════════════════════════════════════════════════
const POS_BLOCK_INTERVAL = 30000; // 30 giây
const MIN_STAKE = 10;
const POS_BLOCK_REWARD = 0.1;

let currentValidator = null;

function selectValidator() {
  const validators = db.getValidators(MIN_STAKE);
  if (validators.length === 0) return null;
  
  const totalStake = validators.reduce((sum, v) => sum + v.amount, 0);
  let random = Math.random() * totalStake;
  for (const v of validators) {
    random -= v.amount;
    if (random <= 0) return v;
  }
  return validators[0];
}

function mintPoSBlock() {
  const validator = selectValidator();
  if (!validator) {
    console.log('🔒 No validator available for PoS block');
    currentValidator = null;
    return;
  }
  
  const reward = POS_BLOCK_REWARD;
  
  const blockId = 'pos_' + crypto.randomBytes(6).toString('hex');
  sqlite.prepare('INSERT INTO blocks_mined (username, bounty_id, reward) VALUES (?, ?, ?)')
    .run(validator.username, blockId, reward);
  
  db.addStakeReward(validator.username, reward);
  
  currentValidator = validator.username;
  
  console.log(`🏦 PoS Block forged by ${validator.username} | +${reward} CC | Stake: ${validator.amount} CC`);
}

function getCurrentValidator() {
  return currentValidator;
}

function startPoSMinting() {
  mintPoSBlock();
  setInterval(mintPoSBlock, POS_BLOCK_INTERVAL);
  console.log(`🏦 PoS minting started (block every ${POS_BLOCK_INTERVAL/1000}s, reward ${POS_BLOCK_REWARD} CC)`);
}

// ═══════════════════════════════════════════════════
// CƠ CHẾ TỰ ĐỘNG ĐIỀU CHỈNH ĐỘ KHÓ TOÀN MẠNG (Global)
// ═══════════════════════════════════════════════════
function adjustDifficulty() {
  const now = Date.now();
  const timeSinceLastBlock = (now - lastBlockTimestamp) / 1000; // giây
  lastBlockTimestamp = now;

  if (timeSinceLastBlock > 3600) {
    recentBlockTimes = [];
    blockSolveCount = 0;
    return;
  }

  blockSolveCount++;
  recentBlockTimes.push(timeSinceLastBlock);

  if (blockSolveCount < DIFFICULTY_ADJUST_INTERVAL) return;

  const avgTime = recentBlockTimes.reduce((a, b) => a + b, 0) / recentBlockTimes.length;

  let newDifficulty = currentDifficulty * (BLOCK_TIME_TARGET / avgTime);

  const minChange = currentDifficulty * (1 - MAX_DIFFICULTY_CHANGE);
  const maxChange = currentDifficulty * (1 + MAX_DIFFICULTY_CHANGE);
  newDifficulty = Math.max(minChange, Math.min(maxChange, newDifficulty));

  newDifficulty = Math.round(newDifficulty);
  newDifficulty = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, newDifficulty));

  if (newDifficulty !== currentDifficulty) {
    console.log(`⛏️  Difficulty adjusted: ${currentDifficulty} → ${newDifficulty} bits (avg time: ${avgTime.toFixed(1)}s, target: ${BLOCK_TIME_TARGET}s, samples: ${recentBlockTimes.length})`);
    currentDifficulty = newDifficulty;
  }

  blockSolveCount = 0;
  recentBlockTimes = [];
}

// ═══════════════════════════════════════════════════
// PER-WORKER DIFFICULTY ADJUSTMENT
// ═══════════════════════════════════════════════════
function adjustWorkerDifficulty(workerName, solveTime) {
  const currentWorkerDiff = db.getWorkerDifficulty(workerName) || currentDifficulty;
  const targetTime = BLOCK_TIME_TARGET; // 30 giây mục tiêu

  let newDiff = currentWorkerDiff * (targetTime / solveTime);
  // Giới hạn thay đổi 50%
  newDiff = Math.max(currentWorkerDiff * 0.5, Math.min(currentWorkerDiff * 1.5, newDiff));
  newDiff = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, Math.round(newDiff)));

  db.setWorkerDifficulty(workerName, newDiff, Date.now());
  console.log(`👷 Worker ${workerName}: difficulty ${currentWorkerDiff} → ${newDiff} (solve time ${solveTime.toFixed(1)}s)`);
}

// ═══════════════════════════════════════════════════
// BOUNTY MANAGEMENT (PoW) + PER-WORKER JOB
// ═══════════════════════════════════════════════════

function getActiveBounties() {
  const rows = sqlite.prepare(
    'SELECT id, creator_username, target_device, difficulty, reward, binary_target, last_hash FROM bounties WHERE status=? ORDER BY created_at DESC LIMIT 50'
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

/**
 * Lấy hoặc tạo job phù hợp cho một worker cụ thể.
 * @param {string} workerName 
 * @returns {object|null} job data
 */
function getJobForWorker(workerName) {
  // 1. Tìm bounty riêng đang active của worker này
  let bounty = sqlite.prepare(
    "SELECT * FROM bounties WHERE worker_name = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
  ).get(workerName);

  if (!bounty) {
    // 2. Nếu chưa có, tạo bounty mới với difficulty phù hợp
    let difficulty = db.getWorkerDifficulty(workerName);
    if (!difficulty) {
      difficulty = currentDifficulty; // lần đầu dùng difficulty chung
    }

    const bountyId = 'wrk_' + crypto.randomBytes(6).toString('hex');
    const binaryTarget = '0'.repeat(difficulty);
    const lastHash = crypto.randomBytes(32).toString('hex');
    const reward = parseFloat((AUTO_BOUNTY_MIN + Math.random() * (AUTO_BOUNTY_MAX - AUTO_BOUNTY_MIN)).toFixed(3));

    sqlite.prepare(`
      INSERT INTO bounties (id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, status, worker_name)
      VALUES (?, 'server', 'all', ?, ?, 0, ?, ?, 'active', ?)
    `).run(bountyId, difficulty, reward, binaryTarget, lastHash, workerName);

    bounty = sqlite.prepare('SELECT * FROM bounties WHERE id = ?').get(bountyId);
  }

  // Ghi nhận thời điểm giao job để sau này tính thời gian giải
  jobAssignTime.set(workerName, Date.now());

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

  // Kiểm tra quyền: nếu bounty có worker_name thì phải khớp với workerName
  if (bounty.worker_name && bounty.worker_name !== workerName) {
    throw new Error('This bounty is assigned to another worker');
  }

  const input = bounty.last_hash + nonce + workerName;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  const binary = hexToBinary(hash);

  if (!binary.startsWith(bounty.binary_target)) {
    return { 
      status: 'error', 
      reason: `Invalid nonce: hash ${binary.substring(0, 12)}... does not meet target` 
    };
  }

  sqlite.prepare('UPDATE bounties SET status=?, nonce=?, solver_username=? WHERE id=?')
    .run('solved', String(nonce), workerName, bountyId);

  const reward = bounty.reward || 1.0;
  db.updateBalance(workerName, reward);

  sqlite.prepare('INSERT INTO blocks_mined (username, bounty_id, reward) VALUES (?, ?, ?)')
    .run(workerName, bountyId, reward);

  // Điều chỉnh difficulty toàn mạng
  adjustDifficulty();

  // Điều chỉnh difficulty riêng cho worker này
  const assignTime = jobAssignTime.get(workerName);
  if (assignTime) {
    const solveTime = (Date.now() - assignTime) / 1000; // giây
    adjustWorkerDifficulty(workerName, solveTime);
    jobAssignTime.delete(workerName);
  }

  // Dọn dẹp bounty cũ
  cleanupOldBounties();

  return { 
    status: 'success', 
    message: `Block solved! You earned ${reward} CC.`,
    reward: reward
  };
}

function hexToBinary(hex) {
  return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

// ─── Exports ─────────────────────────────────────
module.exports = { 
  getActiveBounties, 
  getJob,
  getJobForWorker,     // 🆕 Per-worker job
  submitSolution,
  startAutoBounty,
  checkAndRefillBounties,
  cleanupOldBounties,
  // PoS exports
  startPoSMinting,
  mintPoSBlock,
  getCurrentValidator,
  // Dynamic difficulty
  getCurrentDifficulty: () => currentDifficulty,
  adjustDifficulty
};
