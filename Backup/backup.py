# backup.py – Backup Server nhận full snapshot từ ChocoHub (gọn nhẹ, đồng bộ nhanh)
import os
import json
import time
import threading
import requests
from flask import Flask, request, jsonify
from dotenv import load_dotenv
from datetime import datetime
import sqlite3

load_dotenv()

app = Flask(__name__)

# ─── Config từ .env ─────────────────────────────────
BACKUP_PORT = int(os.getenv('BACKUP_PORT', 5000))
BACKUP_TOKEN = os.getenv('BACKUP_TOKEN', 'chocohub-default-token')
MAIN_SERVER_URL = os.getenv('MAIN_SERVER_URL', 'https://chocohub-r011.onrender.com')
CHECK_INTERVAL = int(os.getenv('CHECK_INTERVAL', 10))
DB_PATH = os.getenv('BACKUP_DB_PATH', 'backup.db')

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
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO snapshot (id, state, updated_at)
        VALUES (1, ?, datetime('now'))
    ''', (json.dumps(state),))
    conn.commit()
    conn.close()
    print('💾 Snapshot saved')

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
        except:
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

# ═══════════════════════════════════════════════════════
# GỬI SNAPSHOT LÊN MAIN SERVER (khi phát hiện online)
# ═══════════════════════════════════════════════════════

def send_snapshot_to_server():
    snap = get_snapshot()
    if not snap or not snap.get('users'):
        print('⚠️ No snapshot data to send')
        return
    print(f'📤 Sending snapshot to {MAIN_SERVER_URL}...')
    try:
        response = requests.post(
            f'{MAIN_SERVER_URL}/api/backup/sync',
            json={
                'type': 'FULL_SNAPSHOT',
                'token': BACKUP_TOKEN,
                'state': snap
            },
            headers={'Content-Type': 'application/json', 'User-Agent': 'ChocoHub-BackupServer/1.0'},
            timeout=30
        )
        if response.status_code == 200:
            print('✅ Snapshot sent successfully')
        else:
            print(f'❌ Failed to send snapshot. Status: {response.status_code}')
    except Exception as e:
        print(f'❌ Error sending snapshot: {e}')

# ═══════════════════════════════════════════════════════
# MONITORING THREAD – Theo dõi main server
# ═══════════════════════════════════════════════════════

def check_main_server():
    try:
        r = requests.get(f'{MAIN_SERVER_URL}/health', timeout=5, headers={'User-Agent': 'ChocoHub-BackupServer/1.0'})
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
    monitor_thread = threading.Thread(target=monitor_main_server, daemon=True)
    monitor_thread.start()
    app.run(host='0.0.0.0', port=BACKUP_PORT, debug=False)
