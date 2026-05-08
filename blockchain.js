// blockchain.js - PoW + PoS hybrid (cleaned + no expiry)
const crypto = require('crypto');
const db = require('./db');

// Kết nối DB nội bộ
const Database = require('better-sqlite3');
const path = require('path');
const sqlite = new Database(path.join(__dirname, 'chocohub.db'));
sqlite.pragma('journal_mode = WAL');

// ═══════════════════════════════════════════════════
// AUTO-BOUNTY: Server tạo block miễn phí (PoW)
// ═══════════════════════════════════════════════════
const AUTO_BOUNTY_MIN = 0.0001;
const AUTO_BOUNTY_MAX = 0.01;
const MIN_ACTIVE_BOUNTIES = 30;
const AUTO_BOUNTY_INTERVAL = 1000; // 1 giây
const AUTO_DIFFICULTIES = [8, 10, 12, 14, 16];

function createAutoBounty() {
  const difficulty = AUTO_DIFFICULTIES[Math.floor(Math.random() * AUTO_DIFFICULTIES.length)];
  const reward = parseFloat((AUTO_BOUNTY_MIN + Math.random() * (AUTO_BOUNTY_MAX - AUTO_BOUNTY_MIN)).toFixed(3));
  
  const bountyId = 'auto_' + crypto.randomBytes(6).toString('hex');
  const binaryTarget = '0'.repeat(difficulty);
  const lastHash = crypto.randomBytes(32).toString('hex');
  
  sqlite.prepare(`
    INSERT INTO bounties (id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, status)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active')
  `).run(bountyId, 'server', 'all', difficulty, reward, binaryTarget, lastHash);
  
  console.log(`🤖 Auto-bounty: #${bountyId.substring(0,12)} | ${difficulty}bits | ${reward} CC`);
}

function checkAndRefillBounties() {
  try {
    const activeCount = sqlite.prepare(
      'SELECT COUNT(*) as count FROM bounties WHERE status=?'
    ).get('active').count;
    
    if (activeCount < MIN_ACTIVE_BOUNTIES) {
      const needed = MIN_ACTIVE_BOUNTIES - activeCount;
      for (let i = 0; i < needed; i++) {
        createAutoBounty();
      }
      console.log(`📊 Bounties refilled: ${activeCount} → ${MIN_ACTIVE_BOUNTIES}`);
    }

    // 🟢 KHÔNG xóa block cũ – không bao giờ hết hạn
    
  } catch (e) {
    console.error('Auto-bounty error:', e.message);
  }
}

function startAutoBounty() {
  checkAndRefillBounties();
  setInterval(checkAndRefillBounties, AUTO_BOUNTY_INTERVAL);
  console.log(`🤖 Auto-bounty started (${AUTO_BOUNTY_MIN}-${AUTO_BOUNTY_MAX} CC, min ${MIN_ACTIVE_BOUNTIES} blocks, no expiry)`);
}

// ═══════════════════════════════════════════════════
// PROOF OF STAKE (PoS) MINTING
// ═══════════════════════════════════════════════════
const POS_BLOCK_INTERVAL = 30000; // 30 giây
const MIN_STAKE = 10;
const POS_BLOCK_REWARD = 0.1; // Thưởng cố định

let currentValidator = null; // 🟢 Lưu validator vừa được chọn

function selectValidator() {
  const validators = db.getValidators(MIN_STAKE);
  if (validators.length === 0) return null;
  
  // Chọn validator dựa trên tỷ lệ stake (xác suất tỷ lệ)
  const totalStake = validators.reduce((sum, v) => sum + v.amount, 0);
  let random = Math.random() * totalStake;
  for (const v of validators) {
    random -= v.amount;
    if (random <= 0) return v;
  }
  // fallback
  return validators[0];
}

function mintPoSBlock() {
  const validator = selectValidator();
  if (!validator) {
    console.log('🔒 No validator available for PoS block');
    currentValidator = null; // Không có ai
    return;
  }
  
  const reward = POS_BLOCK_REWARD;
  
  // Ghi nhận block (dùng chung bảng blocks_mined)
  const blockId = 'pos_' + crypto.randomBytes(6).toString('hex');
  sqlite.prepare('INSERT INTO blocks_mined (username, bounty_id, reward) VALUES (?, ?, ?)')
    .run(validator.username, blockId, reward);
  
  // Cộng pending reward vào stake
  db.addStakeReward(validator.username, reward);
  
  // 🟢 Cập nhật validator hiện tại
  currentValidator = validator.username;
  
  console.log(`🏦 PoS Block forged by ${validator.username} | +${reward} CC | Stake: ${validator.amount} CC`);
}

function getCurrentValidator() {
  return currentValidator;
}

function startPoSMinting() {
  mintPoSBlock(); // chạy ngay lần đầu
  setInterval(mintPoSBlock, POS_BLOCK_INTERVAL);
  console.log(`🏦 PoS minting started (block every ${POS_BLOCK_INTERVAL/1000}s, reward ${POS_BLOCK_REWARD} CC)`);
}

// ═══════════════════════════════════════════════════
// BOUNTY MANAGEMENT (PoW) – đã xóa createBounty
// ═══════════════════════════════════════════════════

function getActiveBounties() {
  const rows = sqlite.prepare(
    'SELECT id, creator_username, target_device, difficulty, reward, binary_target, last_hash FROM bounties WHERE status=? ORDER BY created_at DESC'
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

  // Verify hash
  const input = bounty.last_hash + nonce + workerName;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  const binary = hexToBinary(hash);

  if (!binary.startsWith(bounty.binary_target)) {
    return { 
      status: 'error', 
      reason: `Invalid nonce: hash ${binary.substring(0, 12)}... does not meet target` 
    };
  }

  // Đánh dấu đã giải
  sqlite.prepare('UPDATE bounties SET status=?, nonce=?, solver_username=? WHERE id=?')
    .run('solved', String(nonce), workerName, bountyId);

  // Thưởng miner theo reward của bounty
  const reward = bounty.reward || 1.0;
  db.updateBalance(workerName, reward);

  // Log block đã đào
  sqlite.prepare('INSERT INTO blocks_mined (username, bounty_id, reward) VALUES (?, ?, ?)')
    .run(workerName, bountyId, reward);

  return { 
    status: 'success', 
    message: `Block solved! You earned ${reward} CC.`,
    reward: reward
  };
}

function hexToBinary(hex) {
  return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

module.exports = { 
  getActiveBounties, 
  getJob, 
  submitSolution,
  startAutoBounty,
  checkAndRefillBounties,
  // PoS exports
  startPoSMinting,
  mintPoSBlock,
  getCurrentValidator
};
