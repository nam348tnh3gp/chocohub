import os
import time
import sqlite3
import json
import requests
from datetime import datetime

# ========== CONFIG FILE ==========
CONFIG_FILE = "swap_config.json"

def load_config():
    """Load config from file if exists"""
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r') as f:
                config = json.load(f)
                print("✅ Loaded config from file")
                return config
        except:
            pass
    return None

def save_config(config):
    """Save config to file"""
    with open(CONFIG_FILE, 'w') as f:
        json.dump(config, f, indent=2)
    print("💾 Saved config to file")

def interactive_setup():
    """Ask user for configuration interactively"""
    print("\n" + "="*50)
    print("🔧 FIRST RUN - ENTER CONFIGURATION")
    print("="*50)
    
    config = {}
    
    # Server
    config["RENDER_API_URL"] = input("Server URL [https://chocohub-r011.onrender.com]: ").strip()
    if not config["RENDER_API_URL"]:
        config["RENDER_API_URL"] = "https://chocohub-r011.onrender.com"
    
    # Admin
    print("\n--- Admin Info (authenticate with ChocoHub) ---")
    config["ADMIN_USERNAME"] = input(f"Admin username [chocoetom]: ").strip()
    if not config["ADMIN_USERNAME"]:
        config["ADMIN_USERNAME"] = "chocoetom"
    config["ADMIN_PIN"] = input("Admin PIN: ")
    
    # DUCO Faucet
    print("\n--- DUCO Faucet Info (to send coins) ---")
    config["DUCO_FAUCET_USERNAME"] = input("DUCO Faucet Username: ").strip()
    config["DUCO_FAUCET_PASSWORD"] = input("DUCO Faucet Password: ")
    
    # DUCO Recipient (ví của bạn để nhận DUCO từ user)
    print("\n--- Your DUCO Wallet (to receive coins from users) ---")
    config["DUCO_RECIPIENT"] = input("Your DUCO username [Nam2010]: ").strip()
    if not config["DUCO_RECIPIENT"]:
        config["DUCO_RECIPIENT"] = "Nam2010"
    
    # Options
    print("\n--- Options (Press Enter for defaults) ---")
    memo = input("Memo prefix for SWAP [SWAP CC for]: ").strip()
    config["MEMO_PREFIX"] = memo if memo else "SWAP CC for"
    
    interval = input("Check interval (seconds) [30]: ").strip()
    config["SLEEP_INTERVAL"] = int(interval) if interval.isdigit() else 30
    
    print("\n" + "="*50)
    print("✅ Configuration complete!")
    print("="*50)
    
    return config

# ========== LOAD OR ENTER CONFIG ==========
config = load_config()
if not config:
    config = interactive_setup()
    save_config(config)

# ========== CONFIG FROM FILE ==========
RENDER_API_URL = config.get("RENDER_API_URL")
ADMIN_USERNAME = config.get("ADMIN_USERNAME")
ADMIN_PIN = config.get("ADMIN_PIN")
DUCO_FAUCET_USERNAME = config.get("DUCO_FAUCET_USERNAME")
DUCO_FAUCET_PASSWORD = config.get("DUCO_FAUCET_PASSWORD")
DUCO_RECIPIENT = config.get("DUCO_RECIPIENT", "Nam2010")
MEMO_PREFIX = config.get("MEMO_PREFIX", "SWAP CC for")
SLEEP_INTERVAL = config.get("SLEEP_INTERVAL", 30)

# Cache JWT
jwt_token = None
token_expiry = 0

# Cache balance faucet DUCO
balance_cache = {"balance": None, "last_updated": None, "expiry_seconds": 60}

# Local database
DB_FILE = "swap_history.db"
DUCO_TX_FILE = "duco_processed.json"

# HEADERS cho DUCO API
DUCO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Connection": "keep-alive"
}

def truncate_hash(hash_str, length=9):
    """Rút gọn hash cho hiển thị đẹp"""
    if not hash_str:
        return "unknown"
    if len(hash_str) <= length:
        return hash_str
    return hash_str[:length] + "..."

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
    print("📁 Database initialized")

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

def load_processed_txids():
    """Load danh sách txid đã xử lý (để tránh duplicate)"""
    if os.path.exists(DUCO_TX_FILE):
        try:
            with open(DUCO_TX_FILE, 'r') as f:
                txids = json.load(f)
                return set(txids)
        except:
            pass
    return set()

def save_processed_txids(txids):
    with open(DUCO_TX_FILE, 'w') as f:
        json.dump(list(txids), f, indent=2)

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
                token_expiry = now + 23 * 3600
                print(f"🔑 Got token for {ADMIN_USERNAME}")
                return jwt_token
        print(f"❌ Authentication failed: {resp.status_code}")
        if resp.status_code == 401:
            print("   → Wrong username or PIN. Please run again with correct credentials.")
            exit(1)
    except Exception as e:
        print(f"❌ Connection error: {e}")
    return None

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
        else:
            return None
        if resp.status_code in (200, 201):
            return resp.json()
        print(f"⚠️ API {endpoint} error {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        print(f"⚠️ API connection error: {e}")
    return None

def get_pending_swaps():
    data = api_call("/swap/pending", "GET")
    if data and data.get("status") == "success":
        return data.get("pending", [])
    return []

def fulfill_swap(request_id):
    data = api_call("/swap/fulfill", "POST", {"request_id": request_id})
    return data and data.get("status") == "success"

def update_faucet_balance():
    now = time.time()
    if (balance_cache["balance"] is not None and balance_cache["last_updated"] and
        now - balance_cache["last_updated"] < balance_cache["expiry_seconds"]):
        return balance_cache["balance"]
    try:
        url = f"https://server.duinocoin.com/users/{DUCO_FAUCET_USERNAME}"
        resp = requests.get(url, headers=DUCO_HEADERS, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                balance = data["result"]["balance"]["balance"]
                balance_cache["balance"] = balance
                balance_cache["last_updated"] = now
                print(f"💰 Faucet DUCO balance: {balance:.2f} DUCO")
                return balance
    except Exception as e:
        print(f"⚠️ Error fetching DUCO balance: {e}")
    return balance_cache["balance"] or 0.0

def send_duco(recipient, amount_cc):
    """Gửi DUCO đi (CC → DUCO)"""
    amount_duco = amount_cc / 10.0
    params = {
        "username": DUCO_FAUCET_USERNAME,
        "password": DUCO_FAUCET_PASSWORD,
        "recipient": recipient,
        "amount": amount_duco,
        "memo": f"{MEMO_PREFIX} {recipient}"
    }
    try:
        resp = requests.get("https://server.duinocoin.com/transaction/", params=params, headers=DUCO_HEADERS, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                print(f"   ✅ DUCO transfer initiated")
                print(f"   📝 Memo: {params['memo']}")
                print(f"   💰 Amount: {amount_duco} DUCO")
                return True, None
            else:
                return False, data.get("message", "Unknown error")
        return False, f"HTTP {resp.status_code}"
    except Exception as e:
        return False, str(e)

# ========== CHECK INCOMING DUCO TRANSACTIONS (USER GỬI CHO BẠN) ==========
def fetch_my_transactions(limit=50):
    """Fetch transactions của ví bạn (DUCO_RECIPIENT)"""
    url = f"https://server.duinocoin.com/user_transactions/{DUCO_RECIPIENT}?limit={limit}"
    try:
        resp = requests.get(url, headers=DUCO_HEADERS, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                return data.get("result", [])
            else:
                print(f"   ⚠️ API returned success=false: {data.get('message')}")
        else:
            print(f"   ⚠️ HTTP {resp.status_code}")
    except Exception as e:
        print(f"   ⚠️ Error fetching: {e}")
    return []

def check_incoming_duco_transactions():
    """
    CHECK GIAO DỊCH USER GỬI CHO BẠN (DUCO_RECIPIENT)
    Nếu tìm thấy memo đúng format và amount đúng → auto fulfill
    """
    print(f"\n🔍 Fetching incoming DUCO transactions for {DUCO_RECIPIENT}...")
    
    processed_txids = load_processed_txids()
    transactions = fetch_my_transactions(50)
    
    if not transactions:
        print("   ❌ No transactions found or API error")
        return False
    
    print(f"   ✅ Fetched {len(transactions)} total transactions")
    
    # Lọc giao dịch NHẬN (recipient = bạn) và chưa xử lý
    incoming_txs = [
        tx for tx in transactions 
        if tx.get("recipient") == DUCO_RECIPIENT 
        and tx.get("hash") not in processed_txids
    ]
    
    if not incoming_txs:
        print(f"   ℹ️ No new incoming transactions (all {len(transactions)} are outgoing or already processed)")
        return False
    
    print(f"   🎯 Found {len(incoming_txs)} new incoming transactions")
    
    # Debug: Log tất cả incoming transactions để kiểm tra
    for idx, tx in enumerate(incoming_txs[:5], 1):
        print(f"      {idx}. Sender: {tx.get('sender')}, Amount: {tx.get('amount')}, Memo: '{tx.get('memo', '')}'")
    
    # Lấy pending swaps
    pending_swaps = get_pending_swaps()
    if not pending_swaps:
        print("   ℹ️ No pending swaps")
        return False
    
    # Lọc các swap đang chờ loại duco_to_cc
    pending_ducos = [req for req in pending_swaps if req.get("swap_type") == "duco_to_cc" and req.get("status") == "pending"]
    
    if not pending_ducos:
        print("   ℹ️ No pending duco_to_cc swaps")
        return False
    
    print(f"   📋 Found {len(pending_ducos)} pending duco_to_cc swaps")
    
    # Tạo map: expected_memo -> swap request
    pending_by_memo = {}
    for req in pending_ducos:
        receiver = req.get("receiver")
        expected_memo = f"{MEMO_PREFIX} {receiver}"
        pending_by_memo[expected_memo] = req
        print(f"      Waiting for memo: '{expected_memo}' (Swap ID: {req['id']}, Amount: {req['amount_cc']/10:.2f} DUCO)")
    
    # Duyệt từng incoming transaction
    for tx in incoming_txs:
        tx_hash = tx.get("hash")
        memo = tx.get("memo", "").strip()
        amount_duco = float(tx.get("amount", 0))
        sender = tx.get("sender", "unknown")
        
        print(f"\n   📝 Checking transaction: {truncate_hash(tx_hash)}")
        print(f"      Sender: {sender}")
        print(f"      Amount: {amount_duco} DUCO")
        print(f"      Memo: '{memo}'")
        
        # Tìm swap matching với memo này
        if memo not in pending_by_memo:
            print(f"      ❌ Memo not in pending list")
            continue
        
        req = pending_by_memo[memo]
        expected_duco = req.get("amount_cc", 0) / 10.0
        
        # Kiểm tra amount (cho phép sai số 0.01 DUCO)
        if abs(amount_duco - expected_duco) > 0.01:
            print(f"      ❌ Amount mismatch: expected {expected_duco}, got {amount_duco}")
            continue
        
        print(f"      ✅ MATCH FOUND!")
        print(f"      🎉 Auto-fulfilling swap {req['id']}")
        
        # Fulfill swap ngay lập tức
        if fulfill_swap(req["id"]):
            print(f"      ✅ Swap {req['id']} fulfilled successfully!")
            record_processed(req["id"], req["from_user"], req["amount_cc"],
                            req.get("swap_type"), req["receiver"], tx_hash)
            processed_txids.add(tx_hash)
            save_processed_txids(processed_txids)
            print(f"      📝 Recorded transaction hash: {tx_hash}")
            return True
        else:
            print(f"      ❌ Failed to fulfill swap {req['id']}")
    
    print(f"\n   ⏳ No matching transaction found for any pending swap")
    return False

def process_swap(req):
    rid = req.get("id")
    from_user = req.get("from_user")
    amount_cc = req.get("amount_cc")
    swap_type = req.get("swap_type")
    receiver = req.get("receiver")

    if not all([rid, from_user, amount_cc, swap_type, receiver]):
        print(f"   ⚠️ Request missing info: {req}")
        return False

    if is_processed(rid):
        print(f"   ℹ️ Swap {rid} already processed (skipping)")
        return True

    print(f"\n🔹 Swap {rid}: {from_user} -> {amount_cc} CC ({swap_type}) to {receiver}")

    if swap_type == "duco":
        # CC → DUCO: Gửi DUCO từ faucet đến receiver (user)
        print(f"\n   💸 Sending DUCO from faucet to {receiver}")
        
        balance = update_faucet_balance()
        required_duco = amount_cc / 10.0
        
        if balance < required_duco:
            print(f"   ❌ Insufficient DUCO: need {required_duco:.2f}, have {balance:.2f}")
            return False
        
        success, error = send_duco(receiver, amount_cc)
        if success:
            print(f"   ✅ DUCO sent successfully!")
            temp_txid = f"sent_{int(time.time())}"
            record_processed(rid, from_user, amount_cc, swap_type, receiver, temp_txid)
            
            if fulfill_swap(rid):
                print(f"   ✅ Swap {rid} fulfilled")
                return True
        else:
            print(f"   ❌ Failed to send DUCO: {error}")
            return False

    elif swap_type == "duco_to_cc":
        # DUCO → CC: User gửi DUCO cho bạn, bạn check ngay
        print(f"\n   🔍 Waiting for user to send {amount_cc/10:.2f} DUCO to {DUCO_RECIPIENT}")
        print(f"   📝 Expected memo: '{MEMO_PREFIX} {receiver}'")
        print(f"   ⚡ Checking immediately...")
        
        # Check ngay lập tức
        success = check_incoming_duco_transactions()
        
        if success:
            print(f"   ✅ Swap {rid} processed immediately!")
        else:
            print(f"   ⏳ No transaction found yet for swap {rid}")
        
        return success

    elif swap_type == "ccpoc":
        amount_poc = amount_cc * 0.75
        print(f"   [Simulated] Sending {amount_poc} CC PoC to {receiver}")
        txid = f"SIM_{int(time.time())}"
        record_processed(rid, from_user, amount_cc, swap_type, receiver, txid)
        if fulfill_swap(rid):
            print(f"   ✅ Swap {rid} completed")
        return True
    else:
        print(f"   ⚠️ Unknown swap type: {swap_type}")
        return False

def main():
    print("\n" + "="*60)
    print("🚀 SWAP CLIENT - ChocoHub (Auto-fulfill DUCO→CC)")
    print("="*60)
    print(f"📍 Server: {RENDER_API_URL}")
    print(f"👤 Admin: {ADMIN_USERNAME}")
    print(f"💰 DUCO Faucet: {DUCO_FAUCET_USERNAME}")
    print(f"📥 Your DUCO Wallet: {DUCO_RECIPIENT}")
    print(f"📝 Memo Prefix: {MEMO_PREFIX}")
    print(f"⏱️  Interval: {SLEEP_INTERVAL}s")
    print("="*60 + "\n")

    last_incoming_check = 0
    
    while True:
        try:
            swaps = get_pending_swaps()
            if swaps is None:
                print("⚠️ Cannot fetch swap list, retrying...")
                time.sleep(SLEEP_INTERVAL)
                continue

            if swaps:
                print(f"📋 Found {len(swaps)} pending swaps")
                for req in swaps:
                    swap_type = req.get("swap_type")
                    
                    if swap_type == "duco_to_cc":
                        # XỬ LÝ NGAY LẬP TỨC
                        print(f"\n⚡ Processing DUCO→CC swap {req['id']} IMMEDIATELY!")
                        process_swap(req)
                        time.sleep(2)
                    elif swap_type == "duco":
                        print(f"\n💰 Processing CC→DUCO swap {req['id']}")
                        process_swap(req)
                        time.sleep(2)
                    elif swap_type == "ccpoc":
                        print(f"\n🎮 Processing CCPOC swap {req['id']}")
                        process_swap(req)
                        time.sleep(2)
                    else:
                        print(f"   ⚠️ Unknown swap type: {swap_type}")
            else:
                print("✅ No pending swaps")

            # Periodic check cho các transaction đến sau (mỗi 30s)
            now = time.time()
            if now - last_incoming_check > 30:
                print("\n🔄 Periodic check for pending DUCO→CC swaps...")
                check_incoming_duco_transactions()
                last_incoming_check = now

            print(f"\n⏳ Waiting {SLEEP_INTERVAL} seconds...")
            time.sleep(SLEEP_INTERVAL)

        except KeyboardInterrupt:
            print("\n🛑 Stopped by user")
            break
        except Exception as e:
            print(f"❌ Loop error: {e}")
            import traceback
            traceback.print_exc()
            time.sleep(30)

if __name__ == "__main__":
    main()
