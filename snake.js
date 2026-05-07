// snake.js – Full fix: dùng chung DB, có getCooldown, cooldown 15 phút
const db = require('./db');

const REWARD_NORMAL = 0.5;
const REWARD_HARDCORE = 2.0;
const COOLDOWN_MS = 15 * 60 * 1000; // Đã sửa thành 15 phút

function processClaim(username, pin, apples, mode) {
  username = username.toLowerCase().trim();

  // Bỏ xác thực ở đây vì frontend đã làm rồi, nhưng vẫn nên giữ để kiểm tra lại
  db.authenticate(username, pin);

  // Kiểm tra cooldown (sử dụng hàm dùng chung)
  const lastClaim = db.getLastSnakeClaim(username);
  if (lastClaim) {
    const lastTime = new Date(lastClaim.claimed_at + 'Z').getTime();
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
  username = username.toLowerCase().trim();
  const lastClaim = db.getLastSnakeClaim(username);
  if (!lastClaim) return { cooldown: false };

  const elapsed = Date.now() - new Date(lastClaim.claimed_at + 'Z').getTime();
  const remaining = COOLDOWN_MS - elapsed;

  return {
    cooldown: remaining > 0,
    remaining_ms: remaining > 0 ? remaining : 0,
    remaining_minutes: remaining > 0 ? Math.ceil(remaining / 60000) : 0
  };
}

module.exports = { processClaim, getCooldown };
