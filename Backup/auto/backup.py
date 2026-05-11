# backup.py – Backup Server nhận full snapshot từ ChocoHub (gọn nhẹ, đồng bộ nhanh)
import os
import json
import time
import hashlib
import threading
import requests
import urllib3
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from flask import Flask, request, jsonify
from dotenv import load_dotenv
from datetime import datetime
import sqlite3

load_dotenv()

# Desativa os avisos de InsecureRequestWarning
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

app = Flask(__name__)

# ─── Config ─────────────────────────────────────────
BACKUP_PORT      = int(os.getenv('BACKUP_PORT', 5000))
BACKUP_TOKEN     = os.getenv('BACKUP_TOKEN', 'chocohub-default-token')
MAIN_SERVER_URL  = os.getenv('MAIN_SERVER_URL', 'https://chocohub-r011.onrender.com')
CHECK_INTERVAL   = int(os.getenv('CHECK_INTERVAL', 10))
DB_PATH          = os.getenv('BACKUP_DB_PATH', 'backup.db')
PUBLIC_URL       = os.getenv('PUBLIC_URL', 'https://chocohubbackup.serveousercontent.com')  # URL atual do Cloudflare/Tunnel
NODE_NAME        = os.getenv('NODE_NAME', 'ChocoNode')
NODE_DESCRIPTION = os.getenv('NODE_DESCRIPTION', 'DINAMIC URLS ARE BETTER :<')
NODE_OWNER       = os.getenv('NODE_OWNER', '@BloodFell')
NODE_PLATFORM    = os.getenv('NODE_PLATFORM', 'Serveo')

# FIX: Session com retry automático (resolve hangs e erros TLS intermitentes)
def make_session():
    s = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=1,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=['GET', 'POST']
    )
    adapter = HTTPAdapter(max_retries=retry)
    s.mount('https://', adapter)
    s.mount('http://', adapter)
    s.headers.update({'User-Agent': 'ChocoHub-BackupServer/1.0'})
    return s

http_session = make_session()

# FIX: hash do último snapshot ENVIADO — evita reenviar snapshot idêntico
_last_sent_hash = None

# ─── Khởi tạo SQLite ───────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    # Bảng lưu snapshot mới nhất (chỉ 1 dòng)
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

# ─── Lưu snapshot ──────────────────────────────────
def save_snapshot(state):
    # Salvando como texto puro (sem compressão)
    json_data = json.dumps(state)

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO snapshot (id, state, updated_at)
        VALUES (1, ?, datetime('now'))
    ''', (json_data,))
    conn.commit()
    conn.close()
    print('💾 Snapshot saved')
    print(f"📦 Database size: {os.path.getsize(DB_PATH) / 1024:.2f} KB")

# ─── Lấy snapshot ──────────────────────────────────
def get_snapshot():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT state FROM snapshot WHERE id = 1')
    row = cursor.fetchone()
    conn.close()
    if row:
        try:
            return json.loads(row[0])
        except Exception:
            return None
    return None

# ─── Lấy thời gian cập nhật snapshot ───────────────
def get_snapshot_time():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT updated_at FROM snapshot WHERE id = 1')
    row = cursor.fetchone()
    conn.close()
    return row[0] if row else 'unknown'

# ═══════════════════════════════════════════════════════
# FLASK ROUTES
# ═══════════════════════════════════════════════════════

@app.route('/api/backup/sync', methods=['POST'])
def receive_sync():
    try:
        data = request.get_json()
        if not data:
            return jsonify({'status': 'error', 'message': 'No data'}), 400

        msg_type = data.get('type', '')
        token = data.get('token', '')
        if token != BACKUP_TOKEN:
            return jsonify({'status': 'error', 'message': 'Invalid token'}), 401

        # ─── READY: main server yêu cầu khởi tạo kết nối ───
        if msg_type == 'READY':
            empty = data.get('empty', False)
            if empty:
                snap = get_snapshot()
                if snap and snap.get('users') is not None:  # snapshot có dữ liệu
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
                # Main server đã có dữ liệu, chỉ cần ack
                return jsonify({'type': 'READY_ACK', 'status': 'success', 'message': 'ack'})

        # ─── PING: heartbeat ────────────────────────────
        elif msg_type == 'PING':
            return jsonify({'type': 'PONG', 'timestamp': datetime.now().isoformat()})

        # ─── FULL_SNAPSHOT: nhận snapshot từ main server ──
        elif msg_type == 'FULL_SNAPSHOT':
            if 'state' not in data:
                return jsonify({'status': 'error', 'message': 'Missing state'}), 400
            save_snapshot(data['state'])
            print(f'📥 Received snapshot ({len(data["state"].get("users", []))} users)')
            return jsonify({'type': 'SNAPSHOT_ACK', 'status': 'success'})

        else:
            print(f'⚠️ Unknown message type: {msg_type}')
            return jsonify({'status': 'error', 'message': f'Unknown type: {msg_type}'}), 400

    except Exception as e:
        print(f'❌ Error: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/backup/status', methods=['GET'])
def backup_status():
    snap = get_snapshot()
    db_size_kb = 0
    if os.path.exists(DB_PATH):
        db_size_kb = round(os.path.getsize(DB_PATH) / 1024, 2)

    users_count = len(snap.get('users', [])) if snap else 0
    return jsonify({
        'status': 'ok',
        'name': NODE_NAME,
        'description': NODE_DESCRIPTION,
        'owner': NODE_OWNER,
        'platform': NODE_PLATFORM,
        'snapshot_time': get_snapshot_time(),
        'total_users': users_count,
        'db_size_kb': db_size_kb,
        'main_server': MAIN_SERVER_URL
    })

@app.route('/api/backup/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'snapshot_time': get_snapshot_time()
    })

# ═══════════════════════════════════════════════════════
# GỬI SNAPSHOT LÊN MAIN SERVER (khi phát hiện online)
# ═══════════════════════════════════════════════════════

def send_snapshot_to_server():
    global _last_sent_hash
    snap = get_snapshot()
    if not snap or not snap.get('users'):
        print('⚠️ No snapshot data to send')
        return

    # Skip send if snapshot content hasn't changed
    snap_str  = json.dumps(snap, sort_keys=True)
    snap_hash = hashlib.sha256(snap_str.encode()).hexdigest()[:16]
    if snap_hash == _last_sent_hash:
        print('⏭ Snapshot unchanged, skipping send')
        return

    print(f'📤 Sending snapshot to {MAIN_SERVER_URL} (hash {snap_hash})...')
    try:
        response = http_session.post(
            f'{MAIN_SERVER_URL}/api/backup/sync',
            json={
                'type':  'FULL_SNAPSHOT',
                'token': BACKUP_TOKEN,
                'state': snap
            },
            timeout=30,
            verify=False
        )
        if response.status_code == 200:
            _last_sent_hash = snap_hash
            print(f'✅ Snapshot sent successfully (hash {snap_hash})')
        else:
            print(f'❌ Failed to send snapshot. Status: {response.status_code}')
    except Exception as e:
        print(f'❌ Error sending snapshot: {e}')

# ─── Dynamic node registration with main server ────────────────────────────
# Sends this node's PUBLIC_URL so the main server can connect back to us.
# Called on startup AND periodically so re-registrations happen automatically
# if the main server restarts and loses its in-memory node list.
def register_with_main_server():
    if not PUBLIC_URL:
        print('⚠️ PUBLIC_URL not set in .env — skipping dynamic registration')
        return

    print(f'📡 Registering node "{NODE_NAME}" → {MAIN_SERVER_URL}')
    try:
        res = http_session.post(
            f'{MAIN_SERVER_URL}/api/backup/register',
            json={
                'url':         PUBLIC_URL,
                'token':       BACKUP_TOKEN,
                'name':        NODE_NAME,
                'description': NODE_DESCRIPTION,
                'owner':       NODE_OWNER,
                'platform':    NODE_PLATFORM,
            },
            timeout=15,
            verify=False
        )
        if res.status_code == 200:
            print(f'✅ Node registered successfully: {NODE_NAME} ({PUBLIC_URL})')
        else:
            print(f'ℹ️ Registration not accepted (status {res.status_code}) — main server may be offline')
    except Exception as e:
        print(f'ℹ️ Could not register node: {e}')

# ═══════════════════════════════════════════════════════
# MONITORING THREAD – Theo dõi main server
# ═══════════════════════════════════════════════════════

def check_main_server():
    try:
        r = http_session.get(f'{MAIN_SERVER_URL}/health', timeout=5, verify=False)
        return r.status_code == 200
    except:
        try:
            r = http_session.get(f'{MAIN_SERVER_URL}/api/test', timeout=5, verify=False)
            return r.status_code == 200
        except:
            return False

REREGISTER_INTERVAL = 300  # re-register every 5 min in case main server restarted

def monitor_main_server():
    print(f'🔍 Monitoring main server every {CHECK_INTERVAL}s...')
    was_down = False
    last_register = 0
    while True:
        time.sleep(CHECK_INTERVAL)
        online = check_main_server()
        now = datetime.now()
        now_ts = time.time()

        if not online and not was_down:
            print(f'🔴 Main server DOWN at {now.strftime("%H:%M:%S")}')
            was_down = True
        elif online and was_down:
            print(f'🟢 Main server BACK ONLINE at {now.strftime("%H:%M:%S")}')
            register_with_main_server()   # re-register after downtime
            send_snapshot_to_server()
            was_down = False
            last_register = now_ts
        elif online:
            # Periodic re-registration — covers main server silent restarts
            if now_ts - last_register >= REREGISTER_INTERVAL:
                register_with_main_server()
                last_register = now_ts
            if now.minute % 5 == 0 and now.second < CHECK_INTERVAL:
                print(f'💚 Monitor active – {now.strftime("%H:%M:%S")}')

# ═══════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════
if __name__ == '__main__':
    print('')
    print('╔══════════════════════════════════════╗')
    print('║   CHOCO HUB - BACKUP SERVER         ║')
    print('╠══════════════════════════════════════╣')
    print(f'║  Port: {BACKUP_PORT}                         ║')
    print(f'║  Main Server: {MAIN_SERVER_URL[:35].ljust(35)} ║')
    print(f'║  Check Interval: {CHECK_INTERVAL}s                    ║')
    print(f'║  DB: {DB_PATH}                          ║')
    print('╚══════════════════════════════════════╝')
    print('')
    init_db()
    register_with_main_server()
    monitor_thread = threading.Thread(target=monitor_main_server, daemon=True)
    monitor_thread.start()
    app.run(host='0.0.0.0', port=BACKUP_PORT, debug=False)