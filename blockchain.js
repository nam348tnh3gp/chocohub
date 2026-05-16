// blockchain.js - PoW + PoS hybrid (cleaned + no expiry + auto cleanup + dynamic difficulty)
const crypto = require('crypto');
const db = require('./db');

// Kết nối DB nội bộ
const Database = require('better-sqlite3');
const path = require('path');
const sqlite = new Database(path.join(__dirname, 'chocohub.db'));
sqlite.pragma('journal_mode = WAL');

// ═══════════════════════════════════════════════════
// CẤU HÌNH ĐỘ KHÓ TỰ ĐỘNG (Dynamic Difficulty)
// ═══════════════════════════════════════════════════
const BLOCK_TIME_TARGET = 30;           // Thời gian mục tiêu giữa 2 block PoW (giây)
const DIFFICULTY_ADJUST_INTERVAL = 5;   // Số block giải được trước khi điều chỉnh độ khó
const MIN_DIFFICULTY = 4;              // Độ khó thấp nhất (bits)
const MAX_DIFFICULTY = 20;             // Độ khó cao nhất (bits)
const MAX_DIFFICULTY_CHANGE = 0.5;     // Tối đa thay đổi 50% mỗi lần điều chỉnh

let currentDifficulty = 10;             // Độ khó khởi điểm
let blockSolveCount = 0;
let recentBlockTimes = [];              // Lưu thời gian (giây) của các block gần đây
let lastBlockTimestamp = Date.now();    // Thời điểm block cuối cùng được giải

// ═══════════════════════════════════════════════════
// AUTO-BOUNTY: Server tạo block miễn phí (PoW)
// ═══════════════════════════════════════════════════
const AUTO_BOUNTY_MIN = 0.0001;
const AUTO_BOUNTY_MAX = 0.01;
const MIN_ACTIVE_BOUNTIES = 30;
const MAX_ACTIVE_BOUNTIES = 100;
const AUTO_BOUNTY_INTERVAL = 1000;        // 1 giây

function createAutoBounty() {
  // Sử dụng độ khó động với một chút ngẫu nhiên ±2 để đa dạng
  const variation = Math.floor(Math.random() * 5) - 2; // -2..+2
  let difficulty = currentDifficulty + variation;
  difficulty = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, difficulty));
  
  const reward = parseFloat((AUTO_BOUNTY_MIN + Math.random() * (AUTO_BOUNTY_MAX - AUTO_BOUNTY_MIN)).toFixed(3));
  
  const bountyId = 'auto_' + crypto.randomBytes(6).toString('hex');
  const binaryTarget = '0'.repeat(difficulty);
  const lastHash = crypto.randomBytes(32).toString('hex');
  
  sqlite.prepare(`
    INSERT INTO bounties (id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, status)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active')
  `).run(bountyId, 'server', 'all', difficulty, reward, binaryTarget, lastHash);
  
  // console.log(`🤖 Auto-bounty: #${bountyId.substring(0,12)} | ${difficulty}bits | ${reward} CC`);
}

// 🆕 Dọn dẹp bounty cũ nếu vượt quá MAX_ACTIVE_BOUNTIES
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
// CƠ CHẾ TỰ ĐỘNG ĐIỀU CHỈNH ĐỘ KHÓ (Dynamic Difficulty)
// ═══════════════════════════════════════════════════
function adjustDifficulty() {
  const now = Date.now();
  const timeSinceLastBlock = (now - lastBlockTimestamp) / 1000; // giây
  lastBlockTimestamp = now;

  // Bỏ qua nếu thời gian bất thường (có thể server vừa khởi động)
  if (timeSinceLastBlock > 3600) {
    // Nếu hơn 1 giờ, coi như bắt đầu lại
    recentBlockTimes = [];
    blockSolveCount = 0;
    return;
  }

  blockSolveCount++;
  recentBlockTimes.push(timeSinceLastBlock);

  // Chỉ điều chỉnh sau khi đủ số block quy định
  if (blockSolveCount < DIFFICULTY_ADJUST_INTERVAL) return;

  // Tính thời gian trung bình
  const avgTime = recentBlockTimes.reduce((a, b) => a + b, 0) / recentBlockTimes.length;

  // Công thức điều chỉnh: Difficulty mới = Difficulty hiện tại * (Thời gian mục tiêu / Thời gian thực tế)
  let newDifficulty = currentDifficulty * (BLOCK_TIME_TARGET / avgTime);

  // Giới hạn mức thay đổi không quá MAX_DIFFICULTY_CHANGE (50%)
  const minChange = currentDifficulty * (1 - MAX_DIFFICULTY_CHANGE);
  const maxChange = currentDifficulty * (1 + MAX_DIFFICULTY_CHANGE);
  newDifficulty = Math.max(minChange, Math.min(maxChange, newDifficulty));

  // Làm tròn và giới hạn trong khoảng cho phép
  newDifficulty = Math.round(newDifficulty);
  newDifficulty = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, newDifficulty));

  if (newDifficulty !== currentDifficulty) {
    console.log(`⛏️  Difficulty adjusted: ${currentDifficulty} → ${newDifficulty} bits (avg time: ${avgTime.toFixed(1)}s, target: ${BLOCK_TIME_TARGET}s, samples: ${recentBlockTimes.length})`);
    currentDifficulty = newDifficulty;
  }

  // Reset bộ đếm
  blockSolveCount = 0;
  recentBlockTimes = [];
}

// ═══════════════════════════════════════════════════
// BOUNTY MANAGEMENT (PoW)
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

function submitSolution(bountyId, nonce, workerName, deviceType) {
  const bounty = sqlite.prepare(
    'SELECT * FROM bounties WHERE id=? AND status=?'
  ).get(bountyId, 'active');

  if (!bounty) throw new Error('Bounty not found or already solved');

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

  // 🆕 Điều chỉnh độ khó sau mỗi block được giải
  adjustDifficulty();

  // 🆕 Dọn dẹp sau mỗi block được giải
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

// 🆕 Xuất thêm biến currentDifficulty để dashboard có thể hiển thị
module.exports = { 
  getActiveBounties, 
  getJob, 
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
