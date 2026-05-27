// snake.js – Full fix: dùng chung DB, có getCooldown, cooldown 15 phút
// KHÔNG còn xác thực PIN (đã có JWT token ở server)
const db = require('./db');

const REWARD_NORMAL = 0.5;
const REWARD_HARDCORE = 2.0;
const COOLDOWN_MS = 15 * 60 * 1000; // 15 phút

function processClaim(username, pin, apples, mode) {
  // ⚠️ Không còn authenticate (pin không được dùng nữa, giữ tham số để tương thích)
  // Xác thực đã được thực hiện bởi middleware token ở server.js
  username = username.trim();
  
  // Kiểm tra cooldown
  const lastClaim = db.getLastSnakeClaim(username);
  if (lastClaim) {
    // Xử lý chuỗi ngày tháng từ SQLite (dạng 'YYYY-MM-DD HH:MM:SS')
    let lastTime;
    if (lastClaim.claimed_at.includes('Z')) {
      lastTime = new Date(lastClaim.claimed_at).getTime();
    } else {
      lastTime = new Date(lastClaim.claimed_at + ' UTC').getTime();
    }
    const elapsed = Date.now() - lastTime;
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000 / 60);
      throw new Error(`Cooldown active. Wait ${remaining} minutes.`);
    }
  }

  const rate = mode === 'hardcore' ? REWARD_HARDCORE : REWARD_NORMAL;
  const reward = parseFloat((apples * rate).toFixed(4));

  db.updateBalance(username, reward);
  db.insertSnakeClaim(username, apples, mode, reward);

  return {
    status: 'success',
    message: `Claimed ${reward} CC from ${apples} apples (${mode || 'normal'})`,
    reward: reward,
    new_balance: db.getUser(username).balance
  };
}

function getCooldown(username) {
  username = username.trim();
  const lastClaim = db.getLastSnakeClaim(username);
  if (!lastClaim) return { cooldown: false };

  let lastTime;
  if (lastClaim.claimed_at.includes('Z')) {
    lastTime = new Date(lastClaim.claimed_at).getTime();
  } else {
    lastTime = new Date(lastClaim.claimed_at + ' UTC').getTime();
  }
  const elapsed = Date.now() - lastTime;
  const remaining = COOLDOWN_MS - elapsed;

  return {
    cooldown: remaining > 0,
    remaining_ms: remaining > 0 ? remaining : 0,
    remaining_minutes: remaining > 0 ? Math.ceil(remaining / 60000) : 0
  };
}

module.exports = { processClaim, getCooldown };
