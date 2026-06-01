# backup.py – Backup Server (Flask) với canonical JSON, DH + RSA, history, chống ghi đè
import os
import sys
import json
import time
import threading
import traceback
import hashlib
import sqlite3
from datetime import datetime

import requests
from flask import Flask, request, jsonify
from dotenv import dotenv_values

from dh import DHExchange

# ------------------------------------------------------------
# 1. Canonical JSON (sắp xếp key alphabet)
# ------------------------------------------------------------
def canonical_stringify(obj):
    if obj is None or isinstance(obj, (str, int, float, bool)):
        return json.dumps(obj)
    if isinstance(obj, list):
        return '[' + ','.join(canonical_stringify(item) for item in obj) + ']'
    if isinstance(obj, dict):
        sorted_keys = sorted(obj.keys())
        pairs = [f'"{k}":{canonical_stringify(obj[k])}' for k in sorted_keys]
        return '{' + ','.join(pairs) + '}'
    raise TypeError(f'Unsupported type: {type(obj)}')

# ------------------------------------------------------------
# 2. Cấu hình từ .env
# ------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, '.env')

if not os.path.exists(ENV_PATH):
    print(f'❌ .env not found at {ENV_PATH}')
    sys.exit(1)

config = dotenv_values(ENV_PATH)

BACKUP_PORT     = int(config.get('BACKUP_PORT', 3001))
BACKUP_TOKEN    = config.get('BACKUP_TOKEN', 'chocohub-default-token')
MAIN_SERVER_URL = config.get('MAIN_SERVER_URL', 'https://chocohub-r011.onrender.com')
CHECK_INTERVAL  = int(config.get('CHECK_INTERVAL', '10'))
DB_PATH         = os.path.join(BASE_DIR, config.get('BACKUP_DB_PATH', 'backup.db'))
MAX_BACKUPS     = int(config.get('MAX_BACKUPS', '3'))
SELF_URL        = config.get('SELF_URL', '')

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = None   # không giới hạn kích thước snapshot

# ------------------------------------------------------------
# 3. RSA long‑term keys (server authentication)
# ------------------------------------------------------------
RSA_PRIVATE_PATH = os.path.join(BASE_DIR, 'backup_private.pem')
RSA_PUBLIC_PATH  = os.path.join(BASE_DIR, 'backup_public.pem')

if os.path.exists(RSA_PRIVATE_PATH) and os.path.exists(RSA_PUBLIC_PATH):
    with open(RSA_PRIVATE_PATH, 'r') as f:
        server_private_key_pem = f.read()
    with open(RSA_PUBLIC_PATH, 'r') as f:
        server_public_key_pem = f.read()
    print('🔑 Loaded existing RSA long‑term keys.')
else:
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives import serialization
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
    server_private_key_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    ).decode()
    server_public_key_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    with open(RSA_PRIVATE_PATH, 'w') as f:
        f.write(server_private_key_pem)
    with open(RSA_PUBLIC_PATH, 'w') as f:
        f.write(server_public_key_pem)
    print('🔧 Generated new RSA long‑term keys.')

# ------------------------------------------------------------
# 4. DH keys & sessions
# ------------------------------------------------------------
server_dh_keys = DHExchange.generate_standard_keypair('modp2048')
dh_sessions = {}   # client_id -> {'session_key': str, 'created_at': str}

# ------------------------------------------------------------
# 5. SQLite DB (snapshot + history)
# ------------------------------------------------------------
def init_db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    cursor = conn.cursor()
    # Bảng snapshot chính
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS snapshot (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            state TEXT NOT NULL,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    ''')
    cursor.execute('INSERT OR IGNORE INTO snapshot (id, state) VALUES (1, "{}")')
    # Bảng lịch sử backup
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS snapshot_backups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            state TEXT NOT NULL,
            users_count INTEGER DEFAULT 0,
            total_items INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        )
    ''')
    conn.commit()
    conn.close()
    print('✅ Backup database ready (snapshot + history)')

def count_snapshot_size(state):
    users = len(state.get('users', []))
    stakes = len(state.get('stakes', []))
    blocks = len(state.get('blocks', []))
    transactions = len(state.get('transactions', []))
    total = users + stakes + blocks + transactions
    return {'total': total, 'users': users}

def save_snapshot(state):
    """Lưu snapshot hiện tại, đồng thời backup bản cũ vào history nếu thay đổi."""
    json_state = canonical_stringify(state)
    new_size = count_snapshot_size(state)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    cursor = conn.cursor()
    try:
        # Lấy snapshot cũ
        old_row = cursor.execute('SELECT state FROM snapshot WHERE id = 1').fetchone()
        old_state_json = old_row[0] if old_row else '{}'
        if old_state_json != json_state:
            # Backup bản cũ vào history
            old_state = json.loads(old_state_json) if old_state_json != '{}' else {}
            old_size = count_snapshot_size(old_state)
            cursor.execute('''
                INSERT INTO snapshot_backups (state, users_count, total_items)
                VALUES (?, ?, ?)
            ''', (old_state_json, old_size['users'], old_size['total']))
            print(f'📦 Backup bản cũ ({old_size["users"]} users) vào history')
            # Xóa những bản backup cũ hơn giữ lại tối đa MAX_BACKUPS
            cursor.execute('''
                DELETE FROM snapshot_backups WHERE id NOT IN (
                    SELECT id FROM snapshot_backups
                    ORDER BY created_at DESC LIMIT ?
                )
            ''', (MAX_BACKUPS,))
        # Cập nhật snapshot chính
        cursor.execute('''
            INSERT OR REPLACE INTO snapshot (id, state, updated_at)
            VALUES (1, ?, datetime('now'))
        ''', (json_state,))
        conn.commit()
        size_kb = len(json_state) / 1024
        print(f'💾 Snapshot saved ({new_size["users"]} users, {new_size["total"]} items, {size_kb:.1f} KB)')
    except Exception as e:
        print(f'❌ Save error: {e}')
        traceback.print_exc()
        conn.rollback()
    finally:
        conn.close()

def get_snapshot():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    row = cursor.execute('SELECT state FROM snapshot WHERE id = 1').fetchone()
    conn.close()
    if row and row[0]:
        try:
            return json.loads(row[0])
        except:
            return None
    return None

def get_snapshot_time():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    row = cursor.execute('SELECT updated_at FROM snapshot WHERE id = 1').fetchone()
    conn.close()
    return row[0] if row else 'unknown'

# ------------------------------------------------------------
# 6. Middleware xác thực HMAC (cho các route /api/backup/*)
# ------------------------------------------------------------
@app.before_request
def verify_dh_signature():
    if not request.path.startswith('/api/backup'):
        return
    client_id = request.headers.get('X-Client-Id') or request.args.get('clientId')
    signature = request.headers.get('X-Signature')
    if not client_id or not signature:
        return  # không có chữ ký -> bỏ qua, các route sẽ tự xử lý token
    session = dh_sessions.get(client_id)
    if not session:
        return
    timestamp = request.headers.get('X-Timestamp', '')
    body_str = request.get_data(as_text=True) if request.method == 'POST' else ''
    message = f"{request.method}{request.path}{timestamp}{body_str}"
    if not DHExchange.verify(message, signature, session['session_key']):
        # Trả về 401 và ngắt request
        response = jsonify({'status': 'error', 'message': 'Invalid HMAC signature'})
        response.status_code = 401
        return response

# ------------------------------------------------------------
# 7. Routes public
# ------------------------------------------------------------
@app.route('/api/backup/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'snapshot_time': get_snapshot_time()
    })

@app.route('/api/backup/status', methods=['GET'])
def status():
    snap = get_snapshot()
    users = len(snap.get('users', [])) if snap else 0
    return jsonify({
        'status': 'ok',
        'total_users': users,
        'snapshot_time': get_snapshot_time(),
        'main_server': MAIN_SERVER_URL,
        'max_backups': MAX_BACKUPS
    })

@app.route('/api/backup/history', methods=['GET'])
def history():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    rows = cursor.execute('''
        SELECT id, users_count, total_items, created_at
        FROM snapshot_backups
        ORDER BY created_at DESC
        LIMIT 10
    ''').fetchall()
    conn.close()
    history_list = [
        {'id': r[0], 'users_count': r[1], 'total_items': r[2], 'created_at': r[3]}
        for r in rows
    ]
    return jsonify({'status': 'success', 'history': history_list, 'max_backups': MAX_BACKUPS})

@app.route('/api/backup/restore/<int:backup_id>', methods=['POST'])
def restore_backup(backup_id):
    token = request.headers.get('X-Backup-Token') or request.json.get('token', '')
    if token != BACKUP_TOKEN:
        return jsonify({'status': 'error', 'message': 'Invalid token'}), 401
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    row = cursor.execute('SELECT state FROM snapshot_backups WHERE id = ?', (backup_id,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'status': 'error', 'message': 'Backup not found'}), 404
    try:
        state = json.loads(row[0])
        current = get_snapshot()
        if current and current.get('users'):
            # Backup snapshot hiện tại trước khi ghi đè
            current_size = count_snapshot_size(current)
            cursor.execute('''
                INSERT INTO snapshot_backups (state, users_count, total_items)
                VALUES (?, ?, ?)
            ''', (canonical_stringify(current), current_size['users'], current_size['total']))
        # Ghi đè snapshot chính
        cursor.execute('''
            INSERT OR REPLACE INTO snapshot (id, state, updated_at)
            VALUES (1, ?, datetime('now'))
        ''', (canonical_stringify(state),))
        conn.commit()
        size = count_snapshot_size(state)
        print(f'🔄 Restored backup #{backup_id} ({size["users"]} users)')
        return jsonify({'status': 'success', 'message': f'Restored backup #{backup_id}', 'users': size['users']})
    except Exception as e:
        conn.rollback()
        return jsonify({'status': 'error', 'message': str(e)}), 500
    finally:
        conn.close()

@app.route('/api/server/public-key', methods=['GET'])
def server_public_key():
    return jsonify({
        'status': 'success',
        'publicKey': server_public_key_pem,
        'algorithm': 'RSA-4096',
        'purpose': 'DH server authentication'
    })

# ------------------------------------------------------------
# 8. DH key exchange (có chữ ký server)
# ------------------------------------------------------------
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

    print(f'🔍 DH exchange request from {client_id}')
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
        # Ký dữ liệu public key của server bằng RSA private key
        server_pub_data = canonical_stringify({
            'publicKey': server_dh_keys['public_key'],
            'prime': server_dh_keys['prime'],
            'generator': server_dh_keys['generator'],
            'group': server_dh_keys['group']
        })
        server_signature = DHExchange.sign_with_private_key(server_pub_data, server_private_key_pem)
        print(f'🔐 DH session established with {client_id}')
        return jsonify({
            'status': 'success',
            'serverPublicKey': server_dh_keys['public_key'],
            'prime': server_dh_keys['prime'],
            'generator': server_dh_keys['generator'],
            'group': server_dh_keys['group'],
            'serverSignature': server_signature
        })
    except Exception as e:
        print(f'❌ DH exchange error: {e}')
        traceback.print_exc()
        return jsonify({'status': 'error', 'message': 'Key exchange failed'}), 500

# ------------------------------------------------------------
# 9. Đồng bộ snapshot (giao thức READY / REQUEST_SNAPSHOT / FULL_SNAPSHOT)
# ------------------------------------------------------------
@app.route('/api/backup/sync', methods=['POST'])
def sync():
    if not request.is_json:
        return jsonify({'status': 'error', 'message': 'JSON required'}), 400
    data = request.get_json()
    msg_type = data.get('type')
    token = data.get('token', '')
    client_id = request.headers.get('X-Client-Id')

    # Xác thực: ưu tiên session, nếu không có thì dùng token
    session = dh_sessions.get(client_id) if client_id else None
    if not session and token != BACKUP_TOKEN:
        return jsonify({'status': 'error', 'message': 'Invalid token or no session'}), 401

    if msg_type == 'READY':
        client_empty = data.get('empty', False)
        server_has_data = get_snapshot() and len(get_snapshot().get('users', [])) > 0
        print(f'📋 READY: client_empty={client_empty}, server_has_data={server_has_data}')

        if client_empty:
            snap = get_snapshot()
            if snap and snap.get('users'):
                print(f'📤 Sending full snapshot ({len(snap["users"])} users)')
                return jsonify({
                    'type': 'FULL_SNAPSHOT',
                    'token': BACKUP_TOKEN,
                    'state': snap
                })
            else:
                return jsonify({'type': 'READY_ACK', 'status': 'success', 'message': 'ready but empty'})
        elif not client_empty and not server_has_data:
            print('📤 Server empty, requesting snapshot from client')
            return jsonify({'type': 'REQUEST_SNAPSHOT', 'message': 'Server is empty, please send your snapshot'})
        else:
            print('✅ Both have data or both empty, sending READY_ACK')
            return jsonify({'type': 'READY_ACK', 'status': 'success', 'message': 'ack'})

    elif msg_type == 'PING':
        return jsonify({'type': 'PONG', 'timestamp': datetime.now().isoformat()})

    elif msg_type == 'FULL_SNAPSHOT':
        if 'state' not in data:
            return jsonify({'status': 'error', 'message': 'Missing state'}), 400
        state = data['state']
        new_size = count_snapshot_size(state)
        current = get_snapshot()

        # Tính hash của snapshot mới (dùng canonical JSON)
        new_hash = hashlib.sha256(canonical_stringify(state).encode()).hexdigest()
        if current and current.get('users'):
            current_hash = hashlib.sha256(canonical_stringify(current).encode()).hexdigest()
            if new_hash == current_hash:
                print('⏭ Snapshot identical (same hash), skipping')
                return jsonify({'type': 'SNAPSHOT_ACK', 'status': 'skipped', 'message': 'Identical'})
            current_total = count_snapshot_size(current)['total']
            if new_size['total'] < current_total * 0.5:
                print(f'⚠️ SKIP snapshot: {new_size["total"]} items < 50% of current {current_total} items (possible regression)')
                return jsonify({'type': 'SNAPSHOT_ACK', 'status': 'skipped', 'message': 'Less data'})

        print(f'📥 Receiving snapshot ({new_size["users"]} users, {new_size["total"]} items)...')
        # Lưu snapshot (đồng bộ để đảm bảo dữ liệu nhất quán)
        save_snapshot(state)
        return jsonify({'type': 'SNAPSHOT_ACK', 'status': 'success', 'message': f'OK ({new_size["users"]} users)'})

    else:
        return jsonify({'status': 'error', 'message': f'Unknown type: {msg_type}'}), 400

# ------------------------------------------------------------
# 10. Gửi snapshot lên main server (khi main server online lại)
# ------------------------------------------------------------
main_server_public_key = None

def fetch_main_server_public_key():
    global main_server_public_key
    try:
        resp = requests.get(f'{MAIN_SERVER_URL}/api/server/public-key', timeout=5, verify=True)
        if resp.status_code == 200:
            main_server_public_key = resp.json().get('publicKey')
            print('🔑 Fetched main server public key')
            return True
    except Exception as e:
        print(f'❌ Could not fetch main server public key: {e}')
    return False

def get_session_with_main_server():
    """Thiết lập DH session với main server, trả về (client_id, session_key) hoặc (None, None)."""
    global main_server_public_key
    client_id = f'backup-{os.uname().nodename}'
    session = dh_sessions.get(client_id)
    if session:
        return client_id, session['session_key']

    if not main_server_public_key and not fetch_main_server_public_key():
        return None, None

    try:
        client_dh = DHExchange.generate_standard_keypair('modp2048')
        resp = requests.post(
            f'{MAIN_SERVER_URL}/api/dh/exchange',
            json={
                'clientId': client_id,
                'clientPublicKey': client_dh['public_key'],
                'token': BACKUP_TOKEN
            },
            timeout=10,
            verify=True
        )
        if resp.status_code == 200:
            data = resp.json()
            if 'serverPublicKey' not in data or 'serverSignature' not in data:
                return None, None
            # Xác minh chữ ký của main server
            server_pub_data = canonical_stringify({
                'publicKey': data['serverPublicKey'],
                'prime': data['prime'],
                'generator': data['generator'],
                'group': data.get('group', 'modp2048')
            })
            if not DHExchange.verify_with_public_key(server_pub_data, data['serverSignature'], main_server_public_key):
                print('❌ Main server signature verification failed!')
                return None, None
            shared = DHExchange.compute_shared_secret(
                client_dh['private_key'],
                data['serverPublicKey'],
                data['prime'],
                data['generator']
            )
            session_key = DHExchange.derive_session_key(shared)
            dh_sessions[client_id] = {
                'session_key': session_key,
                'created_at': datetime.now().isoformat()
            }
            print('🔐 Authenticated DH session with main server')
            return client_id, session_key
    except Exception as e:
        print(f'❌ DH exchange with main server failed: {e}')
    return None, None

def send_snapshot_to_main_server():
    snap = get_snapshot()
    if not snap or not snap.get('users'):
        print('⚠️ No snapshot data to send')
        return
    client_id, session_key = get_session_with_main_server()
    payload = {
        'type': 'FULL_SNAPSHOT',
        'token': BACKUP_TOKEN,
        'state': snap
    }
    body_str = canonical_stringify(payload)
    headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'ChocoHub-BackupServer/1.0'
    }
    if client_id and session_key:
        timestamp = str(int(time.time()))
        message = f'POST/api/backup/sync{timestamp}{body_str}'
        signature = DHExchange.sign(message, session_key)
        headers['X-Client-Id'] = client_id
        headers['X-Timestamp'] = timestamp
        headers['X-Signature'] = signature
    print(f'📤 Sending snapshot to main server ({len(snap.get("users", []))} users, {len(body_str)/1024:.1f} KB)...')
    try:
        resp = requests.post(
            f'{MAIN_SERVER_URL}/api/backup/sync',
            data=body_str,
            headers=headers,
            timeout=30,
            verify=True
        )
        if resp.status_code == 200:
            print('✅ Snapshot sent to main server')
        else:
            print(f'❌ Send snapshot failed: {resp.status_code} - {resp.text[:200]}')
    except Exception as e:
        print(f'❌ Error sending snapshot: {e}')

# ------------------------------------------------------------
# 11. Đăng ký với main server (nếu SELF_URL được cấu hình)
# ------------------------------------------------------------
def register_with_main_server():
    if not SELF_URL:
        return
    try:
        payload = canonical_stringify({
            'url': SELF_URL,
            'token': BACKUP_TOKEN,
            'name': 'ChocoHub Backup Server (Python)',
            'platform': 'Python'
        })
        resp = requests.post(
            f'{MAIN_SERVER_URL}/api/backup/register',
            data=payload,
            headers={'Content-Type': 'application/json'},
            timeout=10,
            verify=True
        )
        if resp.status_code == 200:
            print(f'📡 Registered with main server as {SELF_URL}')
        else:
            print(f'⚠️ Registration failed: {resp.status_code}')
    except Exception as e:
        print(f'❌ Could not register with main server: {e}')

# ------------------------------------------------------------
# 12. Giám sát main server (gửi snapshot khi online lại)
# ------------------------------------------------------------
def check_main_server():
    try:
        r = requests.get(f'{MAIN_SERVER_URL}/health', timeout=5, verify=True)
        return r.status_code == 200
    except:
        try:
            r = requests.get(f'{MAIN_SERVER_URL}/api/test', timeout=5, verify=True)
            return r.status_code == 200
        except:
            return False

def monitor_main_server():
    print(f'🔍 Monitoring main server every {CHECK_INTERVAL}s...')
    was_down = False
    while True:
        time.sleep(CHECK_INTERVAL)
        online = check_main_server()
        if not online and not was_down:
            print(f'🔴 Main server DOWN at {datetime.now().strftime("%H:%M:%S")}')
            was_down = True
        elif online and was_down:
            print(f'🟢 Main server BACK ONLINE at {datetime.now().strftime("%H:%M:%S")}')
            send_snapshot_to_main_server()
            was_down = False
        elif online and datetime.now().minute % 5 == 0 and datetime.now().second < CHECK_INTERVAL:
            print(f'💚 Monitor active – {datetime.now().strftime("%H:%M:%S")}')

# ------------------------------------------------------------
# 13. Khởi động
# ------------------------------------------------------------
if __name__ == '__main__':
    print('')
    print('╔══════════════════════════════════════╗')
    print('║   CHOCO HUB - BACKUP SERVER + DH    ║')
    print('╠══════════════════════════════════════╣')
    print(f'║  Port: {BACKUP_PORT}                         ║')
    print(f'║  Main Server: {MAIN_SERVER_URL[:35].ljust(35)} ║')
    print(f'║  Check Interval: {CHECK_INTERVAL}s                    ║')
    print(f'║  Max backups: {MAX_BACKUPS}                         ║')
    print('║  Canonical JSON: ON                 ║')
    print('║  REQUEST_SNAPSHOT: ON               ║')
    print('║  Anti-overwrite: HASH-BASED         ║')
    print('╚══════════════════════════════════════╝')
    print('')

    init_db()
    # Đăng ký với main server nếu có SELF_URL
    register_with_main_server()
    # Chạy luồng giám sát
    monitor_thread = threading.Thread(target=monitor_main_server, daemon=True)
    monitor_thread.start()
    # Chạy Flask
    app.run(host='0.0.0.0', port=BACKUP_PORT, debug=False, threaded=True)
