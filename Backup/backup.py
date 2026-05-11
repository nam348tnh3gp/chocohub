# backup.py – Backup Server nhận full snapshot từ ChocoHub (bất đồng bộ, chống timeout)
# Tất cả cấu hình đều lấy từ file .env trong thư mục hiện tại.
# KHÔNG có giá trị mặc định cứng trong code — thiếu biến sẽ báo lỗi ngay.
import os
import sys
import json
import time
import threading
import requests
from flask import Flask, request, jsonify
from dotenv import load_dotenv
from datetime import datetime
import sqlite3

# Nạp file .env từ thư mục hiện tại (chocohub/Backup)
load_dotenv()

app = Flask(__name__)

# ─── Config từ .env (không có giá trị mặc định) ────────
BACKUP_PORT     = int(os.getenv('BACKUP_PORT'))          # bắt buộc, VD: 5000
BACKUP_TOKEN    = os.getenv('BACKUP_TOKEN')              # bắt buộc
MAIN_SERVER_URL = os.getenv('MAIN_SERVER_URL')           # bắt buộc
CHECK_INTERVAL  = int(os.getenv('CHECK_INTERVAL'))       # bắt buộc, VD: 10
DB_PATH         = os.getenv('BACKUP_DB_PATH')            # bắt buộc, VD: backup.db

# Kiểm tra nhanh các biến bắt buộc
for var, val in [
    ('BACKUP_PORT', BACKUP_PORT),
    ('BACKUP_TOKEN', BACKUP_TOKEN),
    ('MAIN_SERVER_URL', MAIN_SERVER_URL),
    ('CHECK_INTERVAL', CHECK_INTERVAL),
    ('BACKUP_DB_PATH', DB_PATH),
]:
    if val is None:
        print(f'❌ Biến môi trường {var} chưa được đặt trong file .env')
        sys.exit(1)

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

# ─── Lưu snapshot (bất đồng bộ) ────────────────────
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

        # ─── PING: heartbeat ────────────────────────────
        elif msg_type == 'PING':
            return jsonify({'type': 'PONG', 'timestamp': datetime.now().isoformat()})

        # ─── FULL_SNAPSHOT: nhận snapshot từ main server (bất đồng bộ) ──
        elif msg_type == 'FULL_SNAPSHOT':
            if 'state' not in data:
                return jsonify({'status': 'error', 'message': 'Missing state'}), 400

            state = data['state']
            user_count = len(state.get('users', []))
            print(f'📥 Receiving snapshot ({user_count} users)...')

            # 🔧 Lưu trong thread riêng, trả response ngay lập tức
            threading.Thread(target=save_snapshot, args=(state,), daemon=True).start()

            return jsonify({
                'type': 'SNAPSHOT_ACK',
                'status': 'success',
                'message': f'OK ({user_count} users)'
            })

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
