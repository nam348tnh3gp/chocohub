import hashlib, requests, time, threading, argparse, sys, os, signal, subprocess
from datetime import datetime

# =========================== CONFIG FILE ===========================
CONFIG_FILE = "config.txt"

DEFAULT_SERVER  = "https://chocohub-r011.onrender.com"
DEFAULT_WORKER  = None
DEFAULT_THREADS = None
DEFAULT_GPU     = False
DEFAULT_POLL    = 10

def load_config():
    """Load settings from config.txt into global defaults."""
    global DEFAULT_SERVER, DEFAULT_WORKER, DEFAULT_THREADS, DEFAULT_GPU, DEFAULT_POLL
    if not os.path.isfile(CONFIG_FILE):
        return
    try:
        with open(CONFIG_FILE, 'r') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' not in line:
                    continue
                key, val = line.split('=', 1)
                key = key.strip().upper()
                val = val.strip()
                if key == "SERVER":
                    DEFAULT_SERVER = val
                elif key == "WORKER":
                    DEFAULT_WORKER = val
                elif key == "THREADS":
                    try:
                        DEFAULT_THREADS = int(val)
                    except:
                        pass
                elif key == "GPU":
                    DEFAULT_GPU = val.lower() in ("true", "1", "yes")
                elif key == "POLL":
                    try:
                        DEFAULT_POLL = int(val)
                    except:
                        pass
    except Exception as e:
        print(f"Warning: Could not load config: {e}")

def save_config(args):
    """Write current settings to config.txt."""
    try:
        with open(CONFIG_FILE, 'w') as f:
            f.write(f"SERVER={args.server}\n")
            f.write(f"WORKER={args.worker}\n")
            f.write(f"THREADS={args.threads}\n")
            f.write(f"GPU={args.gpu}\n")
            f.write(f"POLL={args.poll}\n")
    except Exception as e:
        print(f"Warning: Could not save config: {e}")

# =========================== PACKAGE CHECKER ===========================
def ensure_package(package_name):
    """Check if a package is installed, install it if not. Returns True on success."""
    try:
        __import__(package_name)
        return True
    except ImportError:
        print(f"{ANSI.YEL}Installing required package: {package_name}...{ANSI.RST}")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", package_name],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            __import__(package_name)
            return True
        except Exception as e:
            print(f"{ANSI.RED}Failed to install {package_name}: {e}{ANSI.RST}")
            return False

# =========================== KEYBOARD INPUT CHECKER ===========================
def get_keyboard_handler():
    """Try to import keyboard listener for better Ctrl+C handling."""
    try:
        # Try pynput first (works on a-shell)
        from pynput import keyboard
        return "pynput"
    except ImportError:
        try:
            # Try getch for Unix systems
            import termios, tty
            return "termios"
        except ImportError:
            return None

# =========================== ANSI / ICONS ===========================
class ANSI:
    RST="\033[0m"; BOLD="\033[1m"
    YEL="\033[93m"; ORG="\033[33m"; GRN="\033[92m"; RED="\033[91m"
    BLU="\033[94m"; CYN="\033[96m"; MAG="\033[95m"; WHT="\033[97m"
    GRY="\033[90m"; CLR="\033[2K"

ICONS = {
    "INFO": f"{ANSI.BLU}i{ANSI.RST}", "OK":  f"{ANSI.GRN}+{ANSI.RST}",
    "WARN": f"{ANSI.YEL}!{ANSI.RST}", "ERR": f"{ANSI.RED}x{ANSI.RST}",
    "WIN":  f"{ANSI.YEL}{ANSI.BOLD}*{ANSI.RST}", "NET": f"{ANSI.CYN}~{ANSI.RST}",
    "DBG":  f"{ANSI.MAG}D{ANSI.RST}",
    "GPU":  f"{ANSI.GRN}G{ANSI.RST}"
}

# =========================== GPU DISCOVERY ===========================
def discover_gpus():
    """Return list of available GPU devices (requires pyopencl)."""
    try:
        import pyopencl as cl
    except ImportError:
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

# =========================== HELPERS ===========================
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

# =========================== MINER CLASS ===========================
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
        self.keyboard_handler = None

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

    def _log_fmt(self, level, msg):
        ts = f"{ANSI.GRY}{datetime.now().strftime('%H:%M:%S')}{ANSI.RST}"
        return f"  {ts}  [{ICONS.get(level,'·')}]  {msg}"

    def log(self, level, msg, direct=False):
        # Only show important levels; NET (new job fetch) is not printed separately
        if level in ("ERR", "WARN", "WIN", "OK", "GPU"):
            formatted = self._log_fmt(level, msg)
            if direct:
                print(formatted)
            else:
                with self.log_lock:
                    self.log_queue.append(formatted)

    def hr_str(self):
        h = self.stats["hashes"]
        t = time.time() - self.stats["start_time"]
        if t < 0.5: return "—       "
        r = h / t
        if r >= 1_000_000: return f"{r/1_000_000:.2f} MH/s"
        if r >= 1_000:     return f"{r/1_000:.1f} KH/s "
        return f"{int(r)} H/s   "

    def periodic_report(self):
        """Print a report every 5 minutes."""
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

    def keyboard_listener_thread(self):
        """Thread that listens for 'q' key to quit (alternative to Ctrl+C)."""
        try:
            handler_type = get_keyboard_handler()
            
            if handler_type == "pynput":
                from pynput import keyboard
                
                def on_press(key):
                    try:
                        if key == keyboard.Key.ctrl_c or (hasattr(key, 'char') and key.char == 'q'):
                            self.log("INFO", "Shutdown requested (keyboard)...", direct=True)
                            self.stop()
                            return False
                    except AttributeError:
                        pass
                
                with keyboard.Listener(on_press=on_press) as listener:
                    self.keyboard_handler = listener
                    listener.join()
                    
            elif handler_type == "termios":
                import termios, tty
                fd = sys.stdin.fileno()
                old_settings = termios.tcgetattr(fd)
                try:
                    tty.setraw(fd)
                    while self.running:
                        if sys.stdin.read(1) == 'q':
                            self.log("INFO", "Shutdown requested (keyboard)...", direct=True)
                            self.stop()
                            break
                finally:
                    termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
        except Exception as e:
            pass  # Silently fail if keyboard handling not available

    def display_loop(self):
        sp = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
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
                f"Up:{ANSI.GRY}{int(elapsed)}s{ANSI.RST}  "
                f"[q to quit]"
            )
            sys.stdout.flush()
            idx += 1
            time.sleep(0.1)
        sys.stdout.write("\n")

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
            self.log("ERR", f"Fetch job error: {e}")
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
        self.log("NET", f"Connecting to {ANSI.CYN}{self.args.server}{ANSI.RST}...", direct=True)
        print(f"\n  {ANSI.YEL}Press Ctrl+C or 'q' to quit the miner{ANSI.RST}\n")
        
        try:
            self.session.get(f"{self.args.server}/api/test", timeout=5)
            self.log("OK", "Server is online", direct=True)
        except:
            self.log("ERR", "Server unreachable", direct=True)
            return

        # Start keyboard listener thread for alternative quit methods
        threading.Thread(target=self.keyboard_listener_thread, daemon=True).start()
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

        try:
            while self.running:
                if self.stats["current_job"] is None:
                    job = self.fetch_job()
                    if not job:
                        time.sleep(self.args.poll)
                        continue
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
                    
        except KeyboardInterrupt:
            self.stop()

    def stop(self):
        self.running = False
        print(f"\n{ANSI.CLR}")
        self.log("INFO", f"Final stats - Hashes: {self.stats['hashes']:,} | Blocks: {self.stats['blocks_found']}", direct=True)
        # Force exit if needed
        os._exit(0)

# =========================== INTERACTIVE SETUP ===========================
def interactive_setup():
    global DEFAULT_WORKER, DEFAULT_THREADS, DEFAULT_GPU, DEFAULT_POLL

    os.system("clear" if os.name != "nt" else "cls")
    print(f"{ANSI.BOLD}{ANSI.CYN}╔══════════════════════════════════════════════════════════╗{ANSI.RST}")
    print(f"{ANSI.BOLD}{ANSI.CYN}║           CHOCOHUB MINER - INTERACTIVE SETUP             ║{ANSI.RST}")
    print(f"{ANSI.BOLD}{ANSI.CYN}╚══════════════════════════════════════════════════════════╝{ANSI.RST}\n")

    while True:
        try:
            wrk = input(f"  {ANSI.YEL}➤ Worker name{ANSI.RST}: ").strip()
            if wrk:
                DEFAULT_WORKER = wrk
                break
            print(f"  {ANSI.RED}Please enter worker name!{ANSI.RST}")
        except (KeyboardInterrupt, EOFError):
            print(f"\n{ANSI.YEL}Exiting setup...{ANSI.RST}")
            sys.exit(0)

    print(f"\n  {ANSI.CYN}[?] Select device type:{ANSI.RST}")
    print(f"     1) {ANSI.BLU}Mobile{ANSI.RST}")
    print(f"     2) {ANSI.GRN}PC{ANSI.RST}")
    try:
        dev_choice = input(f"  {ANSI.YEL}➤ Choice (1/2){ANSI.RST}: ").strip()
    except (KeyboardInterrupt, EOFError):
        print(f"\n{ANSI.YEL}Exiting setup...{ANSI.RST}")
        sys.exit(0)
    is_mobile = (dev_choice == "1")

    use_gpu = False
    if not is_mobile:
        print(f"\n  {ANSI.CYN}[?] Use GPU for mining?{ANSI.RST}")
        print(f"     1) {ANSI.GRN}CPU only{ANSI.RST}")
        print(f"     2) {ANSI.MAG}CPU + GPU{ANSI.RST}")
        try:
            gpu_choice = input(f"  {ANSI.YEL}➤ Choice (1/2){ANSI.RST}: ").strip()
        except (KeyboardInterrupt, EOFError):
            print(f"\n{ANSI.YEL}Exiting setup...{ANSI.RST}")
            sys.exit(0)
        use_gpu = (gpu_choice == "2")
        DEFAULT_GPU = use_gpu

    suggested = suggest_threads("mobile" if is_mobile else "pc", use_gpu)
    try:
        thr_input = input(f"\n  {ANSI.YEL}➤ CPU threads{ANSI.RST} (suggested: {suggested}): ").strip()
    except (KeyboardInterrupt, EOFError):
        print(f"\n{ANSI.YEL}Exiting setup...{ANSI.RST}")
        sys.exit(0)
    if thr_input:
        try:
            DEFAULT_THREADS = int(thr_input)
        except:
            DEFAULT_THREADS = suggested
    else:
        DEFAULT_THREADS = suggested

    try:
        poll_input = input(f"\n  {ANSI.YEL}➤ Job poll interval (seconds){ANSI.RST} [default {DEFAULT_POLL}]: ").strip()
    except (KeyboardInterrupt, EOFError):
        print(f"\n{ANSI.YEL}Exiting setup...{ANSI.RST}")
        sys.exit(0)
    if poll_input:
        try:
            DEFAULT_POLL = int(poll_input)
        except:
            pass

    print(f"\n{ANSI.GRN}✓ Setup complete!{ANSI.RST}")
    time.sleep(1.5)

# =========================== ARGUMENT PARSER ===========================
def parse_arguments():
    parser = argparse.ArgumentParser(description="ChocoHub Python Miner")
    parser.add_argument("--server", default=DEFAULT_SERVER, help=f"Server URL (default: {DEFAULT_SERVER})")
    parser.add_argument("--worker", default=DEFAULT_WORKER, help="Worker name (login username)")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS, help="Number of CPU threads")
    parser.add_argument("--gpu", action="store_true", default=DEFAULT_GPU, help="Enable GPU mining (requires OpenCL)")
    parser.add_argument("--poll", type=int, default=DEFAULT_POLL, help="Job fetch interval in seconds")
    return parser.parse_args()

# =========================== MAIN ===========================
def main():
    # 1. Load saved configuration (if any)
    load_config()

    # 2. Check if essential arguments are missing
    args_passed = sys.argv[1:]
    has_essential = any(x in args_passed for x in ['--worker', '--threads', '--gpu', '--poll'])

    if not has_essential and sys.stdin.isatty():
        # Interactive setup will update the global defaults
        try:
            interactive_setup()
        except KeyboardInterrupt:
            print(f"\n{ANSI.YEL}Setup cancelled. Exiting...{ANSI.RST}")
            sys.exit(0)

    # 3. Parse final arguments (uses current global defaults)
    args = parse_arguments()

    # 4. If still no worker, error out (non-interactive)
    if args.worker is None:
        if sys.stdin.isatty():
            try:
                print(f"{ANSI.YEL}⚠ No worker name. Enter worker name:{ANSI.RST}")
                args.worker = input("Worker: ").strip()
            except KeyboardInterrupt:
                print(f"\n{ANSI.YEL}Exiting...{ANSI.RST}")
                sys.exit(0)
        else:
            print(f"{ANSI.RED}Error: Missing --worker parameter when running non-interactive{ANSI.RST}")
            sys.exit(1)

    # 5. If threads not provided, auto-suggest
    if args.threads is None:
        args.threads = suggest_threads("pc" if not args.gpu else "pc", args.gpu)

    # 6. Save config for next run
    save_config(args)

    # 7. Ensure required packages are installed
    if not ensure_package("requests"):
        print(f"{ANSI.RED}Fatal: requests library could not be installed.{ANSI.RST}")
        sys.exit(1)

    if args.gpu:
        if ensure_package("pyopencl"):
            # If pyopencl installed, GPU discovery will work
            pass
        else:
            print(f"{ANSI.YEL}Warning: pyopencl not available, GPU mining will be skipped.{ANSI.RST}")
            args.gpu = False

    # 8. Start the miner
    os.system("clear" if os.name != "nt" else "cls")
    miner = ChocoMiner(args)

    def signal_handler(sig, frame):
        print(f"\n{ANSI.YEL}Signal received, shutting down...{ANSI.RST}")
        miner.stop()
        os._exit(0)

    # Register multiple signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Try to register SIGQUIT if available (not on Windows)
    try:
        signal.signal(signal.SIGQUIT, signal_handler)
    except AttributeError:
        pass

    try:
        miner.start()
    except Exception as e:
        print(f"{ANSI.RED}Fatal error: {e}{ANSI.RST}")
        miner.stop()

if __name__ == "__main__":
    main()
