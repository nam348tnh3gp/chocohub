// db.js – Full fix + PoS Staking + Leaderboard + Backup full snapshot + Transactions
// 🆕 Thêm bảng worker_difficulty cho per-worker dynamic difficulty
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const db = new Database(path.join(__dirname, 'chocohub.db'));
db.pragma('journal_mode = WAL');

// Helper: chuyển datetime từ SQLite (YYYY-MM-DD HH:MM:SS) sang ISO string (YYYY-MM-DDTHH:MM:SSZ)
function toISO(dateStr) {
    if (!dateStr) return null;
    // Nếu đã có Z hoặc + thì giữ nguyên
    if (dateStr.includes('Z') || dateStr.includes('+')) return dateStr;
    // Nếu đã ở dạng YYYY-MM-DDTHH:MM:SS (không Z) thì thêm Z
    if (dateStr.includes('T')) return dateStr + 'Z';
    // Dạng 'YYYY-MM-DD HH:MM:SS' -> replace space với T và thêm Z
    return dateStr.replace(' ', 'T') + 'Z';
}

// Khởi tạo bảng
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pin_hash TEXT NOT NULL,
    balance REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS bounties (
    id TEXT PRIMARY KEY,
    creator_username TEXT,
    target_device TEXT,
    difficulty INTEGER,
    reward REAL,
    cost REAL,
    binary_target TEXT,
    last_hash TEXT,
    nonce TEXT,
    solver_username TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS snake_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    apples INTEGER,
    mode TEXT,
    reward REAL,
    claimed_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS blocks_mined (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    bounty_id TEXT,
    reward REAL,
    mined_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS stakes (
    username TEXT PRIMARY KEY,
    amount REAL NOT NULL DEFAULT 0,
    pending_reward REAL NOT NULL DEFAULT 0,
    last_reward_block INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS pos_reward_pool (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance REAL NOT NULL DEFAULT 0,
    total_fees REAL NOT NULL DEFAULT 0,
    last_distribution_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sync_seq (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    seq INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO sync_seq (id, seq) VALUES (1, 0);
  INSERT OR IGNORE INTO pos_reward_pool (id, balance, total_fees, last_distribution_at) VALUES (1, 0, 0, datetime('now'));

  -- Bảng lưu lịch sử gửi/nhận CC
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_username TEXT NOT NULL,
    to_username TEXT NOT NULL,
    amount REAL NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- 🆕 Bảng lưu difficulty riêng cho từng worker
  CREATE TABLE IF NOT EXISTS worker_difficulty (
    worker_name TEXT PRIMARY KEY,
    difficulty REAL NOT NULL DEFAULT 10,
    last_solve_time INTEGER DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

console.log('✅ Database ready (better-sqlite3)');

// ─── Auth ─────────────────────────────────────────
function authenticate(username, pin) {
  username = username.trim();
  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    const hash = bcrypt.hashSync(pin, 10);
    db.prepare('INSERT INTO users (username, pin_hash, balance) VALUES (?, ?, 0)').run(username, hash);
    user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  } else {
    if (!bcrypt.compareSync(pin, user.pin_hash)) {
      throw new Error('Invalid PIN');
    }
  }
  const token = jwt.sign({ username: user.username }, process.env.JWT_SECRET || 'secret', { expiresIn: '24h' });
  return { status: 'success', message: user ? 'Authenticated' : 'Account created', token, balance: user.balance };
}

function getUser(username) {
  return db.prepare('SELECT username, balance FROM users WHERE username = ?').get(username.trim());
}

function updateBalance(username, amount) {
  db.prepare('UPDATE users SET balance = balance + ? WHERE username = ?').run(amount, username.trim());
}

// ─── Transactions ────────────────────────────────
function addTransaction(from_username, to_username, amount) {
  return db.prepare('INSERT INTO transactions (from_username, to_username, amount) VALUES (?, ?, ?)').run(from_username.trim(), to_username.trim(), amount);
}

function getTransactions(username, limit = 20) {
  const rows = db.prepare(`
    SELECT from_username, to_username, amount, created_at 
    FROM transactions 
    WHERE from_username = ? OR to_username = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(username.trim(), username.trim(), limit);
  // Chuyển đổi created_at sang ISO
  return rows.map(row => ({
    ...row,
    created_at: toISO(row.created_at)
  }));
}

// ─── Blocks & Miners ─────────────────────────────
function getRecentBlocks(limit = 10) {
  const rows = db.prepare('SELECT bounty_id as id, username, reward, mined_at FROM blocks_mined ORDER BY mined_at DESC LIMIT ?').all(limit);
  return rows.map(row => ({
    ...row,
    mined_at: toISO(row.mined_at)
  }));
}

function getActiveMiners(limit = 5) {
  return db.prepare('SELECT DISTINCT username, "web" as device FROM blocks_mined ORDER BY mined_at DESC LIMIT ?').all(limit);
}

// ─── Staking ─────────────────────────────────────
function getStake(username) {
  username = username.trim();
  let row = db.prepare('SELECT * FROM stakes WHERE username = ?').get(username);
  if (!row) {
    db.prepare('INSERT INTO stakes (username, amount, pending_reward) VALUES (?, 0, 0)').run(username);
    row = { username, amount: 0, pending_reward: 0 };
  }
  return row;
}

function stake(username, amount) {
  username = username.trim();
  const user = getUser(username);
  if (!user) throw new Error('User not found');
  if (user.balance < amount) throw new Error('Insufficient balance');
  updateBalance(username, -amount);
  db.prepare('UPDATE stakes SET amount = amount + ?, pending_reward = pending_reward WHERE username = ?').run(amount, username);
  return getStake(username);
}

function unstake(username) {
  username = username.trim();
  const current = getStake(username);
  if (current.amount <= 0) throw new Error('No stake to withdraw');
  const total = current.amount + (current.pending_reward || 0);
  updateBalance(username, total);
  db.prepare('UPDATE stakes SET amount = 0, pending_reward = 0 WHERE username = ?').run(username);
  return { amount: 0, pending_reward: 0 };
}

function getValidators(minStake = 10) {
  return db.prepare('SELECT username, amount FROM stakes WHERE amount >= ? ORDER BY amount DESC').all(minStake);
}

function addStakeReward(username, reward) {
  db.prepare('UPDATE stakes SET pending_reward = pending_reward + ? WHERE username = ?').run(reward, username.trim());
}

function getPosRewardPool() {
  const row = db.prepare('SELECT balance, total_fees, last_distribution_at FROM pos_reward_pool WHERE id = 1').get();
  return row || { balance: 0, total_fees: 0, last_distribution_at: null };
}

function addPosRewardPool(amount) {
  const fee = Number(amount) || 0;
  if (fee <= 0) return getPosRewardPool();
  db.prepare(`
    UPDATE pos_reward_pool
    SET balance = balance + ?,
        total_fees = total_fees + ?,
        last_distribution_at = datetime('now')
    WHERE id = 1
  `).run(fee, fee);
  return getPosRewardPool();
}

function consumePosRewardPool(amount) {
  const fee = Number(amount) || 0;
  if (fee <= 0) return getPosRewardPool();
  db.prepare(`
    UPDATE pos_reward_pool
    SET balance = CASE WHEN balance - ? < 0 THEN 0 ELSE balance - ? END,
        last_distribution_at = datetime('now')
    WHERE id = 1
  `).run(fee, fee);
  return getPosRewardPool();
}

function distributePosRewards(minStake = 10) {
  const pool = getPosRewardPool();
  const available = Number(pool.balance) || 0;
  if (available <= 0) {
    return { distributed: 0, recipients: 0, totalStake: 0, balance: 0 };
  }

  const validators = getValidators(minStake);
  if (!validators.length) {
    return { distributed: 0, recipients: 0, totalStake: 0, balance: available };
  }

  const totalStake = validators.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  if (totalStake <= 0) {
    return { distributed: 0, recipients: 0, totalStake: 0, balance: available };
  }

  let remaining = Number(available.toFixed(8));
  validators.forEach((row, index) => {
    let reward;
    if (index === validators.length - 1) {
      reward = Number(remaining.toFixed(8));
    } else {
      reward = Number(((available * (Number(row.amount) || 0)) / totalStake).toFixed(8));
      if (reward > remaining) reward = Number(remaining.toFixed(8));
    }

    remaining = Number((remaining - reward).toFixed(8));
    if (reward > 0) {
      addStakeReward(row.username, reward);
    }
  });

  consumePosRewardPool(available);
  return {
    distributed: Number(available.toFixed(8)),
    recipients: validators.length,
    totalStake,
    balance: getPosRewardPool().balance
  };
}

// ─── Snake claim ─────────────────────────────────
function getLastSnakeClaim(username) {
  const row = db.prepare('SELECT claimed_at FROM snake_claims WHERE username=? ORDER BY claimed_at DESC LIMIT 1').get(username.trim());
  if (row && row.claimed_at) row.claimed_at = toISO(row.claimed_at);
  return row;
}

function insertSnakeClaim(username, apples, mode, reward) {
  return db.prepare('INSERT INTO snake_claims (username, apples, mode, reward) VALUES (?, ?, ?, ?)').run(username.trim(), apples, mode || 'normal', reward);
}

// ─── Leaderboard ─────────────────────────────────
function getLeaderboard(mode, limit = 10) {
  return db.prepare(`
    SELECT username, MAX(apples) as score, MAX(reward) as reward 
    FROM snake_claims 
    WHERE mode = ? 
    GROUP BY username 
    ORDER BY score DESC 
    LIMIT ?
  `).all(mode, limit);
}

// ─── Sequence (giữ lại nếu cần) ──────────────────
function getSeq() {
  const row = db.prepare('SELECT seq FROM sync_seq WHERE id = 1').get();
  return row ? row.seq : 0;
}

function incrementSeq() {
  db.prepare('UPDATE sync_seq SET seq = seq + 1 WHERE id = 1').run();
  return db.prepare('SELECT seq FROM sync_seq WHERE id = 1').get().seq;
}

// 🟢 Hỗ trợ hash nhanh cho health check
function getAllUsers() {
  return db.prepare('SELECT username, balance FROM users').all();
}

function getAllStakes() {
  return db.prepare('SELECT username, amount, pending_reward FROM stakes').all();
}

function getPosRewardPoolSnapshot() {
  return getPosRewardPool();
}

// 🆕 Dọn dẹp bounty cũ (giữ 100 bounty active gần nhất)
function cleanupOldBounties() {
  const count = db.prepare('SELECT COUNT(*) as count FROM bounties WHERE status = ?').get('active');
  if (count && count.count > 100) {
    const toDelete = count.count - 100;
    db.prepare(`
      DELETE FROM bounties WHERE id IN (
        SELECT id FROM bounties WHERE status = 'active'
        ORDER BY created_at ASC LIMIT ?
      )
    `).run(toDelete);
    console.log(`🧹 Cleaned up ${toDelete} old bounties`);
  }
}

// ═══════════════════════════════════════════════════
// 🆕 FULL DATABASE SNAPSHOT – GIỚI HẠN 10 BLOCKS + 10 BOUNTIES
// ═══════════════════════════════════════════════════
function exportFullState() {
  const users = db.prepare('SELECT username, pin_hash, balance FROM users').all();
  const stakes = db.prepare('SELECT username, amount, pending_reward FROM stakes').all();
  const posRewardPool = getPosRewardPool();
  
  const blocks = db.prepare(
    'SELECT username, bounty_id, reward, mined_at FROM blocks_mined ORDER BY mined_at DESC LIMIT 10'
  ).all().map(b => ({ ...b, mined_at: b.mined_at }));
  
  const claims = db.prepare(
    'SELECT username, apples, mode, reward, claimed_at FROM snake_claims ORDER BY claimed_at DESC LIMIT 20'
  ).all().map(c => ({ ...c, claimed_at: c.claimed_at }));
  
  const bounties = db.prepare(
    'SELECT id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, nonce, solver_username, status, created_at FROM bounties WHERE status = ? ORDER BY created_at DESC LIMIT 10'
  ).all('active');
  
  return {
    users,
    stakes,
    pos_reward_pool: posRewardPool,
    blocks_mined: blocks,
    snake_claims: claims,
    bounties
  };
}

function importFullState(state) {
  if (!state) return false;

  const transaction = db.transaction(() => {
    db.exec('DELETE FROM users');
    db.exec('DELETE FROM stakes');
    db.exec('DELETE FROM pos_reward_pool');
    db.exec('DELETE FROM blocks_mined');
    db.exec('DELETE FROM snake_claims');
    db.exec('DELETE FROM bounties');
    db.exec('DELETE FROM sync_seq');

    const insertUser = db.prepare('INSERT INTO users (username, pin_hash, balance) VALUES (?, ?, ?)');
    (state.users || []).forEach(u => {
      insertUser.run(u.username, u.pin_hash, u.balance);
    });

    const insertStake = db.prepare('INSERT INTO stakes (username, amount, pending_reward) VALUES (?, ?, ?)');
    (state.stakes || []).forEach(s => {
      insertStake.run(s.username, s.amount, s.pending_reward);
    });

    const insertPool = db.prepare('INSERT INTO pos_reward_pool (id, balance, total_fees, last_distribution_at) VALUES (1, ?, ?, ?)');
    const poolState = state.pos_reward_pool || {};
    insertPool.run(poolState.balance || 0, poolState.total_fees || 0, poolState.last_distribution_at || new Date().toISOString());

    const insertBlock = db.prepare('INSERT INTO blocks_mined (username, bounty_id, reward, mined_at) VALUES (?, ?, ?, ?)');
    (state.blocks_mined || []).forEach(b => {
      insertBlock.run(b.username, b.bounty_id, b.reward, b.mined_at);
    });

    const insertClaim = db.prepare('INSERT INTO snake_claims (username, apples, mode, reward, claimed_at) VALUES (?, ?, ?, ?, ?)');
    (state.snake_claims || []).forEach(c => {
      insertClaim.run(c.username, c.apples, c.mode, c.reward, c.claimed_at);
    });

    const insertBounty = db.prepare('INSERT INTO bounties (id, creator_username, target_device, difficulty, reward, cost, binary_target, last_hash, nonce, solver_username, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    (state.bounties || []).forEach(b => {
      insertBounty.run(b.id, b.creator_username, b.target_device, b.difficulty, b.reward, b.cost, b.binary_target, b.last_hash, b.nonce, b.solver_username, b.status, b.created_at);
    });

    db.prepare('INSERT INTO sync_seq (id, seq) VALUES (1, 0)').run();
  });

  transaction();
  cleanupOldBounties();
  return true;
}

// 🆕 Quản lý difficulty riêng cho từng worker
function getWorkerDifficulty(workerName) {
  const row = db.prepare('SELECT difficulty FROM worker_difficulty WHERE worker_name = ?').get(workerName);
  return row ? row.difficulty : null;
}

function setWorkerDifficulty(workerName, difficulty, lastSolveTime) {
  db.prepare(`
    INSERT INTO worker_difficulty (worker_name, difficulty, last_solve_time, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(worker_name) DO UPDATE SET
      difficulty = excluded.difficulty,
      last_solve_time = excluded.last_solve_time,
      updated_at = datetime('now')
  `).run(workerName, difficulty, lastSolveTime);
}

// ─── Exports ─────────────────────────────────────
module.exports = {
  authenticate,
  getUser,
  updateBalance,
  getRecentBlocks,
  getActiveMiners,
  getLastSnakeClaim,
  insertSnakeClaim,
  getStake,
  stake,
  unstake,
  getValidators,
  addStakeReward,
  getLeaderboard,
  getSeq,
  incrementSeq,
  getAllUsers,
  getAllStakes,
  getPosRewardPool: getPosRewardPoolSnapshot,
  addPosRewardPool,
  consumePosRewardPool,
  distributePosRewards,
  exportFullState,
  importFullState,
  addTransaction,
  getTransactions,
  cleanupOldBounties,
  // 🆕 Per-worker difficulty
  getWorkerDifficulty,
  setWorkerDifficulty
};
