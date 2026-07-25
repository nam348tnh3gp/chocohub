const Database = require('better-sqlite3');

function safeBigInt(value, def) {
  if (typeof value === 'bigint') return value;
  try { return BigInt(value); } catch { return def; }
}

function initDB(dbPath, cfg) {
  cfg = cfg || {};
  const dir = require('path').dirname(dbPath);
  require('fs').mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (
      height INTEGER, hash TEXT PRIMARY KEY, parent_hash TEXT, timestamp INTEGER,
      miner TEXT, challenge_id TEXT, tx_root TEXT, nonce TEXT, difficulty TEXT,
      target TEXT, reward_units TEXT, reward_cc TEXT, tx_count INTEGER,
      chain_work TEXT, signature TEXT, generation_signature TEXT,
      proof_digest TEXT, plot_id TEXT, state_root TEXT, origin TEXT,
      total_fees_units TEXT, gas_used INTEGER, gas_limit INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_height ON blocks(height);
    CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_hash);
    CREATE INDEX IF NOT EXISTS idx_blocks_challenge ON blocks(challenge_id);

    CREATE TABLE IF NOT EXISTS transactions (
      hash TEXT PRIMARY KEY, from_addr TEXT, to_addr TEXT, value TEXT,
      fee TEXT, nonce INTEGER, gas_limit INTEGER, gas_price TEXT,
      signature TEXT, block_height INTEGER, timestamp INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_addr);
    CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_addr);
    CREATE INDEX IF NOT EXISTS idx_tx_height ON transactions(block_height);

    CREATE TABLE IF NOT EXISTS users (
      address TEXT PRIMARY KEY, public_key_ed25519 TEXT UNIQUE,
      balance TEXT DEFAULT '0', nonce INTEGER DEFAULT 0,
      created_at INTEGER, updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS mempool (
      hash TEXT PRIMARY KEY, raw TEXT NOT NULL, timestamp INTEGER, fee TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mempool_fee ON mempool(fee);

    CREATE TABLE IF NOT EXISTS peers (
      url TEXT PRIMARY KEY, node_id TEXT, height INTEGER DEFAULT 0,
      first_seen INTEGER, last_seen INTEGER, health REAL DEFAULT 1.0,
      fail_count INTEGER DEFAULT 0, banned INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS nodes (
      url TEXT PRIMARY KEY, node_id TEXT, height INTEGER DEFAULT 0,
      chain_work TEXT DEFAULT '0', version TEXT DEFAULT '',
      peers INTEGER DEFAULT 0, first_seen INTEGER, last_seen INTEGER
    );

    CREATE TABLE IF NOT EXISTS mining_challenges (
      challenge_id TEXT PRIMARY KEY, challenge_seed TEXT, nonce TEXT,
      target_scoop_index INTEGER, created_at INTEGER, expires_at INTEGER,
      block_height INTEGER, winner_miner TEXT, winner_deadline INTEGER,
      winner_plot_id TEXT, forged_block_height INTEGER, finalized_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS challenge_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      challenge_id TEXT, miner TEXT, plot_id TEXT, size_gb REAL,
      deadline INTEGER, proof_digest TEXT, submitted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sub_challenge ON challenge_submissions(challenge_id);

    CREATE TABLE IF NOT EXISTS plot_commitments (
      plot_id TEXT, miner TEXT, merkle_root TEXT, size_gb REAL,
      created_at INTEGER, PRIMARY KEY(plot_id, miner)
    );

    CREATE TABLE IF NOT EXISTS peer_plot_commitments (
      plot_id TEXT, miner TEXT, size_gb REAL, node_url TEXT,
      created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS block_rewards (
      block_height INTEGER, block_hash TEXT, challenge_id TEXT,
      miner TEXT, plot_id TEXT, size_gb REAL, share_pct REAL,
      reward_cc TEXT, created_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS plot_cache (
      plot_id TEXT PRIMARY KEY, merkle_root TEXT, size_gb REAL,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY, value TEXT
    );
  `);

  const treasuryAddress = '0xccc0000000000000000000000000000000000000000';
  const treasuryAmount = safeBigInt(cfg.maxSupply || '21000000000000000000000000', 0n);
  const existing = db.prepare('SELECT balance FROM users WHERE address = ?').get(treasuryAddress);
  if (!existing) {
    db.prepare('INSERT OR IGNORE INTO users (address, public_key_ed25519, balance, nonce, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(treasuryAddress, '', String(treasuryAmount), 0, cfg.genesisTimestamp || Math.floor(Date.now() / 1000), cfg.genesisTimestamp || Math.floor(Date.now() / 1000));
  }

  return db;
}

module.exports = { initDB };
