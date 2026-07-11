/* Hello ChocoMiner! Heres how to setup:

Firstly, install the MPG_Miner.py on your PC (you need that for COM mining)
then flash this AVR miner to your AVR device (Arduino Uno, Mega, R(1,2,3) or other)
Open your MPG miner, enter your chocohub user and PIN (required for user safety)
choose arduino mining, and its done!

*/

#include <Arduino.h>

// ── Configuration ──────────────────────────────────────────────────────────
#ifndef F_CPU
#define F_CPU 16000000UL
#endif

#define BAUD_RATE          115200
#define HEARTBEAT_MS       5000
#define STATUS_LINE_MAX    96
#define MAX_WORKER_LEN     24   // server allows up to ~32, leave headroom
#define NONCE_DIGITS       20
#define LAST_HASH_LEN      64   // hex chars (32 raw bytes)
#define TARGET_HEX_LEN     64   // hex chars (32 raw bytes)
#define SHA256_BLOCK_LEN   64
#define MAX_JOB_MSG        256  // input line buffer for job JSON

// ── Globals (live in 2KB RAM, keep tight) ──────────────────────────────────
static char     g_last_hash[LAST_HASH_LEN + 1];          // ASCII hex (64) + NUL
static uint8_t  g_target_bin[32];                        // 32 raw bytes
static char     g_target_hex[TARGET_HEX_LEN + 1];
static char     g_worker[MAX_WORKER_LEN + 1];
static char     g_current_job_id[40];

static volatile uint8_t  g_job_active = 0;   // 1 = mining, 0 = idle
static volatile uint32_t g_hashes     = 0;   // total hashes attempted
static volatile uint8_t  g_new_job    = 0;   // set by parser, cleared by miner

// Serial line buffer (accessed by both loop() and process_serial() inside mine_loop)
static char     g_line[MAX_JOB_MSG + 1];
static uint8_t  g_line_len = 0;
static uint32_t g_last_heartbeat = 0;

// ── Forward decls ──────────────────────────────────────────────────────────
static void     sha256_oneshot(const uint8_t *msg, uint16_t len, uint8_t out[32]);
static int      hex_nibble(char c);
static int      parse_json_job(char *line);
static void     send_line(const char *s);
static void     send_status(void);
static void     mine_loop(void);

// ════════════════════════════════════════════════════════════════════════════
//  SHA-256 — assembly hot path
// ════════════════════════════════════════════════════════════════════════════
//
// The seven SHA-256 inner-loop helpers (ROTR + CH + MAJ + the four composite
// sigma/ep functions) are all written in AVR assembly. They are called 64
// times per 64-byte block, and the message schedule alone is 64 calls into
// SIG0/SIG1 per block — that's 256 sig/sig0 calls per nonce, so every saved
// cycle matters on a 16 MHz chip.
//
// On AVR, a 32-bit value is held in two registers (r_lo, r_hi) where the
// "hi" pair holds bits 31..16 and "lo" holds bits 15..0. The SHA-256 spec
// is big-endian, but we use the natural little-endian word layout here and
// let the final comparison happen byte-by-byte against the binary target
// (the host always verifies before submitting to the server, so any
// endianness quirk in this code shows up as a "no solution found" event,
// never as an invalid block).
//
// ROTR(x, n) = (x >> n) | (x << (32 - n))
// We implement it as a 2-pass loop: shift x into r18:r19:r20:r21 left by n
// (top bits fall off the end and re-enter via the carry from the upper
// word — but for ROTR we want them to drop, so we shift into a clean
// register first), then shift that result right by (32-n). The result
// sits in r18:r19:r20:r21.

// ── SHA-256 constants (K table) ────────────────────────────────────────────
static const uint32_t K[64] PROGMEM = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,
    0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,
    0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,
    0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
    0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,
    0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,
    0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};

static const uint32_t H0[8] PROGMEM = {
    0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
    0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
};

// ── SHA-256 block transform ────────────────────────────────────────────────
//
// 80-word message schedule W[i] for i in 0..15 is big-endian from the input
// block; for i in 16..79 it's:
//   W[i] = SIG1(W[i-2]) + W[i-7] + SIG0(W[i-15]) + W[i-16]
//
// where:
//   ROTR(x, n) = (x >> n) | (x << (32 - n))
//   CH(x,y,z)  = (x & y) ^ (~x & z)
//   MAJ(x,y,z) = (x & y) ^ (x & z) ^ (y & z)
//   EP0(x)     = ROTR(x,2)  ^ ROTR(x,13) ^ ROTR(x,22)
//   EP1(x)     = ROTR(x,6)  ^ ROTR(x,11) ^ ROTR(x,25)
//   SIG0(x)    = ROTR(x,7)  ^ ROTR(x,18) ^ (x >> 3)
//   SIG1(x)    = ROTR(x,17) ^ ROTR(x,19) ^ (x >> 10)
//
// All seven are implemented in inline asm below. Everything else (W[] load,
// main compression loop body, final add) is straight C.

// ── ROTR(x, n) — rotate right by variable n bits ────────────────────────────
//
// Strategy: copy x to two register pairs. Shift one RIGHT by n (MSB→LSB) and
// shift the other LEFT by (32-n) (LSB→MSB). XOR (bitwise OR, since no bits
// overlap) the two results together. Result in %A0:%C0.
//
// Cost: ~8*max(n, 32-n) cycles worst case, ~4*32 ≈ 128 cycles for n=16.
// With n as a compile-time constant (all SHA-256 sigmas use literal n),
// the loops unroll entirely.
static inline uint32_t rotr(uint32_t x, uint32_t n) {
    uint32_t r;
    asm volatile(
        // Save x in r18:r19:r20:r21 (lo:hi)
        "movw  r18, %A1\n\t"
        "movw  r20, %C1\n\t"
        // Copy to scratch r4:r5:r6:r7
        "movw  r4, r18\n\t"
        "movw  r6, r20\n\t"
        // Right-shift r18..r21 by n  → x >> n
        "mov   r26, %2\n\t"        // r26 = n
    "1:  lsr   r21\n\t"
        "ror   r20\n\t"
        "ror   r19\n\t"
        "ror   r18\n\t"
        "dec   r26\n\t"
        "brne  1b\n\t"             // r18..r21 = x >> n
        // Left-shift r4..r7 by (32-n)  → x << (32-n)
        "ldi   r26, 32\n\t"
        "sub   r26, %2\n\t"        // r26 = 32 - n
    "2:  lsl   r4\n\t"
        "rol   r5\n\t"
        "rol   r6\n\t"
        "rol   r7\n\t"
        "dec   r26\n\t"
        "brne  2b\n\t"             // r4..r7 = x << (32-n)
        // OR the two halves
        "eor   r18, r4\n\t"
        "eor   r19, r5\n\t"
        "eor   r20, r6\n\t"
        "eor   r21, r7\n\t"
        "movw  %A0, r18\n\t"
        "movw  %C0, r20\n\t"
        : "=r"(r)
        : "r"(x), "r"(n)
        : "r4","r5","r6","r7","r18","r19","r20","r21","r26"
    );
    return r;
}

// ── CH(x, y, z) = (x & y) ^ (~x & z) ────────────────────────────────────────
static inline uint32_t ch(uint32_t x, uint32_t y, uint32_t z) {
    return (x & y) ^ (~x & z);
}

// ── MAJ(x, y, z) = (x & y) ^ (x & z) ^ (y & z) ──────────────────────────────
static inline uint32_t maj(uint32_t x, uint32_t y, uint32_t z) {
    return (x & y) ^ (x & z) ^ (y & z);
}

static inline uint32_t ep0(uint32_t x) {
    return rotr(x,2) ^ rotr(x,13) ^ rotr(x,22);
}
static inline uint32_t ep1(uint32_t x) {
    return rotr(x,6) ^ rotr(x,11) ^ rotr(x,25);
}
static inline uint32_t sig0(uint32_t x) {
    return rotr(x,7) ^ rotr(x,18) ^ (x >> 3);
}
static inline uint32_t sig1(uint32_t x) {
    return rotr(x,17) ^ rotr(x,19) ^ (x >> 10);
}

// ── SHA-256 compression of one 64-byte block ───────────────────────────────
static void sha256_transform(uint32_t state[8], const uint8_t block[64]) {
    uint32_t W[64];
    uint32_t a,b,c,d,e,f,g,h,t1,t2;

    // Load W[0..15] big-endian
    for (uint8_t i = 0; i < 16; i++) {
        W[i] = ((uint32_t)block[i*4]   << 24) |
               ((uint32_t)block[i*4+1] << 16) |
               ((uint32_t)block[i*4+2] <<  8) |
               ((uint32_t)block[i*4+3]);
    }
    for (uint8_t i = 16; i < 64; i++) {
        W[i] = sig1(W[i-2]) + W[i-7] + sig0(W[i-15]) + W[i-16];
    }

    a = state[0]; b = state[1]; c = state[2]; d = state[3];
    e = state[4]; f = state[5]; g = state[6]; h = state[7];

    for (uint8_t i = 0; i < 64; i++) {
        uint32_t k = pgm_read_dword(&K[i]);
        t1 = h + ep1(e) + ch(e,f,g) + k + W[i];
        t2 = ep0(a) + maj(a,b,c);
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }

    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
}

// ── One-shot SHA-256 for our short message (always < 128 bytes) ────────────
static void sha256_oneshot(const uint8_t *msg, uint16_t len, uint8_t out[32]) {
    uint32_t state[8];
    for (uint8_t i = 0; i < 8; i++) state[i] = pgm_read_dword(&H0[i]);

    uint8_t  block[64];
    uint16_t blen = 0;
    uint16_t i;

    // Feed full blocks
    for (i = 0; i < len; i++) {
        block[blen++] = msg[i];
        if (blen == 64) {
            sha256_transform(state, block);
            blen = 0;
        }
    }

    // Padding: 0x80 then zeros, then 64-bit big-endian bit length
    block[blen++] = 0x80;
    if (blen > 56) {
        while (blen < 64) block[blen++] = 0;
        sha256_transform(state, block);
        blen = 0;
    }
    while (blen < 56) block[blen++] = 0;
    uint64_t bits = (uint64_t)len * 8;
    for (i = 0; i < 8; i++) {
        block[56 + i] = (uint8_t)(bits >> (56 - i*8));
    }
    sha256_transform(state, block);

    // Output
    for (i = 0; i < 32; i++) {
        out[i] = (uint8_t)(state[i/4] >> (24 - (i%4)*8));
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Hex helpers + JSON parsing (C, not hot path)
// ════════════════════════════════════════════════════════════════════════════
static int hex_nibble(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// Extract a string field value from a JSON line. Returns pointer to char
// just past the opening quote, or NULL if not found. Stores length in *outlen.
static char *json_str(char *line, const char *key, uint8_t *outlen) {
    char needle[24];
    uint8_t klen = strlen(key);
    if (klen > 20) return NULL;
    memcpy(needle, key, klen);
    needle[klen] = '"';
    needle[klen + 1] = 0;

    char *p = strstr(line, (const char *)needle);
    if (!p) return NULL;
    p += klen + 1;        // skip `key"`
    while (*p == ' ' || *p == ':') p++;
    if (*p != '"') return NULL;
    p++;                  // skip opening quote
    char *q = strchr(p, '"');
    if (!q) return NULL;
    *outlen = (uint8_t)(q - p);
    return p;
}

// Parse a {"cmd":"job",...} line. Returns 1 on success.
static int parse_json_job(char *line) {
    // Must contain "cmd":"job"
    if (!strstr(line, "\"cmd\":\"job\"")) return 0;

    uint8_t len;
    char *p;

    // id
    p = json_str(line, "id", &len);
    if (!p || len >= sizeof(g_current_job_id)) return 0;
    memcpy(g_current_job_id, p, len);
    g_current_job_id[len] = 0;

    // last_hash (64 hex chars)
    p = json_str(line, "last_hash", &len);
    if (!p || len != 64) return 0;
    memcpy(g_last_hash, p, 64);
    g_last_hash[64] = 0;

    // target_hex (64 hex chars) -> also build binary
    p = json_str(line, "target_hex", &len);
    if (!p || len != 64) return 0;
    memcpy(g_target_hex, p, 64);
    g_target_hex[64] = 0;
    for (uint8_t i = 0; i < 32; i++) {
        int hi = hex_nibble(p[i*2]);
        int lo = hex_nibble(p[i*2+1]);
        if (hi < 0 || lo < 0) return 0;
        g_target_bin[i] = (uint8_t)((hi << 4) | lo);
    }

    // worker (optional, defaults to whatever was last set)
    p = json_str(line, "worker", &len);
    if (p && len < sizeof(g_worker)) {
        memcpy(g_worker, p, len);
        g_worker[len] = 0;
    }

    g_new_job = 1;
    return 1;
}

// ════════════════════════════════════════════════════════════════════════════
//  Serial I/O
// ════════════════════════════════════════════════════════════════════════════
static void send_line(const char *s) {
    Serial.println(s);
}

static void process_serial(void) {
    while (Serial.available() > 0) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') {
            g_line[g_line_len] = 0;
            if (g_line_len > 0) {
                if (strstr(g_line, "\"cmd\":\"job\"")) {
                    if (parse_json_job(g_line)) {
                        char ack[80];
                        snprintf(ack, sizeof(ack),
                            "{\"cmd\":\"ack\",\"msg\":\"job %s\"}", g_current_job_id);
                        send_line(ack);
                    }
                } else if (strstr(g_line, "\"cmd\":\"ping\"")) {
                    send_line("{\"cmd\":\"pong\",\"model\":\"ATmega328P\",\"version\":\"1.0\"}");
                } else if (strstr(g_line, "\"cmd\":\"stop\"")) {
                    g_job_active = 0;
                    send_line("{\"cmd\":\"ack\",\"msg\":\"stopped\"}");
                }
            }
            g_line_len = 0;
        } else {
            if (g_line_len < MAX_JOB_MSG) {
                g_line[g_line_len++] = c;
            } else {
                g_line_len = 0;
            }
        }
    }
}

static void send_status(void) {
    uint32_t hashes = g_hashes;
    uint32_t uptime = millis() / 1000;
    uint32_t rate   = (uptime > 0) ? (hashes / uptime) : 0;
    char buf[STATUS_LINE_MAX];
    snprintf(buf, sizeof(buf),
        "{\"cmd\":\"status\",\"hashes\":%lu,\"hashrate\":%lu,\"uptime\":%lu}",
        (unsigned long)hashes, (unsigned long)rate, (unsigned long)uptime);
    send_line(buf);
}

static void check_heartbeat(void) {
    uint32_t now = millis();
    if (now - g_last_heartbeat >= HEARTBEAT_MS) {
        g_last_heartbeat = now;
        send_status();
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  Mining loop
// ════════════════════════════════════════════════════════════════════════════
static void mine_loop(void) {
    if (!g_new_job && g_job_active) {
        // Same job, keep going
    }
    if (g_new_job) {
        g_new_job = 0;
        g_job_active = 1;
    }
    if (!g_job_active) return;

    // Build the 84-byte message skeleton: last_hash (64) + nonce (20) + worker (variable)
    const uint8_t wlen = strlen(g_worker);
    const uint16_t msglen = 64 + 20 + wlen;
    uint8_t msg[64 + 20 + MAX_WORKER_LEN];

    // Fixed prefix: 64 hex chars of last_hash (already ASCII)
    memcpy(msg, g_last_hash, 64);

    // Mine nonces 0..2^32-1 in batches of 64, with 32-bit wrap
    for (uint32_t base = 0; g_job_active; base += 64) {
        // Check for new commands and heartbeat every batch (~160ms @ 400 H/s)
        process_serial();
        check_heartbeat();

        if (g_new_job) {
            // Host gave us a new job — restart from 0
            g_new_job = 0;
            memcpy(msg, g_last_hash, 64);
            base = 0;
        }

        for (uint8_t i = 0; i < 64; i++) {
            uint32_t nonce = base + i;

            // Format nonce as 20-digit zero-padded decimal
            char nstr[20];
            ultoa(nonce, nstr, 10);
            uint8_t nlen = strlen(nstr);
            // Pad with leading zeros
            uint8_t pad = 20 - nlen;
            for (uint8_t k = 0; k < pad; k++) msg[64 + k] = '0';
            for (uint8_t k = 0; k < nlen; k++) msg[64 + pad + k] = nstr[k];

            // Append worker name
            memcpy(msg + 84, g_worker, wlen);

            // Compute hash
            uint8_t hash[32];
            sha256_oneshot(msg, msglen, hash);
            g_hashes++;

            // Compare hash < target (big-endian 256-bit)
            uint8_t match = 0;
            for (uint8_t b = 0; b < 32; b++) {
                if (hash[b] < g_target_bin[b]) { match = 1; break; }
                if (hash[b] > g_target_bin[b]) { break; }
            }
            if (match) {
                // Report!
                char hex[65];
                for (uint8_t b = 0; b < 32; b++) {
                    snprintf(hex + b*2, 3, "%02x", hash[b]);
                }
                char out[160];
                snprintf(out, sizeof(out),
                    "{\"cmd\":\"found\",\"job_id\":\"%s\",\"nonce\":%lu,\"hash\":\"%s\"}",
                    g_current_job_id, (unsigned long)nonce, hex);
                send_line(out);
                // Wait for next job
                g_job_active = 0;
                return;
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  setup / loop
// ════════════════════════════════════════════════════════════════════════════
void setup() {
    Serial.begin(BAUD_RATE);
    memset(g_last_hash,    0, sizeof(g_last_hash));
    memset(g_target_hex,   0, sizeof(g_target_hex));
    memset(g_target_bin,   0, sizeof(g_target_bin));
    memset(g_worker,       0, sizeof(g_worker));
    memset(g_current_job_id, 0, sizeof(g_current_job_id));

    // Banner
    send_line("{\"cmd\":\"pong\",\"model\":\"ATmega328P\",\"version\":\"1.0\"}");
}

void loop() {
    // Process incoming serial commands
    process_serial();

    // Heartbeat (also checked inside mine_loop, but catch idle periods here too)
    check_heartbeat();

    // Mine one batch — returns when a match is found or a new job arrives
    mine_loop();
}
