// blockchain.js
const crypto = require('crypto');
const db = require('./db');

// Tạo bounty mới: trừ 8 CC của creator, 7 CC bị đốt, 1 CC giữ cho miner
function createBounty(username, pin, difficulty, reward, targetDevice) {
  username = username.toLowerCase().trim();
  const user = db.getUser(username);
  if (!user) throw new Error('User not found');
  // Kiểm tra pin
  const auth = db.authenticate(username, pin); // sẽ throw nếu sai, nhưng ta chỉ cần check
  // tính cost = 8 CC (theo tỉ lệ 8:1)
  const cost = 8.0;
  if (user.balance < cost) throw new Error('Insufficient balance (need 8 CC)');
  // Tạo id bounty ngẫu nhiên
  const bountyId = crypto.randomBytes(8).toString('hex');
  const difficultyBits = parseInt(difficulty);
  // tạo binary_target: difficultyBits số '0' đầu
  const binaryTarget = '0'.repeat(difficultyBits);
  // last_hash giả lập (có thể là hash của block trước)
  const lastHash = crypto.randomBytes(32).toString('hex');
  // Trừ tiền creator
  db.updateBalance(username, -cost);
  // Lưu bounty
  db.db.prepare(`INSERT INTO bounties (id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`).run(
      bountyId, username, targetDevice, difficultyBits, reward, cost, binaryTarget, lastHash
    );
  // 7 CC bị đốt (không cần làm gì thêm, chỉ là khái niệm)
  return { status: 'success', bounty_id: bountyId, message: 'Bounty created. 8 CC deducted (1 CC reward, 7 CC burned)' };
}

// Lấy danh sách bounty active
function getActiveBounties() {
  const rows = db.db.prepare(`SELECT id, creator_username, target_device, difficulty, reward, binary_target, last_hash FROM bounties WHERE status='active'`).all();
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

// Lấy job cho miner
function getJob(bountyId) {
  const bounty = db.db.prepare(`SELECT * FROM bounties WHERE id=? AND status='active'`).get(bountyId);
  if (!bounty) return null;
  return {
    last_hash: bounty.last_hash,
    target_bin: bounty.binary_target,
    difficulty_bits: bounty.difficulty,
    bounty_id: bounty.id
  };
}

// Kiểm tra nonce
function submitSolution(bountyId, nonce, workerName, deviceType) {
  const bounty = db.db.prepare(`SELECT * FROM bounties WHERE id=? AND status='active'`).get(bountyId);
  if (!bounty) throw new Error('Bounty not found or already solved');
  // Hash = SHA256(last_hash + nonce + worker_name)
  const input = bounty.last_hash + nonce + workerName;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  const binary = hexToBinary(hash);
  if (!binary.startsWith(bounty.binary_target)) {
    return { status: 'error', reason: 'Invalid nonce: hash does not meet target' };
  }
  // Đánh dấu đã giải
  db.db.prepare(`UPDATE bounties SET status='solved', nonce=?, solver_username=? WHERE id=?`).run(nonce, workerName, bountyId);
  // Thưởng 1 CC cho miner
  db.updateBalance(workerName, 1.0);
  // Ghi log
  db.db.prepare(`INSERT INTO blocks_mined (username, bounty_id, reward) VALUES (?, ?, 1.0)`).run(workerName, bountyId);
  return { status: 'success', message: 'Block solved! You earned 1 CC.' };
}

function hexToBinary(hex) {
  return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

module.exports = { createBounty, getActiveBounties, getJob, submitSolution };
