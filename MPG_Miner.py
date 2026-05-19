import hashlib, requests, time, threading, argparse, sys, os, signal, json
from datetime import datetime

DEFAULT_SERVER  = "https://chocohub-r011.onrender.com"
DEFAULT_WORKER  = None
DEFAULT_THREADS = None
DEFAULT_GPU     = False
DEFAULT_POLL    = 10
DEFAULT_REPORT_INTERVAL = 300  # 5 phút
CONFIG_FILE = "miner_config.json"

_gpu_available = False
try:
    import pyopencl as cl
    _gpu_available = True
except ImportError:
    pass

def discover_gpus():
    if not _gpu_available: return []
    gpu_list = []
    try:
        for platform in cl.get_platforms():
            devices = platform.get_devices(device_type=cl.device_type.GPU)
            for dev in devices:
                gpu_list.append({
                    "device": dev,
                    "platform": platform.name.strip(),
                    "name": dev.name.strip(),
                    "vendor": dev.vendor.strip(),
                    "version": dev.version.strip()
                })
    except Exception:
        pass
    return gpu_list

class ANSI:
    RST="\033[0m"; BOLD="\033[1m"
    YEL="\033[93m"; ORG="\033[33m"; GRN="\033[92m"; RED="\033[91m"
    BLU="\033[94m"; CYN="\033[96m"; MAG="\033[95m"; WHT="\033[97m"
    GRY="\033[90m"; CLR="\033[2K"
    NET = CYN      # alias cho network
    OK = GRN       # alias cho success
    WARN = YEL     # alias cho warning
    INFO = BLU     # alias cho info
    WIN = YEL      # alias cho found

ICONS = {
    "INFO": f"{ANSI.BLU}i{ANSI.RST}", "OK":  f"{ANSI.GRN}+{ANSI.RST}",
    "WARN": f"{ANSI.YEL}!{ANSI.RST}", "ERR": f"{ANSI.RED}x{ANSI.RST}",
    "WIN":  f"{ANSI.YEL}{ANSI.BOLD}*{ANSI.RST}", "NET": f"{ANSI.CYN}~{ANSI.RST}",
    "DBG":  f"{ANSI.MAG}D{ANSI.RST}",
    "GPU":  f"{ANSI.GRN}G{ANSI.RST}"
}

def get_cpu_count():
    try:
        return os.cpu_count() or 2
    except:
        return 2

def suggest_threads(device_type, gpu_enabled):
    cpu_cnt = get_cpu_count()
    if device_type == "mobile":
        return min(2, cpu_cnt)
    else:
        if gpu_enabled:
            return max(1, cpu_cnt - 2)
        else:
            return cpu_cnt

# ========== LƯU / ĐỌC CONFIG ==========
def load_config():
    default_config = {
        "server": DEFAULT_SERVER,
        "worker": DEFAULT_WORKER,
        "threads": DEFAULT_THREADS,
        "gpu": DEFAULT_GPU,
        "poll": DEFAULT_POLL
    }
    if not os.path.exists(CONFIG_FILE):
        return default_config
    try:
        with open(CONFIG_FILE, 'r') as f:
            saved = json.load(f)
            for key in default_config:
                if key not in saved:
                    saved[key] = default_config[key]
            return saved
    except Exception as e:
        print(f"{ANSI.RED}⚠ Lỗi đọc config: {e}{ANSI.RST}")
        return default_config

def save_config(config):
    try:
        with open(CONFIG_FILE, 'w') as f:
            json.dump(config, f, indent=2)
        return True
    except Exception as e:
        print(f"{ANSI.RED}⚠ Lỗi ghi config: {e}{ANSI.RST}")
        return False

# ========== CLASS MINER ==========
class ChocoMiner:
    def __init__(self, args):
        self.args = args
        self.running = True
        self.stats = {
            "hashes": 0,
            "blocks_found": 0,
            "start_time": time.time(),
            "last_report_time": time.time(),
            "current_job": None
        }
        self.stats_lock = threading.Lock()
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "ChocoHub-Miner/v2"})
        self.found_event = threading.Event()
        self.solution = None
        self.last_log_line = ""

    def banner(self):
        print(f"""{ANSI.ORG}{ANSI.BOLD}
  ██████╗██╗  ██╗ ██████╗  ██████╗ ██████╗
 ██╔════╝██║  ██║██╔═══██╗██╔════╝██╔═══██╗
 ██║     ███████║██║   ██║██║     ██║   ██║
 ██║     ██╔══██║██║   ██║██║     ██║   ██║
 ╚██████╗██║  ██║╚██████╔╝╚██████╗╚██████╔╝
  ╚═════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═════╝{ANSI.RST}
{ANSI.YEL}        ⚡ Python miner v2 (compatible) ⚡{ANSI.RST}
{ANSI.GRY}    SHA256(last_hash + 20-digit-nonce + worker){ANSI.RST}
""")

    def log(self, msg, direct=True):
        if direct:
            if self.last_log_line:
                sys.stdout.write(f"\r{ANSI.CLR}{' ' * len(self.last_log_line)}\r")
            timestamp = f"{ANSI.GRY}{datetime.now().strftime('%H:%M:%S')}{ANSI.RST}"
            log_line = f"  {timestamp}  {msg}"
            print(log_line)
            self.last_log_line = ""
        else:
            pass

    def hr_str(self):
        h = self.stats["hashes"]
        t = time.time() - self.stats["start_time"]
        if t < 0.5: return "0.00 H/s"
        r = h / t
        if r >= 1_000_000: return f"{r/1_000_000:.2f} MH/s"
        if r >= 1_000:     return f"{r/1_000:.1f} KH/s"
        return f"{int(r)} H/s"

    def progress_line(self):
        elapsed = time.time() - self.stats["start_time"]
        job = self.stats["current_job"]
        diff = f"{job['difficulty']:.1f}" if job and 'difficulty' in job else "—"
        reward = str(job.get('reward', '?')) if job else "—"
        return (f"  ⚡ HR:{ANSI.YEL}{self.hr_str():<12}{ANSI.RST} "
                f"Diff:{ANSI.CYN}{diff:<6}{ANSI.RST} "
                f"Reward:{ANSI.GRN}{reward:<4} CC{ANSI.RST} "
                f"Blocks:{ANSI.MAG}{self.stats['blocks_found']}{ANSI.RST} "
                f"Up:{ANSI.GRY}{int(elapsed):>4}s{ANSI.RST}")

    def display_loop(self):
        while self.running:
            line = self.progress_line()
            sys.stdout.write(f"\r{line}")
            sys.stdout.flush()
            time.sleep(0.5)
        sys.stdout.write("\n")

    def report_loop(self):
        while self.running:
            time.sleep(self.args.report_interval)
            if not self.running:
                break
            with self.stats_lock:
                now = time.time()
                elapsed = now - self.stats["start_time"]
                elapsed_since_last = now - self.stats.get("last_report_time", self.stats["start_time"])
                hashes_since = self.stats["hashes"] - self.stats.get("last_report_hashes", 0)
                
                if elapsed_since_last > 0:
                    avg_rate = hashes_since / elapsed_since_last
                    rate_str = f"{avg_rate/1e6:.2f} MH/s" if avg_rate >= 1e6 else f"{avg_rate/1e3:.1f} KH/s"
                else:
                    rate_str = "N/A"
                
                self.log(f"{ANSI.CYN}[REPORT]{ANSI.RST} "
                        f"Time: {int(elapsed//3600)}h{int((elapsed%3600)//60)}m{int(elapsed%60)}s | "
                        f"Total hashes: {self.stats['hashes']:,} | "
                        f"Avg rate: {self.hr_str()} | "
                        f"Last period: {rate_str} | "
                        f"Blocks: {self.stats['blocks_found']}")
                
                self.stats["last_report_time"] = now
                self.stats["last_report_hashes"] = self.stats["hashes"]

    def fetch_job(self):
        try:
            resp = self.session.post(
                f"{self.args.server}/get_job",
                json={"worker_name": self.args.worker},
                timeout=5
            )
            if resp.status_code != 200:
                return None
            data = resp.json()
            if not data.get('bounty_id'):
                return None
            return {
                "id": data['bounty_id'],
                "last_hash": data['last_hash'],
                "target_hex": data['target_hex'],
                "difficulty": float(data.get('difficulty', 1.0)),
                "reward": data.get('reward', '?')
            }
        except Exception as e:
            self.log(f"{ANSI.RED}[ERR] Fetch job error: {e}{ANSI.RST}")
            return None

    def mine_cpu(self, tid, nthreads):
        sha256 = hashlib.sha256
        worker_b = self.args.worker.encode()
        batch_size = 2000
        local_jid = None
        nonce = tid

        while self.running:
            job = self.stats["current_job"]
            if not job:
                time.sleep(0.2)
                continue

            jid = job["id"]
            lhb = job["last_hash"].encode()
            target_hex = job["target_hex"]

            if jid != local_jid:
                nonce = tid
                local_jid = jid

            while self.running and not self.found_event.is_set() and self.stats["current_job"]["id"] == jid:
                for _ in range(batch_size):
                    nonce_padded = str(nonce).zfill(20)
                    hash_hex = sha256(lhb + nonce_padded.encode() + worker_b).hexdigest()
                    if hash_hex < target_hex:
                        if not self.found_event.is_set() and self.stats["current_job"]["id"] == jid:
                            self.solution = (jid, nonce, hash_hex)
                            self.found_event.set()
                        break
                    nonce += nthreads

                with self.stats_lock:
                    self.stats["hashes"] += batch_size

    def mine_gpu_wrapper(self, gpu_info, gid):
        self.log(f"{ANSI.GRN}[GPU] Active on {gpu_info['name']} ({gpu_info['vendor']}){ANSI.RST}")
        sha256 = hashlib.sha256
        worker_b = self.args.worker.encode()
        gpu_batch = 100000

        while self.running:
            job = self.stats["current_job"]
            if not job:
                time.sleep(0.5)
                continue

            lhb = job["last_hash"].encode()
            target_hex = job["target_hex"]
            jid = job["id"]
            nonce = gid * 1_000_000

            while self.running and not self.found_event.is_set() and self.stats["current_job"]["id"] == jid:
                for _ in range(gpu_batch):
                    nonce_padded = str(nonce).zfill(20)
                    hash_hex = sha256(lhb + nonce_padded.encode() + worker_b).hexdigest()
                    if hash_hex < target_hex:
                        self.solution = (jid, nonce, hash_hex)
                        self.found_event.set()
                        break
                    nonce += 1

                with self.stats_lock:
                    self.stats["hashes"] += gpu_batch

    def submit(self, bid, nonce):
        try:
            r = self.session.post(
                f"{self.args.server}/submit_solution",
                json={"bounty_id": bid, "nonce": nonce, "worker_name": self.args.worker, "device_type": "python_miner"},
                timeout=10
            )
            return r.json()
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def start(self):
        self.banner()
        self.log(f"{ANSI.CYN}[NET] Connecting to {self.args.server}...{ANSI.RST}")
        try:
            self.session.get(f"{self.args.server}/api/test", timeout=5)
            self.log(f"{ANSI.GRN}[NET] Server is online{ANSI.RST}")
        except:
            self.log(f"{ANSI.RED}[ERR] Server unreachable{ANSI.RST}")
            return

        threading.Thread(target=self.display_loop, daemon=True).start()
        threading.Thread(target=self.report_loop, daemon=True).start()

        for i in range(self.args.threads):
            threading.Thread(target=self.mine_cpu, args=(i, self.args.threads), daemon=True).start()

        if self.args.gpu:
            gpus = discover_gpus()
            if gpus:
                for i, gpu in enumerate(gpus):
                    threading.Thread(target=self.mine_gpu_wrapper, args=(gpu, i), daemon=True).start()
            else:
                self.log(f"{ANSI.YEL}[WARN] No compatible GPU found. Running CPU only.{ANSI.RST}")

        while self.running:
            if self.stats["current_job"] is None:
                job = self.fetch_job()
                if not job:
                    time.sleep(self.args.poll)
                    continue
                self.log(f"{ANSI.CYN}[JOB] New: #{job['id'][:16]}... | Diff: {job['difficulty']:.1f} | Reward: {job['reward']} CC{ANSI.RST}")
                self.found_event.clear()
                self.solution = None
                self.stats["current_job"] = job
            else:
                self.found_event.wait(timeout=0.5)

            if self.solution and self.stats["current_job"]:
                bid, nonce, hx = self.solution
                self.solution = None
                self.found_event.clear()
                self.log(f"{ANSI.YEL}[FOUND] Solution! Nonce: {nonce}{ANSI.RST}")
                resp = self.submit(bid, nonce)
                if resp.get("status") == "success":
                    with self.stats_lock:
                        self.stats["blocks_found"] += 1
                    reward_amount = resp.get('reward', '?')
                    self.log(f"{ANSI.GRN}[ACCEPT] Block accepted! +{reward_amount} CC{ANSI.RST}")
                else:
                    reason = resp.get('reason', resp.get('message', 'unknown'))
                    self.log(f"{ANSI.YEL}[REJECT] {reason}{ANSI.RST}")
                self.stats["current_job"] = None

    def stop(self):
        self.running = False
        print(f"\n{ANSI.CLR}")
        self.log(f"{ANSI.BLU}[FINAL] Hashes: {self.stats['hashes']:,} | Blocks: {self.stats['blocks_found']} | Runtime: {int(time.time() - self.stats['start_time'])}s{ANSI.RST}")

# ========== INTERACTIVE SETUP ==========
def interactive_setup():
    global DEFAULT_WORKER, DEFAULT_THREADS, DEFAULT_GPU, DEFAULT_POLL, DEFAULT_SERVER

    saved_config = load_config()
    
    os.system("clear" if os.name != "nt" else "cls")
    print(f"{ANSI.BOLD}{ANSI.CYN}╔══════════════════════════════════════════════════════════╗{ANSI.RST}")
    print(f"{ANSI.BOLD}{ANSI.CYN}║           CHOCOHUB MINER - INTERACTIVE SETUP            ║{ANSI.RST}")
    print(f"{ANSI.BOLD}{ANSI.CYN}╚══════════════════════════════════════════════════════════╝{ANSI.RST}\n")
    
    if saved_config.get("worker"):
        print(f"  {ANSI.GRY}[Config cũ] Worker: {saved_config['worker']}{ANSI.RST}")
        print(f"  {ANSI.GRY}[Config cũ] Server: {saved_config['server']}{ANSI.RST}")
        print(f"  {ANSI.GRY}[Config cũ] GPU: {'Bật' if saved_config['gpu'] else 'Tắt'}{ANSI.RST}\n")
        use_old = input(f"  {ANSI.YEL}➤ Dùng lại config cũ? (y/n){ANSI.RST}: ").strip().lower()
        if use_old == 'y':
            DEFAULT_WORKER = saved_config["worker"]
            DEFAULT_SERVER = saved_config["server"]
            DEFAULT_THREADS = saved_config["threads"]
            DEFAULT_GPU = saved_config["gpu"]
            DEFAULT_POLL = saved_config["poll"]
            print(f"\n{ANSI.GRN}✓ Đã load config cũ!{ANSI.RST}")
            time.sleep(1)
            return

    while True:
        default_worker = saved_config.get("worker", "")
        prompt = f"  {ANSI.YEL}➤ Worker name{ANSI.RST}"
        if default_worker:
            prompt += f" (current: {default_worker})"
        wrk = input(f"{prompt}: ").strip()
        if wrk:
            DEFAULT_WORKER = wrk
            break
        elif default_worker:
            DEFAULT_WORKER = default_worker
            break
        print(f"  {ANSI.RED}Please enter worker name!{ANSI.RST}")

    default_srv = saved_config.get("server", DEFAULT_SERVER)
    srv_input = input(f"  {ANSI.YEL}➤ Server URL{ANSI.RST} (current: {default_srv}): ").strip()
    DEFAULT_SERVER = srv_input if srv_input else default_srv

    print(f"\n  {ANSI.CYN}[?] Select device type:{ANSI.RST}")
    print(f"     1) {ANSI.BLU}Mobile{ANSI.RST}")
    print(f"     2) {ANSI.GRN}PC{ANSI.RST}")
    dev_choice = input(f"  {ANSI.YEL}➤ Choice (1/2){ANSI.RST}: ").strip()
    is_mobile = (dev_choice == "1")

    use_gpu = False
    if not is_mobile:
        print(f"\n  {ANSI.CYN}[?] Use GPU for mining?{ANSI.RST}")
        print(f"     1) {ANSI.GRN}CPU only{ANSI.RST}")
        print(f"     2) {ANSI.MAG}CPU + GPU{ANSI.RST}")
        gpu_choice = input(f"  {ANSI.YEL}➤ Choice (1/2){ANSI.RST}: ").strip()
        use_gpu = (gpu_choice == "2")
        DEFAULT_GPU = use_gpu

    suggested = suggest_threads("mobile" if is_mobile else "pc", use_gpu)
    default_thr = saved_config.get("threads", suggested)
    thr_input = input(f"\n  {ANSI.YEL}➤ CPU threads{ANSI.RST} (suggested: {suggested}, current: {default_thr}): ").strip()
    if thr_input:
        try:
            DEFAULT_THREADS = int(thr_input)
        except:
            DEFAULT_THREADS = suggested
    else:
        DEFAULT_THREADS = default_thr

    default_poll = saved_config.get("poll", DEFAULT_POLL)
    poll_input = input(f"\n  {ANSI.YEL}➤ Job poll interval (seconds){ANSI.RST} (current: {default_poll}): ").strip()
    if poll_input:
        try:
            DEFAULT_POLL = int(poll_input)
        except:
            pass
    else:
        DEFAULT_POLL = default_poll

    new_config = {
        "server": DEFAULT_SERVER,
        "worker": DEFAULT_WORKER,
        "threads": DEFAULT_THREADS,
        "gpu": DEFAULT_GPU,
        "poll": DEFAULT_POLL
    }
    save_config(new_config)

    print(f"\n{ANSI.GRN}✓ Setup complete! Config saved to {CONFIG_FILE}{ANSI.RST}")
    time.sleep(1.5)

def parse_arguments():
    parser = argparse.ArgumentParser(description="ChocoHub Python Miner")
    parser.add_argument("--server", default=DEFAULT_SERVER, help="Server URL")
    parser.add_argument("--worker", default=DEFAULT_WORKER, help="Worker name")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS, help="Number of CPU threads")
    parser.add_argument("--gpu", action="store_true", default=DEFAULT_GPU, help="Enable GPU mining")
    parser.add_argument("--poll", type=int, default=DEFAULT_POLL, help="Job fetch interval in seconds")
    parser.add_argument("--report-interval", type=int, default=DEFAULT_REPORT_INTERVAL, help="Report interval in seconds (default: 300 = 5 minutes)")
    return parser.parse_args()

def main():
    global DEFAULT_WORKER, DEFAULT_THREADS, DEFAULT_GPU, DEFAULT_POLL, DEFAULT_SERVER
    
    args_passed = sys.argv[1:]
    has_essential = any(x in args_passed for x in ['--worker', '--threads', '--gpu', '--poll'])

    if not has_essential and sys.stdin.isatty():
        interactive_setup()
    else:
        config = load_config()
        if DEFAULT_WORKER is None and config.get("worker"):
            DEFAULT_WORKER = config["worker"]
            DEFAULT_SERVER = config.get("server", DEFAULT_SERVER)
            DEFAULT_THREADS = config.get("threads", DEFAULT_THREADS)
            DEFAULT_GPU = config.get("gpu", DEFAULT_GPU)
            DEFAULT_POLL = config.get("poll", DEFAULT_POLL)

        if DEFAULT_WORKER is None:
            if sys.stdin.isatty():
                print(f"{ANSI.YEL}⚠ No worker name. Enter worker name:{ANSI.RST}")
                DEFAULT_WORKER = input("Worker: ").strip()
            else:
                print(f"{ANSI.RED}Error: Missing --worker parameter{ANSI.RST}")
                sys.exit(1)

    args = parse_arguments()
    if args.worker is None:
        if DEFAULT_WORKER:
            args.worker = DEFAULT_WORKER
        else:
            print(f"{ANSI.RED}Error: No worker name.{ANSI.RST}")
            sys.exit(1)

    if args.threads is None:
        args.threads = suggest_threads("pc" if not args.gpu else "pc", args.gpu)

    os.system("clear" if os.name != "nt" else "cls")
    miner = ChocoMiner(args)

    def signal_handler(sig, frame):
        miner.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    miner.start()

if __name__ == "__main__":
    main()
