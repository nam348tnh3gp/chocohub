import hashlib, json, math, os, ssl, struct, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

SCOOP_SIZE = 64
SCOOPS_PER_NONCE = 4096
HEADER_SIZE = 256
EFFECTIVE_CAPACITY_CAP_GB = 10 * 1024

TIERS = [
    (0, 32,    'tier_1', 1.0),
    (32, 500,  'tier_2', 1.6),
    (500, 5*1024,  'tier_3', 2.4),
    (5*1024, EFFECTIVE_CAPACITY_CAP_GB, 'tier_4', 3.2),
    (EFFECTIVE_CAPACITY_CAP_GB, float('inf'), 'tier_5', 3.2),
]

def load_env(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v

def sha256hex(data):
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).hexdigest()

def sha256buf(data):
    return hashlib.sha256(data.encode() if isinstance(data, str) else data).digest()

_base_target_cache = {}

def get_tier(size_gb):
    size_gb = max(0.0, float(size_gb or 0))
    for min_s, max_s, tid, mult in TIERS:
        if min_s <= size_gb < max_s:
            return tid, mult
    return 'tier_1', 1.0

def compute_effective_capacity_gb(size_gb):
    size = max(0.001, float(size_gb or 0.001))
    capped = min(size, EFFECTIVE_CAPACITY_CAP_GB)
    tier_id, mult = get_tier(size)
    if tier_id == 'tier_1':
        return math.sqrt(capped) * mult
    if tier_id == 'tier_2':
        return (math.sqrt(32) + math.sqrt(capped - 32)) * mult
    return math.sqrt(capped) * mult

def get_base_target(plot_size_gb):
    key = round(float(plot_size_gb), 6)
    bt = _base_target_cache.get(key)
    if bt is not None:
        return bt
    eff = compute_effective_capacity_gb(plot_size_gb)
    adjusted = 86400 / max(1.0, eff)
    bt = max(1, min(int(adjusted), 1000000000))
    _base_target_cache[key] = bt
    return bt

def compute_deadline(scoop_data, sig_bytes, bt):
    quality = sha256buf(scoop_data + sig_bytes)
    quality_int = int.from_bytes(quality[:8], 'big')
    dl = quality_int // bt
    return max(60, min(dl, 86400))

def merkle_tree_internal_node_count(n):
    total = 0
    while n > 1:
        n = -(-n // 2)
        total += n
    return total

def plot_total_size(total_scoops):
    return HEADER_SIZE + total_scoops * SCOOP_SIZE + merkle_tree_internal_node_count(total_scoops) * 32

_plot_cache = {}

def get_plot_meta(path):
    cached = _plot_cache.get(path)
    if cached is not None:
        return cached
    try:
        size = os.path.getsize(path)
        with open(path, 'rb') as f:
            header = f.read(104)
        if len(header) < 104 or header[:8] != b'CHOCOHUB':
            return None
        total_scoops = struct.unpack_from('<I', header, 64)[0]
        if total_scoops < 1 or size != plot_total_size(total_scoops):
            return None
        id_high = struct.unpack_from('<I', header, 12)[0]
        id_low  = struct.unpack_from('<I', header, 16)[0]
        meta = {
            'total_scoops': total_scoops,
            'plot_id': f'{id_high:08x}{id_low:08x}',
            'merkle_root': header[72:104].hex(),
        }
        _plot_cache[path] = meta
        return meta
    except Exception:
        return None

def read_merkle_proof_from_file(path, total_scoops, scoop_index):
    tree_start = HEADER_SIZE + total_scoops * SCOOP_SIZE
    proof = []
    idx = scoop_index
    count = total_scoops
    tree_offset = 0
    with open(path, 'rb') as f:
        while count > 1:
            sibling_idx = idx ^ 1
            if sibling_idx < count:
                if count == total_scoops:
                    f.seek(HEADER_SIZE + sibling_idx * SCOOP_SIZE)
                    proof.append(sha256buf(f.read(SCOOP_SIZE)))
                else:
                    f.seek(tree_start + (tree_offset + sibling_idx) * 32)
                    proof.append(f.read(32))
            idx >>= 1
            next_count = -(-count // 2)
            if count != total_scoops:
                tree_offset += count
            count = next_count
    return proof

def build_poc_proof(plot_path, challenge, plot_size_gb, sig_bytes, bt):
    meta = get_plot_meta(plot_path)
    if not meta:
        return None
    total_scoops = meta['total_scoops']
    try:
        height = int(str(challenge.get('block_height') or challenge.get('height') or 0) or 0)
        gen_sig = challenge.get('challenge_seed') or challenge.get('generation_signature') or ''
        scoop_num = (height + int(sha256hex(gen_sig)[:8], 16)) % SCOOPS_PER_NONCE
        best_deadline = None
        best_scoop_data = None
        best_scoop_index = 0
        with open(plot_path, 'rb') as f:
            for i in range(scoop_num, total_scoops, SCOOPS_PER_NONCE):
                f.seek(HEADER_SIZE + i * SCOOP_SIZE)
                buf = f.read(SCOOP_SIZE)
                if len(buf) < SCOOP_SIZE:
                    buf = buf + b'\x00' * (SCOOP_SIZE - len(buf))
                dl = compute_deadline(buf, sig_bytes, bt)
                if best_deadline is None or dl < best_deadline:
                    best_deadline = dl
                    best_scoop_data = buf
                    best_scoop_index = i
        if best_deadline is None or best_deadline <= 0:
            return None
        merkle_proof = read_merkle_proof_from_file(plot_path, total_scoops, best_scoop_index)
        proof_digest = sha256hex(best_scoop_data + str(best_deadline).encode())
        return {
            'proof_version': 1,
            'scoop_num': scoop_num,
            'deadline': int(best_deadline),
            'proof_digest': proof_digest,
            'read_count': -(-total_scoops // SCOOPS_PER_NONCE),
            'scoop_data': best_scoop_data.hex(),
            'merkle_proof': [h.hex() for h in merkle_proof],
            'scoop_index': best_scoop_index,
        }
    except Exception as e:
        print(f'  [!] build_poc_proof error: {e}')
        return None

_ssl_ctx = None

def _get_ssl_ctx():
    global _ssl_ctx
    if _ssl_ctx is None:
        _ssl_ctx = ssl.create_default_context()
        _ssl_ctx.check_hostname = False
        _ssl_ctx.verify_mode = ssl.CERT_NONE
    return _ssl_ctx

def http_get(url, timeout=10):
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout, context=_get_ssl_ctx()) as r:
        return json.loads(r.read())

def http_post(url, data, timeout=10):
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body,
        headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=timeout, context=_get_ssl_ctx()) as r:
        return json.loads(r.read())

BANNER = r"""
 _____ _                     _           _
/  __ \ |                   | |         | |
| /  \/ |__   ___   ___ ___ | |__  _   _| |__
| |   | '_ \ / _ \ / __/ _ \| '_ \| | | | '_ \
| \__/\ | | | (_) | (_| (_) | | | | |_| | |_) |
 \____/_| |_|\___/ \___\___/|_| |_|\__,_|_.__/


___  ____       _  ___  ____
|  \/  (_)     (_) |  \/  (_)
| .  . |_ _ __  _  | .  . |_ _ __   ___ _ __
| |\/| | | '_ \| | | |\/| | | '_ \ / _ \ '__|
| |  | | | | | | | | |  | | | | | |  __/ |
\_|  |_/_|_| |_|_| \_|  |_/_|_| |_|\___|_|

"""

def _scan_one_plot(ppath, challenge, plot_size_gb, sig_bytes, bt):
    return build_poc_proof(ppath, challenge, plot_size_gb, sig_bytes, bt)

def main():
    load_env()
    print(BANNER)
    seed_url    = os.environ.get('SEED_URL', 'https://seed.chocohub.org')
    address     = os.environ.get('WALLET_ADDRESS', '')
    plots_dir   = os.environ.get('PLOTS_DIR', '')
    plot_size   = float(os.environ.get('PLOT_SIZE_GB', '0.1'))
    interval    = int(os.environ.get('MINING_INTERVAL', '20'))
    max_workers = int(os.environ.get('SCAN_THREADS', '4'))

    if not address:
        print('[!] Set WALLET_ADDRESS in .env'); sys.exit(1)
    if not plots_dir:
        print('[!] Set PLOTS_DIR in .env'); sys.exit(1)

    bt = get_base_target(plot_size)

    print(f'  Seed:       {seed_url}')
    print(f'  Address:    {address}')
    print(f'  Plots dir:  {plots_dir}')
    print(f'  Plot size:  {plot_size} GB')
    print(f'  BaseTarget: {bt}')
    print(f'  Threads:    {max_workers}')
    print(f'  Interval:   {interval}s')
    print()

    plot_files = []
    for fname in os.listdir(plots_dir):
        if not fname.endswith('.plot'):
            continue
        full = os.path.join(plots_dir, fname)
        meta = get_plot_meta(full)
        if not meta:
            print(f'  [!] skipping invalid plot: {fname}')
            continue
        print(f'  [+] plot: {meta["plot_id"]}  scoops={meta["total_scoops"]}  root={meta["merkle_root"][:16]}...')
        plot_files.append(full)

    if not plot_files:
        print('[!] No valid plots found in PLOTS_DIR'); sys.exit(1)

    print()
    scans = 0
    accepted = 0
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        while True:
            challenge = None
            try:
                challenge = http_get(f'{seed_url}/api/mining/challenge')
            except Exception as e:
                print(f'  [!] challenge fetch failed: {e}')
                time.sleep(interval)
                continue

            if not challenge or not challenge.get('challenge_id'):
                print('  [!] no challenge available')
                time.sleep(interval)
                continue

            ch_id = challenge['challenge_id']
            height = challenge.get('block_height') or challenge.get('height') or 0
            gen_sig = challenge.get('challenge_seed') or challenge.get('generation_signature') or ''
            sig_bytes = gen_sig.encode()

            futures = {
                pool.submit(_scan_one_plot, ppath, challenge, plot_size, sig_bytes, bt): ppath
                for ppath in plot_files
            }
            best_proof = None
            best_dl    = None
            best_plot  = None
            for future in futures:
                scans += 1
                try:
                    proof = future.result()
                except Exception:
                    continue
                if proof and (best_dl is None or proof['deadline'] < best_dl):
                    best_dl    = proof['deadline']
                    best_proof = proof
                    best_plot  = futures[future]

            if not best_proof:
                print(f'  [#{height}] no valid proof  ch={ch_id[:12]}...')
                time.sleep(interval)
                continue

            print(f'  [#{height}] best deadline {best_dl}s  plot={os.path.basename(best_plot)}  ch={ch_id[:12]}...')

            meta = get_plot_meta(best_plot)
            payload = {
                'challenge_id': ch_id,
                'miner': address,
                'plot_id': meta['plot_id'] if meta else '',
                'deadline': best_dl,
                'proof_packet': best_proof,
            }

            resp = None
            try:
                resp = http_post(f'{seed_url}/api/mining/submit-proof', payload)
                if resp.get('ok'):
                    accepted += 1
                    bloco = resp.get('bloco')
                    if bloco:
                        print(f'  >>> BLOCK FORGED! height={bloco.get("height")}  reward={bloco.get("reward_cc")}')
                    else:
                        print(f'  >>> proof accepted (total: {accepted})')
                else:
                    print(f'  [!] rejected: {resp.get("error") or resp.get("motivo")}')
            except urllib.error.HTTPError as e:
                body = e.read().decode('utf-8', errors='replace')
                try:
                    j = json.loads(body)
                    print(f'  [!] submit failed ({e.code}): {j.get("error", body)}')
                except Exception:
                    print(f'  [!] submit failed ({e.code}): {body[:200]}')
            except Exception as e:
                print(f'  [!] submit error: {e}')

            del best_proof, payload, resp

            elapsed = int(time.time() - start_time)
            print(f'  [stats] scans={scans}  accepted={accepted}  uptime={elapsed}s')
            print()
            time.sleep(interval)

if __name__ == '__main__':
    main()
