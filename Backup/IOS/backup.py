#!/usr/bin/env python3
"""
ChocoHub Backup Server - Minimal Python version
Chỉ dùng thư viện chuẩn: http.server, json, sqlite3, hashlib, os, time, urllib
Không có Diffie‑Hellman, xác thực bằng BACKUP_TOKEN.
"""

import http.server
import json
import sqlite3
import os
import hashlib
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

# ─── Cấu hình từ biến môi trường ───────────────────────
BACKUP_PORT = int(os.environ.get("BACKUP_PORT", 3001))
BACKUP_TOKEN = os.environ.get("BACKUP_TOKEN", "chocohub-default-token")
MAIN_SERVER_URL = os.environ.get("MAIN_SERVER_URL", "https://chocohub-r011.onrender.com").rstrip('/')
CHECK_INTERVAL = int(os.environ.get("CHECK_INTERVAL", 10))
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       os.environ.get("BACKUP_DB_PATH", "backup_node.db"))
SELF_URL = os.environ.get("SELF_URL", "")
MAX_BACKUPS = int(os.environ.get("MAX_BACKUPS", 3))

# ─── Khởi tạo SQLite ──────────────────────────────────
conn = sqlite3.connect(DB_PATH, check_same_thread=False)
conn.row_factory = sqlite3.Row
conn.executescript("""
    CREATE TABLE IF NOT EXISTS snapshot (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        state TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO snapshot (id, state) VALUES (1, '{}');
    CREATE TABLE IF NOT EXISTS snapshot_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        state TEXT NOT NULL,
        users_count INTEGER DEFAULT 0,
        total_items INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    );
""")
conn.commit()

def count_snapshot_size(state):
    users = len(state.get('users', []))
    stakes = len(state.get('stakes', []))
    blocks = len(state.get('blocks', []))
    transactions = len(state.get('transactions', []))
    return {'total': users + stakes + blocks + transactions, 'users': users}

def get_snapshot():
    row = conn.execute("SELECT state FROM snapshot WHERE id = 1").fetchone()
    if row and row['state']:
        try:
            return json.loads(row['state'])
        except:
            return None
    return None

def get_snapshot_time():
    row = conn.execute("SELECT updated_at FROM snapshot WHERE id = 1").fetchone()
    return row['updated_at'] if row else 'unknown'

def save_snapshot(state):
    # Tính hash để kiểm tra trùng
    new_json = json.dumps(state, sort_keys=True, separators=(',', ':'))
    new_hash = hashlib.sha256(new_json.encode()).hexdigest()

    current = get_snapshot()
    if current and current.get('users'):
        current_json = json.dumps(current, sort_keys=True, separators=(',', ':'))
        current_hash = hashlib.sha256(current_json.encode()).hexdigest()
        if new_hash == current_hash:
            print("⏭ Snapshot identical (same hash), skipping")
            return False
        # Chống ghi đè lùi nếu dữ liệu mới ít hơn 50%
        old_size = count_snapshot_size(current)
        new_size = count_snapshot_size(state)
        if new_size['total'] < old_size['total'] * 0.5:
            print(f"⚠️ SKIP snapshot: {new_size['total']} items < 50% of current {old_size['total']}")
            return False

    # Lưu snapshot cũ vào lịch sử
    old_row = conn.execute("SELECT state FROM snapshot WHERE id = 1").fetchone()
    if old_row and old_row['state'] and old_row['state'] != '{}':
        try:
            old_state = json.loads(old_row['state'])
            old_json_str = json.dumps(old_state, sort_keys=True, separators=(',', ':'))
            if old_json_str != new_json:
                old_size = count_snapshot_size(old_state)
                conn.execute(
                    "INSERT INTO snapshot_backups (state, users_count, total_items) VALUES (?, ?, ?)",
                    (old_row['state'], old_size['users'], old_size['total'])
                )
                print(f"📦 Backup bản cũ ({old_size['users']} users) vào history")
        except:
            pass

    conn.execute(
        "INSERT OR REPLACE INTO snapshot (id, state, updated_at) VALUES (1, ?, datetime('now'))",
        (new_json,)
    )
    # Xóa bản cũ vượt quá MAX_BACKUPS
    conn.execute(
        f"DELETE FROM snapshot_backups WHERE id NOT IN (SELECT id FROM snapshot_backups ORDER BY created_at DESC LIMIT {MAX_BACKUPS})"
    )
    conn.commit()
    size = count_snapshot_size(state)
    print(f"💾 Snapshot saved ({size['users']} users, {size['total']} items, {len(new_json)/1024:.1f} KB)")
    return True

# ─── Helper HTTP request ──────────────────────────────
def http_post(url, data, headers=None):
    if headers is None:
        headers = {}
    headers.setdefault('Content-Type', 'application/json')
    req = urllib.request.Request(url, data=json.dumps(data).encode(), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as e:
        return None, str(e)

def http_get(url):
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, resp.read().decode()
    except:
        return None, None

# ─── Đăng ký với Main Server ──────────────────────────
def register_with_main():
    if not SELF_URL:
        return
    try:
        body = {
            "url": SELF_URL,
            "token": BACKUP_TOKEN,
            "name": "ChocoHub Backup Node (Python)",
            "platform": "Python"
        }
        code, _ = http_post(f"{MAIN_SERVER_URL}/api/backup/register", body)
        if code == 200:
            print(f"📡 Registered with main server as {SELF_URL}")
        else:
            print(f"❌ Registration failed: {code}")
    except Exception as e:
        print(f"❌ Could not register: {e}")

# ─── Gửi snapshot lên Main Server ─────────────────────
def send_snapshot_to_main():
    snap = get_snapshot()
    if not snap or not snap.get('users'):
        print("⚠️ No snapshot data to send")
        return
    payload = {
        "type": "FULL_SNAPSHOT",
        "token": BACKUP_TOKEN,
        "state": snap
    }
    code, _ = http_post(f"{MAIN_SERVER_URL}/api/backup/sync", payload)
    if code == 200:
        print(f"✅ Snapshot sent to main server ({len(snap['users'])} users)")
    else:
        print(f"❌ Send snapshot failed: {code}")

# ─── Theo dõi Main Server ─────────────────────────────
was_down = False
def check_main_server():
    global was_down
    code, _ = http_get(f"{MAIN_SERVER_URL}/health")
    online = (code == 200)
    if not online and not was_down:
        print("🔴 Main server DOWN")
        was_down = True
    elif online and was_down:
        print("🟢 Main server BACK ONLINE")
        send_snapshot_to_main()
        was_down = False

# ─── HTTP Request Handler ─────────────────────────────
class BackupHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Tắt log mặc định, tự in log gọn
        pass

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get('Content-Length', 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except:
            return {}

    def _check_token(self, data, headers):
        token = data.get('token', '')
        # Chỉ kiểm tra token, không dùng session
        if token == BACKUP_TOKEN:
            return True
        return False

    def do_GET(self):
        if self.path == '/api/backup/health':
            self._send_json({
                "status": "healthy",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "snapshot_time": get_snapshot_time()
            })
        elif self.path == '/api/backup/status':
            snap = get_snapshot()
            users = len(snap.get('users', [])) if snap else 0
            self._send_json({
                "status": "ok",
                "total_users": users,
                "snapshot_time": get_snapshot_time(),
                "main_server": MAIN_SERVER_URL,
                "max_backups": MAX_BACKUPS
            })
        elif self.path == '/api/backup/history':
            rows = conn.execute(
                "SELECT id, users_count, total_items, created_at FROM snapshot_backups ORDER BY created_at DESC LIMIT 10"
            ).fetchall()
            history = [{"id": r['id'], "users_count": r['users_count'],
                        "total_items": r['total_items'], "created_at": r['created_at']} for r in rows]
            self._send_json({"status": "success", "history": history, "max_backups": MAX_BACKUPS})
        else:
            self.send_error(404)

    def do_POST(self):
        data = self._read_body()
        if self.path == '/api/backup/sync':
            if not self._check_token(data, self.headers):
                self._send_json({"status": "error", "message": "Invalid token"}, 401)
                return

            msg_type = data.get('type')
            if msg_type == 'PING':
                self._send_json({"type": "PONG", "timestamp": datetime.now(timezone.utc).isoformat()})
            elif msg_type == 'READY':
                client_empty = data.get('empty', False)
                snap = get_snapshot()
                server_has_data = bool(snap and snap.get('users'))
                print(f"📋 READY: client_empty={client_empty}, server_has_data={server_has_data}")
                if client_empty:
                    if server_has_data:
                        print(f"📤 Sending full snapshot ({len(snap['users'])} users)")
                        self._send_json({"type": "FULL_SNAPSHOT", "token": BACKUP_TOKEN, "state": snap})
                    else:
                        self._send_json({"type": "READY_ACK", "status": "success", "message": "ready but empty"})
                elif not client_empty and not server_has_data:
                    print("📤 Server empty, requesting snapshot from client")
                    self._send_json({"type": "REQUEST_SNAPSHOT", "message": "Server is empty, please send your snapshot"})
                else:
                    print("✅ Both have data or both empty, sending READY_ACK")
                    self._send_json({"type": "READY_ACK", "status": "success", "message": "ack"})
            elif msg_type == 'FULL_SNAPSHOT':
                state = data.get('state')
                if not state:
                    self._send_json({"status": "error", "message": "Missing state"}, 400)
                    return
                saved = save_snapshot(state)
                if saved:
                    self._send_json({"type": "SNAPSHOT_ACK", "status": "success"})
                else:
                    self._send_json({"type": "SNAPSHOT_ACK", "status": "skipped"})
            else:
                self._send_json({"status": "error", "message": f"Unknown type: {msg_type}"}, 400)
        else:
            self.send_error(404)

# ─── Chạy server ──────────────────────────────────────
def main():
    print(f"""
╔══════════════════════════════════════╗
║   CHOCO HUB - BACKUP SERVER (Py)   ║
╠══════════════════════════════════════╣
║  Port: {BACKUP_PORT}                          ║
║  Main: {MAIN_SERVER_URL[:35].ljust(35)}║
║  Mode: TOKEN (no DH)                ║
║  Anti-overwrite: HASH-BASED         ║
╚══════════════════════════════════════╝
""")
    # Đăng ký ngay khi khởi động
    register_with_main()

    # Định kỳ kiểm tra main server và đăng ký lại
    import threading
    def periodic():
        while True:
            time.sleep(CHECK_INTERVAL)
            check_main_server()
            # Đăng ký lại mỗi 5 phút để duy trì trạng thái online
            if int(time.time()) % 300 < CHECK_INTERVAL:
                register_with_main()
    threading.Thread(target=periodic, daemon=True).start()

    # Khởi tạo HTTP server
    server = http.server.HTTPServer(('0.0.0.0', BACKUP_PORT), BackupHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        conn.close()
        server.server_close()

if __name__ == '__main__':
    main()
