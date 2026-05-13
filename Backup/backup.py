# backup.py – Backup Server nhận full snapshot từ ChocoHub
# 🆕 Thread-safe với lock, backup cũ, SQLite transaction
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

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(BASE_DIR, '.env')

if not os.path.exists(ENV_PATH):
    print(f'❌ File .env không tồn tại tại: {ENV_PATH}')
    sys.exit(1)

config = dotenv_values(ENV_PATH)

app = Flask(__name__)

BACKUP_PORT     = int(config.get('BACKUP_PORT', 3001))
BACKUP_TOKEN    = config.get('BACKUP_TOKEN', 'chocohub-default-token')
MAIN_SERVER_URL = config.get('MAIN_SERVER_URL', 'https://chocohub-r011.onrender.com')
CHECK_INTERVAL  = int(config.get('CHECK_INTERVAL', 10))
DB_PATH         = os.path.join(BASE_DIR, config.get('BACKUP_DB_PATH', 'backup.db'))
MAX_BACKUPS     = int(config.get('MAX_BACKUPS', 3))  # Số bản backup cũ giữ lại

# ─── Lock cho snapshot operations ──────────────────
_snapshot_lock = threading.RLock()

def init_db():
    with _snapshot_lock:
        conn = sqlite3.connect(DB_PATH)
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
        
        # 🆕 Bảng backup history (giữ các bản cũ)
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
        print('✅ Backup database ready (snapshot mode + history)')

def save_snapshot(state):
    """Lưu snapshot với transaction, backup bản cũ trước khi ghi đè"""
    with _snapshot_lock:
        conn = None
        try:
            json_data = json.dumps(state)
            users_count = len(state.get('users', []))
            total_items = count_snapshot_size(state)[0]
            
            conn = sqlite3.connect(DB_PATH, timeout=10)
            
            # 🆕 Bắt đầu transaction
            conn.execute('BEGIN IMMEDIATE')
            
            try:
                # 1. Lưu bản hiện tại vào history trước khi ghi đè
                cursor = conn.cursor()
                cursor.execute('SELECT state FROM snapshot WHERE id = 1')
                old_row = cursor.fetchone()
                
                if old_row and old_row[0] and old_row[0] != '{}':
                    try:
                        old_state = json.loads(old_row[0])
                        old_users = len(old_state.get('users', []))
                        old_total = count_snapshot_size(old_state)[0]
                        
                        # Chỉ backup nếu khác với bản mới
                        if old_state != state:
                            cursor.execute('''
                                INSERT INTO snapshot_backups (state, users_count, total_items)
                                VALUES (?, ?, ?)
                            ''', (old_row[0], old_users, old_total))
                            print(f'📦 Backup bản cũ ({old_users} users) vào history')
                    except:
                        pass  # Bản cũ lỗi thì bỏ qua
                
                # 2. Ghi đè snapshot mới
                cursor.execute('''
                    INSERT OR REPLACE INTO snapshot (id, state, updated_at)
                    VALUES (1, ?, datetime('now'))
                ''', (json_data,))
                
                # 3. 🆕 Xóa các bản backup cũ (chỉ giữ MAX_BACKUPS bản gần nhất)
                cursor.execute(f'''
                    DELETE FROM snapshot_backups WHERE id NOT IN (
                        SELECT id FROM snapshot_backups 
                        ORDER BY created_at DESC 
                        LIMIT {MAX_BACKUPS}
                    )
                ''')
                
                conn.commit()
                print(f'💾 Snapshot saved ({users_count} users, {total_items} items)')
                
            except Exception as e:
                conn.rollback()
                print(f'❌ Transaction failed, rolled back: {e}')
                raise e
                
        except Exception as e:
            print(f'❌ Save error: {e}')
        finally:
            if conn:
                conn.close()

def get_snapshot():
    """Đọc snapshot thread-safe"""
    with _snapshot_lock:
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
    with _snapshot_lock:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('SELECT updated_at FROM snapshot WHERE id = 1')
        row = cursor.fetchone()
        conn.close()
        return row[0] if row else 'unknown'

def count_snapshot_size(state):
    """Tính tổng dung lượng để so sánh"""
    users = len(state.get('users', []))
    stakes = len(state.get('stakes', [])) if state.get('stakes') else 0
    blocks = len(state.get('blocks', [])) if state.get('blocks') else 0
    transactions = len(state.get('transactions', [])) if state.get('transactions') else 0
    total = users + stakes + blocks + transactions
    return total, users

# 🆕 Endpoint xem backup history
@app.route('/api/backup/history', methods=['GET'])
def backup_history():
    with _snapshot_lock:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('''
            SELECT id, users_count, total_items, created_at 
            FROM snapshot_backups 
            ORDER BY created_at DESC 
            LIMIT 10
        ''')
        rows = cursor.fetchall()
        conn.close()
        
        history = []
        for row in rows:
            history.append({
                'id': row[0],
                'users': row[1],
                'items': row[2],
                'created_at': row[3]
            })
        
        return jsonify({
            'status': 'success',
            'history': history,
            'max_backups': MAX_BACKUPS
        })

# 🆕 Endpoint restore từ backup cũ
@app.route('/api/backup/restore/<int:backup_id>', methods=['POST'])
def restore_backup(backup_id):
    token = request.headers.get('X-Backup-Token') or request.json.get('token', '')
    if token != BACKUP_TOKEN:
        return jsonify({'status': 'error', 'message': 'Invalid token'}), 401
    
    with _snapshot_lock:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute('SELECT state FROM snapshot_backups WHERE id = ?', (backup_id,))
        row = cursor.fetchone()
        
        if not row:
            conn.close()
            return jsonify({'status': 'error', 'message': 'Backup not found'}), 404
        
        try:
            state = json.loads(row[0])
            
            # Lưu bản hiện tại vào history trước khi restore
            cursor.execute('SELECT state FROM snapshot WHERE id = 1')
            current_row = cursor.fetchone()
            if current_row and current_row[0] and current_row[0] != '{}':
                try:
                    current_state = json.loads(current_row[0])
                    cursor.execute('''
                        INSERT INTO snapshot_backups (state, users_count, total_items)
                        VALUES (?, ?, ?)
                    ''', (current_row[0], len(current_state.get('users', [])), count_snapshot_size(current_state)[0]))
                except:
                    pass
            
            # Restore bản cũ
            cursor.execute('''
                INSERT OR REPLACE INTO snapshot (id, state, updated_at)
                VALUES (1, ?, datetime('now'))
            ''', (json.dumps(state),))
            
            conn.commit()
            conn.close()
            
            print(f'🔄 Restored backup #{backup_id} ({len(state.get("users", []))} users)')
            return jsonify({
                'status': 'success',
                'message': f'Restored backup #{backup_id}',
                'users': len(state.get('users', []))
            })
            
        except Exception as e:
            conn.rollback()
            conn.close()
            return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/backup/sync', methods=['POST'])
def receive_sync():
    try:
        if not request.is_json:
            return jsonify({'status': 'error', 'message': 'JSON required'}), 400

        data = request.get_json()
        if not data:
            return jsonify({'status': 'error', 'message': 'No data'}), 400

        msg_type = data.get('type', '')
        token = data.get('token', '')
        
        if not token:
            return jsonify({'status': 'error', 'message': 'No token'}), 400

        if token != BACKUP_TOKEN:
            return jsonify({'status': 'error', 'message': 'Invalid token'}), 401

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

        elif msg_type == 'PING':
            return jsonify({'type': 'PONG', 'timestamp': datetime.now().isoformat()})

        elif msg_type == 'FULL_SNAPSHOT':
            if 'state' not in data:
                return jsonify({'status': 'error', 'message': 'Missing state'}), 400

            state = data['state']
            new_total, new_users = count_snapshot_size(state)
            
            # 🆕 Kiểm tra dung lượng trước khi ghi đè
            current = get_snapshot()
            if current and current.get('users') is not None:
                current_total, current_users = count_snapshot_size(current)
                
                if new_total < current_total:
                    print(f'⚠️ SKIP snapshot: {new_total} items < current {current_total} items ({new_users} users < {current_users} users)')
                    return jsonify({
                        'type': 'SNAPSHOT_ACK',
                        'status': 'skipped',
                        'message': f'Snapshot has less data ({new_total} < {current_total})'
                    })
                
                if new_total == current_total and new_users <= current_users:
                    print(f'⏭ Snapshot unchanged, skipping ({new_total} items, {new_users} users)')
                    return jsonify({
                        'type': 'SNAPSHOT_ACK',
                        'status': 'skipped',
                        'message': 'Snapshot unchanged'
                    })
            
            print(f'📥 Receiving snapshot ({new_users} users, {new_total} total items)...')
            threading.Thread(target=save_snapshot, args=(state,), daemon=True).start()
            return jsonify({
                'type': 'SNAPSHOT_ACK',
                'status': 'success',
                'message': f'OK ({new_users} users)'
            })

        else:
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
        'main_server': MAIN_SERVER_URL,
        'max_backups': MAX_BACKUPS
    })

@app.route('/api/backup/health', methods=['GET'])
def health_check():
    return jsonify({
        'status': 'healthy',
        'timestamp': datetime.now().isoformat(),
        'snapshot_time': get_snapshot_time()
    })

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

if __name__ == '__main__':
    print('')
    print('╔══════════════════════════════════════╗')
    print('║   CHOCO HUB - BACKUP SERVER         ║')
    print('╠══════════════════════════════════════╣')
    print('║  Anti-overwrite protection: ON      ║')
    print('║  Backup history: ON                 ║')
    print('║  Transaction rollback: ON           ║')
    print('╚══════════════════════════════════════╝')
    print('')
    init_db()
    monitor_thread = threading.Thread(target=monitor_main_server, daemon=True)
    monitor_thread.start()
    app.run(host='0.0.0.0', port=BACKUP_PORT, debug=False)
