// snake.js – Xử lý claim thưởng từ game rắn
// Cooldown 15 phút, username lowercase, không cần PIN (đã có token)
const db = require('./db');

const REWARD_NORMAL   = 0.5;    // CC mỗi apple – normal mode
const REWARD_HARDCORE = 2.0;    // CC mỗi apple – hardcore mode
const COOLDOWN_MS     = 15 * 60 * 1000; // 15 phút

/**
 * Xử lý yêu cầu claim thưởng
 * @param {string} username - Tên người chơi (đã qua token)
 * @param {string|null} pin - Không dùng nữa, giữ để tương thích
 * @param {number} apples - Số táo ăn được
 * @param {string} mode - 'normal' hoặc 'hardcore'
 * @returns {object} Kết quả claim
 */
function processClaim(username, pin, apples, mode) {
  // Chuẩn hóa username (chữ thường, bỏ khoảng trắng)
  username = username.trim().toLowerCase();

  // Kiểm tra cooldown
  const lastClaim = db.getLastSnakeClaim(username);
  if (lastClaim && lastClaim.claimed_at) {
    let lastTime = new Date(lastClaim.claimed_at);
    // Nếu chuỗi datetime từ SQLite không có 'Z' hoặc offset, coi như UTC
    if (!lastClaim.claimed_at.includes('Z') && !lastClaim.claimed_at.includes('+')) {
      lastTime = new Date(lastClaim.claimed_at + 'Z');
    }
    const elapsed = Date.now() - lastTime.getTime();
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000 / 60);
      throw new Error(`Cooldown active. Wait ${remaining} minutes.`);
    }
  }

  // Tính thưởng
  const rate = (mode === 'hardcore') ? REWARD_HARDCORE : REWARD_NORMAL;
  const reward = parseFloat((apples * rate).toFixed(4));

  // Cập nhật số dư
  db.updateBalance(username, reward);

  // Ghi lại lịch sử claim
  db.insertSnakeClaim(username, apples, mode || 'normal', reward);

  // Lấy số dư mới nhất
  const user = db.getUser(username);
  return {
    status: 'success',
    message: `Claimed ${reward} CC from ${apples} apples (${mode || 'normal'})`,
    reward: reward,
    new_balance: user ? user.balance : null
  };
}

/**
 * Lấy thông tin cooldown của người dùng
 * @param {string} username 
 * @returns {object} { cooldown, remaining_ms, remaining_minutes }
 */
function getCooldown(username) {
  username = username.trim().toLowerCase();
  const lastClaim = db.getLastSnakeClaim(username);
  if (!lastClaim || !lastClaim.claimed_at) {
    return { cooldown: false };
  }

  let lastTime = new Date(lastClaim.claimed_at);
  if (!lastClaim.claimed_at.includes('Z') && !lastClaim.claimed_at.includes('+')) {
    lastTime = new Date(lastClaim.claimed_at + 'Z');
  }
  const elapsed = Date.now() - lastTime.getTime();
  const remaining = COOLDOWN_MS - elapsed;

  if (remaining <= 0) {
    return { cooldown: false };
  }
  return {
    cooldown: true,
    remaining_ms: remaining,
    remaining_minutes: Math.ceil(remaining / 60000)
  };
}

module.exports = { processClaim, getCooldown };
