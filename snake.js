// snake.js – Đã sửa lỗi ép lowercase
const db = require('./db');

const REWARD_NORMAL = 0.5;
const REWARD_HARDCORE = 2.0;
const COOLDOWN_MS = 15 * 60 * 1000; // 15 phút

function processClaim(username, pin, apples, mode) {
  // KHÔNG ép lowercase – giữ nguyên username từ client
  // username = username.trim().toLowerCase(); // ĐÃ XÓA

  // Kiểm tra cooldown
  const lastClaim = db.getLastSnakeClaim(username);
  if (lastClaim) {
    let lastTime = new Date(lastClaim.claimed_at);
    if (!lastClaim.claimed_at.includes('Z') && !lastClaim.claimed_at.includes('+')) {
      lastTime = new Date(lastClaim.claimed_at + 'Z');
    }
    const elapsed = Date.now() - lastTime.getTime();
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000 / 60);
      throw new Error(`Cooldown active. Wait ${remaining} minutes.`);
    }
  }

  const rate = mode === 'hardcore' ? REWARD_HARDCORE : REWARD_NORMAL;
  const reward = parseFloat((apples * rate).toFixed(4));

  db.updateBalance(username, reward);
  db.insertSnakeClaim(username, apples, mode || 'normal', reward);

  return {
    status: 'success',
    message: `Claimed ${reward} CC from ${apples} apples (${mode || 'normal'})`,
    reward: reward,
    new_balance: db.getUser(username).balance
  };
}

function getCooldown(username) {
  // KHÔNG ép lowercase
  const lastClaim = db.getLastSnakeClaim(username);
  if (!lastClaim) return { cooldown: false };
  
  let lastTime = new Date(lastClaim.claimed_at);
  if (!lastClaim.claimed_at.includes('Z') && !lastClaim.claimed_at.includes('+')) {
    lastTime = new Date(lastClaim.claimed_at + 'Z');
  }
  
  const elapsed = Date.now() - lastTime.getTime();
  const remaining = COOLDOWN_MS - elapsed;

  return {
    cooldown: remaining > 0,
    remaining_ms: remaining > 0 ? remaining : 0,
    remaining_minutes: remaining > 0 ? Math.ceil(remaining / 60000) : 0
  };
}

module.exports = { processClaim, getCooldown };
