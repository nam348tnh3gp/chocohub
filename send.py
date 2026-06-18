import json
import os
import sqlite3
import time
from datetime import datetime
from urllib import error, parse, request


CONFIG_FILE = "swap_config.json"
DB_FILE = "swap_history.db"
DUCO_TX_FILE = "duco_processed.json"
DEFAULT_SERVER_URL = "https://chocohub-r011.onrender.com"

DUCO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Connection": "keep-alive",
}

JSON_HEADERS = {"Content-Type": "application/json", **DUCO_HEADERS}


def env_first(*names, default=None):
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return default


def load_file_config():
    if not os.path.exists(CONFIG_FILE):
        return {}
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_file_config(config):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def http_request_json(url, method="GET", data=None, headers=None, timeout=15):
    req_headers = dict(headers or {})
    payload = None
    if data is not None:
        payload = json.dumps(data).encode("utf-8")
        req_headers.setdefault("Content-Type", "application/json")

    req = request.Request(url, data=payload, headers=req_headers, method=method)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
            status = getattr(resp, "status", 200)
            if body:
                try:
                    return status, json.loads(body)
                except json.JSONDecodeError:
                    return status, body
            return status, None
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        try:
            parsed = json.loads(body) if body else None
        except json.JSONDecodeError:
            parsed = body
        return exc.code, parsed
    except error.URLError as exc:
        raise RuntimeError(str(exc.reason)) from exc


def build_config():
    file_config = load_file_config()

    config = {
        "RENDER_API_URL": env_first("RENDER_API_URL", "MAIN_SERVER_URL", default=file_config.get("RENDER_API_URL", DEFAULT_SERVER_URL)),
        "WORKER_USERNAME": env_first("WORKER_USERNAME", "SWAP_USERNAME", "ADMIN_USERNAME", "USERNAME", default=file_config.get("WORKER_USERNAME") or file_config.get("SWAP_USERNAME") or file_config.get("ADMIN_USERNAME") or file_config.get("USERNAME")),
        "WORKER_PIN": env_first("WORKER_PIN", "SWAP_PIN", "ADMIN_PIN", "PIN", "USER_PIN", default=file_config.get("WORKER_PIN") or file_config.get("SWAP_PIN") or file_config.get("ADMIN_PIN") or file_config.get("PIN") or file_config.get("USER_PIN")),
        "DUCO_FAUCET_USERNAME": env_first("DUCO_USERNAME", "DUCO_FAUCET_USERNAME", default=file_config.get("DUCO_FAUCET_USERNAME")),
        "DUCO_FAUCET_PASSWORD": env_first("DUCO_PASSWORD", "DUCO_FAUCET_PASSWORD", default=file_config.get("DUCO_FAUCET_PASSWORD")),
        "DUCO_RECIPIENT": env_first("DUCO_RECIPIENT", "DUCO_USERNAME", "DUCO_FAUCET_USERNAME", default=file_config.get("DUCO_RECIPIENT")),
        "MEMO_PREFIX_RECEIVE": env_first("MEMO_PREFIX_RECEIVE", default=file_config.get("MEMO_PREFIX_RECEIVE", "SWAP CC for")),
        "MEMO_PREFIX_SEND": env_first("MEMO_PREFIX_SEND", default=file_config.get("MEMO_PREFIX_SEND", "swap from chocohub")),
        "SLEEP_INTERVAL": int(env_first("SLEEP_INTERVAL", default=str(file_config.get("SLEEP_INTERVAL", 3)))),
    }

    if not config["DUCO_RECIPIENT"]:
        config["DUCO_RECIPIENT"] = config["DUCO_FAUCET_USERNAME"] or "Nam2010"

    return config


config = build_config()
worker_token = None

if not all([config["RENDER_API_URL"], config["WORKER_USERNAME"], config["WORKER_PIN"], config["DUCO_FAUCET_USERNAME"], config["DUCO_FAUCET_PASSWORD"]]):
    if os.isatty(0):
        print("\n" + "=" * 50)
        print("🔧 FIRST RUN - ENTER CONFIGURATION")
        print("=" * 50)

        config["RENDER_API_URL"] = input(f"Server URL [{DEFAULT_SERVER_URL}]: ").strip() or DEFAULT_SERVER_URL
        print("\n--- Worker Login Info ---")
        config["WORKER_USERNAME"] = input("Username: ").strip()
        config["WORKER_PIN"] = input("PIN: ")
        print("\n--- DUCO Faucet Info (to send coins) ---")
        config["DUCO_FAUCET_USERNAME"] = input("DUCO Faucet Username: ").strip()
        config["DUCO_FAUCET_PASSWORD"] = input("DUCO Faucet Password: ")
        print("\n--- Your DUCO Wallet (to receive coins from users) ---")
        config["DUCO_RECIPIENT"] = input("Your DUCO username [Nam2010]: ").strip() or "Nam2010"
        print("\n--- Options (Press Enter for defaults) ---")
        config["MEMO_PREFIX_RECEIVE"] = input("Memo prefix for RECEIVING [SWAP CC for]: ").strip() or "SWAP CC for"
        config["MEMO_PREFIX_SEND"] = input("Memo prefix for SENDING [swap from chocohub]: ").strip() or "swap from chocohub"
        sleep_interval = input("Check interval (seconds) [3]: ").strip()
        config["SLEEP_INTERVAL"] = int(sleep_interval) if sleep_interval.isdigit() else 3
        print("\n" + "=" * 50)
        print("✅ Configuration complete!")
        print("=" * 50)
        save_file_config(config)
    else:
        missing = [k for k in ["RENDER_API_URL", "WORKER_USERNAME", "WORKER_PIN", "DUCO_FAUCET_USERNAME", "DUCO_FAUCET_PASSWORD"] if not config.get(k)]
        raise SystemExit(f"Missing required config in non-interactive mode: {', '.join(missing)}")


RENDER_API_URL = config["RENDER_API_URL"].rstrip("/")
WORKER_USERNAME = config["WORKER_USERNAME"]
WORKER_PIN = config["WORKER_PIN"]
DUCO_FAUCET_USERNAME = config["DUCO_FAUCET_USERNAME"]
DUCO_FAUCET_PASSWORD = config["DUCO_FAUCET_PASSWORD"]
DUCO_RECIPIENT = config["DUCO_RECIPIENT"]
MEMO_PREFIX_RECEIVE = config["MEMO_PREFIX_RECEIVE"]
MEMO_PREFIX_SEND = config["MEMO_PREFIX_SEND"]
SLEEP_INTERVAL = int(config["SLEEP_INTERVAL"])


balance_cache = {"balance": None, "last_updated": None, "expiry_seconds": 60}


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
    if not os.path.exists(DUCO_TX_FILE):
        return set()
    try:
        with open(DUCO_TX_FILE, "r", encoding="utf-8") as f:
            return set(json.load(f))
    except Exception:
        return set()


def save_processed_txids(txids):
    with open(DUCO_TX_FILE, "w", encoding="utf-8") as f:
        json.dump(list(txids), f, indent=2)


def authenticate_worker():
    global worker_token

    payload = {
        "username": WORKER_USERNAME,
        "pin": WORKER_PIN,
    }
    status, data = http_request_json(f"{RENDER_API_URL}/auth", method="POST", data=payload, headers=JSON_HEADERS, timeout=15)
    if status in (200, 201) and isinstance(data, dict):
        token = data.get("token")
        if token:
            worker_token = token
            print(f"🔐 Authenticated worker as {WORKER_USERNAME}")
            return token
    raise RuntimeError(f"Failed to authenticate worker: {data}")


def api_call(endpoint, method="GET", data=None, token=None):
    global worker_token

    auth_token = token or worker_token
    if not auth_token:
        auth_token = authenticate_worker()

    url = f"{RENDER_API_URL}{endpoint}"
    headers = {"Authorization": f"Bearer {auth_token}", "Content-Type": "application/json"}
    try:
        status, payload = http_request_json(url, method=method, data=data, headers=headers, timeout=15)
        if status in (200, 201):
            return payload
        if status in (401, 403):
            print(f"⚠️ API {endpoint} auth error {status}, refreshing worker token...")
            worker_token = authenticate_worker()
            headers["Authorization"] = f"Bearer {worker_token}"
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
    return bool(data and data.get("status") == "success")


def update_faucet_balance():
    now = time.time()
    if (
        balance_cache["balance"] is not None
        and balance_cache["last_updated"]
        and now - balance_cache["last_updated"] < balance_cache["expiry_seconds"]
    ):
        return balance_cache["balance"]

    try:
        status, data = http_request_json(f"https://server.duinocoin.com/users/{DUCO_FAUCET_USERNAME}", headers=DUCO_HEADERS, timeout=10)
        if status == 200 and isinstance(data, dict):
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
        if status == 200 and isinstance(data, dict):
            if data.get("success"):
                print("   ✅ DUCO transfer initiated")
                print(f"   📝 Memo: {memo}")
                print(f"   💰 Amount: {amount_duco} DUCO")
                return True, None
            return False, data.get("message", "Unknown error")
        return False, f"HTTP {status}"
    except Exception as e:
        return False, str(e)


def fetch_raw_transactions(username, limit=100):
    url = f"https://server.duinocoin.com/user_transactions/{username}?limit={limit}"
    try:
        status, data = http_request_json(url, headers=DUCO_HEADERS, timeout=10)
        if status == 200 and isinstance(data, dict):
            if data.get("success"):
                return data.get("result", [])
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

        success, error = send_duco(receiver, amount_cc)
        if success:
            print("   ✅ DUCO sent successfully!")
            temp_txid = f"sent_{int(time.time())}"
            record_processed(rid, from_user, amount_cc, swap_type, receiver, temp_txid)
            if fulfill_swap(rid):
                print(f"   ✅ Swap {rid} fulfilled")
                return True
        else:
            print(f"   ❌ Failed to send DUCO: {error}")
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
    print(f"🔐 Worker auth: {WORKER_USERNAME}")
    print(f"💰 DUCO Faucet: {DUCO_FAUCET_USERNAME}")
    print(f"📥 Your DUCO Wallet: {DUCO_RECIPIENT}")
    print(f"📝 Memo Receive (user → you): {MEMO_PREFIX_RECEIVE}")
    print(f"📝 Memo Send (you → user): {MEMO_PREFIX_SEND}")
    print(f"⏱️  Interval: {SLEEP_INTERVAL}s")
    print("=" * 60 + "\n")

    authenticate_worker()
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
