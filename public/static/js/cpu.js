// cpu.js - TURBO SHA-256 MINER (Ultra Performance) – hỗ trợ target_hex (difficulty float)
(function() {
'use strict';

let running = false;
let bountyId = '';
let targetHex = ''; // thay thế targetBin

// ==================== PRE-COMPUTED DATA ====================
const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0xfc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x6ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);

const HEX = new Array(256);
for (let i = 0; i < 256; i++) {
    HEX[i] = (i >> 4).toString(16) + (i & 15).toString(16);
}

// ==================== FAST SHA-256 ====================
function sha256(msg, msgLen) {
    const H = new Uint32Array(8);
    H[0] = 0x6a09e667; H[1] = 0xbb67ae85;
    H[2] = 0x3c6ef372; H[3] = 0xa54ff53a;
    H[4] = 0x510e527f; H[5] = 0x9b05688c;
    H[6] = 0x1f83d9ab; H[7] = 0x5be0cd19;

    const W = new Uint32Array(64);
    const len = msgLen;
    
    let off = 0;
    while (len - off >= 64) {
        for (let t = 0; t < 16; t++) {
            const idx = off + t * 4;
            W[t] = (msg[idx] << 24) | (msg[idx+1] << 16) | (msg[idx+2] << 8) | msg[idx+3];
        }
        for (let t = 16; t < 64; t++) {
            const w15 = W[t-15], w2 = W[t-2];
            const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
            const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
            W[t] = (W[t-16] + s0 + W[t-7] + s1) | 0;
        }

        let a = H[0], b = H[1], c = H[2], d = H[3],
            e = H[4], f = H[5], g = H[6], h = H[7];

        for (let t = 0; t < 64; t += 8) {
            // Round t
            let S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            let ch = (e & f) ^ (~e & g);
            let temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
            let S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;

            // Round t+1
            S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            ch = (e & f) ^ (~e & g);
            temp1 = (h + S1 + ch + K[t+1] + W[t+1]) | 0;
            S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            maj = (a & b) ^ (a & c) ^ (b & c);
            temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;

            // Round t+2
            S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            ch = (e & f) ^ (~e & g);
            temp1 = (h + S1 + ch + K[t+2] + W[t+2]) | 0;
            S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            maj = (a & b) ^ (a & c) ^ (b & c);
            temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;

            // Round t+3
            S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            ch = (e & f) ^ (~e & g);
            temp1 = (h + S1 + ch + K[t+3] + W[t+3]) | 0;
            S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            maj = (a & b) ^ (a & c) ^ (b & c);
            temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;

            // Round t+4
            S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            ch = (e & f) ^ (~e & g);
            temp1 = (h + S1 + ch + K[t+4] + W[t+4]) | 0;
            S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            maj = (a & b) ^ (a & c) ^ (b & c);
            temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;

            // Round t+5
            S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            ch = (e & f) ^ (~e & g);
            temp1 = (h + S1 + ch + K[t+5] + W[t+5]) | 0;
            S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            maj = (a & b) ^ (a & c) ^ (b & c);
            temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;

            // Round t+6
            S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            ch = (e & f) ^ (~e & g);
            temp1 = (h + S1 + ch + K[t+6] + W[t+6]) | 0;
            S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            maj = (a & b) ^ (a & c) ^ (b & c);
            temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;

            // Round t+7
            S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            ch = (e & f) ^ (~e & g);
            temp1 = (h + S1 + ch + K[t+7] + W[t+7]) | 0;
            S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            maj = (a & b) ^ (a & c) ^ (b & c);
            temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }

        H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
        H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
        H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
        off += 64;
    }

    const hash = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
        const s = H[i];
        hash[i*4] = (s >>> 24) & 255;
        hash[i*4+1] = (s >>> 16) & 255;
        hash[i*4+2] = (s >>> 8) & 255;
        hash[i*4+3] = s & 255;
    }
    return hash;
}

// ==================== MINING CORE ====================
let inputBuffer;
let lastHashStr, usernameStr;
let prefixBytes, suffixBytes;
let bufferLen;

function initJob(lastHash, username, targetHexStr, bid) {
    lastHashStr = lastHash;
    usernameStr = username;
    targetHex = targetHexStr;   // Lưu target dạng hex
    bountyId = bid;

    const enc = new TextEncoder();
    prefixBytes = enc.encode(lastHash);
    suffixBytes = enc.encode(username);
    
    bufferLen = prefixBytes.length + 20 + suffixBytes.length;
    inputBuffer = new Uint8Array(bufferLen);
    inputBuffer.set(prefixBytes, 0);
    inputBuffer.set(suffixBytes, prefixBytes.length + 20);
    
    const nonceStart = prefixBytes.length;
    for (let i = 0; i < 20; i++) {
        inputBuffer[nonceStart + i] = 48; // '0'
    }
}

function writeNonce(n) {
    const buf = inputBuffer;
    let pos = prefixBytes.length + 19;
    
    if (n < 10) {
        buf[pos] = 48 + n;
        return pos;
    }
    
    while (n > 0 && pos >= prefixBytes.length) {
        buf[pos--] = 48 + (n % 10);
        n = (n / 10) | 0;
    }
    return pos + 1;
}

// ==================== TARGET VERIFICATION (HEX COMPARISON) ====================
function meetsTarget(hashBytes) {
    // Chuyển hashBytes thành chuỗi hex 64 ký tự
    let hex = '';
    for (let i = 0; i < 32; i++) {
        hex += HEX[hashBytes[i]];
    }
    // So sánh trực tiếp chuỗi hex
    return hex < targetHex;
}

function formatHash(bytes) {
    let hex = '';
    for (let i = 0; i < 32; i++) {
        hex += HEX[bytes[i]];
    }
    return hex;
}

// ==================== MINING LOOP ====================
function mine() {
    let nonce = 0;
    let batchSize = 50000;
    const TARGET_MS = 45;
    
    while (running) {
        const start = performance.now();
        let hashes = 0;
        
        for (let i = 0; i < batchSize && running; i++, hashes++) {
            const startIdx = writeNonce(nonce);
            const msgLen = bufferLen - (startIdx - prefixBytes.length);
            
            const hashBytes = sha256(inputBuffer.subarray(0, bufferLen), msgLen);
            
            if (meetsTarget(hashBytes)) {
                const hexHash = formatHash(hashBytes);
                self.postMessage({
                    type: 'found',
                    nonce: nonce,
                    hash: hexHash,
                    bounty_id: bountyId
                });
                running = false;
                return;
            }
            nonce++;
        }
        
        self.postMessage({
            type: 'progress',
            nonce: nonce,
            hashes: hashes
        });
        
        const elapsed = performance.now() - start;
        if (elapsed > TARGET_MS && batchSize > 5000) {
            batchSize = Math.max(5000, Math.floor(batchSize * 0.75));
        } else if (elapsed < TARGET_MS * 0.5 && batchSize < 500000) {
            batchSize = Math.min(500000, Math.floor(batchSize * 1.5));
        }
        
        if (running) {
            setTimeout(mine, 0);
            return;
        }
    }
}

// ==================== MESSAGE HANDLER ====================
self.onmessage = function(e) {
    switch(e.data.type) {
        case 'start':
            if (!running) {
                // Nhận target_hex thay vì target_bin
                initJob(e.data.last_hash, e.data.username, e.data.target_hex, e.data.bounty_id);
                running = true;
                setTimeout(mine, 0);
            }
            break;
        case 'stop':
            running = false;
            break;
        case 'ping':
            self.postMessage({ type: 'pong' });
            break;
    }
};

self.postMessage({ type: 'ready' });

})();
