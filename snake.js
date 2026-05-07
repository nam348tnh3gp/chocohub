// snake.js
const db = require('./db');

const REWARD_NORMAL = 0.5;
const REWARD_HARDCORE = 2.0;
const COOLDOWN_MS = 60 * 60 * 1000; // 1 giờ

function processClaim(username, pin, apples, mode) {
  username = username.toLowerCase().trim();
  
  // Verify credentials
  db.authenticate(username, pin);
  
  // Check cooldown
  const lastClaim = db.db.prepare(
    'SELECT claimed_at FROM snake_claims WHERE username=? ORDER BY claimed_at DESC LIMIT 1'
  ).get(username);
  
  if (lastClaim) {
    const lastTime = new Date(lastClaim.claimed_at + 'Z').getTime();
    const elapsed = Date.now() - lastTime;
    if (elapsed < COOLDOWN_MS) {
      const remaining = Math.ceil((COOLDOWN_MS - elapsed) / 1000 / 60);
      throw new Error(`Cooldown active. Wait ${remaining} minutes.`);
    }
  }
  
  // Calculate reward
  const rate = mode === 'hardcore' ? REWARD_HARDCORE : REWARD_NORMAL;
  const reward = parseFloat((apples * rate).toFixed(4));
  
  // Update balance
  db.updateBalance(username, reward);
  
  // Log claim
  db.db.prepare('INSERT INTO snake_claims (username, apples, mode, reward) VALUES (?, ?, ?, ?)')
    .run(username, apples, mode, reward);
  
  return {
    status: 'success',
    message: `Claimed ${reward} CC from ${apples} apples (${mode})`,
    reward: reward,
    new_balance: db.getUser(username).balance
  };
}

module.exports = { processClaim };
