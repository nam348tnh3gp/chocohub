// cpu.js - Web Worker tối ưu SHA-256 (hashrate cao)
let running = false;
let jobData = null;

// SHA-256 implementation thuần JavaScript - tối ưu cho mining
class SHA256 {
    constructor() {
        this.reset();
    }
    
    reset() {
        this.h0 = 0x6a09e667;
        this.h1 = 0xbb67ae85;
        this.h2 = 0x3c6ef372;
        this.h3 = 0xa54ff53a;
        this.h4 = 0x510e527f;
        this.h5 = 0x9b05688c;
        this.h6 = 0x1f83d9ab;
        this.h7 = 0x5be0cd19;
        this.block = new Uint8Array(64);
        this.blockOffset = 0;
        this.length = 0;
    }
    
    update(data) {
        for (let i = 0; i < data.length; i++) {
            this.block[this.blockOffset++] = data[i];
            this.length += 8;
            if (this.blockOffset === 64) {
                this.processBlock();
                this.blockOffset = 0;
            }
        }
    }
    
    pad() {
        // Padding
        this.block[this.blockOffset++] = 0x80;
        if (this.blockOffset > 56) {
            this.block.fill(0, this.blockOffset, 64);
            this.processBlock();
            this.blockOffset = 0;
        }
        this.block.fill(0, this.blockOffset, 56);
        
        // Length in bits (big-endian)
        const len = this.length;
        this.block[56] = (len >>> 24) & 0xFF;
        this.block[57] = (len >>> 16) & 0xFF;
        this.block[58] = (len >>> 8) & 0xFF;
        this.block[59] = len & 0xFF;
        
        this.processBlock();
    }
    
    processBlock() {
        const w = new Uint32Array(64);
        const block32 = new Uint32Array(this.block.buffer);
        
        for (let i = 0; i < 16; i++) {
            w[i] = ((block32[i * 4] << 24) | 
                    (block32[i * 4 + 1] << 16) | 
                    (block32[i * 4 + 2] << 8) | 
                    block32[i * 4 + 3]) >>> 0;
        }
        
        for (let i = 16; i < 64; i++) {
            const s0 = this.rotr(w[i-15], 7) ^ this.rotr(w[i-15], 18) ^ (w[i-15] >>> 3);
            const s1 = this.rotr(w[i-2], 17) ^ this.rotr(w[i-2], 19) ^ (w[i-2] >>> 10);
            w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
        }
        
        let a = this.h0, b = this.h1, c = this.h2, d = this.h3;
        let e = this.h4, f = this.h5, g = this.h6, h = this.h7;
        
        for (let i = 0; i < 64; i++) {
            const S1 = this.rotr(e, 6) ^ this.rotr(e, 11) ^ this.rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = this.rotr(a, 2) ^ this.rotr(a, 13) ^ this.rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) >>> 0;
            
            h = g; g = f; f = e; e = (d + temp1) >>> 0;
            d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        
        this.h0 = (this.h0 + a) >>> 0;
        this.h1 = (this.h1 + b) >>> 0;
        this.h2 = (this.h2 + c) >>> 0;
        this.h3 = (this.h3 + d) >>> 0;
        this.h4 = (this.h4 + e) >>> 0;
        this.h5 = (this.h5 + f) >>> 0;
        this.h6 = (this.h6 + g) >>> 0;
        this.h7 = (this.h7 + h) >>> 0;
    }
    
    rotr(x, n) {
        return (x >>> n) | (x << (32 - n));
    }
    
    digest() {
        this.pad();
        const result = new Uint8Array(32);
        const view = new DataView(result.buffer);
        view.setUint32(0, this.h0);
        view.setUint32(4, this.h1);
        view.setUint32(8, this.h2);
        view.setUint32(12, this.h3);
        view.setUint32(16, this.h4);
        view.setUint32(20, this.h5);
        view.setUint32(24, this.h6);
        view.setUint32(28, this.h7);
        return result;
    }
    
    hexDigest() {
        const hash = this.digest();
        return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
    }
}

// Constants for SHA-256
const K = Uint32Array.from([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

self.onmessage = function(e) {
    if (e.data.type === 'stop') {
        running = false;
        return;
    }
    jobData = e.data;
    running = true;
    mine();
};

function sha256(str) {
    const sha = new SHA256();
    sha.update(new TextEncoder().encode(str));
    return sha.hexDigest();
}

// Cache TextEncoder cho performance
const encoder = new TextEncoder();

function sha256Fast(str) {
    const sha = new SHA256();
    sha.update(encoder.encode(str));
    return sha.hexDigest();
}

function meetsTarget(hashHex, targetBinStr) {
    const bitsRequired = targetBinStr.length;
    const hexLen = Math.ceil(bitsRequired / 4);
    const prefixHex = hashHex.substring(0, hexLen);
    let binFull = '';
    for (let i = 0; i < prefixHex.length; i++) {
        binFull += parseInt(prefixHex[i], 16).toString(2).padStart(4, '0');
    }
    return binFull.startsWith(targetBinStr);
}

function mine() {
    const { last_hash, username, target_bin, bounty_id } = jobData;
    let nonce = jobData.startNonce || 0;
    
    // BATCH SIZE LỚN cho hiệu suất tối đa
    const BATCH = 10000;
    const prefix = last_hash;
    const suffix = username;
    
    while (running) {
        let batchHashes = 0;
        
        for (let i = 0; i < BATCH; i++) {
            if (!running) return;
            
            const input = prefix + nonce + suffix;
            const hashed = sha256Fast(input);
            
            if (meetsTarget(hashed, target_bin)) {
                self.postMessage({ status: 'found', nonce: nonce, bounty_id: bounty_id });
                running = false;
                return;
            }
            
            nonce++;
            batchHashes++;
        }
        
        self.postMessage({ status: 'progress', hashesDone: batchHashes, nonce: nonce });
    }
}
