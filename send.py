import os
import time
import sqlite3
import json
from datetime import datetime
from urllib import parse, request, error

# ========== CONFIG FILE ==========
CONFIG_FILE = "swap_config.json"
DEFAULT_SERVER_URL = "https://chocohub-r011.onrender.com"
DB_FILE = "swap_history.db"
DUCO_TX_FILE = "duco_processed.json"

DUCO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Connection": "keep-alive",
}

JSON_HEADERS = {"Content-Type": "application/json", **DUCO_HEADERS}


def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                config = json.load(f)
                print("✅ Loaded config from file")
                return config if isinstance(config, dict) else None
        except Exception:
            pass
    return None


def save_config(config):
    with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
        json.dump(config, f, indent=2)
    print("💾 Saved config to file")


def interactive_setup():
    print("\n" + "=" * 50)
    print("🔧 FIRST RUN - ENTER CONFIGURATION")
    print("=" * 50)

    config = {}

    config["RENDER_API_URL"] = input(f"Server URL [{DEFAULT_SERVER_URL}]: ").strip() or DEFAULT_SERVER_URL

    print("\n--- Admin Info (authenticate with ChocoHub) ---")
    config["ADMIN_USERNAME"] = input("Admin username [chocoetom]: ").strip() or "chocoetom"
    config["ADMIN_PIN"] = input("Admin PIN: ")

    print("\n--- DUCO Faucet Info (to send coins) ---")
    config["DUCO_FAUCET_USERNAME"] = input("DUCO Faucet Username: ").strip()
    config["DUCO_FAUCET_PASSWORD"] = input("DUCO Faucet Password: ")

    print("\n--- Your DUCO Wallet (to receive coins from users) ---")
    config["DUCO_RECIPIENT"] = input("Your DUCO username [Nam2010]: ").strip() or "Nam2010"

    print("\n--- Options (Press Enter for defaults) ---")
    config["MEMO_PREFIX_RECEIVE"] = input("Memo prefix for RECEIVING [SWAP CC for]: ").strip() or "SWAP CC for"
    config["MEMO_PREFIX_SEND"] = input("Memo prefix for SENDING [swap from chocohub]: ").strip() or "swap from chocohub"
    interval = input("Check interval (seconds) [3]: ").strip()
    config["SLEEP_INTERVAL"] = int(interval) if interval.isdigit() else 3

    print("\n" + "=" * 50)
    print("✅ Configuration complete!")
    print("=" * 50)
    return config


config = load_config()
if not config:
    config = interactive_setup()
    save_config(config)

RENDER_API_URL = config.get("RENDER_API_URL", DEFAULT_SERVER_URL)
ADMIN_USERNAME = config.get("ADMIN_USERNAME", "chocoetom")
ADMIN_PIN = config.get("ADMIN_PIN")
DUCO_FAUCET_USERNAME = config.get("DUCO_FAUCET_USERNAME")
DUCO_FAUCET_PASSWORD = config.get("DUCO_FAUCET_PASSWORD")
DUCO_RECIPIENT = config.get("DUCO_RECIPIENT", "Nam2010")
MEMO_PREFIX_RECEIVE = config.get("MEMO_PREFIX_RECEIVE", "SWAP CC for")
MEMO_PREFIX_SEND = config.get("MEMO_PREFIX_SEND", "swap from chocohub")
SLEEP_INTERVAL = int(config.get("SLEEP_INTERVAL", 3))

jwt_token = None
token_expiry = 0
balance_cache = {"balance": None, "last_updated": None, "expiry_seconds": 60}


# ========== LOCAL DATABASE ==========
def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute(
        """CREATE TABLE IF NOT EXISTS swap_history
                 (request_id TEXT PRIMARY KEY,
                  from_user TEXT,
                  amount_cc REAL,
                  swap_type TEXT,
                  receiver TEXT,
                  processed_at TIMESTAMP,
                  txid TEXT)"""
    )
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
    c.execute(
        """INSERT OR REPLACE INTO swap_history
                 (request_id, from_user, amount_cc, swap_type, receiver, processed_at, txid)
                 VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (request_id, from_user, amount_cc, swap_type, receiver, datetime.now().isoformat(), txid),
    )
    conn.commit()
    conn.close()


def load_processed_txids():
    if os.path.exists(DUCO_TX_FILE):
        try:
            with open(DUCO_TX_FILE, 'r', encoding='utf-8') as f:
                return set(json.load(f))
        except Exception:
            pass
    return set()


def save_processed_txids(txids):
    with open(DUCO_TX_FILE, 'w', encoding='utf-8') as f:
        json.dump(list(txids), f, indent=2)


def http_request_json(url, method="GET", data=None, headers=None, timeout=15):
    req_headers = dict(headers or {})
    payload = None
    if data is not None:
        payload = json.dumps(data).encode('utf-8')
        req_headers.setdefault('Content-Type', 'application/json')

    req = request.Request(url, data=payload, headers=req_headers, method=method)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8', errors='replace')
            status = getattr(resp, 'status', 200)
            return status, json.loads(body) if body else None
    except error.HTTPError as exc:
        body = exc.read().decode('utf-8', errors='replace') if exc.fp else ''
        try:
            parsed = json.loads(body) if body else None
        except json.JSONDecodeError:
            parsed = body
        return exc.code, parsed
    except error.URLError as exc:
        raise RuntimeError(str(exc.reason)) from exc


def get_admin_token():
    global jwt_token, token_expiry
    now = time.time()
    if jwt_token and now < token_expiry:
        return jwt_token

    if not ADMIN_PIN:
        raise SystemExit('Missing required config in non-interactive mode: ADMIN_PIN')

    url = f"{RENDER_API_URL}/auth"
    payload = {"username": ADMIN_USERNAME, "pin": ADMIN_PIN}
    status, data = http_request_json(url, method="POST", data=payload, headers=JSON_HEADERS, timeout=10)
    if status == 200 and isinstance(data, dict):
        if data.get("status") == "success" and data.get("token"):
            jwt_token = data["token"]
            token_expiry = now + 23 * 3600
            print(f"🔑 Got token for {ADMIN_USERNAME}")
            return jwt_token
    print(f"❌ Authentication failed: {status}")
    if status == 401:
        print("   → Wrong username or PIN. Please run again with correct credentials.")
        raise SystemExit(1)
    return None


def api_call(endpoint, method="GET", data=None):
    token = get_admin_token()
    if not token:
        return None
    url = f"{RENDER_API_URL}{endpoint}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    status = None
    try:
        status, payload = http_request_json(url, method=method, data=data, headers=headers, timeout=15)
        if status in (200, 201):
            return payload
        print(f"⚠️ API {endpoint} error {status}: {str(payload)[:200]}")
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
    if (
        balance_cache["balance"] is not None
        and balance_cache["last_updated"]
        and now - balance_cache["last_updated"] < balance_cache["expiry_seconds"]
    ):
        return balance_cache["balance"]

    try:
        url = f"https://server.duinocoin.com/users/{DUCO_FAUCET_USERNAME}"
        status, data = http_request_json(url, headers=DUCO_HEADERS, timeout=10)
        if status == 200 and isinstance(data, dict) and data.get("success"):
            balance = data["result"]["balance"]["balance"]
            balance_cache["balance"] = balance
            balance_cache["last_updated"] = now
            print(f"💰 Faucet DUCO balance: {balance:.2f} DUCO")
            return balance
    except Exception as e:
        print(f"⚠️ Error fetching DUCO balance: {e}")
    return balance_cache["balance"] or 0.0


def send_duco(recipient, amount_cc):
    amount_duco = amount_cc / 10.0
    memo = f"{MEMO_PREFIX_SEND} {recipient}"
    params = {
        "username": DUCO_FAUCET_USERNAME,
        "password": DUCO_FAUCET_PASSWORD,
        "recipient": recipient,
        "amount": amount_duco,
        "memo": memo,
    }
    try:
        url = "https://server.duinocoin.com/transaction/?" + parse.urlencode(params)
        status, data = http_request_json(url, headers=DUCO_HEADERS, timeout=15)
        if status == 200 and isinstance(data, dict) and data.get("success"):
            print("   ✅ DUCO transfer initiated")
            print(f"   📝 Memo: {memo}")
            print(f"   💰 Amount: {amount_duco} DUCO")
            return True, None
        return False, data.get("message", f"HTTP {status}") if isinstance(data, dict) else f"HTTP {status}"
    except Exception as e:
        return False, str(e)


def fetch_raw_transactions(username, limit=100):
    url = f"https://server.duinocoin.com/user_transactions/{username}?limit={limit}"
    try:
        status, data = http_request_json(url, headers=DUCO_HEADERS, timeout=10)
        if status == 200 and isinstance(data, dict) and data.get("success"):
            return data.get("result", [])
        if isinstance(data, dict):
            print(f"   ⚠️ API returned success=false: {data.get('message')}")
        else:
            print(f"   ⚠️ HTTP {status}")
    except RuntimeError as e:
        print(f"   ⚠️ Timeout fetching transactions for {username}: {e}")
    except Exception as e:
        print(f"   ⚠️ Timeout fetching transactions for {username}")
        print(f"   ⚠️ Error fetching: {e}")
    return []


def find_matching_duco_transaction(processed_txids, pending_swaps):
    raw_transactions = fetch_raw_transactions(DUCO_RECIPIENT, 100)
    if not raw_transactions:
        print("   ❌ No transactions found from API")
        return None

    print(f"   ✅ Fetched {len(raw_transactions)} RAW transactions (no filter)")
    unprocessed_txs = [tx for tx in raw_transactions if tx.get("hash") not in processed_txids]
    if not unprocessed_txs:
        print(f"   ℹ️ All {len(raw_transactions)} transactions already processed")
        return None

    print(f"   🎯 Found {len(unprocessed_txs)} unprocessed transactions")
    print("   📋 RAW unprocessed transactions:")
    for idx, tx in enumerate(unprocessed_txs[:20], 1):
        sender = tx.get("sender", "unknown")[:15]
        recipient = tx.get("recipient", "unknown")[:15]
        amount = tx.get("amount", 0)
        memo = tx.get("memo", "")[:40]
        tx_hash = tx.get("hash", "")[:12]
        print(f"      {idx}. {sender} → {recipient} | {amount} DUCO | Memo: '{memo}' | Hash: {tx_hash}")

    pending_ducos = [req for req in pending_swaps if req.get("swap_type") == "duco_to_cc" and req.get("status") == "pending"]
    if not pending_ducos:
        print("   ℹ️ No pending duco_to_cc swaps")
        return None

    pending_by_memo = {}
    for req in pending_ducos:
        receiver = req.get("receiver")
        expected_memo = f"{MEMO_PREFIX_RECEIVE} {receiver}"
        pending_by_memo[expected_memo] = req
        print(f"      📌 EXPECTED: Memo '{expected_memo}' for {req['amount_cc'] / 10} DUCO")

    for tx in unprocessed_txs:
        tx_hash = tx.get("hash")
        memo = tx.get("memo", "").strip()
        amount_duco = float(tx.get("amount", 0))
        recipient = tx.get("recipient", "unknown")

        print(f"\n   🔍 Checking RAW TX: {tx_hash[:12]}...")
        print(f"      📤 Sender: {tx.get('sender', 'unknown')}")
        print(f"      📥 Recipient: {recipient}")
        print(f"      💰 Amount: {amount_duco} DUCO")
        print(f"      📝 Memo: '{memo}'")

        if memo not in pending_by_memo:
            continue

        req = pending_by_memo[memo]
        expected_duco = req.get("amount_cc", 0) / 10.0
        if abs(amount_duco - expected_duco) > 0.01:
            print(f"      ❌ Amount mismatch: expected {expected_duco}, got {amount_duco}")
            continue

        if recipient != DUCO_RECIPIENT:
            print(f"      ❌ Recipient mismatch: expected {DUCO_RECIPIENT}, got {recipient}")
            continue

        print("\n   ✅✅✅ MATCH FOUND IN RAW TRANSACTIONS! ✅✅✅")
        print(f"   📝 Transaction hash: {tx_hash}")
        print(f"   👤 Sender: {tx.get('sender', 'unknown')}")
        print(f"   💰 Amount: {amount_duco} DUCO")
        print(f"   📋 Memo: '{memo}'")
        print(f"   🔄 Swap ID: {req['id']}")
        return tx, req

    print(f"\n   ⏳ No VALID matching transaction found in {len(unprocessed_txs)} RAW transactions")
    return None


def check_duco_transactions_raw():
    print(f"\n🔍 RAW FETCH - Getting ALL transactions for {DUCO_RECIPIENT} from DUCO API...")
    processed_txids = load_processed_txids()
    pending_swaps = get_pending_swaps()

    if not pending_swaps:
        print("   ℹ️ No pending swaps")
        return False

    result = find_matching_duco_transaction(processed_txids, pending_swaps)
    if result:
        tx, req = result
        tx_hash = tx.get("hash")
        if fulfill_swap(req["id"]):
            print(f"   ✅ Swap {req['id']} fulfilled successfully!")
            record_processed(req["id"], req["from_user"], req["amount_cc"], req.get("swap_type"), req["receiver"], tx_hash)
            processed_txids.add(tx_hash)
            save_processed_txids(processed_txids)
            print(f"   📝 Recorded transaction hash: {tx_hash}")
            return True
        print(f"   ❌ Failed to fulfill swap {req['id']}")
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
        print(f"\n   💸 Sending DUCO from faucet to {receiver}")
        balance = update_faucet_balance()
        required_duco = amount_cc / 10.0
        if balance < required_duco:
            print(f"   ❌ Insufficient DUCO: need {required_duco:.2f}, have {balance:.2f}")
            return False

        success, err = send_duco(receiver, amount_cc)
        if success:
            print("   ✅ DUCO sent successfully!")
            temp_txid = f"sent_{int(time.time())}"
            record_processed(rid, from_user, amount_cc, swap_type, receiver, temp_txid)
            if fulfill_swap(rid):
                print(f"   ✅ Swap {rid} fulfilled")
                return True
        else:
            print(f"   ❌ Failed to send DUCO: {err}")
        return False

    if swap_type == "duco_to_cc":
        print(f"\n   🔍 User needs to send {amount_cc / 10:.2f} DUCO to {DUCO_RECIPIENT}")
        print(f"   📝 Expected memo: '{MEMO_PREFIX_RECEIVE} {receiver}'")
        success = check_duco_transactions_raw()
        if success:
            print(f"   ✅ Swap {rid} processed and fulfilled!")
        else:
            print(f"   ⏳ No valid transaction found yet for swap {rid}")
        return success

    print(f"   ⚠️ Unsupported swap type for auto-processing: {swap_type}")
    return False


def periodic_check_raw():
    print("\n🔄 Periodic RAW check for pending DUCO→CC swaps...")
    processed_txids = load_processed_txids()
    pending_swaps = get_pending_swaps()
    if pending_swaps:
        result = find_matching_duco_transaction(processed_txids, pending_swaps)
        if result:
            tx, req = result
            tx_hash = tx.get("hash")
            if fulfill_swap(req["id"]):
                print(f"   ✅ Periodic check fulfilled swap {req['id']}")
                record_processed(req["id"], req["from_user"], req["amount_cc"], req.get("swap_type"), req["receiver"], tx_hash)
                processed_txids.add(tx_hash)
                save_processed_txids(processed_txids)


def main():
    print("\n" + "=" * 60)
    print("🚀 SWAP CLIENT - Railway auto worker")
    print("=" * 60)
    print(f"📍 Server: {RENDER_API_URL}")
    print(f"🔐 Worker auth: {ADMIN_USERNAME}")
    print(f"💰 DUCO Faucet: {DUCO_FAUCET_USERNAME}")
    print(f"📥 Your DUCO Wallet: {DUCO_RECIPIENT}")
    print(f"📝 Memo Receive (user → you): {MEMO_PREFIX_RECEIVE}")
    print(f"📝 Memo Send (you → user): {MEMO_PREFIX_SEND}")
    print(f"⏱️  Interval: {SLEEP_INTERVAL}s")
    print("=" * 60 + "\n")

    get_admin_token()
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
                        print(f"\n⚡ Processing DUCO→CC swap {req['id']} immediately")
                        process_swap(req)
                        time.sleep(1)
                    elif swap_type == "duco":
                        print(f"\n💰 Processing CC→DUCO swap {req['id']}")
                        process_swap(req)
                        time.sleep(1)
                    else:
                        print(f"   ℹ️ Skipping unsupported auto-swap type: {swap_type}")
            else:
                print("✅ No pending swaps")

            now = time.time()
            if now - last_incoming_check > 15:
                periodic_check_raw()
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

