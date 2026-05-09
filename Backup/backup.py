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
    
    # Bảng lưu backup data
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS backup_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            seq INTEGER NOT NULL,
            data_type TEXT NOT NULL,
            action TEXT,
            username TEXT,
            payload TEXT NOT NULL,
            received_at TEXT DEFAULT (datetime('now'))
        )
    ''')
    
    # Bảng lưu trạng thái đồng bộ
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS sync_state (
            id INTEGER PRIMARY KEY CHECK(id = 1),
            last_seq INTEGER NOT NULL DEFAULT 0,
            last_ready_time TEXT,
            ready_count INTEGER DEFAULT 0,
            last_heartbeat TEXT
        )
    ''')
    cursor.execute('INSERT OR IGNORE INTO sync_state (id, last_seq, ready_count) VALUES (1, 0, 0)')
    
    # Bảng log hoạt động
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_type TEXT NOT NULL,
            details TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    ''')
    
    conn.commit()
    conn.close()
    print('✅ Backup database ready')

# ─── Log activity ──────────────────────────────────
def log_activity(event_type, details=''):
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute(
            'INSERT INTO activity_log (event_type, details) VALUES (?, ?)',
            (event_type, json.dumps(details) if isinstance(details, dict) else str(details))
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f'⚠️ Log error: {e}')

# ─── Lưu dữ liệu backup ────────────────────────────
def save_backup(seq, data_type, data):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        'INSERT INTO backup_data (seq, data_type, action, username, payload) VALUES (?, ?, ?, ?, ?)',
        (
            seq, 
            data_type, 
            data.get('action', ''),
            data.get('username', ''),
            json.dumps(data.get('payload', data))
        )
    )
    # Cập nhật last_seq
    cursor.execute('UPDATE sync_state SET last_seq = MAX(last_seq, ?) WHERE id = 1', (seq,))
    conn.commit()
    conn.close()
    
    # Log ngắn gọn
    action = data.get('action', 'N/A')
    print(f'💾 Saved: seq={seq} | type={data_type} | action={action}')

# ─── Lấy dữ liệu backup mới nhất ────────────────────
def get_latest_backup():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT seq, data_type, action, username, payload FROM backup_data ORDER BY seq DESC LIMIT 1')
    row = cursor.fetchone()
    conn.close()
    if row:
        return {
            'seq': row[0],
            'type': row[1],
            'action': row[2],
            'username': row[3],
            'payload': json.loads(row[4])
        }
    return None

# ─── Lấy toàn bộ backup data ────────────────────────
def get_all_backup_data():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT seq, data_type, action, username, payload FROM backup_data ORDER BY seq ASC')
    rows = cursor.fetchall()
    conn.close()
    return [
        {
            'seq': r[0], 
            'type': r[1], 
            'action': r[2],
            'username': r[3],
            'payload': json.loads(r[4])
        } 
        for r in rows
    ]

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

# ─── Update heartbeat timestamp ─────────────────────
def update_heartbeat():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('UPDATE sync_state SET last_heartbeat = datetime("now") WHERE id = 1')
    conn.commit()
    conn.close()

# ─── Lấy trạng thái sync ────────────────────────────
def get_sync_state():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT last_seq, last_ready_time, ready_count, last_heartbeat FROM sync_state WHERE id = 1')
    row = cursor.fetchone()
    conn.close()
    return {
        'last_seq': row[0] if row else 0,
        'last_ready_time': row[1],
        'ready_count': row[2] if row else 0,
        'last_heartbeat': row[3]
    }

# ═══════════════════════════════════════════════════════
# FLASK ROUTES – Nhận sync từ server.js
# ═══════════════════════════════════════════════════════

@app.route('/api/backup/sync', methods=['POST'])
def receive_sync():
    """Nhận READY, PING, DELTA, RESYNC từ main server"""
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
            log_activity('INVALID_TOKEN', {'token': token[:10]})
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
                log_activity('SERVER_RESTART_DETECTED', {'ready_count': count})
                # Reset count để tránh gửi lại liên tục
                reset_ready_count()
                # Trigger gửi backup trong background
                threading.Thread(target=send_full_backup_to_server, daemon=True).start()
            
            return jsonify({
                'type': 'READY_ACK',
                'seq': seq,
                'status': 'success',
                'message': 'Backup server ready'
            })
        
        elif msg_type == 'RESYNC':
            # Server reconnect – gửi delta từ last_seq
            print(f'🔄 RESYNC request, server seq={seq}')
            save_backup(seq, 'RESYNC', data)
            
            # Kiểm tra nếu server thiếu data
            state = get_sync_state()
            if state['last_seq'] > seq:
                print(f'📤 Server behind by {state["last_seq"] - seq} sequences')
                # Gửi delta còn thiếu
                threading.Thread(
                    target=send_missing_deltas, 
                    args=(seq,),
                    daemon=True
                ).start()
            
            return jsonify({
                'type': 'RESYNC_ACK',
                'seq': state['last_seq'],
                'status': 'success'
            })
        
        elif msg_type == 'PING':
            # Heartbeat – reset ready count vì server vẫn alive
            reset_ready_count()
            update_heartbeat()
            
            return jsonify({
                'type': 'PONG',
                'seq': seq,
                'timestamp': datetime.now().isoformat()
            })
        
        elif msg_type == 'DELTA':
            # Nhận delta update
            save_backup(seq, 'DELTA', data)
            log_activity('DELTA_RECEIVED', {
                'action': data.get('action'),
                'username': data.get('username')
            })
            
            return jsonify({
                'type': 'DELTA_ACK',
                'seq': seq,
                'status': 'saved'
            })
        
        elif msg_type == 'FULL_BACKUP':
            # Nhận full backup từ server
            print(f'📥 Receiving FULL_BACKUP ({len(data.get("rows", []))} rows)')
            save_backup(seq, 'FULL_BACKUP', data)
            log_activity('FULL_BACKUP_RECEIVED', {'rows': len(data.get('rows', []))})
            
            return jsonify({
                'type': 'BACKUP_ACK',
                'seq': seq,
                'status': 'success'
            })
        
        else:
            print(f'⚠️ Unknown message type: {msg_type}')
            log_activity('UNKNOWN_TYPE', {'type': msg_type})
            return jsonify({'status': 'error', 'message': f'Unknown type: {msg_type}'}), 400
            
    except Exception as e:
        print(f'❌ Error processing sync: {e}')
        log_activity('ERROR', {'error': str(e)})
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/backup/status', methods=['GET'])
def backup_status():
    """Kiểm tra trạng thái backup server"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT COUNT(*) FROM backup_data')
    total_backups = cursor.fetchone()[0]
    cursor.execute('SELECT COUNT(*) FROM activity_log')
    total_logs = cursor.fetchone()[0]
    conn.close()
    
    state = get_sync_state()
    
    return jsonify({
        'status': 'ok',
        'sync_state': state,
        'total_backups': total_backups,
        'total_logs': total_logs,
        'main_server': MAIN_SERVER_URL,
        'config': {
            'check_interval': CHECK_INTERVAL,
            'max_ready_retries': MAX_READY_RETRIES
        }
    })

@app.route('/api/backup/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    state = get_sync_state()
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'last_seq': state['last_seq'],
        'last_heartbeat': state['last_heartbeat']
    })

@app.route('/api/backup/data', methods=['GET'])
def get_backup_data():
    """Lấy danh sách backup data (hỗ trợ filter)"""
    limit = request.args.get('limit', 50, type=int)
    offset = request.args.get('offset', 0, type=int)
    data_type = request.args.get('type', None)
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    if data_type:
        cursor.execute(
            'SELECT seq, data_type, action, username, received_at FROM backup_data WHERE data_type = ? ORDER BY seq DESC LIMIT ? OFFSET ?',
            (data_type, limit, offset)
        )
    else:
        cursor.execute(
            'SELECT seq, data_type, action, username, received_at FROM backup_data ORDER BY seq DESC LIMIT ? OFFSET ?',
            (limit, offset)
        )
    
    rows = cursor.fetchall()
    cursor.execute('SELECT COUNT(*) FROM backup_data')
    total = cursor.fetchone()[0]
    conn.close()
    
    return jsonify({
        'status': 'success',
        'total': total,
        'limit': limit,
        'offset': offset,
        'data': [
            {
                'seq': r[0],
                'type': r[1],
                'action': r[2],
                'username': r[3],
                'received_at': r[4]
            }
            for r in rows
        ]
    })

@app.route('/api/backup/logs', methods=['GET'])
def get_activity_logs():
    """Lấy activity log"""
    limit = request.args.get('limit', 20, type=int)
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('SELECT event_type, details, created_at FROM activity_log ORDER BY id DESC LIMIT ?', (limit,))
    rows = cursor.fetchall()
    conn.close()
    
    return jsonify({
        'status': 'success',
        'logs': [
            {
                'event': r[0],
                'details': r[1],
                'time': r[2]
            }
            for r in rows
        ]
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
            log_activity('BACKUP_SENT', {'rows': len(backup_data), 'status': 'success'})
        else:
            print(f'❌ Failed to send backup. Status: {response.status_code}')
            print(f'   Response: {response.text[:200]}')
            log_activity('BACKUP_SENT_FAILED', {'status': response.status_code})
            
    except requests.exceptions.RequestException as e:
        print(f'❌ Error sending backup: {e}')
        log_activity('BACKUP_SEND_ERROR', {'error': str(e)})
    except Exception as e:
        print(f'❌ Unexpected error: {e}')
        log_activity('BACKUP_UNEXPECTED_ERROR', {'error': str(e)})

def send_missing_deltas(from_seq):
    """Gửi các delta bị thiếu cho server"""
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute(
            'SELECT seq, data_type, action, username, payload FROM backup_data WHERE seq > ? AND data_type = "DELTA" ORDER BY seq ASC',
            (from_seq,)
        )
        rows = cursor.fetchall()
        conn.close()
        
        if not rows:
            print(f'ℹ️ No missing deltas after seq {from_seq}')
            return
        
        print(f'📤 Sending {len(rows)} missing deltas...')
        
        for row in rows:
            payload = {
                'type': 'DELTA',
                'token': BACKUP_TOKEN,
                'seq': row[0],
                'action': row[2],
                'username': row[3],
                'payload': json.loads(row[4])
            }
            
            response = requests.post(
                f'{MAIN_SERVER_URL}/api/backup/sync',
                json=payload,
                headers={'Content-Type': 'application/json'},
                timeout=10
            )
            
            if response.status_code == 200:
                print(f'  ✅ Delta seq={row[0]} sent')
            else:
                print(f'  ❌ Delta seq={row[0]} failed: {response.status_code}')
            
            time.sleep(0.5)  # Tránh rate limit
        
        log_activity('MISSING_DELTAS_SENT', {'from_seq': from_seq, 'count': len(rows)})
        
    except Exception as e:
        print(f'❌ Error sending missing deltas: {e}')

def check_main_server():
    """Kiểm tra main server có online không"""
    try:
        response = requests.get(
            f'{MAIN_SERVER_URL}/health',
            timeout=5,
            headers={'User-Agent': 'ChocoHub-BackupServer/1.0'}
        )
        return response.status_code == 200
    except:
        # Thử lại với /api/test nếu /health không có
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
    down_since = None
    
    while True:
        time.sleep(CHECK_INTERVAL)
        
        is_online = check_main_server()
        now = datetime.now()
        
        if not is_online and not was_down:
            down_since = now
            print(f'🔴 Main server appears DOWN at {now.strftime("%H:%M:%S")}')
            log_activity('SERVER_DOWN', {'time': now.isoformat()})
            was_down = True
            
        elif is_online and was_down:
            downtime = (now - down_since).total_seconds() if down_since else 0
            print(f'🟢 Main server is BACK ONLINE at {now.strftime("%H:%M:%S")} (downtime: {downtime:.0f}s)')
            log_activity('SERVER_RECOVERED', {
                'time': now.isoformat(),
                'downtime_seconds': downtime
            })
            print('🔄 Server just recovered – sending backup...')
            was_down = False
            down_since = None
            send_full_backup_to_server()
            
        elif is_online:
            # Server vẫn online – reset ready count
            reset_ready_count()
            
            # Log heartbeat mỗi 5 phút để biết monitor vẫn chạy
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
    print(f'║  Max Ready Retries: {MAX_READY_RETRIES}                  ║')
    print(f'║  DB: {DB_PATH}                          ║')
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
