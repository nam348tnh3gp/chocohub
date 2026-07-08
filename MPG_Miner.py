import hashlib, requests, time, threading, argparse, sys, os, signal, subprocess, json
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

    if gpu:
        try:
            import numpy
        except ImportError:
            print("Installing numpy (required for GPU mining)...")
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

def ensure_serial():
    """Ensure pyserial is available for Arduino bridge."""
    try:
        import serial
    except ImportError:
        print("Installing pyserial (required for Arduino bridge)...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyserial"])
        print("pyserial installed – please restart the miner.")
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
DEFAULT_SERVER      = "https://chocohub-r011.onrender.com"
DEFAULT_WORKER      = None
DEFAULT_THREADS     = None
DEFAULT_GPU         = False
DEFAULT_POLL        = 10
DEFAULT_ARDUINO_PORT = None
DEFAULT_ARDUINO_BAUD = 115200

# serial module: imported on demand
_serial_available = False
try:
    import serial
    _serial_available = True
except ImportError:
    pass

# ===========================================================================
# NEW OPENCL KERNEL – uses hex last_hash (64 bytes) + nonce + worker name
# ===========================================================================
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

// SHA-256 compression for a single 64-byte block
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

// Compute SHA-256 of a message of arbitrary length (up to ~128 bytes)
void sha256_hash(const uchar *msg, uint len, uchar *hash) {
    uint state[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };
    uchar block[64];
    uint block_len = 0;
    uint i;

    // Process full blocks
    for (i = 0; i < len; i++) {
        block[block_len++] = msg[i];
        if (block_len == 64) {
            sha256_transform(state, block);
            block_len = 0;
        }
    }

    // Padding
    uint total_bits = len * 8;
    block[block_len++] = 0x80;
    if (block_len > 56) {
        while (block_len < 64) block[block_len++] = 0;
        sha256_transform(state, block);
        block_len = 0;
    }
    while (block_len < 56) block[block_len++] = 0;
    // Append length as 64-bit big-endian
    for (i = 0; i < 8; i++) {
        block[56 + i] = (uchar)((total_bits >> (56 - i*8)) & 0xFF);
    }
    sha256_transform(state, block);

    // Output hash
    for (i = 0; i < 32; i++) {
        hash[i] = (state[i/4] >> (24 - (i%4)*8)) & 0xFF;
    }
}

__kernel void sha256_gpu_miner(
    __global const uchar *hex_last_hash,   // 64 bytes (ASCII hex)
    __global const uchar *worker_name,     // bytes of worker name
    uint worker_len,
    __global const uchar *target_hex,      // 32 bytes (binary target)
    uint start_nonce,
    uint work_items,
    __global uint *result_nonce,
    __global uchar *result_hash
) {
    uint gid = get_global_id(0);
    if (gid >= work_items || *result_nonce != UINT32_MAX) return;
    
    uint nonce = start_nonce + gid;
    
    // Build message: hex_last_hash (64) + nonce (20-digit zero-padded) + worker_name
    uchar message[128];
    uint idx = 0;
    for (int i = 0; i < 64; i++) message[idx++] = hex_last_hash[i];
    
    // Convert nonce to 20-digit string with leading zeros
    uchar nonce_str[20];
    uint tmp = nonce;
    for (int i = 19; i >= 0; i--) {
        nonce_str[i] = (uchar)('0' + (tmp % 10));
        tmp /= 10;
    }
    for (int i = 0; i < 20; i++) message[idx++] = nonce_str[i];
    
    // Append worker name
    for (int i = 0; i < worker_len; i++) message[idx++] = worker_name[i];
    
    // Compute SHA-256 hash of message
    uchar hash[32];
    sha256_hash(message, idx, hash);
    
    // Compare with target (binary)
    bool match = true;
    for (int i = 0; i < 32; i++) {
        if (hash[i] != target_hex[i]) {
            match = false;
            break;
        }
    }
    if (match) {
        atomic_cmpxchg(result_nonce, UINT32_MAX, nonce);
        for (int i = 0; i < 32; i++) {
            result_hash[i] = hash[i];
        }
    }
}
"""

# ---------------------------------------------------------------------------
# GPU Miner Class (rewritten)
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
        self.np = None
        
    def _import_numpy(self):
        if self.np is None:
            import numpy as np
            self.np = np
        return self.np
        
    def init_gpu(self, platform_idx: Optional[int] = None, device_idx: Optional[int] = None) -> bool:
        try:
            platforms = self.cl.get_platforms()
            if not platforms:
                return False
            if platform_idx is not None and platform_idx < len(platforms):
                self.platform = platforms[platform_idx]
            else:
                for p in platforms:
                    if p.get_devices(device_type=self.cl.device_type.GPU):
                        self.platform = p
                        break
                if not self.platform:
                    return False
            devices = self.platform.get_devices(device_type=self.cl.device_type.GPU)
            if not devices:
                return False
            if device_idx is not None and device_idx < len(devices):
                self.device = devices[device_idx]
            else:
                self.device = devices[0]
            self.max_work = self.device.max_work_group_size * self.device.max_compute_units * 4
            self.ctx = self.cl.Context([self.device])
            self.queue = self.cl.CommandQueue(self.ctx)
            self.prog = self.cl.Program(self.ctx, OPENCL_KERNEL_SHA256).build()
            self.kernel = self.cl.Kernel(self.prog, "sha256_gpu_miner")
            return True
        except Exception as e:
            print(f"GPU init error: {e}")
            return False
            
    def solve_job(self, last_hash_hex: str, target_hex: str, worker_name: str,
                  gpu_load_percent: int = 25) -> Tuple[Optional[int], float, float]:
        np = self._import_numpy()
        
        # Prepare buffers
        hex_bytes = np.array(list(last_hash_hex.encode('ascii')), dtype=np.uint8)  # 64 bytes
        worker_bytes = np.array(list(worker_name.encode('utf-8')), dtype=np.uint8)
        worker_len = np.uint32(len(worker_bytes))
        target_bytes = bytes.fromhex(target_hex)  # 32 bytes
        target_np = np.array(list(target_bytes), dtype=np.uint8)
        
        chunk_items = max(64, int(self.max_work * gpu_load_percent / 100))
        max_nonce = 10000000
        
        # Buffers
        buf_hex = self.cl.Buffer(self.ctx, self.cl.mem_flags.READ_ONLY | self.cl.mem_flags.COPY_HOST_PTR,
                                 hostbuf=hex_bytes)
        buf_worker = self.cl.Buffer(self.ctx, self.cl.mem_flags.READ_ONLY | self.cl.mem_flags.COPY_HOST_PTR,
                                    hostbuf=worker_bytes)
        buf_target = self.cl.Buffer(self.ctx, self.cl.mem_flags.READ_ONLY | self.cl.mem_flags.COPY_HOST_PTR,
                                    hostbuf=target_np)
        buf_result = self.cl.Buffer(self.ctx, self.cl.mem_flags.READ_WRITE, 4)
        buf_hash = self.cl.Buffer(self.ctx, self.cl.mem_flags.WRITE_ONLY, 32)
        
        init_val = np.full(1, 0xFFFFFFFF, dtype=np.uint32)
        self.cl.enqueue_copy(self.queue, buf_result, init_val)
        
        self.kernel.set_arg(0, buf_hex)
        self.kernel.set_arg(1, buf_worker)
        self.kernel.set_arg(2, worker_len)
        self.kernel.set_arg(3, buf_target)
        self.kernel.set_arg(6, buf_result)
        self.kernel.set_arg(7, buf_hash)
        
        start_time = time.time()
        total_checked = 0
        start_nonce = 0
        
        while start_nonce <= max_nonce:
            current_items = min(chunk_items, max_nonce - start_nonce + 1)
            local = min(64, current_items)
            global_size = ((current_items + local - 1) // local) * local
            
            self.kernel.set_arg(4, np.uint32(start_nonce))
            self.kernel.set_arg(5, np.uint32(current_items))
            
            try:
                self.cl.enqueue_nd_range_kernel(self.queue, self.kernel, (global_size,), (local,)).wait()
            except Exception as e:
                print(f"Kernel error: {e}")
                return None, 0.0, time.time() - start_time
                
            total_checked += current_items
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
                    "platform_idx": None,
                    "device_idx": None,
                    "platform_name": platform.name.strip(),
                    "name": dev.name.strip(),
                    "vendor": dev.vendor.strip(),
                    "version": dev.version.strip()
                })
        for i, gpu in enumerate(gpu_list):
            gpu["device_idx"] = i
        for p_idx, platform in enumerate(cl.get_platforms()):
            for gpu in gpu_list:
                if gpu["platform_name"] == platform.name.strip():
                    gpu["platform_idx"] = p_idx
    except Exception as e:
        print(f"GPU discovery error: {e}")
    return gpu_list

# ---------------------------------------------------------------------------
# Arduino bridge (serial co-miner)
# ---------------------------------------------------------------------------
class ArduinoBridge:
    """Manages a serial connection to an Arduino running chocohub_avr_miner.ino.

    Protocol (line-delimited JSON at 115200 baud):
      Host → Arduino: {"cmd":"job","id":"...","last_hash":"<64 hex>",
                       "target_hex":"<64 hex>","worker":"<name>"}
      Arduino → Host: {"cmd":"found","job_id":"...","nonce":123,"hash":"<64 hex>"}
                      {"cmd":"status","hashes":N,"hashrate":R,"uptime":U}
                      {"cmd":"pong","model":"..."}
                      {"cmd":"ack","msg":"..."}
    """

    def __init__(self, port, baud=115200, timeout=2):
        self.port = port
        self.baud = baud
        self.timeout = timeout
        self.ser = None
        self.reader_thread = None
        self.running = False
        self.lock = threading.Lock()
        self.model = "Arduino"
        self.last_status = {}

    def open(self):
        import serial
        self.ser = serial.Serial(self.port, self.baud, timeout=self.timeout)
        self.running = True
        # Flush any stale data and wait for pong
        self.ser.reset_input_buffer()
        self.ser.reset_output_buffer()
        self.ser.write(b'{"cmd":"ping"}\n')
        deadline = time.time() + 3
        acked = False
        while time.time() < deadline:
            try:
                line = self.ser.readline().decode('utf-8', errors='replace').strip()
                if not line:
                    continue
                data = json.loads(line)
                if data.get('cmd') in ('pong', 'ack'):
                    self.model = data.get('model', 'Arduino')
                    acked = True
                    break
            except Exception:
                pass
        if not acked:
            self.running = False
            self.ser.close()
            raise ConnectionError(f"Arduino on {self.port} did not respond to ping")
        return True

    def send_job(self, job_id, last_hash, target_hex, worker_name):
        """Send a mining job to the Arduino asynchronously."""
        msg = json.dumps({
            "cmd": "job",
            "id": job_id,
            "last_hash": last_hash,
            "target_hex": target_hex,
            "worker": worker_name
        }, separators=(',', ':')) + "\n"
        with self.lock:
            if self.ser and self.running:
                self.ser.write(msg.encode('utf-8'))

    def _reader(self, found_event, solution_container, stats_lock, stats):
        """Background thread: read serial lines and surface 'found' events."""
        # Use a short read timeout so the reader is responsive
        if self.ser:
            self.ser.timeout = 0.1
        while self.running:
            try:
                with self.lock:
                    if not self.ser or not self.ser.is_open:
                        break
                    try:
                        raw = self.ser.readline()
                    except Exception:
                        raw = b""
                if not raw:
                    time.sleep(0.05)
                    continue
                line = raw.decode('utf-8', errors='replace').strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    cmd = data.get('cmd')
                    if cmd == 'found':
                        jid = data.get('job_id')
                        nonce = int(data.get('nonce', 0))
                        solution_container[0] = (jid, nonce, data.get('hash', ''))
                        found_event.set()
                    elif cmd == 'status':
                        self.last_status = data
                        if stats_lock and stats is not None:
                            with stats_lock:
                                h = data.get('hashes', 0)
                                stats['avr_hashes'] = max(stats.get('avr_hashes', 0), h)
                except json.JSONDecodeError:
                    pass
            except Exception as e:
                print(f"\n[AVR_READER] EXCEPTION: {e}\n", flush=True)
                if self.running:
                    time.sleep(0.1)

    def start_reader(self, found_event, solution_container, stats_lock=None, stats=None):
        self.reader_thread = threading.Thread(
            target=self._reader,
            args=(found_event, solution_container, stats_lock, stats),
            daemon=True
        )
        self.reader_thread.start()

    def close(self):
        self.running = False
        with self.lock:
            if self.ser:
                try:
                    self.ser.write(b'{"cmd":"stop"}\n')
                except Exception:
                    pass
                try:
                    self.ser.close()
                except Exception:
                    pass
                self.ser = None

def discover_ports():
    """Return a list of serial port names."""
    ports = []
    if not _serial_available:
        return ports
    try:
        import serial.tools.list_ports
        for p in serial.tools.list_ports.comports():
            ports.append(p.device)
    except Exception:
        pass
    return ports

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
    "GPU":  f"{ANSI.GRN}G{ANSI.RST}",
    "AVR":  f"{ANSI.GRN}A{ANSI.RST}"
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
# Core miner class (CPU + GPU)
# ---------------------------------------------------------------------------
class ChocoMiner:
    def __init__(self, args):
        self.args = args
        self.running = True
        self.stats = {
            "hashes": 0,
            "avr_hashes": 0,
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
        self.token = None  # 🆕 JWT token

        self.gpu_miner = None
        if self.args.gpu and _gpu_available:
            self.gpu_miner = GPUMiner(cl)

        self.arduino = None
        self.arduino_solution = [None]  # mutable container for reader thread
        self._arduino_seen = set()      # (job_id, nonce) already submitted
        # Per-instance identity for independent difficulty tracking
        self.instance_id = os.urandom(4).hex()
        self.effective_worker = f"{self.args.worker}:{self.instance_id}"
        if getattr(self.args, 'arduino_port', None):
            self.arduino = ArduinoBridge(self.args.arduino_port, baud=getattr(self.args, 'arduino_baud', 115200))

    def banner(self):
        parts = []
        if self.args.gpu:
            parts.append(f"{ANSI.GRN}GPU{ANSI.RST}")
        if self.arduino:
            parts.append(f"{ANSI.GRN}AVR({self.arduino.port}){ANSI.RST}")
        if not parts:
            parts.append(f"{ANSI.GRY}CPU only{ANSI.RST}")
        mode_str = " + ".join(parts)
        print(f"""\033[33m\033[1m
  ██████╗██╗  ██╗ ██████╗  ██████╗ ██████╗
 ██╔════╝██║  ██║██╔═══██╗██╔════╝██╔═══██╗
 ██║     ███████║██║   ██║██║     ██║   ██║
 ██║     ██╔══██║██║   ██║██║     ██║   ██║
 ╚██████╗██║  ██║╚██████╔╝╚██████╗╚██████╔╝
  ╚═════╝╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═════╝{ANSI.RST}
{ANSI.YEL}        ⚡ Python miner v2 (GPU ready) ⚡{ANSI.RST}
{ANSI.GRY}    SHA256(hex_last_hash + 20-digit-nonce + worker){ANSI.RST}
{ANSI.CYN}    Mode: {mode_str}{ANSI.RST}
""")

    def _log_fmt(self, level, msg):
        ts = f"{ANSI.GRY}{datetime.now().strftime('%H:%M:%S')}{ANSI.RST}"
        return f"  {ts}  [{ICONS.get(level,'·')}]  {msg}"

    def log(self, level, msg, direct=False):
        if level in ("ERR", "WARN", "WIN", "OK", "GPU", "AVR"):
            formatted = self._log_fmt(level, msg)
            if direct:
                print(formatted)
            else:
                with self.log_lock:
                    self.log_queue.append(formatted)

    def hr_str(self):
        h = self.stats["hashes"] + self.stats.get("avr_hashes", 0)
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
                json={"worker_name": self.args.worker, "instance_id": self.instance_id},
                timeout=5
            )
            if resp.status_code != 200:
                return None
            data = resp.json()
            job_id = data.get('bounty_id') or data.get('job_id')
            last_hash = data.get('last_hash') or data.get('prev_hash')
            target_hex = data.get('target_hex')
            difficulty = float(data.get('difficulty', 1.0))
            reward = data.get('reward', '?')
            if not job_id or not last_hash or not target_hex:
                return None
            return {
                "id": job_id,
                "last_hash": last_hash,
                "target_hex": target_hex,
                "difficulty": difficulty,
                "reward": reward
            }
        except Exception as e:
            self.log("ERR", f"Fetch job error: {e}")
            return None

    def mine_cpu(self, tid, nthreads):
        sha256 = hashlib.sha256
        worker_b = self.effective_worker.encode()
        batch_size = 2000
        local_jid = None
        nonce = tid

        while self.running:
            job = self.stats["current_job"]
            if not job:
                time.sleep(0.2)
                continue

            jid = job["id"]
            lhb = job["last_hash"].encode()          # hex string → bytes (64)
            target_hex = job["target_hex"]

            if jid != local_jid:
                nonce = tid
                local_jid = jid

            while self.running and not self.found_event.is_set() and self.stats["current_job"]["id"] == jid:
                for _ in range(batch_size):
                    nonce_padded = str(nonce).zfill(20)
                    # hash of (hex_last_hash + nonce + worker)
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
        if not self.gpu_miner:
            return
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

            nonce, hashrate, elapsed = self.gpu_miner.solve_job(
                last_hash, target_hex, self.effective_worker,
                gpu_load_percent=90
            )

            if nonce is not None and not self.found_event.is_set():
                if self.stats["current_job"] and self.stats["current_job"]["id"] == jid:
                    # verify with CPU
                    nonce_padded = str(nonce).zfill(20)
                    sha256 = hashlib.sha256
                    worker_b = self.effective_worker.encode()
                    hash_hex = sha256(last_hash.encode() + nonce_padded.encode() + worker_b).hexdigest()
                    if hash_hex < target_hex:
                        self.solution = (jid, nonce, hash_hex)
                        self.found_event.set()
                        self.log("GPU", f"GPU found valid nonce! Nonce: {nonce} (HR: {hashrate/1e3:.2f} KH/s)", direct=True)
                    else:
                        self.log("WARN", f"GPU returned invalid nonce, ignoring", direct=True)

            with self.stats_lock:
                self.stats["hashes"] += int(hashrate * elapsed) if hashrate > 0 else 0

    def authenticate(self):
        """Authenticate with server and store JWT token."""
        try:
            resp = self.session.post(
                f"{self.args.server}/auth",
                json={"username": self.args.worker, "pin": self.args.pin},
                timeout=10
            )
            data = resp.json()
            if resp.status_code == 200 and data.get("status") == "success":
                self.token = data.get("token")
                self.session.headers.update({"Authorization": f"Bearer {self.token}"})
                self.log("OK", f"Authenticated as {ANSI.CYN}{self.args.worker}{ANSI.RST}", direct=True)
                return True
            else:
                self.log("ERR", f"Auth failed: {data.get('message', 'Unknown error')}", direct=True)
                return False
        except Exception as e:
            self.log("ERR", f"Auth error: {e}", direct=True)
            return False

    def register_tier(self):
        """Register the worker's device tier once (with 24h cooldown on server side)."""
        if not self.token:
            return
        tier = getattr(self.args, "tier", None) or "gpu"
        try:
            resp = self.session.post(
                f"{self.args.server}/mining/register-tier",
                json={"tier": tier, "instance_id": self.instance_id},
                timeout=10
            )
            data = resp.json()
            if resp.status_code == 200 and data.get("status") == "success":
                self.log("OK", (
                    f"Tier registered: {ANSI.YEL}{data.get('tier')}{ANSI.RST}  "
                    f"multiplier={ANSI.GRN}{data.get('multiplier')}x{ANSI.RST}  "
                    f"max_diff={data.get('max_difficulty')}"
                ), direct=True)
            else:
                # Cooldown or same tier — not fatal
                self.log("INFO", f"Tier: {data.get('message', tier)}", direct=True)
        except Exception as e:
            self.log("WARN", f"Tier registration skipped: {e}", direct=True)

    def submit(self, bid, nonce, hashrate=0):
        """Submit a solved nonce. Requires JWT (set in session headers)."""
        try:
            r = self.session.post(
                f"{self.args.server}/submit_solution",
                json={
                    "bounty_id": bid,
                    "nonce": nonce,
                    "hashrate_reported": int(hashrate),
                    "instance_id": self.instance_id
                },
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

        # 🆕 Authenticate and get JWT
        if not self.authenticate():
            self.log("ERR", "Cannot mine without authentication. Check --pin.", direct=True)
            return

        # 🆕 Register tier (ignored if cooldown active — server handles it)
        self.register_tier()

        # 🆕 Connect Arduino bridge (if configured)
        if self.arduino:
            try:
                self.arduino.open()
                self.log("AVR", f"Arduino connected: {self.arduino.model} on {self.arduino.port}", direct=True)
                self.arduino.start_reader(self.found_event, self.arduino_solution, self.stats_lock, self.stats)
            except Exception as e:
                self.log("ERR", f"Arduino connection failed: {e}", direct=True)
                self.arduino = None

        threading.Thread(target=self.display_loop, daemon=True).start()
        threading.Thread(target=self.periodic_report, daemon=True).start()

        # In pure AVR mode (arduino present, threads == 0) skip CPU threads entirely
        # so the Arduino doesn't race against the host CPU for the same found_event.
        cpu_threads = self.args.threads if self.args.threads else 0
        if self.arduino and cpu_threads == 0:
            self.log("AVR", "Pure AVR mode — CPU mining disabled", direct=True)
        else:
            for i in range(cpu_threads):
                threading.Thread(target=self.mine_cpu, args=(i, cpu_threads), daemon=True).start()

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
                # Feed job to Arduino bridge immediately
                if self.arduino:
                    # Discard any stale solution from the previous job cycle
                    self.arduino_solution[0] = None
                    self._arduino_seen.clear()
                    self.arduino.send_job(job['id'], job['last_hash'], job['target_hex'], self.effective_worker)
                    self.log("AVR", f"Job {job['id']} sent to Arduino")
            else:
                self.found_event.wait(timeout=0.5)

            # Check Arduino solution (bridge verifies hash on host side)
            if self.arduino and self.arduino_solution[0] is not None:
                jid, nonce, hash_hex = self.arduino_solution[0]
                self.arduino_solution[0] = None
                if (jid, nonce) in self._arduino_seen:
                    continue
                if self.stats["current_job"] and self.stats["current_job"]["id"] == jid:
                    # Host-side SHA-256 verify
                    sha256 = hashlib.sha256
                    lhb = self.stats["current_job"]["last_hash"].encode()
                    worker_b = self.effective_worker.encode()
                    nonce_padded = str(nonce).zfill(20)
                    computed = sha256(lhb + nonce_padded.encode() + worker_b).hexdigest()
                    if computed == hash_hex and hash_hex < self.stats["current_job"]["target_hex"]:
                        self._arduino_seen.add((jid, nonce))
                        self.solution = (jid, nonce, hash_hex)
                        self.found_event.set()
                        self.log("AVR", f"Arduino found valid nonce! Nonce: {nonce}", direct=True)

            if self.solution and self.stats["current_job"]:
                bid, nonce, hx = self.solution
                self.solution = None
                self.found_event.clear()

                # 🆕 Calculate hashrate to report
                elapsed = time.time() - self.stats["start_time"]
                total_hashes = self.stats["hashes"]
                current_hashrate = int(total_hashes / elapsed) if elapsed > 0 else 0

                self.log("WIN", f"Solution found! Nonce: {nonce}  HR: {self.hr_str()}")
                resp = self.submit(bid, nonce, hashrate=current_hashrate)
                if resp.get("status") == "success":
                    with self.stats_lock:
                        self.stats["blocks_found"] += 1
                    reward = resp.get('reward', '?')
                    tier = resp.get('tier', '')
                    mult = resp.get('tier_multiplier', '')
                    self.log("OK", f"Block accepted! +{reward} CC  [{tier} {mult}x]")
                else:
                    reason = resp.get('reason', resp.get('message', 'Unknown'))
                    self.log("WARN", f"Rejected: {reason}")
                    # 🆕 Re-authenticate if token expired
                    if 'token' in str(reason).lower() or resp.get('message') == 'Missing or invalid token':
                        self.log("INFO", "Token expired — re-authenticating...", direct=True)
                        self.authenticate()
                self.stats["current_job"] = None

    def stop(self):
        self.running = False
        if self.gpu_miner:
            self.gpu_miner.cleanup()
        if self.arduino:
            self.arduino.close()
        print(f"\n{ANSI.CLR}")
        avr_h = self.stats.get('avr_hashes', 0)
        total_h = self.stats['hashes'] + avr_h
        self.log("INFO", f"Final stats - Hashes: {total_h:,} (CPU: {self.stats['hashes']:,}, AVR: {avr_h:,}) | Blocks: {self.stats['blocks_found']}", direct=True)

# ---------------------------------------------------------------------------
# Interactive setup
# ---------------------------------------------------------------------------
def interactive_setup():
    global DEFAULT_WORKER, DEFAULT_THREADS, DEFAULT_GPU, DEFAULT_POLL, DEFAULT_ARDUINO_PORT, DEFAULT_ARDUINO_BAUD
    os.system("clear" if os.name != "nt" else "cls")
    print(f"{ANSI.BOLD}{ANSI.CYN}╔══════════════════════════════════════════════════════════╗{ANSI.RST}")
    print(f"{ANSI.BOLD}{ANSI.CYN}║           CHOCOHUB MINER - INTERACTIVE SETUP             ║{ANSI.RST}")
    print(f"{ANSI.BOLD}{ANSI.CYN}╚══════════════════════════════════════════════════════════╝{ANSI.RST}\n")

    # Show loaded config values if they exist
    has_config = os.path.exists(CONFIG_FILE)
    if has_config:
        print(f"  {ANSI.GRY}[Loaded config.txt — press Enter to keep current value]{ANSI.RST}\n")

    while True:
        default_val = f" [{DEFAULT_WORKER}]" if DEFAULT_WORKER else ""
        wrk = input(f"  {ANSI.YEL}➤ Worker name{ANSI.RST}{default_val}: ").strip()
        if wrk:
            DEFAULT_WORKER = wrk
            break
        if DEFAULT_WORKER:
            break  # keep loaded value
        print(f"  {ANSI.RED}Please enter worker name!{ANSI.RST}")

    # PIN for JWT auth
    pin_input = input(f"  {ANSI.YEL}➤ Account PIN{ANSI.RST}: ").strip()
    if not pin_input:
        print(f"  {ANSI.RED}PIN is required for authentication!{ANSI.RST}")
        sys.exit(1)

    print(f"\n  {ANSI.CYN}[?] Select device type (for tier registration):{ANSI.RST}")
    print(f"     1) {ANSI.BLU}Mobile (Android/iOS){ANSI.RST}                  — 1.8x  multiplier")
    print(f"     2) {ANSI.GRN}CPU (desktop/laptop){ANSI.RST}                  — 1.0x  multiplier")
    print(f"     3) {ANSI.MAG}GPU (Nvidia/AMD){ANSI.RST}                      — 1.0x  multiplier")
    print(f"     4) {ANSI.GRN}AVR (Arduino via COM){ANSI.RST}                 — 3.5x  multiplier")
    tier_hint = {"mobile": "1", "cpu": "2", "gpu": "3", "embedded_avr": "4"}.get(DEFAULT_GPU and "gpu" or "cpu", "")
    hint_str = f" [{tier_hint}]" if tier_hint else ""
    dev_choice = input(f"  {ANSI.YEL}➤ Choice (1/2/3/4){ANSI.RST}{hint_str}: ").strip()
    tier_map = {"1": "mobile", "2": "cpu", "3": "gpu", "4": "embedded_avr"}
    selected_tier = tier_map.get(dev_choice, "gpu")
    is_mobile = (dev_choice == "1")
    is_avr = (dev_choice == "4")

    if is_avr:
        # COM port selection
        ports = discover_ports()
        if ports:
            print(f"\n  {ANSI.CYN}Available serial ports:{ANSI.RST}")
            for i, p in enumerate(ports):
                print(f"     {i+1}) {p}")
            port_idx = input(f"  {ANSI.YEL}➤ Select port (1-{len(ports)}){ANSI.RST}: ").strip()
            try:
                DEFAULT_ARDUINO_PORT = ports[int(port_idx) - 1]
            except (ValueError, IndexError):
                DEFAULT_ARDUINO_PORT = input(f"  {ANSI.YEL}➤ Enter COM port manually (e.g. COM3){ANSI.RST}: ").strip()
        else:
            DEFAULT_ARDUINO_PORT = input(f"  {ANSI.YEL}➤ Enter COM port (e.g. COM3){ANSI.RST}: ").strip()
        baud_str = input(f"  {ANSI.YEL}➤ Baud rate{ANSI.RST} [default {DEFAULT_ARDUINO_BAUD}]: ").strip()
        if baud_str:
            try:
                DEFAULT_ARDUINO_BAUD = int(baud_str)
            except ValueError:
                pass
        DEFAULT_GPU = False
        DEFAULT_THREADS = 0  # no CPU threads in pure AVR mode
    else:
        use_gpu = False
        if not is_mobile:
            print(f"\n  {ANSI.CYN}[?] Use GPU for mining?{ANSI.RST}")
            print(f"     1) {ANSI.GRN}CPU only{ANSI.RST}")
            print(f"     2) {ANSI.MAG}CPU + GPU{ANSI.RST}")
            gpu_hint = " [2]" if DEFAULT_GPU else " [1]"
            gpu_choice = input(f"  {ANSI.YEL}➤ Choice (1/2){ANSI.RST}{gpu_hint}: ").strip()
            if not gpu_choice:
                use_gpu = DEFAULT_GPU
            else:
                use_gpu = (gpu_choice == "2")
            DEFAULT_GPU = use_gpu

        suggested = suggest_threads("mobile" if is_mobile else "pc", use_gpu)
        thr_hint = f" [{DEFAULT_THREADS}]" if DEFAULT_THREADS is not None else ""
        thr_input = input(f"\n  {ANSI.YEL}➤ CPU threads{ANSI.RST} (suggested: {suggested}){thr_hint}: ").strip()
        if thr_input:
            try:
                DEFAULT_THREADS = int(thr_input)
            except:
                DEFAULT_THREADS = suggested
        else:
            if DEFAULT_THREADS is None:
                DEFAULT_THREADS = suggested

    poll_hint = f" [{DEFAULT_POLL}]" if DEFAULT_POLL else ""
    poll_input = input(f"\n  {ANSI.YEL}➤ Job poll interval (seconds){ANSI.RST}{poll_hint}: ").strip()
    if poll_input:
        try:
            DEFAULT_POLL = int(poll_input)
        except:
            pass

    print(f"\n{ANSI.GRN}✓ Setup complete!{ANSI.RST}")
    time.sleep(1.5)
    return pin_input, selected_tier

def parse_arguments():
    parser = argparse.ArgumentParser(description="ChocoHub Python Miner with GPU support")
    parser.add_argument("--server", default=DEFAULT_SERVER, help=f"Server URL (default: {DEFAULT_SERVER})")
    parser.add_argument("--worker", default=DEFAULT_WORKER, help="Worker name (login username)")
    parser.add_argument("--pin", default=None, help="Account PIN for JWT authentication (required)")
    parser.add_argument("--tier", default="gpu", help="Device tier: embedded_avr, embedded_arm, embedded_esp, embedded_esp32, mobile, cpu, gpu (default: gpu)")
    parser.add_argument("--threads", type=int, default=DEFAULT_THREADS, help="Number of CPU threads")
    parser.add_argument("--gpu", action="store_true", default=DEFAULT_GPU, help="Enable GPU mining (requires OpenCL)")
    parser.add_argument("--no-gpu", action="store_true", default=False, help="Explicitly disable GPU mining (overrides saved config)")
    parser.add_argument("--arduino-port", default=DEFAULT_ARDUINO_PORT, help="Serial port for Arduino (e.g. COM3 or /dev/ttyACM0)")
    parser.add_argument("--arduino-baud", type=int, default=DEFAULT_ARDUINO_BAUD, help="Arduino serial baud rate (default: 115200)")
    parser.add_argument("--poll", type=int, default=DEFAULT_POLL, help="Job fetch interval in seconds")
    parser.add_argument("--reset", action="store_true", default=False, help="Delete saved config and run fresh interactive setup")
    parser.add_argument("--no-config", action="store_true", default=False, help="Ignore saved config, use defaults (no interactive setup)")
    return parser.parse_args()

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
def main():
    global DEFAULT_SERVER, DEFAULT_WORKER, DEFAULT_THREADS, DEFAULT_GPU, DEFAULT_POLL, DEFAULT_ARDUINO_PORT, DEFAULT_ARDUINO_BAUD

    # Handle --reset: delete config and force fresh setup
    if '--reset' in sys.argv[1:]:
        if os.path.exists(CONFIG_FILE):
            os.remove(CONFIG_FILE)
            print(f"{ANSI.GRN}Config deleted. Starting fresh setup...{ANSI.RST}")
            time.sleep(1)

    config = {} if '--no-config' in sys.argv[1:] else load_config()
    DEFAULT_SERVER        = config.get("server", DEFAULT_SERVER)
    DEFAULT_WORKER        = config.get("worker", DEFAULT_WORKER)
    DEFAULT_THREADS       = config.get("threads", DEFAULT_THREADS)
    DEFAULT_GPU           = config.get("gpu", DEFAULT_GPU)
    DEFAULT_POLL          = config.get("poll", DEFAULT_POLL)
    DEFAULT_ARDUINO_PORT  = config.get("arduino_port", DEFAULT_ARDUINO_PORT)
    DEFAULT_ARDUINO_BAUD  = config.get("arduino_baud", DEFAULT_ARDUINO_BAUD)

    args_passed = sys.argv[1:]
    # Include all meaningful flags so passing them skips interactive setup
    has_essential = any(x in args_passed for x in [
        '--worker', '--threads', '--gpu', '--no-gpu', '--poll',
        '--pin', '--tier', '--arduino-port', '--server'
    ])

    pin_from_setup = None
    tier_from_setup = "embedded_avr" if '--arduino-port' in args_passed else "gpu"

    if not has_essential and sys.stdin.isatty():
        pin_from_setup, tier_from_setup = interactive_setup()
    else:
        if DEFAULT_WORKER is None and '--worker' not in args_passed:
            if sys.stdin.isatty():
                print(f"{ANSI.YEL}No worker name. Enter worker name:{ANSI.RST}")
                DEFAULT_WORKER = input("Worker: ").strip()
            else:
                print(f"{ANSI.RED}Error: Missing --worker parameter when running non-interactive{ANSI.RST}")
                sys.exit(1)

    args = parse_arguments()

    # Handle --no-gpu: override any saved/config GPU value
    if args.no_gpu:
        args.gpu = False

    if args.worker is None:
        print(f"{ANSI.RED}Error: No worker name. Use --worker or run without parameters.{ANSI.RST}")
        sys.exit(1)

    # 🆕 Resolve PIN: CLI > interactive > prompt
    if args.pin is None:
        if pin_from_setup:
            args.pin = pin_from_setup
        elif sys.stdin.isatty():
            import getpass
            args.pin = getpass.getpass(f"  {ANSI.YEL}➤ Account PIN: {ANSI.RST}").strip()
        else:
            print(f"{ANSI.RED}Error: --pin is required for authentication{ANSI.RST}")
            sys.exit(1)

    # 🆕 Resolve tier: auto-detect AVR when arduino port given & no explicit --tier
    if '--tier' not in args_passed:
        args.tier = tier_from_setup

    if args.threads is None:
        # Pure AVR mode: no CPU threads; otherwise pick a sensible default
        if args.arduino_port and not args.gpu:
            args.threads = 0
        else:
            args.threads = suggest_threads("pc", args.gpu)

    ensure_libraries(gpu=args.gpu)
    if args.arduino_port:
        ensure_serial()

    save_config({
        "server": args.server,
        "worker": args.worker,
        "threads": args.threads,
        "gpu": args.gpu,
        "poll": args.poll,
        "tier": args.tier,
        "arduino_port": args.arduino_port,
        "arduino_baud": args.arduino_baud
        # Note: PIN is intentionally NOT saved to config for security
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
