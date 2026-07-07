// db.js – Full fix + PoS Staking + Leaderboard + Backup full snapshot + Transactions
// 🆕 Thêm bảng worker_difficulty cho per-worker dynamic difficulty
// 🆕 Thêm blockchain tables: blocks, mining_jobs
// 🆕 Thêm mempool và node_fees
// 🆕 Thêm admin functions: deleteUser, setUserBanned, ensureBannedColumn

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const db = new Database(path.join(__dirname, 'chocohub.db'));
db.pragma('journal_mode = WAL');

// Helper: chuyển datetime từ SQLite (YYYY-MM-DD HH:MM:SS) sang ISO string (YYYY-MM-DDTHH:MM:SSZ)
function toISO(dateStr) {
    if (!dateStr) return null;
    if (dateStr.includes('Z') || dateStr.includes('+')) return dateStr;
    if (dateStr.includes('T')) return dateStr + 'Z';
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

  -- 🆕 Bảng blockchain mới
  CREATE TABLE IF NOT EXISTS blocks (
    height INTEGER PRIMARY KEY,
    hash TEXT UNIQUE NOT NULL,
    prev_hash TEXT NOT NULL,
    miner TEXT NOT NULL,
    nonce TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    reward REAL NOT NULL,
    difficulty REAL NOT NULL,
    tx_count INTEGER DEFAULT 0,
    total_fees REAL DEFAULT 0,
    device_type TEXT DEFAULT 'unknown'
  );

  CREATE TABLE IF NOT EXISTS mining_jobs (
    id TEXT PRIMARY KEY,
    height INTEGER NOT NULL,
    prev_hash TEXT NOT NULL,
    difficulty REAL NOT NULL,
    target_hex TEXT NOT NULL,
    reward REAL NOT NULL,
    assigned_to TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- 🆕 Bảng mempool
  CREATE TABLE IF NOT EXISTS mempool (
    id TEXT PRIMARY KEY,
    from_username TEXT NOT NULL,
    to_username TEXT NOT NULL,
    amount REAL NOT NULL,
    fee REAL NOT NULL,
    total_deducted REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    confirmed_at TEXT,
    block_height INTEGER DEFAULT NULL
  );

  -- 🆕 Bảng node_fees (lưu số dư và tổng phí thu)
  CREATE TABLE IF NOT EXISTS node_fees (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    balance REAL NOT NULL DEFAULT 0,
    total_collected REAL NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO node_fees (id, balance, total_collected) VALUES (1, 0, 0);

  -- 🆕 Bảng game_sessions (proof-of-play cho Snake)
  CREATE TABLE IF NOT EXISTS game_sessions (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0
  );

  -- 🆕 Bảng mining_boosts (ad-click boost)
  CREATE TABLE IF NOT EXISTS mining_boosts (
    worker_name TEXT PRIMARY KEY,
    multiplier REAL NOT NULL DEFAULT 1.0,
    expires_at INTEGER NOT NULL DEFAULT 0,
    total_activations INTEGER DEFAULT 0,
    last_activation_at INTEGER DEFAULT 0
  );

  -- Tạo index cho hiệu suất
  CREATE INDEX IF NOT EXISTS idx_mining_jobs_assigned_to_status ON mining_jobs(assigned_to, status);
  CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height DESC);
  CREATE INDEX IF NOT EXISTS idx_mempool_status ON mempool(status);
  CREATE INDEX IF NOT EXISTS idx_mempool_created_at ON mempool(created_at);
  CREATE INDEX IF NOT EXISTS idx_game_sessions_username ON game_sessions(username);
  CREATE INDEX IF NOT EXISTS idx_mining_boosts_expires ON mining_boosts(expires_at);
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
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret === 'your_super_secret_random_string_here' || jwtSecret === 'secret') {
    if (!process.env._JWT_WARNED) {
      console.warn('⚠️ WARNING: JWT_SECRET is weak or default. Set a real secret in .env!');
      process.env._JWT_WARNED = '1';
    }
  }
  const token = jwt.sign({ username: user.username }, jwtSecret || crypto.randomBytes(32).toString('hex'), { expiresIn: '24h' });
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
  return rows.map(row => ({
    ...row,
    created_at: toISO(row.created_at)
  }));
}

// ─── Blocks & Miners (cũ) ─────────────────────────
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
    // Xóa thêm bảng mới nếu có dữ liệu cũ (tuỳ chọn)
    // db.exec('DELETE FROM blocks');
    // db.exec('DELETE FROM mining_jobs');

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

// ═══════════════════════════════════════════════════
// 🆕 BLOCKCHAIN HELPER FUNCTIONS
// ═══════════════════════════════════════════════════

function getLastBlock() {
  return db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get();
}

function getBlockByHeight(height) {
  return db.prepare('SELECT * FROM blocks WHERE height = ?').get(height);
}

function getBlockByHash(hash) {
  return db.prepare('SELECT * FROM blocks WHERE hash = ?').get(hash);
}

function insertBlock(block) {
  const { height, hash, prev_hash, miner, nonce, timestamp, reward, difficulty, tx_count, total_fees, device_type, tier, pos_contribution } = block;
  db.prepare(`
    INSERT OR IGNORE INTO blocks (height, hash, prev_hash, miner, nonce, timestamp, reward, difficulty, tx_count, total_fees, device_type, tier, pos_contribution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(height, hash, prev_hash, miner, nonce, timestamp, reward, difficulty, tx_count || 0, total_fees || 0, device_type || 'unknown', tier || 'unknown', pos_contribution || 0);
}

function updateBlockFees(height, totalFees) {
  db.prepare('UPDATE blocks SET total_fees = ? WHERE height = ?').run(totalFees, height);
}

function getActiveJob(jobId) {
  return db.prepare('SELECT * FROM mining_jobs WHERE id = ? AND status = ?').get(jobId, 'active');
}

function getJobForWorker(workerName) {
  return db.prepare('SELECT * FROM mining_jobs WHERE assigned_to = ? AND status = ? ORDER BY created_at DESC LIMIT 1')
    .get(workerName, 'active');
}

function createJob(job) {
  const { id, height, prev_hash, difficulty, target_hex, reward, assigned_to, tier, reward_multiplier } = job;
  db.prepare(`
    INSERT INTO mining_jobs (id, height, prev_hash, difficulty, target_hex, reward, assigned_to, tier, reward_multiplier, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(id, height, prev_hash, difficulty, target_hex, reward, assigned_to, tier || 'cpu', reward_multiplier || 1.0);
}

function markJobSolved(jobId) {
  db.prepare('UPDATE mining_jobs SET status = ? WHERE id = ?').run('solved', jobId);
}

function deleteJobsForWorker(workerName, exceptJobId) {
  db.prepare(`
    DELETE FROM mining_jobs
    WHERE assigned_to = ? AND status = 'active' AND id != ?
  `).run(workerName, exceptJobId);
}

// Invalidate all active jobs at a given block height (called after a block is accepted)
function deleteJobsAtHeight(height, exceptJobId) {
  if (exceptJobId) {
    db.prepare(`
      DELETE FROM mining_jobs
      WHERE height = ? AND status = 'active' AND id != ?
    `).run(height, exceptJobId);
  } else {
    db.prepare(`
      DELETE FROM mining_jobs
      WHERE height = ? AND status = 'active'
    `).run(height);
  }
}

function cleanupExpiredJobs(expireSeconds) {
  db.prepare(`
    DELETE FROM mining_jobs
    WHERE status = 'active'
    AND (strftime('%s', 'now') - strftime('%s', created_at)) > ?
  `).run(expireSeconds);
}

function getBlockCount() {
  const row = db.prepare('SELECT COUNT(*) as count FROM blocks').get();
  return row ? row.count : 0;
}

function getBlocks(limit = 10, offset = 0) {
  return db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT ? OFFSET ?').all(limit, offset);
}

function getBlocksByMiner(minerName, sinceTimestamp) {
  if (sinceTimestamp != null) {
    return db.prepare('SELECT * FROM blocks WHERE miner = ? AND timestamp >= ? ORDER BY height DESC').all(minerName, sinceTimestamp);
  }
  return db.prepare('SELECT * FROM blocks WHERE miner = ? ORDER BY height DESC').all(minerName);
}

// ═══════════════════════════════════════════════════
// 🆕 MEMPOOL FUNCTIONS
// ═══════════════════════════════════════════════════

// Thêm giao dịch vào mempool
function addToMempool(tx) {
  const { id, from_username, to_username, amount, fee, total_deducted } = tx;
  db.prepare(`
    INSERT INTO mempool (id, from_username, to_username, amount, fee, total_deducted, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
  `).run(id, from_username, to_username, amount, fee, total_deducted);
  return id;
}

// Lấy các giao dịch pending (sắp xếp theo thời gian cũ nhất trước)
function getPendingMempool(limit = 50) {
  return db.prepare(`
    SELECT * FROM mempool 
    WHERE status = 'pending' 
    ORDER BY created_at ASC 
    LIMIT ?
  `).all(limit);
}

// Đếm số lượng giao dịch pending
function getMempoolCount() {
  const row = db.prepare('SELECT COUNT(*) as count FROM mempool WHERE status = ?').get('pending');
  return row ? row.count : 0;
}

// Đánh dấu giao dịch đã xác nhận
function markMempoolConfirmed(txId, blockHeight) {
  db.prepare(`
    UPDATE mempool 
    SET status = 'confirmed', confirmed_at = datetime('now'), block_height = ?
    WHERE id = ?
  `).run(blockHeight, txId);
}

// Đánh dấu giao dịch thất bại (do không đủ balance)
function markMempoolFailed(txId) {
  db.prepare(`
    UPDATE mempool SET status = 'failed', confirmed_at = datetime('now')
    WHERE id = ?
  `).run(txId);
}

// Đánh dấu giao dịch đã được hoàn tiền
function markMempoolRefunded(txId) {
  db.prepare(`
    UPDATE mempool SET status = 'refunded', confirmed_at = datetime('now')
    WHERE id = ?
  `).run(txId);
}

// Lấy thông tin một giao dịch theo ID
function getMempoolTx(txId) {
  return db.prepare('SELECT * FROM mempool WHERE id = ?').get(txId);
}

// Dọn dẹp các giao dịch pending quá hạn (trả về danh sách các tx để hoàn tiền)
function getExpiredMempool(expireSeconds) {
  return db.prepare(`
    SELECT * FROM mempool 
    WHERE status = 'pending' 
    AND (strftime('%s', 'now') - strftime('%s', created_at)) > ?
  `).all(expireSeconds);
}

// ═══════════════════════════════════════════════════
// 🆕 GAME SESSION FUNCTIONS (proof-of-play)
// ═══════════════════════════════════════════════════

function createGameSession(id, username, expiresAt) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO game_sessions (id, username, created_at, expires_at, used)
    VALUES (?, ?, ?, ?, 0)
  `).run(id, username.trim(), now, expiresAt);
  return { id, username, expires_at: expiresAt };
}

function getGameSession(id) {
  return db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(id);
}

function consumeGameSession(id) {
  db.prepare('UPDATE game_sessions SET used = 1 WHERE id = ?').run(id);
}

function cleanupExpiredGameSessions() {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('DELETE FROM game_sessions WHERE expires_at < ?').run(now);
}

// ═══════════════════════════════════════════════════
// 🆕 MINING BOOST FUNCTIONS
// ═══════════════════════════════════════════════════

function getMiningBoost(workerName) {
  const row = db.prepare('SELECT * FROM mining_boosts WHERE worker_name = ?').get(workerName.trim());
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at <= now) return null;
  return row;
}

function activateMiningBoost(workerName, multiplier) {
  const now = Math.floor(Date.now() / 1000);
  const extensionMs = 3600;
  const existing = db.prepare('SELECT * FROM mining_boosts WHERE worker_name = ?').get(workerName.trim());
  if (existing) {
    const newExpiry = Math.max(existing.expires_at, now) + extensionMs;
    db.prepare(`
      UPDATE mining_boosts
      SET multiplier = ?, expires_at = ?, total_activations = total_activations + 1, last_activation_at = ?
      WHERE worker_name = ?
    `).run(multiplier, newExpiry, now, workerName.trim());
    return { worker_name: workerName, multiplier, expires_at: newExpiry, total_activations: existing.total_activations + 1 };
  } else {
    const expiresAt = now + extensionMs;
    db.prepare(`
      INSERT INTO mining_boosts (worker_name, multiplier, expires_at, total_activations, last_activation_at)
      VALUES (?, ?, ?, 1, ?)
    `).run(workerName.trim(), multiplier, expiresAt, now);
    return { worker_name: workerName, multiplier, expires_at: expiresAt, total_activations: 1 };
  }
}

function getMiningBoostMultiplier(workerName) {
  const boost = getMiningBoost(workerName);
  return boost ? boost.multiplier : 1.0;
}

// ═══════════════════════════════════════════════════
// 🆕 NODE FEES FUNCTIONS
// ═══════════════════════════════════════════════════

// Lấy số dư node_fees
function getNodeFeesBalance() {
  const row = db.prepare('SELECT balance FROM node_fees WHERE id = 1').get();
  return row ? row.balance : 0;
}

// Cộng phí vào node_fees
function addNodeFees(amount) {
  const fee = Number(amount) || 0;
  if (fee <= 0) return 0;
  db.prepare(`
    UPDATE node_fees 
    SET balance = balance + ?, 
        total_collected = total_collected + ?,
        updated_at = datetime('now')
    WHERE id = 1
  `).run(fee, fee);
  return fee;
}

// Trừ tiền từ node_fees (khi rút)
function deductNodeFees(amount) {
  const fee = Number(amount) || 0;
  if (fee <= 0) return 0;
  const current = getNodeFeesBalance();
  if (current < fee) throw new Error('Insufficient node_fees balance');
  db.prepare(`
    UPDATE node_fees 
    SET balance = balance - ?,
        updated_at = datetime('now')
    WHERE id = 1
  `).run(fee);
  return fee;
}

// Cập nhật trực tiếp số dư node_fees (để đặt lại balance)
function setNodeFeesBalance(newBalance) {
  const bal = Number(newBalance) || 0;
  db.prepare(`
    UPDATE node_fees 
    SET balance = ?,
        updated_at = datetime('now')
    WHERE id = 1
  `).run(bal);
  return bal;
}

// Lấy tổng phí đã thu
function getTotalNodeFeesCollected() {
  const row = db.prepare('SELECT total_collected FROM node_fees WHERE id = 1').get();
  return row ? row.total_collected : 0;
}

// ═══════════════════════════════════════════════════
// 🆕 ADMIN FUNCTIONS
// ═══════════════════════════════════════════════════

// Đảm bảo cột banned tồn tại
function ensureBannedColumn() {
  try {
    db.prepare("ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0").run();
    console.log('✅ Banned column ensured');
  } catch (e) {
    // Cột đã tồn tại hoặc lỗi khác, bỏ qua
    if (!e.message.includes('duplicate column name')) {
      console.warn('Could not ensure banned column:', e.message);
    }
  }
}

// Xóa user và các dữ liệu liên quan
function deleteUser(username) {
  const user = getUser(username);
  if (!user) throw new Error('User not found');
  db.prepare('DELETE FROM users WHERE username = ?').run(username);
  db.prepare('DELETE FROM stakes WHERE username = ?').run(username);
  db.prepare('DELETE FROM transactions WHERE from_username = ? OR to_username = ?').run(username, username);
  db.prepare('DELETE FROM snake_claims WHERE username = ?').run(username);
  db.prepare('DELETE FROM mempool WHERE from_username = ? OR to_username = ?').run(username, username);
  // blocks_mined giữ lại để thống kê
  console.log(`🗑️ Deleted user ${username} and related data`);
}

// Cập nhật trạng thái banned
function setUserBanned(username, banned) {
  const user = getUser(username);
  if (!user) throw new Error('User not found');
  db.prepare('UPDATE users SET banned = ? WHERE username = ?').run(banned ? 1 : 0, username);
  console.log(`🔒 User ${username} ${banned ? 'banned' : 'unbanned'}`);
}

// Garantir coluna device_type na tabela blocks (para DBs existentes)
function ensureBlockDeviceTypeColumn() {
  try {
    db.prepare("ALTER TABLE blocks ADD COLUMN device_type TEXT DEFAULT 'unknown'").run();
    console.log('✅ device_type column added to blocks table');
  } catch (e) {
    if (!e.message.includes('duplicate column name')) {
      console.warn('Could not ensure device_type column:', e.message);
    }
  }
}

// ═══════════════════════════════════════════════════
// 🆕 SAFE COLUMN ADDITION HELPER
// ═══════════════════════════════════════════════════
function ensureColumn(tableName, columnName, columnDef) {
  try {
    const check = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const exists = check.some(col => col.name === columnName);
    if (!exists) {
      db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
      console.log(`✅ Added column ${columnName} to ${tableName}`);
    }
  } catch (e) {
    if (!e.message.includes('duplicate column')) {
      console.warn(`⚠️ Could not add ${columnName} to ${tableName}:`, e.message);
    }
  }
}

// ═══════════════════════════════════════════════════
// 🆕 TIER & FLAG MANAGEMENT FUNCTIONS
// ═══════════════════════════════════════════════════

function getWorkerTier(workerName) {
  const row = db.prepare('SELECT tier FROM worker_difficulty WHERE worker_name = ?').get(workerName);
  return row ? row.tier : 'cpu'; // default to cpu if not found
}

function setWorkerTier(workerName, tier) {
  const validTiers = ['embedded_avr', 'embedded_arm', 'embedded_esp', 'embedded_esp32', 'mobile', 'cpu', 'gpu'];
  if (!validTiers.includes(tier)) {
    throw new Error(`Invalid tier: ${tier}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const existing = db.prepare('SELECT tier_registered_at FROM worker_difficulty WHERE worker_name = ?').get(workerName);
  
  if (existing && existing.tier_registered_at > 0) {
    const elapsed = now - existing.tier_registered_at;
    const COOLDOWN = 24 * 3600; // 24 hours
    if (elapsed < COOLDOWN) {
      const remaining = Math.ceil((COOLDOWN - elapsed) / 3600);
      throw new Error(`Tier cooldown active. Wait ${remaining} hours before changing tier again.`);
    }
  }
  
  db.prepare(`
    INSERT INTO worker_difficulty (worker_name, tier, tier_registered_at, tier_changes, difficulty, last_solve_time, updated_at)
    VALUES (?, ?, ?, 1, 10, 0, datetime('now'))
    ON CONFLICT(worker_name) DO UPDATE SET
      tier = excluded.tier,
      tier_registered_at = excluded.tier_registered_at,
      tier_changes = tier_changes + 1,
      updated_at = datetime('now')
  `).run(workerName, tier, now);
  
  console.log(`📋 Worker ${workerName} tier set to ${tier}`);
}

function getWorkerFlags(workerName) {
  const row = db.prepare('SELECT * FROM worker_flags WHERE worker_name = ?').get(workerName);
  if (!row) return { warning_count: 0, suspended: false };
  
  // Parse warnings JSON
  try {
    row.warnings = JSON.parse(row.warnings_json || '[]');
  } catch (e) {
    row.warnings = [];
  }
  row.suspended = Boolean(row.suspended);
  return row;
}

function addWorkerWarning(workerName, reason) {
  const now = Math.floor(Date.now() / 1000);
  const WINDOW = 24 * 3600; // 24 hours
  const existing = getWorkerFlags(workerName);
  let warnings = existing.warnings || [];
  
  // Remove warnings older than 24h
  warnings = warnings.filter(w => (now - w.timestamp) < WINDOW);
  
  // Add new warning
  warnings.push({ timestamp: now, reason });
  const newCount = warnings.length;
  const shouldSuspend = newCount >= 3;
  
  db.prepare(`
    INSERT INTO worker_flags (worker_name, warning_count, last_warning_at, warnings_json, suspended, suspended_at, suspension_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(worker_name) DO UPDATE SET
      warning_count = excluded.warning_count,
      last_warning_at = excluded.last_warning_at,
      warnings_json = excluded.warnings_json,
      suspended = excluded.suspended,
      suspended_at = excluded.suspended_at,
      suspension_reason = excluded.suspension_reason
  `).run(
    workerName,
    newCount,
    now,
    JSON.stringify(warnings),
    shouldSuspend ? 1 : 0,
    shouldSuspend ? now : (existing.suspended_at || 0),
    shouldSuspend ? `3 warnings in 24h` : (existing.suspension_reason || null)
  );
  
  if (shouldSuspend && !existing.suspended) {
    console.warn(`🚫 Worker ${workerName} suspended after 3 warnings`);
  }
  
  return { warning_count: newCount, suspended: shouldSuspend };
}

function suspendWorker(workerName, reason) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO worker_flags (worker_name, suspended, suspended_at, suspension_reason)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(worker_name) DO UPDATE SET
      suspended = 1,
      suspended_at = excluded.suspended_at,
      suspension_reason = excluded.suspension_reason
  `).run(workerName, now, reason);
  console.log(`🚫 Worker ${workerName} manually suspended: ${reason}`);
}

function clearWorkerSuspension(workerName, adminUsername) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    UPDATE worker_flags
    SET suspended = 0,
        warning_count = 0,
        warnings_json = '[]',
        cleared_by = ?,
        cleared_at = ?
    WHERE worker_name = ?
  `).run(adminUsername, now, workerName);
  console.log(`✅ Worker ${workerName} suspension cleared by ${adminUsername}`);
}

function getFlaggedWorkers() {
  return db.prepare(`
    SELECT worker_name, warning_count, suspended, suspended_at, suspension_reason, warnings_json
    FROM worker_flags
    WHERE warning_count > 0 OR suspended = 1
    ORDER BY suspended DESC, warning_count DESC
  `).all().map(row => {
    try {
      row.warnings = JSON.parse(row.warnings_json || '[]');
    } catch (e) {
      row.warnings = [];
    }
    row.suspended = Boolean(row.suspended);
    delete row.warnings_json;
    return row;
  });
}

// Gọi ensureBannedColumn e ensureBlockDeviceTypeColumn quando module load
ensureBannedColumn();
ensureBlockDeviceTypeColumn();

// ═══════════════════════════════════════════════════
// 🆕 EXTEND EXISTING TABLES WITH NEW COLUMNS
// ═══════════════════════════════════════════════════
ensureColumn('worker_difficulty', 'tier', 'TEXT DEFAULT "cpu"');
ensureColumn('worker_difficulty', 'tier_registered_at', 'INTEGER DEFAULT 0');
ensureColumn('worker_difficulty', 'tier_changes', 'INTEGER DEFAULT 0');
ensureColumn('mining_jobs', 'tier', 'TEXT DEFAULT "cpu"');
ensureColumn('mining_jobs', 'reward_multiplier', 'REAL DEFAULT 1.0');
ensureColumn('blocks', 'tier', 'TEXT DEFAULT "unknown"');
ensureColumn('blocks', 'pos_contribution', 'REAL DEFAULT 0');

// ═══════════════════════════════════════════════════
// 🆕 CREATE WORKER_FLAGS TABLE
// ═══════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS worker_flags (
    worker_name TEXT PRIMARY KEY,
    warning_count INTEGER DEFAULT 0,
    last_warning_at INTEGER DEFAULT 0,
    warnings_json TEXT DEFAULT '[]',
    suspended INTEGER DEFAULT 0,
    suspended_at INTEGER DEFAULT 0,
    suspension_reason TEXT,
    cleared_by TEXT,
    cleared_at INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_worker_flags_suspended ON worker_flags(suspended);

  -- 🆕 Mining Nodes table
  CREATE TABLE IF NOT EXISTS mining_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT UNIQUE NOT NULL,
    auth_token TEXT UNIQUE NOT NULL,
    owner TEXT DEFAULT '',
    location TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    connected_miners INTEGER DEFAULT 0,
    cpu_load REAL DEFAULT 0,
    ping_ms REAL DEFAULT 0,
    last_heartbeat TEXT DEFAULT (datetime('now')),
    total_earned REAL DEFAULT 0,
    total_blocks_relayed INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_mining_nodes_status ON mining_nodes(status);
  CREATE INDEX IF NOT EXISTS idx_mining_nodes_heartbeat ON mining_nodes(last_heartbeat);
`);

ensureColumn('mining_nodes', 'last_block_height', 'INTEGER DEFAULT 0');

// ═══════════════════════════════════════════════════
// 🆕 MINING NODE FUNCTIONS
// ═══════════════════════════════════════════════════

const MAX_MINING_NODES = 50;

function registerMiningNode(name, url, owner, location) {
  const crypto = require('crypto');
  // Input validation
  if (!name || typeof name !== 'string' || name.length > 100) {
    throw new Error('Invalid node name (1-100 chars)');
  }
  if (!url || typeof url !== 'string' || url.length > 500 || !/^https?:\/\/.+/i.test(url)) {
    throw new Error('Invalid node URL (must start with http:// or https://)');
  }
  // Limit total nodes
  const count = db.prepare('SELECT COUNT(*) as c FROM mining_nodes').get().c;
  if (count >= MAX_MINING_NODES) {
    throw new Error(`Maximum node limit reached (${MAX_MINING_NODES})`);
  }
  const authToken = 'node_' + crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO mining_nodes (name, url, auth_token, owner, location)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), url.trim(), authToken, (owner || '').trim().substring(0, 100), (location || '').trim().substring(0, 100));
  return { name: name.trim(), url: url.trim(), auth_token: authToken, owner, location };
}

function getMiningNodeByToken(token) {
  return db.prepare('SELECT * FROM mining_nodes WHERE auth_token = ?').get(token);
}

function getMiningNodeById(id) {
  return db.prepare('SELECT * FROM mining_nodes WHERE id = ?').get(id);
}

function getMiningNodeByUrl(url) {
  return db.prepare('SELECT * FROM mining_nodes WHERE url = ?').get(url);
}

function updateMiningNodeHeartbeat(id, miners, cpuLoad, ping, blockchainHeight) {
  db.prepare(`
    UPDATE mining_nodes
    SET connected_miners = ?, cpu_load = ?, ping_ms = ?,
        last_heartbeat = datetime('now'), status = 'active',
        last_block_height = ?
    WHERE id = ?
  `).run(miners, cpuLoad, ping, blockchainHeight || 0, id);
}

function getActiveMiningNodes() {
  return db.prepare(`
    SELECT * FROM mining_nodes
    WHERE status = 'active'
    AND (strftime('%s', 'now') - strftime('%s', last_heartbeat)) < 300
    ORDER BY ping_ms ASC, connected_miners ASC
  `).all();
}

function getBestBackupNode() {
  return db.prepare(`
    SELECT * FROM mining_nodes
    WHERE status = 'active'
    AND (strftime('%s', 'now') - strftime('%s', last_heartbeat)) < 300
    AND last_block_height > 0
    ORDER BY last_block_height DESC, ping_ms ASC
    LIMIT 1
  `).get();
}

function addMiningNodeEarnings(id, amount) {
  if (!id || typeof id !== 'number' || id <= 0) return;
  if (!amount || typeof amount !== 'number' || amount <= 0 || !Number.isFinite(amount)) return;
  db.prepare(`
    UPDATE mining_nodes
    SET total_earned = total_earned + ?,
        total_blocks_relayed = total_blocks_relayed + 1
    WHERE id = ?
  `).run(amount, id);
}

// ─── Transaction-safe block submission ──────────
function submitBlockTransaction(block, userName, finalReward, posContribution, nodeId, nodeContribution) {
  const runTransaction = db.transaction(() => {
    insertBlock(block);
    updateBalance(userName, finalReward);
    addPosRewardPool(posContribution);
    if (nodeId && nodeContribution > 0) {
      const node = getMiningNodeById(nodeId);
      if (node) {
        addMiningNodeEarnings(nodeId, nodeContribution);
      }
    }
  });
  runTransaction();
}

function deleteMiningNode(id) {
  db.prepare('DELETE FROM mining_nodes WHERE id = ?').run(id);
}

function deactivateMiningNode(id) {
  db.prepare("UPDATE mining_nodes SET status = 'offline' WHERE id = ?").run(id);
}

// ─── Exports ─────────────────────────────────────
module.exports = {
  _db: db,
  prepare: (sql) => db.prepare(sql),
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
  // Per-worker difficulty
  getWorkerDifficulty,
  setWorkerDifficulty,
  // Blockchain helpers
  getLastBlock,
  getBlockByHeight,
  getBlockByHash,
  insertBlock,
  updateBlockFees,
  getActiveJob,
  getJobForWorker,
  createJob,
  markJobSolved,
  deleteJobsForWorker,
  deleteJobsAtHeight,
  cleanupExpiredJobs,
  getBlockCount,
  getBlocks,
  getBlocksByMiner,
  // Mempool
  addToMempool,
  getPendingMempool,
  getMempoolCount,
  markMempoolConfirmed,
  markMempoolFailed,
  markMempoolRefunded,
  getMempoolTx,
  getExpiredMempool,
  // Node fees
  getNodeFeesBalance,
  addNodeFees,
  deductNodeFees,
  setNodeFeesBalance,
  getTotalNodeFeesCollected,
  // Game sessions
  createGameSession,
  getGameSession,
  consumeGameSession,
  cleanupExpiredGameSessions,
  // Mining boosts
  getMiningBoost,
  activateMiningBoost,
  getMiningBoostMultiplier,
  // Admin functions
  ensureBannedColumn,
  deleteUser,
  setUserBanned,
  // 🆕 Tier management
  getWorkerTier,
  setWorkerTier,
  // 🆕 Worker flags
  getWorkerFlags,
  addWorkerWarning,
  suspendWorker,
  clearWorkerSuspension,
  getFlaggedWorkers,
  // 🆕 Mining Nodes
  registerMiningNode,
  getMiningNodeByToken,
  getMiningNodeById,
  getMiningNodeByUrl,
  updateMiningNodeHeartbeat,
  getActiveMiningNodes,
  getBestBackupNode,
  addMiningNodeEarnings,
  submitBlockTransaction,
  deleteMiningNode,
  deactivateMiningNode
};
