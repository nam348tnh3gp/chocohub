import os
import time
import requests
import sqlite3
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

# ========== CẤU HÌNH ==========
RENDER_API_URL = os.getenv("RENDER_API_URL", "https://chocohub-r011.onrender.com")
ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "chocoetom")   # hoặc "Nam2010"
ADMIN_PIN = os.getenv("ADMIN_PIN")                         # PIN của admin
DUCO_FAUCET_USERNAME = os.getenv("DUCO_FAUCET_USERNAME")   # tài khoản faucet DUCO
DUCO_FAUCET_PASSWORD = os.getenv("DUCO_FAUCET_PASSWORD")   # password faucet DUCO
MEMO = os.getenv("MEMO", "Swap")
SLEEP_INTERVAL = int(os.getenv("SLEEP_INTERVAL", "30"))

# Cache JWT
jwt_token = None
token_expiry = 0

# Cache balance faucet DUCO
balance_cache = {"balance": None, "last_updated": None, "expiry_seconds": 60}

# Database local để tránh xử lý trùng lặp
DB_FILE = "swap_history.db"

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""CREATE TABLE IF NOT EXISTS swap_history
                 (request_id TEXT PRIMARY KEY,
                  from_user TEXT,
                  amount_cc REAL,
                  swap_type TEXT,
                  receiver TEXT,
                  processed_at TIMESTAMP,
                  txid TEXT)""")
    conn.commit()
    conn.close()

init_db()

def is_processed(request_id):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("SELECT 1 FROM swap_history WHERE request_id = ?", (request_id,))
    row = c.fetchone()
    conn.close()
    return row is not None

def record_processed(request_id, from_user, amount_cc, swap_type, receiver, txid):
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute("""INSERT OR REPLACE INTO swap_history
                 (request_id, from_user, amount_cc, swap_type, receiver, processed_at, txid)
                 VALUES (?, ?, ?, ?, ?, ?, ?)""",
              (request_id, from_user, amount_cc, swap_type, receiver, datetime.now().isoformat(), txid))
    conn.commit()
    conn.close()

# ========== XÁC THỰC LẤY TOKEN ==========
def get_admin_token():
    global jwt_token, token_expiry
    now = time.time()
    if jwt_token and now < token_expiry:
        return jwt_token

    url = f"{RENDER_API_URL}/auth"
    payload = {"username": ADMIN_USERNAME, "pin": ADMIN_PIN}
    try:
        resp = requests.post(url, json=payload, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("status") == "success" and data.get("token"):
                jwt_token = data["token"]
                token_expiry = now + 23 * 3600  # 23 tiếng (token có hạn 24h)
                print(f"🔑 Đã lấy token cho {ADMIN_USERNAME}")
                return jwt_token
        print(f"❌ Xác thực thất bại: {resp.status_code}")
    except Exception as e:
        print(f"❌ Lỗi kết nối: {e}")
    return None

# ========== GỌI API CÓ TOKEN ==========
def api_call(endpoint, method="GET", data=None):
    token = get_admin_token()
    if not token:
        return None
    url = f"{RENDER_API_URL}{endpoint}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    try:
        if method == "GET":
            resp = requests.get(url, headers=headers, timeout=15)
        elif method == "POST":
            resp = requests.post(url, json=data, headers=headers, timeout=15)
        elif method == "DELETE":
            resp = requests.delete(url, headers=headers, timeout=10)
        else:
            return None
        if resp.status_code in (200, 201):
            return resp.json()
        print(f"⚠️ API {endpoint} lỗi {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        print(f"⚠️ Lỗi kết nối API: {e}")
    return None

def get_pending_swaps():
    data = api_call("/swap/pending", "GET")
    if data and data.get("status") == "success":
        return data.get("pending", [])
    return []

def fulfill_swap(request_id):
    data = api_call("/swap/fulfill", "POST", {"request_id": request_id})
    return data and data.get("status") == "success"

# ========== GỬI COIN THẬT ==========
def update_faucet_balance():
    now = time.time()
    if (balance_cache["balance"] is not None and balance_cache["last_updated"] and
        now - balance_cache["last_updated"] < balance_cache["expiry_seconds"]):
        return balance_cache["balance"]
    try:
        url = f"https://server.duinocoin.com/users/{DUCO_FAUCET_USERNAME}"
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                balance = data["result"]["balance"]["balance"]
                balance_cache["balance"] = balance
                balance_cache["last_updated"] = now
                print(f"💰 Faucet DUCO balance: {balance:.2f} DUCO")
                return balance
    except Exception as e:
        print(f"⚠️ Lỗi lấy balance DUCO: {e}")
    return balance_cache["balance"] or 0.0

def send_duco(recipient, amount_cc):
    """Gửi DUCO qua API Duino Coin, trả về (success, txid_or_error)"""
    amount_duco = amount_cc / 10.0
    params = {
        "username": DUCO_FAUCET_USERNAME,
        "password": DUCO_FAUCET_PASSWORD,
        "recipient": recipient,
        "amount": amount_duco,
        "memo": MEMO
    }
    try:
        resp = requests.get("https://server.duinocoin.com/transaction/", params=params, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return True, data.get("txid", "unknown")
            else:
                return False, data.get("message", "Unknown error")
        return False, f"HTTP {resp.status_code}"
    except Exception as e:
        return False, str(e)

def send_ccpoc(receiver, amount_cc):
    """Tích hợp API CC PoC nếu có. Ở đây giả lập."""
    amount_poc = amount_cc * 0.75
    print(f"   [Giả lập] Gửi {amount_poc} CC PoC đến {receiver}")
    return True, "simulated_txid"

# ========== XỬ LÝ MỘT SWAP ==========
def process_swap(req):
    rid = req.get("id")
    from_user = req.get("from_user")
    amount_cc = req.get("amount_cc")
    swap_type = req.get("swap_type")
    receiver = req.get("receiver")

    if not all([rid, from_user, amount_cc, swap_type, receiver]):
        print(f"   ⚠️ Request thiếu thông tin: {req}")
        return False

    if is_processed(rid):
        print(f"   ℹ️ Swap {rid} đã xử lý trước đó (bỏ qua)")
        return True  # coi như thành công để xóa request

    print(f"\n🔹 Swap {rid}: {from_user} -> {amount_cc} CC ({swap_type}) cho {receiver}")

    if swap_type == "duco":
        balance = update_faucet_balance()
        required_duco = amount_cc / 10.0
        if balance < required_duco:
            print(f"   ⚠️ Không đủ DUCO: cần {required_duco:.2f} DUCO, có {balance:.2f} DUCO")
            return False
        success, info = send_duco(receiver, amount_cc)
        if success:
            print(f"   ✅ Đã gửi {required_duco:.2f} DUCO, TxID: {info}")
            record_processed(rid, from_user, amount_cc, swap_type, receiver, info)
            update_faucet_balance()  # cập nhật lại balance sau khi gửi
            return True
        else:
            print(f"   ❌ Gửi DUCO thất bại: {info}")
            return False

    elif swap_type == "ccpoc":
        success, info = send_ccpoc(receiver, amount_cc)
        if success:
            print(f"   ✅ Đã gửi CC PoC (giả lập), ID: {info}")
            record_processed(rid, from_user, amount_cc, swap_type, receiver, info)
            return True
        else:
            print(f"   ❌ Gửi CC PoC thất bại: {info}")
            return False
    else:
        print(f"   ❌ Loại swap không hỗ trợ: {swap_type}")
        return False

# ========== VÒNG LẶP CHÍNH ==========
def main():
    print("🚀 Swap Client for ChocoHub (Duino Coin + CC PoC)")
    print(f"📍 Server: {RENDER_API_URL}")
    print(f"👤 Admin: {ADMIN_USERNAME}")
    print(f"⏱️  Interval: {SLEEP_INTERVAL}s\n")

    while True:
        try:
            swaps = get_pending_swaps()
            if swaps is None:
                print("⚠️ Không thể lấy danh sách swap, thử lại...")
                time.sleep(SLEEP_INTERVAL)
                continue

            if not swaps:
                print("✅ Không có swap pending")
            else:
                print(f"📋 Tìm thấy {len(swaps)} swap pending")
                for req in swaps:
                    success = process_swap(req)
                    if success:
                        if fulfill_swap(req["id"]):
                            print(f"   ✅ Đã báo server hoàn thành swap {req['id']}")
                        else:
                            print(f"   ⚠️ Không báo được server, sẽ thử lại lần sau")
                    else:
                        print(f"   ⏳ Giữ lại swap {req['id']} để xử lý sau")
                    time.sleep(2)  # nghỉ giữa các request

            print(f"\n⏳ Chờ {SLEEP_INTERVAL} giây...")
            time.sleep(SLEEP_INTERVAL)

        except KeyboardInterrupt:
            print("\n🛑 Dừng bởi người dùng")
            break
        except Exception as e:
            print(f"❌ Lỗi vòng lặp: {e}")
            time.sleep(30)

if __name__ == "__main__":
    if not ADMIN_PIN:
        print("❌ Thiếu ADMIN_PIN trong biến môi trường!")
        exit(1)
    if not DUCO_FAUCET_USERNAME or not DUCO_FAUCET_PASSWORD:
        print("⚠️ Thiếu DUCO_FAUCET_USERNAME/PASSWORD – sẽ không gửi được DUCO thật!")
    main()
