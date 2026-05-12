# backup.py – Backup Server nhận full snapshot + Diffie-Hellman secured
import os
import sys
import json
import time
import threading
import requests
from flask import Flask, request, jsonify
from dotenv import dotenv_values
from datetime import datetime
import sqlite3

# 🆕 Import DH module (cần cài cryptography: pip install cryptography)
from dh import DHExchange

# ─── Đường dẫn thư mục hiện tại ────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, '.env')

if not os.path.exists(ENV_PATH):
    print(f'❌ File .env không tồn tại tại: {ENV_PATH}')
    print('   Hãy tạo file .env với nội dung:')
    print('   BACKUP_PORT=3001')
    print('   BACKUP_TOKEN=chocohub-default-token')
    print('   MAIN_SERVER_URL=https://chocohub-r011.onrender.com')
    print('   CHECK_INTERVAL=10')
    print('   BACKUP_DB_PATH=backup.db')
    sys.exit(1)

config = dotenv_values(ENV_PATH)

app = Flask(__name__)

# ─── Cấu hình từ .env ─────────────────────────────
BACKUP_PORT     = int(config.get('BACKUP_PORT', 3001))
BACKUP_TOKEN    = config.get('BACKUP_TOKEN', 'chocohub-default-token')
MAIN_SERVER_URL = config.get('MAIN_SERVER_URL', 'https://chocohub-r011.onrender.com')
CHECK_INTERVAL  = int(config.get('CHECK_INTERVAL', 10))
DB_PATH         = os.path.join(BASE_DIR, config.get('BACKUP_DB_PATH', 'backup.db'))

print(f'📁 Working directory: {BASE_DIR}')
print(f'📄 .env loaded: {ENV_PATH}')
print(f'💾 Database path: {DB_PATH}')
print(f'🔑 BACKUP_PORT: {BACKUP_PORT}')

# 🆕 DH keys của backup server (sinh một lần khi khởi động)
server_dh_keys = DHExchange.generate_keypair()
dh_sessions = {}   # client_id → { 'session_key': ..., 'created_at': ... }

# ─── Khởi tạo SQLite ───────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS snapshot (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            state TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    ''')
    cursor.execute('INSERT OR IGNORE INTO snapshot (id, state) VALUES (1, "{}")')
    conn.commit()
    conn.close()
    print('✅ Backup database ready (snapshot mode)')

def save_snapshot(state):
    try:
        json_data = json.dumps(state)
        conn = sqlite3.connect(DB_PATH, timeout=10)
        cursor = conn.cursor()
        cursor.execute('''
            INSERT OR REPLACE INTO snapshot (id, state, updated_at)
            VALUES (1, ?, datetime('now'))
        ''', (json_data,))
        conn.commit()
        conn.close()
        print(f'💾 Snapshot saved ({len(state.get("users", []))} users)')
    except Exception as e:
        print(f'❌ Save error: {e}')

def get_snapshot():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT state FROM snapshot WHERE id = 1')
    row = cursor.fetchone()
    conn.close()
    if row:
        try:
            return json.loads(row[0])
        except:
            return None
    return None

def get_snapshot_time():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT updated_at FROM snapshot WHERE id = 1')
    row = cursor.fetchone()
    conn.close()
    return row[0] if row else 'unknown'

# ═══════════════════════════════════════════════════
# MIDDLEWARE KIỂM TRA CHỮ KÝ DH (cho các route backup)
# ═══════════════════════════════════════════════════
@app.before_request
def verify_dh_signature():
    if not request.path.startswith('/api/backup'):
        return

    client_id = request.headers.get('X-Client-Id') or request.args.get('clientId')
    signature = request.headers.get('X-Signature')

    # Nếu không có session info, fallback về token (giữ nguyên logic cũ)
    if not client_id or not signature:
        return

    session = dh_sessions.get(client_id)
    if not session:
        return  # Fallback

    timestamp = request.headers.get('X-Timestamp', '')
    body_str = request.get_data(as_text=True) if request.method == 'POST' else ''
    message = f"{request.method}{request.path}{timestamp}{body_str}"

    if not DHExchange.verify(message, signature, session['session_key']):
        return jsonify({'status': 'error', 'message': 'Invalid HMAC signature'}), 401
    # Nếu hợp lệ, cho phép đi tiếp (không cần kiểm tra token nữa)
    return

# ═══════════════════════════════════════════════════
# ROUTE: DH KEY EXCHANGE
# ═══════════════════════════════════════════════════
@app.route('/api/dh/exchange', methods=['POST'])
def dh_exchange():
    data = request.get_json()
    if not data:
        return jsonify({'status': 'error', 'message': 'No data'}), 400

    client_id = data.get('clientId')
    client_public_key = data.get('clientPublicKey')
    token = data.get('token', '')

    if not client_id or not client_public_key or not token:
        return jsonify({'status': 'error', 'message': 'Missing fields'}), 400

    if token != BACKUP_TOKEN:
        return jsonify({'status': 'error', 'message': 'Invalid token'}), 401

    try:
        shared_secret = DHExchange.compute_shared_secret(
            server_dh_keys['private_key'],
            client_public_key,
            server_dh_keys['prime'],
            server_dh_keys['generator']
        )
        session_key = DHExchange.derive_session_key(shared_secret)

        dh_sessions[client_id] = {
            'session_key': session_key,
            'created_at': datetime.now().isoformat()
        }
        print(f'🔐 DH session established with {client_id}')

        return jsonify({
            'status': 'success',
            'serverPublicKey': server_dh_keys['public_key'],
            'prime': server_dh_keys['prime'],
            'generator': server_dh_keys['generator']
        })
    except Exception as e:
        print(f'❌ DH exchange error: {e}')
        return jsonify({'status': 'error', 'message': 'Key exchange failed'}), 500

# ═══════════════════════════════════════════════════
# BACKUP SYNC ROUTE (chấp nhận token hoặc session)
# ═══════════════════════════════════════════════════
@app.route('/api/backup/sync', methods=['POST'])
def receive_sync():
    if not request.is_json:
        print('⚠️ Non-JSON request received, ignoring...')
        return jsonify({'status': 'error', 'message': 'JSON required'}), 400

    data = request.get_json()
    if not data:
        return jsonify({'status': 'error', 'message': 'No data'}), 400

    msg_type = data.get('type', '')
    token = data.get('token', '')
    client_id = request.headers.get('X-Client-Id')

    # Xác thực: ưu tiên session, nếu không có mới dùng token
    session = dh_sessions.get(client_id) if client_id else None
    if not session:
        # Không có session DH, fallback về kiểm tra token
        if not token or token != BACKUP_TOKEN:
            return jsonify({'status': 'error', 'message': 'Invalid token or no session'}), 401

    # ─── READY ────────────────────────────────
    if msg_type == 'READY':
        empty = data.get('empty', False)
        if empty:
            snap = get_snapshot()
            if snap and snap.get('users') is not None:
                print(f'📤 Main server is empty, sending full snapshot ({len(snap.get("users", []))} users)')
                return jsonify({
                    'type': 'FULL_SNAPSHOT',
                    'token': BACKUP_TOKEN,
                    'state': snap
                })
            else:
                print('ℹ️ Backup server also empty – nothing to send')
                return jsonify({'type': 'READY_ACK', 'status': 'success', 'message': 'ready but empty'})
        else:
            return jsonify({'type': 'READY_ACK', 'status': 'success', 'message': 'ack'})

    # ─── PING ─────────────────────────────────
    elif msg_type == 'PING':
        return jsonify({'type': 'PONG', 'timestamp': datetime.now().isoformat()})

    # ─── FULL_SNAPSHOT (bất đồng bộ) ──────────
    elif msg_type == 'FULL_SNAPSHOT':
        if 'state' not in data:
            return jsonify({'status': 'error', 'message': 'Missing state'}), 400

        state = data['state']
        user_count = len(state.get('users', []))
        print(f'📥 Receiving snapshot ({user_count} users)...')

        threading.Thread(target=save_snapshot, args=(state,), daemon=True).start()

        return jsonify({
            'type': 'SNAPSHOT_ACK',
            'status': 'success',
            'message': f'OK ({user_count} users)'
        })

    else:
        print(f'⚠️ Unknown message type: {msg_type}')
        return jsonify({'status': 'error', 'message': f'Unknown type: {msg_type}'}), 400

# ─── Các route trạng thái ──────────────────────────
@app.route('/api/backup/status', methods=['GET'])
def backup_status():
    snap = get_snapshot()
    users_count = len(snap.get('users', [])) if snap else 0
    return jsonify({
        'status': 'ok',
        'snapshot_time': get_snapshot_time(),
        'total_users': users_count,
        'main_server': MAIN_SERVER_URL
    })

@app.route('/api/backup/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'snapshot_time': get_snapshot_time()
    })

# ═══════════════════════════════════════════════════
# GỬI SNAPSHOT LÊN MAIN SERVER (có DH nếu cần)
# ═══════════════════════════════════════════════════
def get_or_create_session_with_main_server():
    """Lấy session DH đã lưu cho main server hoặc thực hiện exchange mới."""
    client_id = f"backup-{os.uname().nodename}"  # ID duy nhất cho backup này
    session = dh_sessions.get(client_id)
    if session:
        return client_id, session['session_key']

    # Thực hiện DH exchange với main server
    try:
        client_keys = DHExchange.generate_keypair()
        resp = requests.post(
            f'{MAIN_SERVER_URL}/api/dh/exchange',
            json={
                'clientId': client_id,
                'clientPublicKey': client_keys['public_key'],
                'token': BACKUP_TOKEN
            },
            timeout=10
        )
        if resp.status_code == 200:
            data = resp.json()
            if 'serverPublicKey' in data:
                shared = DHExchange.compute_shared_secret(
                    client_keys['private_key'],
                    data['serverPublicKey'],
                    data['prime'],
                    data['generator']
                )
                session_key = DHExchange.derive_session_key(shared)
                dh_sessions[client_id] = {
                    'session_key': session_key,
                    'created_at': datetime.now().isoformat()
                }
                print(f'🔐 DH session established with main server ({client_id})')
                return client_id, session_key
    except Exception as e:
        print(f'❌ DH exchange with main server failed: {e}')

    return None, None

def send_snapshot_to_server():
    snap = get_snapshot()
    if not snap or not snap.get('users'):
        print('⚠️ No snapshot data to send')
        return

    # Thử dùng DH session để ký gói tin
    client_id, session_key = get_or_create_session_with_main_server()
    headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'ChocoHub-BackupServer/1.0'
    }

    payload = {
        'type': 'FULL_SNAPSHOT',
        'token': BACKUP_TOKEN,
        'state': snap
    }

    if client_id and session_key:
        # Ký request
        timestamp = str(int(time.time()))
        body_json = json.dumps(payload)
        message = f"POST/api/backup/sync{timestamp}{body_json}"
        signature = DHExchange.sign(message, session_key)
        headers['X-Client-Id'] = client_id
        headers['X-Timestamp'] = timestamp
        headers['X-Signature'] = signature

    print(f'📤 Sending snapshot to {MAIN_SERVER_URL}...')
    try:
        response = requests.post(
            f'{MAIN_SERVER_URL}/api/backup/sync',
            json=payload,
            headers=headers,
            timeout=30
        )
        if response.status_code == 200:
            print('✅ Snapshot sent successfully')
        else:
            print(f'❌ Failed to send snapshot. Status: {response.status_code}')
    except Exception as e:
        print(f'❌ Error sending snapshot: {e}')

# ═══════════════════════════════════════════════════
# MONITORING THREAD
# ═══════════════════════════════════════════════════
def check_main_server():
    try:
        r = requests.get(f'{MAIN_SERVER_URL}/health', timeout=5,
                         headers={'User-Agent': 'ChocoHub-BackupServer/1.0'})
        return r.status_code == 200
    except:
        try:
            r = requests.get(f'{MAIN_SERVER_URL}/api/test', timeout=5)
            return r.status_code == 200
        except:
            return False

def monitor_main_server():
    print(f'🔍 Monitoring main server every {CHECK_INTERVAL}s...')
    was_down = False
    while True:
        time.sleep(CHECK_INTERVAL)
        online = check_main_server()
        now = datetime.now()
        if not online and not was_down:
            print(f'🔴 Main server DOWN at {now.strftime("%H:%M:%S")}')
            was_down = True
        elif online and was_down:
            print(f'🟢 Main server BACK ONLINE at {now.strftime("%H:%M:%S")}')
            send_snapshot_to_server()
            was_down = False
        elif online and now.minute % 5 == 0 and now.second < CHECK_INTERVAL:
            print(f'💚 Monitor active – {now.strftime("%H:%M:%S")}')

# ═══════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════
if __name__ == '__main__':
    print('')
    print('╔══════════════════════════════════════╗')
    print('║   CHOCO HUB - BACKUP SERVER + DH    ║')
    print('╠══════════════════════════════════════╣')
    print(f'║  Port: {BACKUP_PORT}                         ║')
    print(f'║  Main Server: {MAIN_SERVER_URL[:35].ljust(35)} ║')
    print(f'║  Check Interval: {CHECK_INTERVAL}s                    ║')
    print(f'║  DB: {DB_PATH}                          ║')
    print('║  DH Exchange: /api/dh/exchange       ║')
    print('╚══════════════════════════════════════╝')
    print('')
    init_db()
    monitor_thread = threading.Thread(target=monitor_main_server, daemon=True)
    monitor_thread.start()
    app.run(host='0.0.0.0', port=BACKUP_PORT, debug=False)
