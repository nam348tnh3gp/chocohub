// db.js
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
`);

console.log('✅ Database ready (better-sqlite3)');

// Helper functions
function authenticate(username, pin) {
  username = username.toLowerCase().trim();
  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  
  if (!user) {
    // Tạo mới
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
  return db.prepare('SELECT username, balance FROM users WHERE username = ?').get(username.toLowerCase());
}

function updateBalance(username, amount) {
  db.prepare('UPDATE users SET balance = balance + ? WHERE username = ?').run(amount, username.toLowerCase());
}

function getRecentBlocks(limit = 10) {
  return db.prepare('SELECT bounty_id as id, username, reward FROM blocks_mined ORDER BY mined_at DESC LIMIT ?').all(limit);
}

function getActiveMiners(limit = 5) {
  return db.prepare('SELECT DISTINCT username, "web" as device FROM blocks_mined ORDER BY mined_at DESC LIMIT ?').all(limit);
}

module.exports = { authenticate, getUser, updateBalance, getRecentBlocks, getActiveMiners };
