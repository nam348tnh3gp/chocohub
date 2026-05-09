# backup.py – Backup Server nhận sync từ ChocoHub qua HTTP
import os
import json
import time
import threading
import requests
from flask import Flask, request, jsonify
from dotenv import load_dotenv
from datetime import datetime
import sqlite3
from pathlib import Path

load_dotenv()

app = Flask(__name__)

# ─── Config từ .env ─────────────────────────────────
BACKUP_PORT = int(os.getenv('BACKUP_PORT', 5000))
BACKUP_TOKEN = os.getenv('BACKUP_TOKEN', 'chocohub-default-token')
MAIN_SERVER_URL = os.getenv('MAIN_SERVER_URL', 'https://chocohub-r011.onrender.com')
CHECK_INTERVAL = int(os.getenv('CHECK_INTERVAL', 10))  # Giây
MAX_READY_RETRIES = int(os.getenv('MAX_READY_RETRIES', 2))
DB_PATH = os.getenv('BACKUP_DB_PATH', 'backup.db')

# ─── Khởi tạo SQLite ───────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS backup_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seq INTEGER NOT NULL,
            data_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            received_at TEXT DEFAULT (datetime('now'))
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sync_state (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            last_seq INTEGER NOT NULL DEFAULT 0,
            last_ready_time TEXT,
            ready_count INTEGER DEFAULT 0
        )
    ''')
    cursor.execute('INSERT OR IGNORE INTO sync_state (id, last_seq, ready_count) VALUES (1, 0, 0)')
    conn.commit()
    conn.close()
    print('✅ Backup database ready')

# ─── Lưu dữ liệu backup ────────────────────────────
def save_backup(seq, data_type, payload):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        'INSERT INTO backup_data (seq, data_type, payload) VALUES (?, ?, ?)',
        (seq, data_type, json.dumps(payload))
    )
    # Cập nhật last_seq
    cursor.execute('UPDATE sync_state SET last_seq = MAX(last_seq, ?) WHERE id = 1', (seq,))
    conn.commit()
    conn.close()
    print(f'💾 Saved backup: seq={seq}, type={data_type}')

# ─── Lấy dữ liệu backup mới nhất ────────────────────
def get_latest_backup():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT seq, data_type, payload FROM backup_data ORDER BY seq DESC LIMIT 1')
    row = cursor.fetchone()
    conn.close()
    if row:
        return {
            'seq': row[0],
            'type': row[1],
            'payload': json.loads(row[2])
        }
    return None

# ─── Lấy toàn bộ backup data ────────────────────────
def get_all_backup_data():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT seq, data_type, payload FROM backup_data ORDER BY seq ASC')
    rows = cursor.fetchall()
    conn.close()
    return [{'seq': r[0], 'type': r[1], 'payload': json.loads(r[2])} for r in rows]

# ─── Cập nhật ready count ───────────────────────────
def update_ready_count():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        UPDATE sync_state 
        SET ready_count = ready_count + 1,
            last_ready_time = datetime('now')
        WHERE id = 1
    ''')
    cursor.execute('SELECT ready_count FROM sync_state WHERE id = 1')
    count = cursor.fetchone()[0]
    conn.commit()
    conn.close()
    return count

# ─── Reset ready count ──────────────────────────────
def reset_ready_count():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('UPDATE sync_state SET ready_count = 0 WHERE id = 1')
    conn.commit()
    conn.close()

# ═══════════════════════════════════════════════════════
# FLASK ROUTES – Nhận sync từ server.js
# ═══════════════════════════════════════════════════════

@app.route('/api/backup/sync', methods=['POST'])
def receive_sync():
    """Nhận READY, PING, DELTA từ main server"""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'status': 'error', 'message': 'No data'}), 400
        
        msg_type = data.get('type', 'UNKNOWN')
        token = data.get('token', '')
        seq = data.get('seq', 0)
        
        print(f'📥 Received: type={msg_type}, seq={seq}')
        
        # Verify token
        if token != BACKUP_TOKEN:
            return jsonify({'status': 'error', 'message': 'Invalid token'}), 401
        
        if msg_type == 'READY':
            # Đếm số lần READY
            count = update_ready_count()
            print(f'🔔 READY received (count: {count}/{MAX_READY_RETRIES})')
            
            # Lưu backup
            save_backup(seq, 'READY', data)
            
            # Nếu READY >= MAX_READY_RETRIES lần → server vừa restart
            if count >= MAX_READY_RETRIES:
                print('🔄 Detected server restart! Will send backup...')
                # Reset count để tránh gửi lại liên tục
                reset_ready_count()
                # Trigger gửi backup trong background
                threading.Thread(target=send_full_backup_to_server, daemon=True).start()
            
            return jsonify({
                'type': 'READY_ACK',
                'seq': seq,
                'status': 'success'
            })
        
        elif msg_type == 'PING':
            # Heartbeat – reset ready count vì server vẫn alive
            reset_ready_count()
            return jsonify({
                'type': 'PONG',
                'seq': seq,
                'timestamp': datetime.now().isoformat()
            })
        
        elif msg_type == 'DELTA':
            # Nhận delta update
            save_backup(seq, 'DELTA', data)
            return jsonify({
                'type': 'DELTA_ACK',
                'seq': seq
            })
        
        elif msg_type == 'FULL_BACKUP':
            # Nhận full backup từ server (nếu có)
            save_backup(seq, 'FULL_BACKUP', data)
            return jsonify({
                'type': 'BACKUP_ACK',
                'seq': seq
            })
        
        else:
            print(f'⚠️ Unknown message type: {msg_type}')
            return jsonify({'status': 'error', 'message': f'Unknown type: {msg_type}'}), 400
            
    except Exception as e:
        print(f'❌ Error processing sync: {e}')
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/backup/status', methods=['GET'])
def backup_status():
    """Kiểm tra trạng thái backup server"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT last_seq, last_ready_time, ready_count FROM sync_state WHERE id = 1')
    state = cursor.fetchone()
    cursor.execute('SELECT COUNT(*) FROM backup_data')
    total_backups = cursor.fetchone()[0]
    conn.close()
    
    return jsonify({
        'status': 'ok',
        'last_seq': state[0] if state else 0,
        'last_ready_time': state[1] if state else None,
        'ready_count': state[2] if state else 0,
        'total_backups': total_backups,
        'main_server': MAIN_SERVER_URL
    })

@app.route('/api/backup/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat()
    })

# ═══════════════════════════════════════════════════════
# GỬI BACKUP LÊN MAIN SERVER
# ═══════════════════════════════════════════════════════

def send_full_backup_to_server():
    """Gửi toàn bộ backup data lên main server khi phát hiện server restart"""
    try:
        print(f'📤 Sending full backup to {MAIN_SERVER_URL}...')
        
        backup_data = get_all_backup_data()
        if not backup_data:
            print('⚠️ No backup data to send')
            return
        
        latest = get_latest_backup()
        
        payload = {
            'type': 'FULL_BACKUP',
            'token': BACKUP_TOKEN,
            'seq': latest['seq'] if latest else 0,
            'rows': backup_data,
            'timestamp': datetime.now().isoformat()
        }
        
        # Gửi qua HTTP POST đến main server
        response = requests.post(
            f'{MAIN_SERVER_URL}/api/backup/sync',
            json=payload,
            headers={
                'Content-Type': 'application/json',
                'User-Agent': 'ChocoHub-BackupServer/1.0'
            },
            timeout=30
        )
        
        if response.status_code == 200:
            print(f'✅ Backup sent successfully to {MAIN_SERVER_URL}')
            print(f'   Response: {response.json()}')
        else:
            print(f'❌ Failed to send backup. Status: {response.status_code}')
            print(f'   Response: {response.text[:200]}')
            
    except requests.exceptions.RequestException as e:
        print(f'❌ Error sending backup: {e}')
    except Exception as e:
        print(f'❌ Unexpected error: {e}')

def check_main_server():
    """Kiểm tra main server có online không"""
    try:
        response = requests.get(
            f'{MAIN_SERVER_URL}/api/test',
            timeout=5
        )
        return response.status_code == 200
    except:
        return False

# ═══════════════════════════════════════════════════════
# MONITORING THREAD – Theo dõi main server
# ═══════════════════════════════════════════════════════

def monitor_main_server():
    """Background thread: Kiểm tra main server định kỳ"""
    print(f'🔍 Starting server monitor (check every {CHECK_INTERVAL}s)...')
    print(f'   Main server: {MAIN_SERVER_URL}')
    
    was_down = False
    
    while True:
        time.sleep(CHECK_INTERVAL)
        
        is_online = check_main_server()
        
        if not is_online and not was_down:
            print(f'🔴 Main server appears DOWN at {datetime.now().strftime("%H:%M:%S")}')
            was_down = True
        elif is_online and was_down:
            print(f'🟢 Main server is BACK ONLINE at {datetime.now().strftime("%H:%M:%S")}')
            print('🔄 Server just recovered – sending backup...')
            was_down = False
            send_full_backup_to_server()
        elif is_online:
            # Server vẫn online – reset ready count
            reset_ready_count()

# ═══════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════

if __name__ == '__main__':
    print('')
    print('╔══════════════════════════════════════╗')
    print('║   CHOCO HUB - BACKUP SERVER         ║')
    print('╠══════════════════════════════════════╣')
    print(f'║  Port: {BACKUP_PORT}                         ║')
    print(f'║  Main Server: {MAIN_SERVER_URL[:30]}... ║')
    print(f'║  Token: {BACKUP_TOKEN[:15]}...          ║')
    print(f'║  Check Interval: {CHECK_INTERVAL}s                  ║')
    print(f'║  Max Ready Retries: {MAX_READY_RETRIES}                ║')
    print('╚══════════════════════════════════════╝')
    print('')
    
    # Khởi tạo database
    init_db()
    
    # Bắt đầu monitor thread
    monitor_thread = threading.Thread(target=monitor_main_server, daemon=True)
    monitor_thread.start()
    
    # Chạy Flask server
    app.run(
        host='0.0.0.0',
        port=BACKUP_PORT,
        debug=False
    )
