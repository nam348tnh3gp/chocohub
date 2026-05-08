// cpu.js - Web Worker tương thích MỌI BROWSER
(function() {
'use strict';

let running = false;
let jobData = null;

// ==================== SHA-256 CORE - PURE JS ====================
class SHA256 {
    constructor() {
        this.state = new Uint32Array(8);
        this.w = new Uint32Array(64);
        this.buffer = new Uint8Array(64);
        this.bufferLen = 0;
        this.totalLen = 0;
        this.reset();
    }
    
    reset() {
        this.state[0] = 0x6a09e667;
        this.state[1] = 0xbb67ae85;
        this.state[2] = 0x3c6ef372;
        this.state[3] = 0xa54ff53a;
        this.state[4] = 0x510e527f;
        this.state[5] = 0x9b05688c;
        this.state[6] = 0x1f83d9ab;
        this.state[7] = 0x5be0cd19;
        this.bufferLen = 0;
        this.totalLen = 0;
        return this;
    }
    
    update(data, len) {
        for (let i = 0; i < len; i++) {
            this.buffer[this.bufferLen++] = data[i];
            this.totalLen++;
            if (this.bufferLen === 64) {
                this._processBlock(this.buffer, 0);
                this.bufferLen = 0;
            }
        }
    }
    
    digest() {
        // Padding
        const buffer = this.buffer;
        const bufferLen = this.bufferLen;
        buffer[bufferLen] = 0x80;
        
        if (bufferLen >= 56) {
            for (let i = bufferLen + 1; i < 64; i++) buffer[i] = 0;
            this._processBlock(buffer, 0);
            this.bufferLen = 0;
        }
        
        for (let i = this.bufferLen; i < 56; i++) buffer[i] = 0;
        
        const bitLen = this.totalLen * 8;
        buffer[56] = (bitLen >>> 24) & 0xFF;
        buffer[57] = (bitLen >>> 16) & 0xFF;
        buffer[58] = (bitLen >>> 8) & 0xFF;
        buffer[59] = bitLen & 0xFF;
        
        this._processBlock(buffer, 0);
        
        const result = new Uint8Array(32);
        const view = new DataView(result.buffer);
        for (let i = 0; i < 8; i++) {
            view.setUint32(i * 4, this.state[i], false);
        }
        return result;
    }
    
    _processBlock(block, offset) {
        const w = this.w;
        const view = new DataView(block.buffer || block, offset);
        
        for (let i = 0; i < 16; i++) {
            w[i] = view.getUint32(i * 4, false);
        }
        
        for (let i = 16; i < 64; i++) {
            const w15 = w[i-15], w2 = w[i-2];
            const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
            const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
            w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
        }
        
        let a = this.state[0], b = this.state[1], c = this.state[2], d = this.state[3];
        let e = this.state[4], f = this.state[5], g = this.state[6], h = this.state[7];
        
        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K_TABLE[i] + w[i]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;
            
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        
        this.state[0] = (this.state[0] + a) | 0;
        this.state[1] = (this.state[1] + b) | 0;
        this.state[2] = (this.state[2] + c) | 0;
        this.state[3] = (this.state[3] + d) | 0;
        this.state[4] = (this.state[4] + e) | 0;
        this.state[5] = (this.state[5] + f) | 0;
        this.state[6] = (this.state[6] + g) | 0;
        this.state[7] = (this.state[7] + h) | 0;
    }
}

// ==================== CONSTANTS ====================
const K_TABLE = new Uint32Array([
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
]);

// ==================== PRE-COMPUTED HEX TABLE ====================
const HEX_CHARS = '0123456789abcdef';
const HEX = new Array(256);
for (let i = 0; i < 256; i++) {
    HEX[i] = HEX_CHARS[i >> 4] + HEX_CHARS[i & 0xf];
}

// ==================== TEXT ENCODER POLYFILL ====================
let textEncoder;
try {
    textEncoder = new TextEncoder();
} catch(e) {
    // Polyfill cho browser cũ
    textEncoder = {
        encode: function(str) {
            const len = str.length;
            const bytes = new Uint8Array(len * 3);
            let pos = 0;
            for (let i = 0; i < len; i++) {
                let c = str.charCodeAt(i);
                if (c < 0x80) {
                    bytes[pos++] = c;
                } else if (c < 0x800) {
                    bytes[pos++] = 0xc0 | (c >> 6);
                    bytes[pos++] = 0x80 | (c & 0x3f);
                } else {
                    bytes[pos++] = 0xe0 | (c >> 12);
                    bytes[pos++] = 0x80 | ((c >> 6) & 0x3f);
                    bytes[pos++] = 0x80 | (c & 0x3f);
                }
            }
            return bytes.slice(0, pos);
        }
    };
}

// ==================== MINING CORE ====================
const hasher = new SHA256();
let prefixBytes, suffixBytes, targetBinStr, bountyId;
let inputBuffer, prefixLen, suffixLen, bufferLen;

function initJob(last_hash, username, target_bin, bounty_id) {
    prefixBytes = textEncoder.encode(last_hash);
    suffixBytes = textEncoder.encode(username);
    targetBinStr = target_bin;
    bountyId = bounty_id;
    
    prefixLen = prefixBytes.length;
    suffixLen = suffixBytes.length;
    bufferLen = prefixLen + 20 + suffixLen;
    
    inputBuffer = new Uint8Array(bufferLen);
    inputBuffer.set(prefixBytes);
    inputBuffer.set(suffixBytes, prefixLen + 20);
}

// Inline nonce conversion - siêu nhanh
function writeNonce(nonce) {
    let n = nonce;
    let pos = prefixLen + 19;
    if (n === 0) {
        inputBuffer[pos] = 48; // '0'
        return pos;
    }
    while (n > 0) {
        inputBuffer[pos--] = 48 + (n % 10);
        n = (n / 10) | 0;
    }
    return pos + 1;
}

// Fast target check
function verifyHash(hashBytes) {
    // Check từng byte
    const bitLen = targetBinStr.length;
    
    for (let i = 0; i < bitLen; i++) {
        const byteIdx = i >>> 3;
        const bitIdx = 7 - (i & 7);
        const bit = (hashBytes[byteIdx] >>> bitIdx) & 1;
        const expected = targetBinStr.charCodeAt(i) - 48; // '0'=48, '1'=49
        if (bit !== expected) {
            return bit < expected; // true nếu nhỏ hơn target (valid)
        }
    }
    return true; // bằng nhau cũng valid
}

function mine() {
    let nonce = jobData.startNonce || 0;
    
    // Batch size động - điều chỉnh theo performance
    const BATCH_SIZE = 10000;
    
    while (running) {
        let count = 0;
        
        for (let i = 0; i < BATCH_SIZE; i++) {
            if (!running) return;
            
            const start = writeNonce(nonce);
            const len = prefixLen + (prefixLen + 20 - start) + suffixLen;
            
            hasher.reset();
            hasher.update(inputBuffer, len);
            const hashBytes = hasher.digest();
            
            if (verifyHash(hashBytes)) {
                const hex = Array.from(hashBytes, b => HEX[b]).join('');
                self.postMessage({
                    type: 'found',
                    nonce: nonce,
                    hash: hex,
                    bounty_id: bountyId
                });
                running = false;
                return;
            }
            
            nonce++;
            count++;
        }
        
        // Report progress - không block main thread quá lâu
        self.postMessage({
            type: 'progress',
            nonce: nonce,
            hashes: count
        });
        
        // Yield cho browser breathing room
        if (count < BATCH_SIZE) {
            setTimeout(function() { if (running) mine(); }, 0);
            return;
        }
    }
}

// ==================== MESSAGE HANDLER ====================
self.onmessage = function(e) {
    const msg = e.data;
    
    switch(msg.type) {
        case 'start':
            running = true;
            initJob(msg.last_hash, msg.username, msg.target_bin, msg.bounty_id);
            jobData = msg;
            mine();
            break;
            
        case 'stop':
            running = false;
            break;
            
        case 'ping':
            self.postMessage({ type: 'pong' });
            break;
    }
};

// Report ready
self.postMessage({ type: 'ready' });

})();
