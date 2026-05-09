// db.js – Full fix + PoS Staking support + Leaderboard (Case-Sensitive Username) + Backup sync
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const db = new Database(path.join(__dirname, 'chocohub.db'));
db.pragma('journal_mode = WAL');

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
  CREATE TABLE IF NOT EXISTS sync_seq (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    seq INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO sync_seq (id, seq) VALUES (1, 0);
`);

console.log('✅ Database ready (better-sqlite3)');

// ─── Helper functions ─────────────────────────────
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

function getRecentBlocks(limit = 10) {
  return db.prepare('SELECT bounty_id as id, username, reward FROM blocks_mined ORDER BY mined_at DESC LIMIT ?').all(limit);
}

function getActiveMiners(limit = 5) {
  return db.prepare('SELECT DISTINCT username, "web" as device FROM blocks_mined ORDER BY mined_at DESC LIMIT ?').all(limit);
}

// ─── Staking functions ────────────────────────────
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
  const current = getStake(username);
  db.prepare('UPDATE stakes SET amount = amount + ?, pending_reward = pending_reward WHERE username = ?')
    .run(amount, username);
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
  db.prepare('UPDATE stakes SET pending_reward = pending_reward + ? WHERE username = ?')
    .run(reward, username.trim());
}

// ─── Snake claim ─────────────────────────────────
function getLastSnakeClaim(username) {
  return db.prepare(
    'SELECT claimed_at FROM snake_claims WHERE username=? ORDER BY claimed_at DESC LIMIT 1'
  ).get(username.trim());
}

function insertSnakeClaim(username, apples, mode, reward) {
  return db.prepare(
    'INSERT INTO snake_claims (username, apples, mode, reward) VALUES (?, ?, ?, ?)'
  ).run(username.trim(), apples, mode || 'normal', reward);
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

// 🟢 Backup sync sequence
function getSeq() {
  const row = db.prepare('SELECT seq FROM sync_seq WHERE id = 1').get();
  return row ? row.seq : 0;
}

function incrementSeq() {
  db.prepare('UPDATE sync_seq SET seq = seq + 1 WHERE id = 1').run();
  return db.prepare('SELECT seq FROM sync_seq WHERE id = 1').get().seq;
}

// 🟢 Backup support: export full data & apply delta
function getAllUsers() {
  return db.prepare('SELECT username, balance FROM users').all();
}

function getAllStakes() {
  return db.prepare('SELECT username, amount, pending_reward FROM stakes').all();
}

function applyDelta(deltaMsg) {
  const { action, username, payload } = deltaMsg;
  try {
    switch (action) {
      case 'user_created': {
        const existing = db.prepare('SELECT username FROM users WHERE username = ?').get(username);
        if (!existing) {
          db.prepare('INSERT INTO users (username, pin_hash, balance) VALUES (?, ?, ?)').run(
            username, 
            bcrypt.hashSync('backup_restore', 10), 
            payload.balance || 0
          );
        }
        break;
      }
      case 'block_mined':
        db.prepare(
          'INSERT OR IGNORE INTO blocks_mined (username, bounty_id, reward) VALUES (?, ?, ?)'
        ).run(username, payload.bounty_id, payload.reward || 0);
        break;
      case 'snake_claim':
        db.prepare(
          'INSERT OR IGNORE INTO snake_claims (username, apples, mode, reward, claimed_at) VALUES (?, ?, ?, ?, datetime("now"))'
        ).run(username, payload.apples, payload.mode || 'normal', payload.reward || 0);
        break;
      case 'stake': {
        const existingStake = db.prepare('SELECT username FROM stakes WHERE username = ?').get(username);
        if (existingStake) {
          db.prepare('UPDATE stakes SET amount = amount + ? WHERE username = ?').run(payload.amount || 0, username);
        } else {
          db.prepare('INSERT INTO stakes (username, amount, pending_reward) VALUES (?, ?, 0)').run(username, payload.amount || 0);
        }
        break;
      }
      case 'unstake':
        db.prepare('UPDATE stakes SET amount = 0, pending_reward = 0 WHERE username = ?').run(username);
        break;
      default:
        console.log(`⚠️ Unknown delta action: ${action}`);
    }
  } catch (e) {
    console.error(`❌ Error applying delta: ${e.message}`);
  }
}

// ✅ MỘT module.exports DUY NHẤT bao gồm tất cả hàm
module.exports = {
  authenticate,
  getUser,
  updateBalance,
  getRecentBlocks,
  getActiveMiners,
  getLastSnakeClaim,
  insertSnakeClaim,
  // PoS
  getStake,
  stake,
  unstake,
  getValidators,
  addStakeReward,
  // Leaderboard
  getLeaderboard,
  // Backup sync
  getSeq,
  incrementSeq,
  // Backup support
  getAllUsers,
  getAllStakes,
  applyDelta
};
