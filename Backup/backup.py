#!/usr/bin/env python3
"""
backup.py – Backup server for ChocoHub (Hybrid PoW+PoS)
Python version
"""

import os
import sys
import json
import socket
import sqlite3
import threading
import time
import logging
from datetime import datetime
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse
import requests

# ==================== Configuration ====================
from dotenv import load_dotenv
load_dotenv()

HTTP_PORT = int(os.getenv('HTTP_PORT', 0)) or None
TCP_PORT = int(os.getenv('TCP_PORT', 0)) or None
BACKUP_TOKENS = [t.strip() for t in os.getenv('BACKUP_TOKENS', 'chocohub-default-token').split(',') if t.strip()]
DB_PATH = os.getenv('BACKUP_DB_PATH', os.path.join(os.path.dirname(__file__), 'backup.db'))
MAIN_SERVERS = [s.strip() for s in os.getenv('MAIN_SERVERS', '').split(',') if s.strip()]

if not HTTP_PORT and not TCP_PORT:
    print('❌ No server configured! Set HTTP_PORT and/or TCP_PORT in .env')
    sys.exit(1)

# ==================== Logging ====================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger('backup')

# ==================== Database ====================
class Database:
    def __init__(self, db_path):
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute('PRAGMA journal_mode = WAL')
        self._init_tables()
    
    def _init_tables(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS backup_data (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            );
            INSERT OR IGNORE INTO backup_data (key, value) VALUES ('seq', '0');
            INSERT OR IGNORE INTO backup_data (key, value) VALUES ('ready_count', '0');
            INSERT OR IGNORE INTO backup_data (key, value) VALUES ('last_backup', '{}');
            INSERT OR IGNORE INTO backup_data (key, value) VALUES ('backup_status', 'idle');
        """)
        self.conn.commit()
    
    def get(self, key):
        row = self.conn.execute('SELECT value FROM backup_data WHERE key = ?', (key,)).fetchone()
        return row['value'] if row else '0'
    
    def set(self, key, value):
        self.conn.execute(
            'INSERT OR REPLACE INTO backup_data (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))',
            (key, str(value))
        )
        self.conn.commit()
    
    def get_ready_count(self):
        return int(self.get('ready_count'))
    
    def increment_ready(self):
        count = self.get_ready_count() + 1
        self.set('ready_count', count)
        return count
    
    def reset_ready(self):
        self.set('ready_count', '0')
    
    def close(self):
        self.conn.close()

db = Database(DB_PATH)

# ==================== Backup Logic ====================
main_backup_data = None

def fetch_from_main_servers():
    """Lấy dữ liệu từ main server"""
    global main_backup_data
    
    if not MAIN_SERVERS:
        logger.info('ℹ️  No MAIN_SERVERS configured. Waiting for data push...')
        return
    
    logger.info(f'🔄 Fetching data from {len(MAIN_SERVERS)} main server(s)...')
    
    for main_url in MAIN_SERVERS:
        try:
            if not main_url.startswith('http'):
                main_url = f'http://{main_url}'
            
            resp = requests.get(
                f'{main_url}/network_status',
                headers={'Accept': 'application/json'},
                timeout=5
            )
            
            if resp.status_code == 200:
                data = resp.json()
                main_backup_data = data
                db.set('last_backup', json.dumps(data))
                db.set('seq', str(int(time.time() * 1000)))
                db.set('backup_status', 'synced')
                logger.info(f'✅ Fetched data from {main_url}')
            else:
                logger.error(f'❌ Fetch failed from {main_url}: HTTP {resp.status_code}')
        except Exception as e:
            logger.error(f'❌ Fetch error from {main_url}: {e}')


def push_backup_to_main():
    """Đẩy backup về main server"""
    if not MAIN_SERVERS:
        logger.info('ℹ️  No MAIN_SERVERS to push backup to.')
        return
    
    backup_data = main_backup_data or json.loads(db.get('last_backup') or '{}')
    
    payload = {
        'type': 'FULL_BACKUP',
        'rows': backup_data,
        'seq': db.get('seq'),
        'timestamp': datetime.now().isoformat(),
        'server': 'backup'
    }
    
    logger.info(f'📤 Pushing FULL_BACKUP to {len(MAIN_SERVERS)} main server(s)...')
    
    for main_url in MAIN_SERVERS:
        try:
            if not main_url.startswith('http'):
                main_url = f'http://{main_url}'
            
            resp = requests.post(
                f'{main_url}/api/backup/receive',
                json=payload,
                headers={
                    'Content-Type': 'application/json',
                    'X-Backup-Token': BACKUP_TOKENS[0] if BACKUP_TOKENS else 'chocohub-default-token'
                },
                timeout=10
            )
            
            if resp.status_code == 200:
                logger.info(f'✅ Backup pushed to {main_url}')
                db.set('backup_status', 'pushed')
            else:
                logger.error(f'❌ Push failed to {main_url}: HTTP {resp.status_code}')
        except Exception as e:
            logger.error(f'❌ Push error to {main_url}: {e}')


def handle_ready_message():
    """Xử lý READY, trả về response và kiểm tra có cần push không"""
    count = db.increment_ready()
    logger.info(f'📥 READY received (count: {count}/2)')
    
    response = {
        'type': 'READY_ACK',
        'seq': db.get('seq'),
        'ready_count': count
    }
    
    # Nếu nhận READY 2 lần → push backup
    if count >= 2:
        logger.info('🎯 READY received 2 times! Triggering backup push...')
        db.reset_ready()
        threading.Thread(target=push_backup_to_main, daemon=True).start()
        response['message'] = 'Backup will be pushed to main servers'
    
    return response


# ==================== HTTP Server ====================
class BackupHTTPHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logger.debug(f'HTTP: {args[0]}')
    
    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, ngrok-skip-browser-warning, X-Backup-Token')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def do_OPTIONS(self):
        self._send_json({})
    
    def do_GET(self):
        if self.path == '/health':
            self._send_json({
                'status': 'ok',
                'seq': db.get('seq'),
                'ready_count': db.get_ready_count(),
                'backup_status': db.get('backup_status'),
                'main_servers': len(MAIN_SERVERS),
                'time': datetime.now().isoformat()
            })
        elif self.path == '/backup/status':
            self._send_json({
                'status': db.get('backup_status'),
                'seq': db.get('seq'),
                'ready_count': db.get_ready_count(),
                'has_data': main_backup_data is not None,
                'main_servers': MAIN_SERVERS
            })
        else:
            self._send_json({'error': 'Not found'}, 404)
    
    def do_POST(self):
        if self.path in ['/api/backup/sync', '/api/backup/receive']:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length).decode() if content_length > 0 else '{}'
            
            try:
                msg = json.loads(body)
                logger.info(f'📥 [HTTP] Received: {msg.get("type", "unknown")}')
                
                # Xác thực token
                token = msg.get('token') or self.headers.get('X-Backup-Token')
                if token and token not in BACKUP_TOKENS:
                    self._send_json({'type': 'ERROR', 'message': 'Invalid token'}, 403)
                    return
                
                response = {}
                
                if msg.get('type') == 'READY':
                    response = handle_ready_message()
                    
                elif msg.get('type') == 'FULL_BACKUP':
                    logger.info('📥 Receiving FULL_BACKUP from main server...')
                    if msg.get('rows'):
                        global main_backup_data
                        main_backup_data = msg['rows']
                        db.set('last_backup', json.dumps(msg['rows']))
                        db.set('seq', str(msg.get('seq', int(time.time() * 1000))))
                        db.set('backup_status', 'received')
                    response = {'type': 'BACKUP_ACK', 'status': 'saved', 'seq': db.get('seq')}
                    
                elif msg.get('type') == 'POLL':
                    response = {'type': 'POLL_ACK', 'seq': db.get('seq')}
                    
                elif msg.get('type') == 'DELTA':
                    logger.info('📥 Receiving DELTA...')
                    response = {'type': 'DELTA_ACK', 'seq': db.get('seq')}
                    
                else:
                    response = {'type': 'UNKNOWN', 'message': f"Unknown type: {msg.get('type')}"}
                
                self._send_json(response)
                
            except json.JSONDecodeError:
                self._send_json({'type': 'ERROR', 'message': 'Invalid JSON'}, 400)
        
        elif self.path == '/backup/push':
            threading.Thread(target=push_backup_to_main, daemon=True).start()
            self._send_json({'status': 'pushing', 'message': 'Backup push initiated'})
        
        else:
            self._send_json({'error': 'Not found'}, 404)


# ==================== TCP Server ====================
def handle_tcp_client(client_socket, client_address):
    """Xử lý TCP client"""
    client_info = f'{client_address[0]}:{client_address[1]}'
    logger.info(f'🔌 [TCP] New connection: {client_info}')
    
    authenticated = False
    buffer = ''
    
    try:
        while True:
            data = client_socket.recv(4096)
            if not data:
                break
            
            buffer += data.decode()
            lines = buffer.split('\n')
            buffer = lines.pop()
            
            for line in lines:
                if not line.strip():
                    continue
                
                try:
                    msg = json.loads(line)
                    
                    if not authenticated:
                        if msg.get('type') == 'READY' and msg.get('token') in BACKUP_TOKENS:
                            authenticated = True
                            response = handle_ready_message()
                            client_socket.send((json.dumps(response) + '\n').encode())
                            logger.info(f'✅ [TCP] {client_info} authenticated')
                        else:
                            client_socket.send((json.dumps({'type': 'ERROR', 'message': 'Invalid token'}) + '\n').encode())
                            client_socket.close()
                            return
                    else:
                        if msg.get('type') == 'DELTA':
                            client_socket.send((json.dumps({'type': 'DELTA_ACK', 'seq': db.get('seq')}) + '\n').encode())
                        else:
                            client_socket.send((json.dumps({'type': 'UNKNOWN', 'message': f"Unknown: {msg.get('type')}"}) + '\n').encode())
                            
                except json.JSONDecodeError:
                    logger.error(f'❌ Parse error: {line[:100]}')
                    
    except Exception as e:
        logger.error(f'❌ [TCP] Socket error ({client_info}): {e}')
    finally:
        logger.info(f'🔌 [TCP] Disconnected: {client_info}')
        client_socket.close()


def start_tcp_server():
    """Khởi động TCP server"""
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('0.0.0.0', TCP_PORT))
    server.listen(5)
    logger.info(f'🔌 TCP Backup server on port {TCP_PORT}')
    
    while True:
        client_socket, client_address = server.accept()
        thread = threading.Thread(target=handle_tcp_client, args=(client_socket, client_address), daemon=True)
        thread.start()


# ==================== Main ====================
def main():
    print('╔══════════════════════════════════════╗')
    print('║   CHOCO HUB - BACKUP SERVER (Py)    ║')
    print('╚══════════════════════════════════════╝')
    
    # HTTP Server
    if HTTP_PORT:
        httpd = HTTPServer(('0.0.0.0', HTTP_PORT), BackupHTTPHandler)
        logger.info(f'🌐 HTTP Backup server on port {HTTP_PORT}')
        logger.info(f'   Health: http://localhost:{HTTP_PORT}/health')
        http_thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        http_thread.start()
    
    # TCP Server
    if TCP_PORT:
        tcp_thread = threading.Thread(target=start_tcp_server, daemon=True)
        tcp_thread.start()
    
    logger.info(f'🔐 Tokens: {", ".join(BACKUP_TOKENS) if BACKUP_TOKENS else "(none)"}')
    logger.info(f'💾 DB: {DB_PATH}')
    logger.info(f'📡 Main servers: {", ".join(MAIN_SERVERS) if MAIN_SERVERS else "(none - will only receive, not push)"}')
    print('')
    
    # Auto-fetch từ main server
    if MAIN_SERVERS:
        time.sleep(2)
        fetch_from_main_servers()
        # Fetch định kỳ
        def periodic_fetch():
            while True:
                time.sleep(60)
                fetch_from_main_servers()
        threading.Thread(target=periodic_fetch, daemon=True).start()
    
    # Giữ main thread alive
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print('\n🛑 Shutting down...')
        db.close()
        sys.exit(0)


if __name__ == '__main__':
    main()
