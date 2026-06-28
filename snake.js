// snake.js – Validação total com game session + max reward + max apples
const db = require('./db');

const REWARD_NORMAL = 0.05;      // 0.05 CC / apple
const REWARD_HARDCORE = 0.1;     // 0.1 CC / apple
const COOLDOWN_MS = 15 * 60 * 1000; // 15 phút
const MAX_APPLES = 500;           // max apples por sessão
const MAX_REWARD = 50;            // max 50 CC por claim
const GAME_SESSION_TTL = 600;     // 10 minutos para completar o jogo

function processClaim(username, gameSessionId, apples, mode) {
  // Valida game session (prova de jogo)
  const session = db.getGameSession(gameSessionId);
  if (!session) {
    throw new Error('Invalid or missing game session');
  }
  if (session.username !== username) {
    throw new Error('Game session belongs to another user');
  }
  if (session.used) {
    throw new Error('Game session already used');
  }
  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at < now) {
    throw new Error('Game session expired');
  }

  // Valida apples
  if (typeof apples !== 'number' || !Number.isFinite(apples) || apples < 0 || apples > MAX_APPLES) {
    throw new Error(`Invalid apples count (max ${MAX_APPLES})`);
  }

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
  const rawReward = parseFloat((apples * rate).toFixed(4));
  const reward = Math.min(rawReward, MAX_REWARD);

  // Marca game session como usada
  db.consumeGameSession(gameSessionId);

  db.updateBalance(username, reward);
  db.insertSnakeClaim(username, apples, mode || 'normal', reward);

  return {
    status: 'success',
    message: `Claimed ${reward} CC from ${apples} apples (${mode || 'normal'})`,
    reward: reward,
    new_balance: db.getUser(username).balance
  };
}

function createGameSession(username) {
  const id = 'snake_' + Date.now() + '_' + require('crypto').randomBytes(8).toString('hex');
  const expiresAt = Math.floor(Date.now() / 1000) + GAME_SESSION_TTL;
  return db.createGameSession(id, username, expiresAt);
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

module.exports = { processClaim, getCooldown, createGameSession };
