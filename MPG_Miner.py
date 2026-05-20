import sys
import os
import subprocess
import json
import hashlib
import time
import threading
import argparse
import signal
from datetime import datetime

# ------------------------------------------------------------
# Auto-install required packages
# ------------------------------------------------------------
def install_package(package):
    """Install a Python package using pip."""
    subprocess.check_call([sys.executable, "-m", "pip", "install", package])

# Ensure 'requests' is available
try:
    import requests
except ImportError:
    print("Installing required package: requests...")
    install_package("requests")
    import requests

# ------------------------------------------------------------
# Default configuration (will be overwritten by config.txt or CLI)
# ------------------------------------------------------------
DEFAULT_SERVER  = "https://chocohub-r011.onrender.com"
DEFAULT_WORKER  = None
DEFAULT_THREADS = None
DEFAULT_GPU     = False
DEFAULT_POLL    = 10

_gpu_available = False
try:
    import pyopencl as cl
    _gpu_available = True
except ImportError:
    pass

# ------------------------------------------------------------
# GPU discovery
# ------------------------------------------------------------
def discover_gpus():
    """Return list of GPU devices available through OpenCL."""
    if not _gpu_available:
        return []
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

# ------------------------------------------------------------
# ANSI colour / icon helpers
# ------------------------------------------------------------
class ANSI:
    RST = "\033[0m"
    BOLD = "\033[1m"
    YEL = "\033[93m"
    ORG = "\033[33m"
    GRN = "\033[92m"
    RED = "\033[91m"
    BLU = "\033[94m"
    CYN = "\033[96m"
    MAG = "\033[95m"
    WHT = "\033[97m"
    GRY = "\033[90m"
    CLR = "\033[2K"

ICONS = {
    "INFO": f"{ANSI.BLU}i{ANSI.RST}",
    "OK":   f"{ANSI.GRN}+{ANSI.RST}",
    "WARN": f"{ANSI.YEL}!{ANSI.RST}",
    "ERR":  f"{ANSI.RED}x{ANSI.RST}",
    "WIN":  f"{ANSI.YEL}{ANSI.BOLD}*{ANSI.RST}",
    "NET":  f"{ANSI.CYN}~{ANSI.RST}",
    "DBG":  f"{ANSI.MAG}D{ANSI.RST}",
    "GPU":  f"{ANSI.GRN}G{ANSI.RST}"
}

# ------------------------------------------------------------
# Utility functions
# ------------------------------------------------------------
def get_cpu_count():
    """Return number of logical CPUs."""
    try:
        return os.cpu_count() or 2
    except:
        return 2

def suggest_threads(device_type, gpu_enabled):
    """Suggest a sensible number of CPU mining threads."""
    cpu_cnt = get_cpu_count()
    if device_type == "mobile":
        return min(2, cpu_cnt)
    if gpu_enabled:
        return max(1, cpu_cnt - 2)
    return cpu_cnt

def load_config():
    """Load persisted config from config.txt (JSON format)."""
    cfg = {}
    if os.path.exists("config.txt"):
        try:
            with open("config.txt", "r") as f:
                cfg = json.load(f)
        except (json.JSONDecodeError, IOError):
            pass
    return cfg

def save_config(config_dict):
    """Save current configuration to config.txt."""
    try:
        with open("config.txt", "w") as f:
            json.dump(config_dict, f, indent=2)
    except IOError:
        pass  # non-critical

# ------------------------------------------------------------
# Core miner class
# ------------------------------------------------------------
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
        self.log_queue = []
        self.log_lock = threading.Lock()
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": "ChocoHub-Miner/v2"})
        self.found_event = threading.Event()
        self.solution = None

    def banner(self):
        """Print a fancy startup banner."""
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

    def _log_fmt(self, level, msg):
        """Format a log line with timestamp and icon."""
        ts = f"{ANSI.GRY}{datetime.now().strftime('%H:%M:%S')}{ANSI.RST}"
        return f"  {ts}  [{ICONS.get(level, '·')}]  {msg}"

    def log(self, level, msg, direct=False):
        """Queue a log message (or print immediately if direct)."""
        # Only keep important levels; NET (job fetch) is suppressed to avoid clutter
        if level in ("ERR", "WARN", "WIN", "OK", "GPU"):
            formatted = self._log_fmt(level, msg)
            if direct:
                print(formatted)
            else:
                with self.log_lock:
                    self.log_queue.append(formatted)

    def hr_str(self):
        """Return a human-readable hash rate string."""
        h = self.stats["hashes"]
        t = time.time() - self.stats["start_time"]
        if t < 0.5:
            return "—       "
        r = h / t
        if r >= 1_000_000:
            return f"{r/1_000_000:.2f} MH/s"
        if r >= 1_000:
            return f"{r/1_000:.1f} KH/s "
        return f"{int(r)} H/s   "

    def periodic_report(self):
        """Print a detailed report every 5 minutes."""
        while self.running:
            time.sleep(300)
            if not self.running:
                break
            with self.stats_lock:
                now = time.time()
                elapsed = now - self.stats["last_report_time"]
                hashes = self.stats["hashes"]
                blocks = self.stats["blocks_found"]
                rate = hashes / (now - self.stats["start_time"]) if (now - self.stats["start_time"]) > 0 else 0
                report = (f"\n{ANSI.CLR}[REPORT] {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n"
                          f"  Total hashes  : {hashes:,}\n"
                          f"  Avg hashrate  : {rate/1e3:.2f} KH/s\n"
                          f"  Blocks found  : {blocks}\n"
                          f"  Uptime        : {int(elapsed)} seconds\n")
                sys.stdout.write(report)
                sys.stdout.flush()
                self.stats["last_report_time"] = now

    def display_loop(self):
        """Continuously update the status line."""
        sp = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
        idx = 0
        while self.running:
            with self.log_lock:
                pending, self.log_queue[:] = self.log_queue[:], []
            for line in pending:
                sys.stdout.write(f"\r{ANSI.CLR}{line}\n")

            elapsed = time.time() - self.stats["start_time"]
            job = self.stats["current_job"]
            diff = f"{job['difficulty']:.1f}" if job and 'difficulty' in job else "—"
            reward = str(job.get('reward', '?')) if job else "—"

            sys.stdout.write(
                f"\r{ANSI.CLR}  {ANSI.ORG}{sp[idx%len(sp)]}{ANSI.RST} "
                f"HR:{ANSI.YEL}{self.hr_str()}{ANSI.RST}  "
                f"Diff:{ANSI.CYN}{diff}{ANSI.RST}  "
                f"Reward:{ANSI.GRN}{reward} CC{ANSI.RST}  "
                f"Blocks:{ANSI.MAG}{self.stats['blocks_found']}{ANSI.RST}  "
                f"Up:{ANSI.GRY}{int(elapsed)}s{ANSI.RST}"
            )
            sys.stdout.flush()
            idx += 1
            time.sleep(0.1)
        sys.stdout.write("\n")

    def fetch_job(self):
        """Request a new mining job from the server."""
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
            self.log("ERR", f"Fetch job error: {e}")
            return None

    def mine_cpu(self, tid, nthreads):
        """CPU mining thread (stride = nthreads)."""
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
        """GPU mining wrapper (currently uses CPU hashing for compatibility)."""
        self.log("GPU", f"Active on {ANSI.GRN}{gpu_info['name']}{ANSI.RST} ({gpu_info['vendor']})")
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
        """Submit a found solution to the server."""
        try:
            r = self.session.post(
                f"{self.args.server}/submit_solution",
                json={
                    "bounty_id": bid,
                    "nonce": nonce,
                    "worker_name": self.args.worker,
                    "device_type": "python_miner"
                },
                timeout=10
            )
            return r.json()
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def start(self):
        """Launch all mining threads and the main event loop."""
        self.banner()
        self.log("NET", f"Connecting to {ANSI.CYN}{self.args.server}{ANSI.RST}...", direct=True)
        try:
            self.session.get(f"{self.args.server}/api/test", timeout=5)
            self.log("OK", "Server is online", direct=True)
        except:
            self.log("ERR", "Server unreachable", direct=True)
            return

        threading.Thread(target=self.display_loop, daemon=True).start()
        threading.Thread(target=self.periodic_report, daemon=True).start()

        for i in range(self.args.threads):
            threading.Thread(target=self.mine_cpu, args=(i, self.args.threads), daemon=True).start()

        if self.args.gpu:
            gpus = discover_gpus()
            if gpus:
                for i, gpu in enumerate(gpus):
                    threading.Thread(target=self.mine_gpu_wrapper, args=(gpu, i), daemon=True).start()
            else:
                self.log("WARN", "No compatible GPU found. Running CPU only.")

        while self.running:
            if self.stats["current_job"] is None:
                job = self.fetch_job()
                if not job:
                    time.sleep(self.args.poll)
                    continue
                # Job successfully fetched – status line will show new difficulty/reward
                self.found_event.clear()
                self.solution = None
                self.stats["current_job"] = job
            else:
                self.found_event.wait(timeout=0.5)

            if self.solution and self.stats["current_job"]:
                bid, nonce, hx = self.solution
                self.solution = None
                self.found_event.clear()
                self.log("WIN", f"Solution found! Nonce: {nonce}")
                resp = self.submit(bid, nonce)
                if resp.get("status") == "success":
                    with self.stats_lock:
                        self.stats["blocks_found"] += 1
                    self.log("OK", f"Block accepted! +{resp.get('reward','?')} CC")
                else:
                    self.log("WARN", f"Rejected: {resp.get('reason', resp.get('message'))}")
                self.stats["current_job"] = None

    def stop(self):
        """Gracefully stop the miner."""
        self.running = False
        print(f"\n{ANSI.CLR}")
        self.log("INFO", f"Final stats - Hashes: {self.stats['hashes']:,} | Blocks: {self.stats['blocks_found']}", direct=True)

# ------------------------------------------------------------
# Interactive first-run setup
# ------------------------------------------------------------
def interactive_setup():
    """Ask user for configuration and return a populated dict."""
    global DEFAULT_WORKER, DEFAULT_THREADS, DEFAULT_GPU, DEFAULT_POLL

    os.system("clear" if os.name != "nt" else "cls")
    print(f"{ANSI.BOLD}{ANSI.CYN}╔══════════════════════════════════════════════════════════╗{ANSI.RST}")
    print(f"{ANSI.BOLD}{ANSI.CYN}║           CHOCOHUB MINER - INTERACTIVE SETUP             ║{ANSI.RST}")
    print(f"{ANSI.BOLD}{ANSI.CYN}╚══════════════════════════════════════════════════════════╝{ANSI.RST}\n")

    while True:
        wrk = input(f"  {ANSI.YEL}➤ Worker name{ANSI.RST}: ").strip()
        if wrk:
            DEFAULT_WORKER = wrk
            break
        print(f"  {ANSI.RED}Please enter a worker name!{ANSI.RST}")

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
    thr_input = input(f"\n  {ANSI.YEL}➤ CPU threads{ANSI.RST} (suggested: {suggested}): ").strip()
    if thr_input:
        try:
            DEFAULT_THREADS = int(thr_input)
        except:
            DEFAULT_THREADS = suggested
    else:
        DEFAULT_THREADS = suggested

    poll_input = input(f"\n  {ANSI.YEL}➤ Job poll interval (seconds){ANSI.RST} [default {DEFAULT_POLL}]: ").strip()
    if poll_input:
        try:
            DEFAULT_POLL = int(poll_input)
        except:
            pass

    print(f"\n{ANSI.GRN}✓ Setup complete!{ANSI.RST}")
    time.sleep(1.5)

# ------------------------------------------------------------
# Argument parsing and config loading
# ------------------------------------------------------------
def parse_arguments():
    parser = argparse.ArgumentParser(description="ChocoHub Python Miner")
    parser.add_argument("--server", default=DEFAULT_SERVER, help=f"Server URL (default: {DEFAULT_SERVER})")
    parser.add_argument("--worker", default=DEFAULT_WORKER, help="Worker name (your login username)")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS, help="Number of CPU threads")
    parser.add_argument("--gpu", action="store_true", default=DEFAULT_GPU, help="Enable GPU mining (requires OpenCL)")
    parser.add_argument("--poll", type=int, default=DEFAULT_POLL, help="Job fetch interval in seconds")
    return parser.parse_args()

# ------------------------------------------------------------
# Main entry point
# ------------------------------------------------------------
def main():
    global DEFAULT_WORKER, DEFAULT_THREADS, DEFAULT_GPU, DEFAULT_POLL, _gpu_available

    # Load previous config if available
    saved = load_config()
    if saved:
        DEFAULT_SERVER  = saved.get("server", DEFAULT_SERVER)
        DEFAULT_WORKER  = saved.get("worker", DEFAULT_WORKER)
        DEFAULT_THREADS = saved.get("threads", DEFAULT_THREADS)
        DEFAULT_GPU     = saved.get("gpu", DEFAULT_GPU)
        DEFAULT_POLL    = saved.get("poll", DEFAULT_POLL)

    # Determine if we need interactive setup
    args_passed = sys.argv[1:]
    has_essential = any(x in args_passed for x in ['--worker', '--threads', '--gpu', '--poll'])

    if not has_essential and sys.stdin.isatty():
        # No essential CLI args and we have a terminal → interactive
        interactive_setup()
    else:
        # Still need a worker name if missing
        if DEFAULT_WORKER is None:
            if sys.stdin.isatty():
                print(f"{ANSI.YEL}⚠ No worker name. Enter worker name:{ANSI.RST}")
                DEFAULT_WORKER = input("Worker: ").strip()
            else:
                print(f"{ANSI.RED}Error: Missing --worker parameter when running non-interactive.{ANSI.RST}")
                sys.exit(1)

    # Parse final arguments (CLI overrides defaults)
    args = parse_arguments()
    if args.worker is None:
        if DEFAULT_WORKER:
            args.worker = DEFAULT_WORKER
        else:
            print(f"{ANSI.RED}Error: No worker name. Use --worker or run without parameters.{ANSI.RST}")
            sys.exit(1)

    if args.threads is None:
        args.threads = suggest_threads("pc" if not args.gpu else "pc", args.gpu)

    # Auto-install pyopencl if GPU mining is requested and not available
    if args.gpu and not _gpu_available:
        print(f"{ANSI.YEL}GPU mining requested but pyopencl not found. Installing...{ANSI.RST}")
        try:
            install_package("pyopencl")
            import pyopencl as cl
            _gpu_available = True
            print(f"{ANSI.GRN}pyopencl installed successfully.{ANSI.RST}")
        except Exception as e:
            print(f"{ANSI.RED}Failed to install pyopencl: {e}{ANSI.RST}")
            print(f"{ANSI.YEL}Disabling GPU mode and continuing with CPU only.{ANSI.RST}")
            args.gpu = False

    # Save current config for next run
    save_config({
        "server": args.server,
        "worker": args.worker,
        "threads": args.threads,
        "gpu": args.gpu,
        "poll": args.poll
    })

    os.system("clear" if os.name != "nt" else "cls")
    miner = ChocoMiner(args)

    def signal_handler(sig, frame):
        miner.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    miner.start()

if __name__ == "__main__":
    main()
