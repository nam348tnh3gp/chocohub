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
    
    # Options
    print("\n--- Options (Press Enter for defaults) ---")
    memo = input("Memo for transaction [Swap]: ").strip()
    config["MEMO"] = memo if memo else "Swap"
    
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
MEMO = config.get("MEMO", "Swap")
SLEEP_INTERVAL = config.get("SLEEP_INTERVAL", 30)

# Cache JWT
jwt_token = None
token_expiry = 0

# Cache balance faucet DUCO
balance_cache = {"balance": None, "last_updated": None, "expiry_seconds": 60}

# Local database to avoid duplicate processing
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

# ========== GET ADMIN TOKEN ==========
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
                token_expiry = now + 23 * 3600  # 23 hours (token expires in 24h)
                print(f"🔑 Got token for {ADMIN_USERNAME}")
                return jwt_token
        print(f"❌ Authentication failed: {resp.status_code}")
        if resp.status_code == 401:
            print("   → Wrong username or PIN. Please run again with correct credentials.")
            exit(1)
    except Exception as e:
        print(f"❌ Connection error: {e}")
    return None

# ========== API CALLS WITH TOKEN ==========
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

# ========== SEND REAL COINS ==========
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
        print(f"⚠️ Error fetching DUCO balance: {e}")
    return balance_cache["balance"] or 0.0

def send_duco(recipient, amount_cc):
    """Send DUCO via Duino Coin API, returns (success, txid_or_error)"""
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
    """Integrate with CC PoC API if available. Currently simulated."""
    amount_poc = amount_cc * 0.75
    print(f"   [Simulated] Sending {amount_poc} CC PoC to {receiver}")
    return True, "simulated_txid"

# ========== PROCESS ONE SWAP ==========
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
        success, info = send_duco(receiver, amount_cc)
        if success:
            print(f"   ✅ Sent {required_duco:.2f} DUCO, TxID: {info}")
            record_processed(rid, from_user, amount_cc, swap_type, receiver, info)
            update_faucet_balance()
            return True
        else:
            print(f"   ❌ DUCO send failed: {info}")
            return False

    elif swap_type == "ccpoc":
        success, info = send_ccpoc(receiver, amount_cc)
        if success:
            print(f"   ✅ Sent CC PoC (simulated), ID: {info}")
            record_processed(rid, from_user, amount_cc, swap_type, receiver, info)
            return True
        else:
            print(f"   ❌ CC PoC send failed: {info}")
            return False
    else:
        print(f"   ❌ Unsupported swap type: {swap_type}")
        return False

# ========== MAIN LOOP ==========
def main():
    print("\n" + "="*50)
    print("🚀 SWAP CLIENT - ChocoHub")
    print("="*50)
    print(f"📍 Server: {RENDER_API_URL}")
    print(f"👤 Admin: {ADMIN_USERNAME}")
    print(f"💾 Config: {CONFIG_FILE}")
    print(f"⏱️  Interval: {SLEEP_INTERVAL}s")
    print("="*50 + "\n")

    while True:
        try:
            swaps = get_pending_swaps()
            if swaps is None:
                print("⚠️ Cannot fetch swap list, retrying...")
                time.sleep(SLEEP_INTERVAL)
                continue

            if not swaps:
                print("✅ No pending swaps")
            else:
                print(f"📋 Found {len(swaps)} pending swaps")
                for req in swaps:
                    success = process_swap(req)
                    if success:
                        if fulfill_swap(req["id"]):
                            print(f"   ✅ Notified server: swap {req['id']} completed")
                        else:
                            print(f"   ⚠️ Could not notify server, will retry later")
                    else:
                        print(f"   ⏳ Keeping swap {req['id']} for later processing")
                    time.sleep(2)

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
