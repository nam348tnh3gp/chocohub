import os, time, math, random, hashlib, json
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, render_template, send_from_directory
from functools import wraps

app = Flask(__name__)
DB_PATH = "chocohub.db"

# ─── Database helpers ─────────────────────────────────────────────────
def get_db():
    import sqlite3
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    c = conn.cursor()
    c.executescript('''
        CREATE TABLE IF NOT EXISTS users (
            username TEXT PRIMARY KEY,
            pin TEXT NOT NULL,
            balance REAL DEFAULT 0.0,
            last_snake_claim REAL DEFAULT 0.0,
            created_at REAL DEFAULT (strftime('%s','now'))
        );
        CREATE TABLE IF NOT EXISTS snake_scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT,
            score INTEGER,
            hardcore INTEGER DEFAULT 0,
            timestamp REAL DEFAULT (strftime('%s','now'))
        );
        CREATE TABLE IF NOT EXISTS bounties (
            id TEXT PRIMARY KEY,
            creator TEXT,
            block_hash TEXT,
            target_bin TEXT,
            difficulty_bits INTEGER,
            reward REAL,
            target_device TEXT,
            created_at REAL DEFAULT (strftime('%s','now')),
            solved INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS mining_jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id TEXT UNIQUE,
            target_bin TEXT,
            difficulty_bits INTEGER,
            reward REAL,
            created_at REAL DEFAULT (strftime('%s','now')),
            active INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS mined_blocks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            block_hash TEXT,
            username TEXT,
            reward REAL,
            device TEXT,
            timestamp REAL DEFAULT (strftime('%s','now'))
        );
    ''')
    conn.commit()
    conn.close()

init_db()

# ─── Helper functions ─────────────────────────────────────────────────
def generate_block_hash():
    return hashlib.sha256(os.urandom(32)).hexdigest()

def target_from_difficulty(diff_bits):
    """Creates target_bin string: first diff_bits are '0', rest '1'."""
    return '0' * int(diff_bits) + '1' * (256 - int(diff_bits))

# ─── Authentication ───────────────────────────────────────────────────
@app.route('/auth', methods=['POST'])
def auth():
    data = request.get_json() or {}
    username = data.get('username', '').strip().lower()
    pin = data.get('pin', '').strip()
    if len(username) < 3 or len(pin) < 4:
        return jsonify(status='error', message='Username min 3, PIN min 4')
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if user:
        if user['pin'] != pin:
            return jsonify(status='error', message='Wrong PIN')
    else:
        conn.execute("INSERT INTO users (username, pin, balance) VALUES (?,?,?)", (username, pin, 0.0))
        conn.commit()
    conn.close()
    return jsonify(status='success', message=f'Welcome, {username}!')

@app.route('/get_user/<username>')
def get_user(username):
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username=?", (username.lower(),)).fetchone()
    conn.close()
    if user:
        return jsonify(status='success', balance=user['balance'], last_snake_claim=user['last_snake_claim'])
    return jsonify(status='error', message='User not found')

# ─── Snake ────────────────────────────────────────────────────────────
SNAKE_COOLDOWN = 3600  # 1 hour
REWARD_NORMAL = 0.5
REWARD_HARDCORE = 2.0
MAX_CLAIM = 500.0

@app.route('/check_user', methods=['POST'])
def check_user():
    # used by snake to verify credentials before start
    data = request.get_json() or {}
    username = data.get('username','').strip().lower()
    pin = data.get('pin','')
    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    conn.close()
    if not user or user['pin'] != pin:
        return jsonify(status='error', message='Invalid credentials')
    return jsonify(status='success')

@app.route('/claim_reward', methods=['POST'])
def claim_reward():
    data = request.get_json() or {}
    username = data.get('username','').strip().lower()
    pin = data.get('pin','')
    score = int(data.get('score', 0))
    hardcore = bool(data.get('hardcore', False))

    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not user or user['pin'] != pin:
        conn.close()
        return jsonify(status='error', message='Invalid credentials')

    # Cooldown
    now = time.time()
    if user['last_snake_claim'] > 0 and (now - user['last_snake_claim']) < SNAKE_COOLDOWN:
        remaining = int(SNAKE_COOLDOWN - (now - user['last_snake_claim']))
        conn.close()
        return jsonify(status='error', message=f'Cooldown: {remaining//60}m{remaining%60}s', cooldown=remaining)

    reward_per_apple = REWARD_HARDCORE if hardcore else REWARD_NORMAL
    reward = min(score * reward_per_apple, MAX_CLAIM)
    if reward <= 0:
        conn.close()
        return jsonify(status='error', message='No apples to reward')

    new_balance = user['balance'] + reward
    conn.execute("UPDATE users SET balance=?, last_snake_claim=? WHERE username=?",
                 (new_balance, now, username))
    conn.execute("INSERT INTO snake_scores (username, score, hardcore) VALUES (?,?,?)",
                 (username, score, int(hardcore)))
    conn.commit()
    conn.close()
    return jsonify(status='success', reward=reward, new_balance=new_balance)

@app.route('/leaderboard/<mode>')
def leaderboard(mode):
    # mode: normal or hardcore
    hardcore = 1 if mode == 'hardcore' else 0
    conn = get_db()
    rows = conn.execute('''
        SELECT username, MAX(score) as best
        FROM snake_scores
        WHERE hardcore=?
        GROUP BY username
        ORDER BY best DESC
        LIMIT 10
    ''', (hardcore,)).fetchall()
    conn.close()
    return jsonify([{'username': r['username'], 'score': r['best']} for r in rows])

# ─── Block Hunt (Bounties) ────────────────────────────────────────────
@app.route('/create_bounty', methods=['POST'])
def create_bounty():
    data = request.get_json() or {}
    username = data.get('username','').strip().lower()
    pin = data.get('pin','')
    difficulty = int(data.get('difficulty', 8))
    reward = float(data.get('reward', 1.0))
    target_device = data.get('target_device', 'web')

    # Validate ratio: creator pays 8 * reward
    pay_amount = 8.0 * reward
    if pay_amount <= 0:
        return jsonify(status='error', detail='Invalid reward')

    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    if not user or user['pin'] != pin:
        conn.close()
        return jsonify(status='error', detail='Auth failed')
    if user['balance'] < pay_amount:
        conn.close()
        return jsonify(status='error', detail=f'Insufficient balance. Need {pay_amount} CC')

    # Deduct full pay amount
    new_balance = user['balance'] - pay_amount
    conn.execute("UPDATE users SET balance=? WHERE username=?", (new_balance, username))

    # Create bounty
    bounty_id = hashlib.sha256(os.urandom(16)).hexdigest()[:12]
    block_hash = generate_block_hash()
    target_bin = target_from_difficulty(difficulty)
    conn.execute('''INSERT INTO bounties
        (id, creator, block_hash, target_bin, difficulty_bits, reward, target_device)
        VALUES (?,?,?,?,?,?,?)''',
        (bounty_id, username, block_hash, target_bin, difficulty, reward, target_device))
    conn.commit()
    conn.close()
    return jsonify(status='success', bounty_id=bounty_id, new_balance=new_balance)

@app.route('/active_bounties_list')
def active_bounties():
    conn = get_db()
    rows = conn.execute("SELECT * FROM bounties WHERE solved=0").fetchall()
    conn.close()
    result = {}
    for b in rows:
        result[b['id']] = {
            'id': b['id'],
            'creator': b['creator'],
            'block_hash': b['block_hash'],
            'target_bin': b['target_bin'],
            'difficulty_bits': b['difficulty_bits'],
            'reward': b['reward'],
            'target_device': b['target_device'],
            'created_at': b['created_at']
        }
    return jsonify(result)

@app.route('/get_job/<bounty_id>')
def get_job(bounty_id):
    conn = get_db()
    bounty = conn.execute("SELECT * FROM bounties WHERE id=? AND solved=0", (bounty_id,)).fetchone()
    conn.close()
    if not bounty:
        return jsonify(status='error', detail='Bounty not found')
    return jsonify(
        block_hash=bounty['block_hash'],
        target_bin=bounty['target_bin'],
        difficulty_bits=bounty['difficulty_bits'],
        reward=bounty['reward'],
        bounty_id=bounty_id
    )

@app.route('/submit_solution', methods=['POST'])
def submit_solution():
    bounty_id = request.args.get('bounty_id')
    nonce = request.args.get('nonce')
    worker_name = request.args.get('worker_name', 'anonymous').strip().lower()
    # Verify
    conn = get_db()
    bounty = conn.execute("SELECT * FROM bounties WHERE id=? AND solved=0", (bounty_id,)).fetchone()
    if not bounty:
        conn.close()
        return jsonify(status='error', detail='Bounty not available')

    # Validate hash
    candidate = hashlib.sha256((bounty['block_hash'] + nonce).encode()).hexdigest()
    binary = bin(int(candidate, 16))[2:].zfill(256)
    if binary.startswith(bounty['target_bin']):
        # valid!
        reward = bounty['reward']
        # Mark solved
        conn.execute("UPDATE bounties SET solved=1 WHERE id=?", (bounty_id,))
        # Reward miner (worker_name)
        miner = conn.execute("SELECT * FROM users WHERE username=?", (worker_name,)).fetchone()
        if miner:
            new_balance = miner['balance'] + reward
            conn.execute("UPDATE users SET balance=? WHERE username=?", (new_balance, worker_name))
        else:
            # create user with pin? cannot. Skip reward for unknown miner.
            conn.close()
            return jsonify(status='error', detail='Miner not found')
        # Log mined block
        conn.execute("INSERT INTO mined_blocks (block_hash, username, reward, device) VALUES (?,?,?,?)",
                     (candidate, worker_name, reward, 'web_v6'))
        conn.commit()
        conn.close()
        return jsonify(status='success', message=f'Block solved! Reward {reward} CC sent to {worker_name}')
    else:
        conn.close()
        return jsonify(status='error', detail='Invalid solution')

# ─── Web Miner (CPU Mining) ───────────────────────────────────────────
MINING_REWARD_PER_SHARE = 0.01  # adjustable
@app.route('/mining/get_job')
def mining_get_job():
    # Create a mining job if none active, or return an existing one
    conn = get_db()
    job = conn.execute("SELECT * FROM mining_jobs WHERE active=1 ORDER BY created_at DESC LIMIT 1").fetchone()
    if not job:
        diff = 12  # lower difficulty for continuous mining
        job_id = hashlib.sha256(os.urandom(16)).hexdigest()[:12]
        target_bin = target_from_difficulty(diff)
        reward = MINING_REWARD_PER_SHARE
        conn.execute("INSERT INTO mining_jobs (job_id, target_bin, difficulty_bits, reward) VALUES (?,?,?,?)",
                     (job_id, target_bin, diff, reward))
        conn.commit()
        job = conn.execute("SELECT * FROM mining_jobs WHERE job_id=?", (job_id,)).fetchone()
    conn.close()
    return jsonify(job_id=job['job_id'], target_bin=job['target_bin'], difficulty_bits=job['difficulty_bits'], reward=job['reward'])

@app.route('/mining/submit_share', methods=['POST'])
def mining_submit_share():
    job_id = request.args.get('job_id')
    nonce = request.args.get('nonce')
    worker_name = request.args.get('worker_name', 'anonymous').strip().lower()

    conn = get_db()
    job = conn.execute("SELECT * FROM mining_jobs WHERE job_id=? AND active=1", (job_id,)).fetchone()
    if not job:
        conn.close()
        return jsonify(status='error', detail='Job not active')

    # Validate (no block_hash, use job_id as seed)
    candidate = hashlib.sha256((job_id + nonce).encode()).hexdigest()
    binary = bin(int(candidate, 16))[2:].zfill(256)
    if binary.startswith(job['target_bin']):
        reward = job['reward']
        miner = conn.execute("SELECT * FROM users WHERE username=?", (worker_name,)).fetchone()
        if miner:
            new_balance = miner['balance'] + reward
            conn.execute("UPDATE users SET balance=? WHERE username=?", (new_balance, worker_name))
        else:
            conn.close()
            return jsonify(status='error', detail='Miner not found')
        # Log and optionally create new job
        conn.execute("INSERT INTO mined_blocks (block_hash, username, reward, device) VALUES (?,?,?,?)",
                     (candidate, worker_name, reward, 'cpu_miner'))
        # Refresh job (rotate after successful share)
        conn.execute("UPDATE mining_jobs SET active=0 WHERE job_id=?", (job_id,))
        # Create new job for next miner
        new_job_id = hashlib.sha256(os.urandom(16)).hexdigest()[:12]
        target_bin = target_from_difficulty(job['difficulty_bits'])
        conn.execute("INSERT INTO mining_jobs (job_id, target_bin, difficulty_bits, reward) VALUES (?,?,?,?)",
                     (new_job_id, target_bin, job['difficulty_bits'], reward))
        conn.commit()
        conn.close()
        return jsonify(status='success', message=f'Share accepted! Reward {reward} CC')
    else:
        conn.close()
        return jsonify(status='error', detail='Share rejected')

# ─── Network status (for dashboard) ────────────────────────────────────
@app.route('/network_status')
def network_status():
    conn = get_db()
    recent = conn.execute("SELECT * FROM mined_blocks ORDER BY timestamp DESC LIMIT 8").fetchall()
    active_miners = []  # can be extended
    conn.close()
    return jsonify(
        recent_blocks=[dict(b) for b in recent],
        active_miners=active_miners
    )

# ─── Serve static files (already handled by Flask if placed in /static) ──
# For HTML files, we can also serve them directly, but you may use a separate web server.
# For simplicity, we add routes to serve index.html, mining.html etc.
@app.route('/')
def index_page():
    return send_from_directory('static', 'index.html')

@app.route('/SnakeMain.html')
def snake_page():
    return send_from_directory('static', 'SnakeMain.html')

@app.route('/hunt.html')
def hunt_page():
    return send_from_directory('static', 'hunt.html')

@app.route('/mining.html')
def mining_page():
    return send_from_directory('static', 'mining.html')

@app.route('/static/<path:path>')
def static_files(path):
    return send_from_directory('static', path)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
