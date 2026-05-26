import hashlib, requests, time, threading, argparse, sys, os, signal, subprocess, json, numpy as np
from datetime import datetime
from typing import Optional, Tuple

# ---------------------------------------------------------------------------
# Automatic library installer
# ---------------------------------------------------------------------------
def ensure_libraries(gpu=False):
    """Make sure requests, numpy, and pyopencl (if GPU) are available."""
    try:
        import requests
    except ImportError:
        print("Installing requests...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "requests"])
        print("requests installed – please restart the miner.")
        sys.exit(1)

    try:
        import numpy
    except ImportError:
        print("Installing numpy...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "numpy"])
        print("numpy installed – please restart the miner.")
        sys.exit(1)

    if gpu:
        try:
            import pyopencl as cl
        except ImportError:
            print("Installing pyopencl...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", "pyopencl"])
            print("pyopencl installed – please restart the miner.")
            sys.exit(1)

# ---------------------------------------------------------------------------
# Configuration persistence
# ---------------------------------------------------------------------------
CONFIG_FILE = "config.txt"

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_config(cfg):
    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, indent=4, ensure_ascii=False)
    except Exception:
        pass

# ---------------------------------------------------------------------------
# Default values
# ---------------------------------------------------------------------------
DEFAULT_SERVER  = "https://chocohub-r011.onrender.com"
DEFAULT_WORKER  = None
DEFAULT_THREADS = None
DEFAULT_GPU     = False
DEFAULT_POLL    = 10

# ---------------------------------------------------------------------------
# OPENCL KERNEL for SHA256 (adapted from working GPU miner)
# ---------------------------------------------------------------------------
OPENCL_KERNEL_SHA256 = """
#define UINT32_MAX 0xFFFFFFFF
#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define ROTL(x, n) (((x) << (n)) | ((x) >> (32 - (n))))
#define CH(x, y, z) (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define EP0(x) (ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22))
#define EP1(x) (ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25))
#define SIG0(x) (ROTR(x, 7) ^ ROTR(x, 18) ^ ((x) >> 3))
#define SIG1(x) (ROTR(x, 17) ^ ROTR(x, 19) ^ ((x) >> 10))

__constant uint K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

void sha256_transform(uint *state, const uchar *data) {
    uint W[64];
    uint i, t1, t2;
    uint a, b, c, d, e, f, g, h;
    
    for (i = 0; i < 16; i++) {
        W[i] = ((uint)data[i*4] << 24) | ((uint)data[i*4+1] << 16) | 
               ((uint)data[i*4+2] << 8) | (uint)data[i*4+3];
    }
    for (i = 16; i < 64; i++) {
        W[i] = SIG1(W[i-2]) + W[i-7] + SIG0(W[i-15]) + W[i-16];
    }
    
    a = state[0]; b = state[1]; c = state[2]; d = state[3];
    e = state[4]; f = state[5]; g = state[6]; h = state[7];
    
    for (i = 0; i < 64; i++) {
        t1 = h + EP1(e) + CH(e, f, g) + K[i] + W[i];
        t2 = EP0(a) + MAJ(a, b, c);
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }
    
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
}

__kernel void sha256_gpu_miner(
    __global const uchar *last_hash,
    __global const uchar *target_hex,
    uint start_nonce,
    uint work_items,
    __global uint *result_nonce,
    __global uchar *result_hash
) {
    uint gid = get_global_id(0);
    if (gid >= work_items || *result_nonce != UINT32_MAX) return;
    
    uint nonce = start_nonce + gid;
    
    // Build message: last_hash (32 bytes) + 20-digit nonce + worker name (placeholder)
    uchar message[128] = {0};
    for (int i = 0; i < 32; i++) message[i] = last_hash[i];
    
    // Convert nonce to 20-digit string with leading zeros
    uchar nonce_str[20];
    uint tmp = nonce;
    for (int i = 19; i >= 0; i--) {
        nonce_str[i] = (uchar)('0' + (tmp % 10));
        tmp /= 10;
    }
    for (int i = 0; i < 20; i++) message[32 + i] = nonce_str[i];
    
    // Padding for SHA256
    uint msg_len = 52; // 32 bytes hash + 20 bytes nonce
    ulong bit_len = (ulong)msg_len * 8;
    message[msg_len] = 0x80;
    message[56] = (uchar)(bit_len >> 56);
    message[57] = (uchar)(bit_len >> 48);
    message[58] = (uchar)(bit_len >> 40);
    message[59] = (uchar)(bit_len >> 32);
    message[60] = (uchar)(bit_len >> 24);
    message[61] = (uchar)(bit_len >> 16);
    message[62] = (uchar)(bit_len >> 8);
    message[63] = (uchar)bit_len;
    
    uint state[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };
    
    sha256_transform(state, message);
    
    // Second block if needed (64 bytes)
    if (msg_len + 1 > 56) {
        uint state2[8];
        for (int i = 0; i < 8; i++) state2[i] = state[i];
        uchar second_block[64] = {0};
        for (int i = 0; i < 8; i++) {
            second_block[i*4] = (state[i] >> 24) & 0xFF;
            second_block[i*4+1] = (state[i] >> 16) & 0xFF;
            second_block[i*4+2] = (state[i] >> 8) & 0xFF;
            second_block[i*4+3] = state[i] & 0xFF;
        }
        uint final_state[8] = {
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
        };
        sha256_transform(final_state, second_block);
        for (int i = 0; i < 8; i++) state[i] = final_state[i];
    }
    
    // Check if hash meets target
    bool match = true;
    for (int i = 0; i < 32; i++) {
        uchar hash_byte = (state[i/4] >> (24 - (i%4)*8)) & 0xFF;
        if (hash_byte != target_hex[i]) {
            match = false;
            break;
        }
    }
    
    if (match) {
        atomic_cmpxchg(result_nonce, UINT32_MAX, nonce);
        for (int i = 0; i < 32; i++) {
            result_hash[i] = (state[i/4] >> (24 - (i%4)*8)) & 0xFF;
        }
    }
}
"""

# ---------------------------------------------------------------------------
# GPU Miner Class (adapted from working code)
# ---------------------------------------------------------------------------
class GPUMiner:
    def __init__(self, cl_mod):
        self.cl = cl_mod
        self.ctx = None
        self.queue = None
        self.prog = None
        self.kernel = None
        self.max_work = 0
        self.device = None
        self.platform = None
        
    def init_gpu(self, platform_idx: Optional[int] = None, device_idx: Optional[int] = None) -> bool:
        try:
            platforms = self.cl.get_platforms()
            if not platforms:
                return False
                
            # Select platform
            if platform_idx is not None and platform_idx < len(platforms):
                self.platform = platforms[platform_idx]
            else:
                # Find first platform with GPU
                for p in platforms:
                    if p.get_devices(device_type=self.cl.device_type.GPU):
                        self.platform = p
                        break
                if not self.platform:
                    return False
                    
            # Get GPU devices
            devices = self.platform.get_devices(device_type=self.cl.device_type.GPU)
            if not devices:
                return False
                
            # Select device
            if device_idx is not None and device_idx < len(devices):
                self.device = devices[device_idx]
            else:
                self.device = devices[0]
                
            # Calculate max work items
            self.max_work = self.device.max_work_group_size * self.device.max_compute_units * 4
            
            # Create context and queue
            self.ctx = self.cl.Context([self.device])
            self.queue = self.cl.CommandQueue(self.ctx)
            
            # Build program
            self.prog = self.cl.Program(self.ctx, OPENCL_KERNEL_SHA256).build()
            self.kernel = self.cl.Kernel(self.prog, "sha256_gpu_miner")
            
            return True
        except Exception as e:
            print(f"GPU init error: {e}")
            return False
            
    def solve_job(self, last_hash_hex: str, target_hex: str, worker_name: str, 
                  gpu_load_percent: int = 25) -> Tuple[Optional[int], float, float]:
        """
        Solve a mining job using GPU
        Returns: (nonce, hashrate, elapsed_time)
        """
        import numpy as np
        
        last_bytes = bytes.fromhex(last_hash_hex)
        target_bytes = bytes.fromhex(target_hex)
        
        # Ensure correct lengths
        if len(last_bytes) != 32:
            last_bytes = last_bytes.ljust(32, b'\0')[:32]
        if len(target_bytes) != 32:
            target_bytes = target_bytes.ljust(32, b'\0')[:32]
        
        chunk_items = max(64, int(self.max_work * gpu_load_percent / 100))
        max_nonce = 10000000  # Adjust based on difficulty
        
        # Create buffers
        buf_last = self.cl.Buffer(self.ctx, self.cl.mem_flags.READ_ONLY | self.cl.mem_flags.COPY_HOST_PTR, 
                                  hostbuf=np.array(list(last_bytes), dtype=np.uint8))
        buf_target = self.cl.Buffer(self.ctx, self.cl.mem_flags.READ_ONLY | self.cl.mem_flags.COPY_HOST_PTR,
                                    hostbuf=np.array(list(target_bytes), dtype=np.uint8))
        buf_result = self.cl.Buffer(self.ctx, self.cl.mem_flags.READ_WRITE, 4)
        buf_hash = self.cl.Buffer(self.ctx, self.cl.mem_flags.WRITE_ONLY, 32)
        
        # Initialize result with UINT32_MAX
        init_val = np.full(1, 0xFFFFFFFF, dtype=np.uint32)
        self.cl.enqueue_copy(self.queue, buf_result, init_val)
        
        # Set kernel arguments
        self.kernel.set_arg(0, buf_last)
        self.kernel.set_arg(1, buf_target)
        self.kernel.set_arg(4, buf_result)
        self.kernel.set_arg(5, buf_hash)
        
        start_time = time.time()
        total_checked = 0
        start_nonce = 0
        
        while start_nonce <= max_nonce:
            current_items = min(chunk_items, max_nonce - start_nonce + 1)
            local = min(64, current_items)
            global_size = ((current_items + local - 1) // local) * local
            
            self.kernel.set_arg(2, np.uint32(start_nonce))
            self.kernel.set_arg(3, np.uint32(current_items))
            
            try:
                self.cl.enqueue_nd_range_kernel(self.queue, self.kernel, (global_size,), (local,)).wait()
            except Exception as e:
                print(f"Kernel error: {e}")
                return None, 0.0, time.time() - start_time
                
            total_checked += current_items
            
            # Check result
            res = np.zeros(1, dtype=np.uint32)
            self.cl.enqueue_copy(self.queue, res, buf_result).wait()
            
            if res[0] != 0xFFFFFFFF:
                elapsed = time.time() - start_time
                hashrate = total_checked / elapsed if elapsed > 0 else 0.0
                return int(res[0]), hashrate, elapsed
                
            start_nonce += current_items
            
        elapsed = time.time() - start_time
        return None, 0.0, elapsed
        
    def cleanup(self):
        for attr in ['kernel', 'prog', 'queue', 'ctx']:
            if hasattr(self, attr) and getattr(self, attr):
                delattr(self, attr)

# GPU probing helpers
_gpu_available = False
try:
    import pyopencl as cl
    _gpu_available = True
except ImportError:
    pass

def discover_gpus():
    if not _gpu_available:
        return []
    gpu_list = []
    try:
        for platform in cl.get_platforms():
            devices = platform.get_devices(device_type=cl.device_type.GPU)
            for dev in devices:
                gpu_list.append({
                    "device": dev,
                    "platform_idx": None,  # Will fill later
                    "device_idx": None,
                    "platform_name": platform.name.strip(),
                    "name": dev.name.strip(),
                    "vendor": dev.vendor.strip(),
                    "version": dev.version.strip()
                })
        # Add indices
        for i, gpu in enumerate(gpu_list):
            gpu["device_idx"] = i
        # Find platform indices
        for p_idx, platform in enumerate(cl.get_platforms()):
            for gpu in gpu_list:
                if gpu["platform_name"] == platform.name.strip():
                    gpu["platform_idx"] = p_idx
    except Exception as e:
        print(f"GPU discovery error: {e}")
    return gpu_list

# ANSI helpers
class ANSI:
    RST = "\033[0m"; BOLD = "\033[1m"
    YEL = "\033[93m"; ORG = "\033[33m"; GRN = "\033[92m"; RED = "\033[91m"
    BLU = "\033[94m"; CYN = "\033[96m"; MAG = "\033[95m"; WHT = "\033[97m"
    GRY = "\033[90m"; CLR = "\033[2K"

ICONS = {
    "INFO": f"{ANSI.BLU}i{ANSI.RST}",
    "OK":  f"{ANSI.GRN}+{ANSI.RST}",
    "WARN": f"{ANSI.YEL}!{ANSI.RST}",
    "ERR": f"{ANSI.RED}x{ANSI.RST}",
    "WIN":  f"{ANSI.YEL}{ANSI.BOLD}*{ANSI.RST}",
    "NET": f"{ANSI.CYN}~{ANSI.RST}",
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

# ---------------------------------------------------------------------------
# Core miner class (modified for GPU)
# ---------------------------------------------------------------------------
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
        self.session.headers.update({"User-Agent": "ChocoHub-Miner/v2-GPU"})
        self.found_event = threading.Event()
        self.solution = None
        
        # GPU miner instance
        self.gpu_miner = None
        if self.args.gpu and _gpu_available:
            import pyopencl as cl
            self.gpu_miner = GPUMiner(cl)

    def banner(self):
        gpu_status = f"{ANSI.GRN}GPU ENABLED{ANSI.RST}" if self.args.gpu else f"{ANSI.GRY}CPU only{ANSI.RST}"
        print(f"""\033[33m\033[1m
  ██████╗██╗  ██╗ ██████╗  ██████╗ ██████╗
 ██╔════╝██║  ██║██╔═══██╗██╔════╝██╔═══██╗
 ██║     ███████║██║   ██║██║     ██║   ██║
 ██║     ██╔══██║██║   ██║██║     ██║   ██║
 ╚██████╗██║  ██║╚██████╔╝╚██████╗╚██████╔╝
  ╚═════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═════╝{ANSI.RST}
{ANSI.YEL}        ⚡ Python miner v2 (GPU ready) ⚡{ANSI.RST}
{ANSI.GRY}    SHA256(last_hash + 20-digit-nonce + worker){ANSI.RST}
{ANSI.CYN}    Mode: {gpu_status}{ANSI.RST}
""")

    def _log_fmt(self, level, msg):
        ts = f"{ANSI.GRY}{datetime.now().strftime('%H:%M:%S')}{ANSI.RST}"
        return f"  {ts}  [{ICONS.get(level,'·')}]  {msg}"

    def log(self, level, msg, direct=False):
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
        if t < 0.5:
            return "—       "
        r = h / t
        if r >= 1_000_000:
            return f"{r/1_000_000:.2f} MH/s"
        if r >= 1_000:
            return f"{r/1_000:.1f} KH/s "
        return f"{int(r)} H/s   "

    def periodic_report(self):
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

    def mine_gpu(self):
        """GPU mining thread using OpenCL kernel"""
        if not self.gpu_miner:
            return
            
        # Initialize GPU
        if not self.gpu_miner.init_gpu():
            self.log("ERR", "Failed to initialize GPU miner", direct=True)
            return
            
        self.log("GPU", f"GPU initialized: {self.gpu_miner.device.name}", direct=True)
        
        while self.running:
            job = self.stats["current_job"]
            if not job:
                time.sleep(0.5)
                continue
                
            jid = job["id"]
            last_hash = job["last_hash"]
            target_hex = job["target_hex"]
            
            # Solve using GPU
            nonce, hashrate, elapsed = self.gpu_miner.solve_job(
                last_hash, target_hex, self.args.worker,
                gpu_load_percent=90  # High GPU load for mining
            )
            
            if nonce is not None and not self.found_event.is_set():
                if self.stats["current_job"] and self.stats["current_job"]["id"] == jid:
                    # Format nonce to 20 digits
                    nonce_padded = str(nonce).zfill(20)
                    sha256 = hashlib.sha256
                    worker_b = self.args.worker.encode()
                    hash_hex = sha256(last_hash.encode() + nonce_padded.encode() + worker_b).hexdigest()
                    self.solution = (jid, nonce, hash_hex)
                    self.found_event.set()
                    self.log("GPU", f"GPU found solution! Nonce: {nonce} (HR: {hashrate/1e3:.2f} KH/s)", direct=True)
            
            # Update stats
            with self.stats_lock:
                self.stats["hashes"] += int(hashrate * elapsed) if hashrate > 0 else 0

    def submit(self, bid, nonce):
        try:
            r = self.session.post(
                f"{self.args.server}/submit_solution",
                json={"bounty_id": bid, "nonce": nonce, "worker_name": self.args.worker, "device_type": "gpu_miner"},
                timeout=10
            )
            return r.json()
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def start(self):
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

        # Start CPU threads
        for i in range(self.args.threads):
            threading.Thread(target=self.mine_cpu, args=(i, self.args.threads), daemon=True).start()

        # Start GPU thread if enabled
        if self.args.gpu and self.gpu_miner:
            threading.Thread(target=self.mine_gpu, daemon=True).start()
        elif self.args.gpu and not self.gpu_miner:
            self.log("WARN", "GPU mining requested but OpenCL not available. Running CPU only.")

        while self.running:
            if self.stats["current_job"] is None:
                job = self.fetch_job()
                if not job:
                    time.sleep(self.args.poll)
                    continue
                self.found_event.clear()
                self.solution = None
                self.stats["current_job"] = job
                self.log("INFO", f"New job: diff={job['difficulty']}, reward={job['reward']} CC")
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
        self.running = False
        if self.gpu_miner:
            self.gpu_miner.cleanup()
        print(f"\n{ANSI.CLR}")
        self.log("INFO", f"Final stats - Hashes: {self.stats['hashes']:,} | Blocks: {self.stats['blocks_found']}", direct=True)

# ---------------------------------------------------------------------------
# Interactive setup (unchanged but updated)
# ---------------------------------------------------------------------------
def interactive_setup():
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
        print(f"  {ANSI.RED}Please enter worker name!{ANSI.RST}")

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

def parse_arguments():
    parser = argparse.ArgumentParser(description="ChocoHub Python Miner with GPU support")
    parser.add_argument("--server", default=DEFAULT_SERVER, help=f"Server URL (default: {DEFAULT_SERVER})")
    parser.add_argument("--worker", default=DEFAULT_WORKER, help="Worker name (login username)")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS, help="Number of CPU threads")
    parser.add_argument("--gpu", action="store_true", default=DEFAULT_GPU, help="Enable GPU mining (requires OpenCL)")
    parser.add_argument("--poll", type=int, default=DEFAULT_POLL, help="Job fetch interval in seconds")
    return parser.parse_args()

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
def main():
    global DEFAULT_SERVER, DEFAULT_WORKER, DEFAULT_THREADS, DEFAULT_GPU, DEFAULT_POLL

    # Load persisted settings
    config = load_config()
    DEFAULT_SERVER  = config.get("server", DEFAULT_SERVER)
    DEFAULT_WORKER  = config.get("worker", DEFAULT_WORKER)
    DEFAULT_THREADS = config.get("threads", DEFAULT_THREADS)
    DEFAULT_GPU     = config.get("gpu", DEFAULT_GPU)
    DEFAULT_POLL    = config.get("poll", DEFAULT_POLL)

    args_passed = sys.argv[1:]
    has_essential = any(x in args_passed for x in ['--worker', '--threads', '--gpu', '--poll'])

    if not has_essential and sys.stdin.isatty():
        interactive_setup()
    else:
        if DEFAULT_WORKER is None:
            if sys.stdin.isatty():
                print(f"{ANSI.YEL}⚠ No worker name. Enter worker name:{ANSI.RST}")
                DEFAULT_WORKER = input("Worker: ").strip()
            else:
                print(f"{ANSI.RED}Error: Missing --worker parameter when running non-interactive{ANSI.RST}")
                sys.exit(1)

    args = parse_arguments()
    if args.worker is None:
        print(f"{ANSI.RED}Error: No worker name. Use --worker or run without parameters.{ANSI.RST}")
        sys.exit(1)

    if args.threads is None:
        args.threads = suggest_threads("pc" if not args.gpu else "pc", args.gpu)

    # Install required libraries
    ensure_libraries(gpu=args.gpu)

    # Save configuration
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
