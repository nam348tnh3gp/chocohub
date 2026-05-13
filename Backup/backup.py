# backup.py – Backup Server nhận full snapshot + Diffie‑Hellman (nhóm chuẩn) + server authentication
import os
import sys
import json
import time
import threading
import traceback                       # 🆕 để in stack trace chi tiết
import requests
from flask import Flask, request, jsonify
from dotenv import dotenv_values
from datetime import datetime
import sqlite3

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

# ─── Tạo / nạp RSA key pair cho server authentication ──
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
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption()
    ).decode()
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo
    ).decode()
    with open(RSA_PRIVATE_PATH, 'w') as f:
        f.write(private_pem)
    with open(RSA_PUBLIC_PATH, 'w') as f:
        f.write(public_pem)
    server_private_key_pem = private_pem
    server_public_key_pem = public_pem
    print('🔧 Generated new RSA long‑term keys.')

# ─── DH keys của backup server (dùng nhóm chuẩn modp2048) ──
server_dh_keys = DHExchange.generate_standard_keypair()
print(f'🔧 Server DH keys generated (group: {server_dh_keys["group"]})')
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

    if not client_id or not signature:
        return

    session = dh_sessions.get(client_id)
    if not session:
        return

    timestamp = request.headers.get('X-Timestamp', '')
    body_str = request.get_data(as_text=True) if request.method == 'POST' else ''
    message = f"{request.method}{request.path}{timestamp}{body_str}"

    if not DHExchange.verify(message, signature, session['session_key']):
        return jsonify({'status': 'error', 'message': 'Invalid HMAC signature'}), 401

# ═══════════════════════════════════════════════════
# ROUTE: Lấy public key dài hạn của backup server
# ═══════════════════════════════════════════════════
@app.route('/api/server/public-key', methods=['GET'])
def server_public_key():
    return jsonify({
        'status': 'success',
        'publicKey': server_public_key_pem,
        'algorithm': 'RSA-4096',
        'purpose': 'DH server authentication'
    })

# ═══════════════════════════════════════════════════
# ROUTE: DH KEY EXCHANGE (có chữ ký server) – ĐÃ THÊM LOG
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

    # 🆕 Log đầu vào
    print(f'🔍 DH exchange request from {client_id}')
    print(f'   client public key (first 60 chars): {client_public_key[:60]}...')
    print(f'   prime (first 60 chars): {server_dh_keys["prime"][:60]}...')
    print(f'   generator: {server_dh_keys["generator"]}')

    try:
        shared_secret = DHExchange.compute_shared_secret(
            server_dh_keys['private_key'],
            client_public_key,
            server_dh_keys['prime'],
            server_dh_keys['generator']
        )
        print(f'   shared secret computed (first 40 chars): {shared_secret[:40]}...')
        session_key = DHExchange.derive_session_key(shared_secret)
        print(f'   session key derived (first 40 chars): {session_key[:40]}...')

        dh_sessions[client_id] = {
            'session_key': session_key,
            'created_at': datetime.now().isoformat()
        }

        server_pub_data = json.dumps({
            'publicKey': server_dh_keys['public_key'],
            'prime': server_dh_keys['prime'],
            'generator': server_dh_keys['generator'],
            'group': server_dh_keys['group']
        })
        server_signature = DHExchange.sign_with_private_key(server_pub_data, server_private_key_pem)

        print(f'🔐 DH session established with {client_id} (server signed)')
        return jsonify({
            'status': 'success',
            'serverPublicKey': server_dh_keys['public_key'],
            'prime': server_dh_keys['prime'],
            'generator': server_dh_keys['generator'],
            'group': server_dh_keys['group'],
            'serverSignature': server_signature,
            'message': 'Session key established'
        })
    except Exception as e:
        print(f'❌ DH exchange error for {client_id}: {e}')
        traceback.print_exc()          # In toàn bộ stack trace
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
        if not token or token != BACKUP_TOKEN:
            return jsonify({'status': 'error', 'message': 'Invalid token or no session'}), 401

    if msg_type == 'READY':
        empty = data.get('empty', False)
        if empty:
            snap = get_snapshot()
            if snap and snap.get('users') is not None:
                print(f'📤 Sending full snapshot ({len(snap.get("users", []))} users)')
                return jsonify({
                    'type': 'FULL_SNAPSHOT',
                    'token': BACKUP_TOKEN,
                    'state': snap
                })
            else:
                return jsonify({'type': 'READY_ACK', 'status': 'success', 'message': 'ready but empty'})
        else:
            return jsonify({'type': 'READY_ACK', 'status': 'success', 'message': 'ack'})

    elif msg_type == 'PING':
        return jsonify({'type': 'PONG', 'timestamp': datetime.now().isoformat()})

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
# GỬI SNAPSHOT LÊN MAIN SERVER (có xác thực server)
# ═══════════════════════════════════════════════════

# Lưu public key của main server sau khi fetch
main_server_public_key = None

def fetch_main_server_public_key():
    global main_server_public_key
    try:
        resp = requests.get(f'{MAIN_SERVER_URL}/api/server/public-key', timeout=5, verify=True)
        if resp.status_code == 200:
            data = resp.json()
            main_server_public_key = data.get('publicKey')
            print(f'🔑 Fetched main server public key')
            return True
    except Exception as e:
        print(f'❌ Could not fetch main server public key: {e}')
    return False

def get_or_create_session_with_main_server():
    """Lấy session DH với main server, có xác minh chữ ký server."""
    global main_server_public_key
    client_id = f"backup-{os.uname().nodename}"

    session = dh_sessions.get(client_id)
    if session:
        return client_id, session['session_key']

    # Nếu chưa có public key của main server, thử fetch
    if not main_server_public_key:
        if not fetch_main_server_public_key():
            print('⚠️ Cannot authenticate main server – skipping DH session')
            return None, None

    try:
        client_dh_keys = DHExchange.generate_standard_keypair()
        resp = requests.post(
            f'{MAIN_SERVER_URL}/api/dh/exchange',
            json={
                'clientId': client_id,
                'clientPublicKey': client_dh_keys['public_key'],
                'token': BACKUP_TOKEN
            },
            timeout=10,
            verify=True
        )
        if resp.status_code == 200:
            data = resp.json()
            if 'serverPublicKey' not in data or 'serverSignature' not in data:
                return None, None

            # Xác minh chữ ký server
            server_pub_data = json.dumps({
                'publicKey': data['serverPublicKey'],
                'prime': data['prime'],
                'generator': data['generator'],
                'group': data.get('group', 'modp2048')
            })
            if not DHExchange.verify_with_public_key(server_pub_data, data['serverSignature'], main_server_public_key):
                print('❌ Main server signature verification failed!')
                return None, None

            shared = DHExchange.compute_shared_secret(
                client_dh_keys['private_key'],
                data['serverPublicKey'],
                data['prime'],
                data['generator']
            )
            session_key = DHExchange.derive_session_key(shared)
            dh_sessions[client_id] = {
                'session_key': session_key,
                'created_at': datetime.now().isoformat()
            }
            print(f'🔐 Authenticated DH session established with main server')
            return client_id, session_key
    except Exception as e:
        print(f'❌ DH exchange with main server failed: {e}')

    return None, None

def send_snapshot_to_server():
    snap = get_snapshot()
    if not snap or not snap.get('users'):
        print('⚠️ No snapshot data to send')
        return

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
            timeout=30,
            verify=True
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
                         headers={'User-Agent': 'ChocoHub-BackupServer/1.0'}, verify=True)
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
    print('║  Server PubKey: /api/server/public-key║')
    print('╚══════════════════════════════════════╝')
    print('')
    init_db()
    monitor_thread = threading.Thread(target=monitor_main_server, daemon=True)
    monitor_thread.start()
    app.run(host='0.0.0.0', port=BACKUP_PORT, debug=False)
