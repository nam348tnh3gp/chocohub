import os
import time
import requests
import sqlite3
import json
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
    
    # DUCO Recipient (địa chỉ nhận DUCO khi swap DUCO→CC)
    print("\n--- DUCO Recipient Info (your wallet address) ---")
    config["DUCO_RECIPIENT"] = input("DUCO recipient username [Nam2010]: ").strip()
    if not config["DUCO_RECIPIENT"]:
        config["DUCO_RECIPIENT"] = "Nam2010"
    
    # Options
    print("\n--- Options (Press Enter for defaults) ---")
    memo = input("Memo for transaction [Swap from chocohub]: ").strip()
    config["MEMO"] = memo if memo else "Swap from chocohub"
    
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
MEMO = config.get("MEMO", "Swap from chocohub")
SLEEP_INTERVAL = config.get("SLEEP_INTERVAL", 30)

# Cache JWT
jwt_token = None
token_expiry = 0

# Cache balance faucet DUCO
balance_cache = {"balance": None, "last_updated": None, "expiry_seconds": 60}

# Local database
DB_FILE = "swap_history.db"
DUCO_TX_FILE = "duco_processed.json"
LAST_CHECK_FILE = "last_check.json"

# 👉 HEADERS CHO DUCO API
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
        elif method == "DELETE":
            resp = requests.delete(url, headers=headers, timeout=10)
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
        # 👉 THÊM HEADERS
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
        "memo": MEMO
    }
    try:
        # 👉 THÊM HEADERS
        resp = requests.get("https://server.duinocoin.com/transaction/", params=params, headers=DUCO_HEADERS, timeout=15)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success"):
                print(f"   ✅ DUCO transfer initiated")
                return True, None
            else:
                return False, data.get("message", "Unknown error")
        return False, f"HTTP {resp.status_code}"
    except Exception as e:
        return False, str(e)

def fetch_transaction_hash(amount_duco, expected_memo, sender, max_wait=30):
    """Fetch transaction hash từ DUCO API sau khi gửi"""
    start_time = time.time()
    
    while time.time() - start_time < max_wait:
        try:
            url = f"https://server.duinocoin.com/user_transactions/{sender}?limit=20"
            # 👉 THÊM HEADERS
            resp = requests.get(url, headers=DUCO_HEADERS, timeout=10)
            
            if resp.status_code == 200:
                data = resp.json()
                if data.get("success"):
                    for tx in data.get("result", []):
                        if (tx.get("sender") == sender and 
                            tx.get("recipient") == DUCO_RECIPIENT and
                            abs(float(tx.get("amount", 0)) - amount_duco) <= 0.01 and
                            tx.get("memo", "").strip() == expected_memo):
                            return tx.get("hash")
            
            time.sleep(2)
        except:
            time.sleep(2)
    
    return None

def check_incoming_duco_transactions():
    """Check transactions NHẬN vào DUCO_RECIPIENT (DUCO → CC)"""
    processed_txids = load_processed_txids()
    
    try:
        url = f"https://server.duinocoin.com/user_transactions/{DUCO_RECIPIENT}?limit=50"
        # 👉 THÊM HEADERS
        resp = requests.get(url, headers=DUCO_HEADERS, timeout=15)
        
        if resp.status_code != 200:
            return
        
        data = resp.json()
        if not data.get("success"):
            return
        
        transactions = data.get("result", [])
        
        incoming_txs = [tx for tx in transactions if tx.get("recipient") == DUCO_RECIPIENT]
        
        if not incoming_txs:
            return
        
        pending_swaps = get_pending_swaps()
        if not pending_swaps:
            return
        
        for tx in incoming_txs:
            full_hash = tx.get("hash")
            if not full_hash or full_hash in processed_txids:
                continue
            
            memo = tx.get("memo", "").strip()
            amount_duco = float(tx.get("amount", 0))
            sender = tx.get("sender", "unknown")
            
            for req in pending_swaps:
                if req.get("status") != "pending":
                    continue
                if req.get("swap_type") != "duco_to_cc":
                    continue
                
                expected_duco = req.get("amount_cc", 0) / 10.0
                
                if abs(amount_duco - expected_duco) <= 0.01:
                    print(f"\n✅ Found incoming DUCO transaction!")
                    print(f"   Sender: {sender}")
                    print(f"   Amount: {amount_duco} DUCO")
                    print(f"   Memo: {memo}")
                    print(f"   Hash: {full_hash}")
                    print(f"   Swap ID: {req['id']}")
                    
                    if fulfill_swap(req["id"]):
                        print(f"   ✅ Auto-fulfilled DUCO → CC swap for {req['from_user']}")
                        record_processed(req["id"], req["from_user"], req["amount_cc"],
                                        req.get("swap_type"), req["receiver"], full_hash)
                        processed_txids.add(full_hash)
                        save_processed_txids(processed_txids)
                    break
                    
    except Exception as e:
        print(f"⚠️ Error checking DUCO transactions: {e}")

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
        balance = update_faucet_balance()
        required_duco = amount_cc / 10.0
        if balance < required_duco:
            print(f"   ⚠️ Insufficient DUCO: need {required_duco:.2f} DUCO, have {balance:.2f} DUCO")
            return False
        
        success, _ = send_duco(receiver, amount_cc)
        if success:
            print(f"   ✅ Sent {required_duco:.2f} DUCO, fetching transaction hash...")
            
            tx_hash = fetch_transaction_hash(
                amount_duco=required_duco,
                expected_memo=MEMO,
                sender=DUCO_FAUCET_USERNAME,
                max_wait=30
            )
            
            if tx_hash:
                print(f"   ✅ Transaction hash: {truncate_hash(tx_hash)}")
                if fulfill_swap(rid):
                    record_processed(rid, from_user, amount_cc, swap_type, receiver, tx_hash)
                    print(f"   ✅ Swap {rid} completed and recorded")
                    return True
                else:
                    print(f"   ⚠️ Could not fulfill swap")
                    return False
            else:
                print(f"   ⚠️ Could not fetch hash, but transaction sent")
                record_processed(rid, from_user, amount_cc, swap_type, receiver, f"pending_{rid}")
                if fulfill_swap(rid):
                    print(f"   ✅ Swap {rid} completed (hash pending)")
                    return True
                return False
        else:
            print(f"   ❌ DUCO send failed")
            return False

    elif swap_type == "ccpoc":
        success, info = send_ccpoc(receiver, amount_cc)
        if success:
            print(f"   ✅ Sent CC PoC (simulated), ID: {info}")
            record_processed(rid, from_user, amount_cc, swap_type, receiver, info)
            if fulfill_swap(rid):
                print(f"   ✅ Notified server: swap {rid} completed")
            return True
        else:
            print(f"   ❌ CC PoC send failed: {info}")
            return False
    else:
        print(f"   ⚠️ Skipping swap type: {swap_type}")
        return False

def send_ccpoc(receiver, amount_cc):
    amount_poc = amount_cc * 0.75
    print(f"   [Simulated] Sending {amount_poc} CC PoC to {receiver}")
    return True, "simulated_txid"

def main():
    print("\n" + "="*50)
    print("🚀 SWAP CLIENT - ChocoHub")
    print("="*50)
    print(f"📍 Server: {RENDER_API_URL}")
    print(f"👤 Admin: {ADMIN_USERNAME}")
    print(f"💰 DUCO Faucet: {DUCO_FAUCET_USERNAME}")
    print(f"📥 DUCO Recipient: {DUCO_RECIPIENT}")
    print(f"📝 Memo: {MEMO}")
    print(f"⏱️  Interval: {SLEEP_INTERVAL}s")
    print("="*50 + "\n")

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
                    if swap_type == "duco":
                        process_swap(req)
                        time.sleep(2)
                    elif swap_type == "duco_to_cc":
                        print(f"   ℹ️ DUCO→CC swap {req['id']} waiting for incoming transaction...")
                    elif swap_type == "ccpoc":
                        process_swap(req)
                        time.sleep(2)
                    else:
                        print(f"   ⚠️ Unknown swap type: {swap_type}")
            else:
                print("✅ No pending swaps")

            now = time.time()
            if now - last_incoming_check > 30:
                check_incoming_duco_transactions()
                last_incoming_check = now

            print(f"\n⏳ Waiting {SLEEP_INTERVAL} seconds...")
            time.sleep(SLEEP_INTERVAL)

        except KeyboardInterrupt:
            print("\n🛑 Stopped by user")
            break
        except Exception as e:
            print(f"❌ Loop error: {e}")
            time.sleep(30)

if __name__ == "__main__":
    main()
