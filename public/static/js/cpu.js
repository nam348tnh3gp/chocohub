// cpu.js – SHA-256 tối ưu tốc độ (batch processing, tái sử dụng buffer) – hỗ trợ server blockchain mới
(function() {
'use strict';

let running = false;
let jobId = '';                 // có thể là bounty_id hoặc job_id
let targetBytes = null;         // target dạng Uint8Array (32 bytes)
let prefixBytes, suffixBytes;
let nonceBytes = new Uint8Array(20);
let miningNonce = 0;
let inputBuffer = null;         // buffer tái sử dụng, chỉ cập nhật nonce

// Bảng K SHA-256
const K = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);

// SHA-256 cho một message (Uint8Array) trả về hash Uint8Array
function sha256(msg) {
    const ml = msg.length;
    const newLen = ((ml + 8 + 63) >> 6) << 6;
    const buf = new Uint8Array(newLen);
    buf.set(msg);
    buf[ml] = 0x80;
    const bitLen = ml * 8;
    const view = new DataView(buf.buffer);
    view.setUint32(newLen - 4, bitLen, false);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                               0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let offset = 0; offset < newLen; offset += 64) {
        for (let t = 0; t < 16; t++) {
            const i = offset + t*4;
            W[t] = (buf[i]<<24)|(buf[i+1]<<16)|(buf[i+2]<<8)|buf[i+3];
        }
        for (let t = 16; t < 64; t++) {
            const w15 = W[t-15], w2 = W[t-2];
            const s0 = ((w15>>>7)|(w15<<25)) ^ ((w15>>>18)|(w15<<14)) ^ (w15>>>3);
            const s1 = ((w2>>>17)|(w2<<15)) ^ ((w2>>>19)|(w2<<13)) ^ (w2>>>10);
            W[t] = (W[t-16] + s0 + W[t-7] + s1) | 0;
        }
        let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
        for (let t=0; t<64; t++) {
            const S1 = ((e>>>6)|(e<<26)) ^ ((e>>>11)|(e<<21)) ^ ((e>>>25)|(e<<7));
            const ch = (e&f) ^ (~e&g);
            const temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
            const S0 = ((a>>>2)|(a<<30)) ^ ((a>>>13)|(a<<19)) ^ ((a>>>22)|(a<<10));
            const maj = (a&b) ^ (a&c) ^ (b&c);
            const temp2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        H[0] = (H[0]+a)|0; H[1] = (H[1]+b)|0; H[2] = (H[2]+c)|0; H[3] = (H[3]+d)|0;
        H[4] = (H[4]+e)|0; H[5] = (H[5]+f)|0; H[6] = (H[6]+g)|0; H[7] = (H[7]+h)|0;
    }
    const hash = new Uint8Array(32);
    for (let i=0; i<8; i++) {
        hash[i*4] = H[i]>>>24;
        hash[i*4+1] = H[i]>>>16 & 0xFF;
        hash[i*4+2] = H[i]>>>8 & 0xFF;
        hash[i*4+3] = H[i] & 0xFF;
    }
    return hash;
}

// So sánh hash với target (dạng Uint8Array) nhanh hơn
function meetsTargetFast(hash) {
    for (let i = 0; i < 32; i++) {
        if (hash[i] !== targetBytes[i]) {
            return hash[i] < targetBytes[i];
        }
    }
    return true; // bằng nhau (trường hợp rất hiếm)
}

// Ghi nonce vào nonceBytes (ASCII decimal, 20 ký tự, căn phải)
function setNonce(nonce) {
    const s = nonce.toString();
    const len = s.length;
    const start = 20 - len;
    for (let i = 0; i < start; i++) nonceBytes[i] = 48; // '0'
    for (let i = 0; i < len; i++) nonceBytes[start + i] = s.charCodeAt(i);
}

// Tạo input buffer cố định (chưa điền nonce)
function buildInputBuffer() {
    const total = prefixBytes.length + 20 + suffixBytes.length;
    const buf = new Uint8Array(total);
    buf.set(prefixBytes, 0);
    buf.set(suffixBytes, prefixBytes.length + 20);
    return buf;
}

// Mining loop batch
function mineBatch() {
    if (!running) return;
    const BATCH_SIZE = 5000;
    let hashes = 0;
    const startTime = performance.now();
    const input = inputBuffer;
    const prefixLen = prefixBytes.length;
    for (let i = 0; i < BATCH_SIZE && running; i++) {
        setNonce(miningNonce);
        // copy nonceBytes vào vị trí thích hợp trong input
        for (let j = 0; j < 20; j++) input[prefixLen + j] = nonceBytes[j];
        const hash = sha256(input);
        if (meetsTargetFast(hash)) {
            // Chuyển hash thành hex string để gửi về (dùng cho debug)
            let hex = '';
            for (let i = 0; i < 32; i++) {
                const b = hash[i];
                hex += (b < 16 ? '0' : '') + b.toString(16);
            }
            self.postMessage({
                type: 'found',
                nonce: miningNonce,
                hash: hex,
                job_id: jobId
            });
            running = false;
            return;
        }
        miningNonce++;
        hashes++;
    }
    const elapsed = performance.now() - startTime;
    if (elapsed > 0) {
        const hps = hashes / (elapsed / 1000);
        self.postMessage({ type: 'progress', hashes: hashes, hps: hps });
    } else {
        self.postMessage({ type: 'progress', hashes: hashes });
    }
    if (running) {
        // Dùng requestAnimationFrame nếu có, hoặc setTimeout 0 để không block main thread
        if (typeof requestAnimationFrame !== 'undefined') {
            requestAnimationFrame(mineBatch);
        } else {
            setTimeout(mineBatch, 0);
        }
    }
}

// Khởi tạo job với thông tin từ server (hỗ trợ cả định dạng cũ và mới)
function initJob(jobData) {
    // Lấy job_id (có thể là bounty_id hoặc job_id)
    jobId = jobData.bounty_id || jobData.job_id || jobData.id;
    if (!jobId) {
        self.postMessage({ type: 'error', message: 'Missing job id' });
        return;
    }

    // Lấy last_hash hoặc prev_hash
    const lastHash = jobData.last_hash || jobData.prev_hash;
    if (!lastHash) {
        self.postMessage({ type: 'error', message: 'Missing last_hash' });
        return;
    }

    const username = jobData.username || jobData.worker_name || 'anonymous';
    const targetHexStr = jobData.target_hex || jobData.targetHex;
    if (!targetHexStr) {
        self.postMessage({ type: 'error', message: 'Missing target_hex' });
        return;
    }

    // Chuyển targetHex thành Uint8Array để so sánh nhanh
    targetBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        targetBytes[i] = parseInt(targetHexStr.substr(i*2, 2), 16);
    }

    const enc = new TextEncoder();
    prefixBytes = enc.encode(lastHash);
    suffixBytes = enc.encode(username);
    nonceBytes.fill(48);
    miningNonce = 0;
    inputBuffer = buildInputBuffer();

    // Thông báo đã sẵn sàng
    self.postMessage({
        type: 'job_ready',
        job_id: jobId,
        difficulty: jobData.difficulty || '?',
        reward: jobData.reward || '?'
    });
}

self.onmessage = function(e) {
    switch(e.data.type) {
        case 'start':
            if (!running) {
                initJob(e.data);
                if (jobId) {
                    running = true;
                    // Bắt đầu mining ngay
                    if (typeof requestAnimationFrame !== 'undefined') {
                        requestAnimationFrame(mineBatch);
                    } else {
                        setTimeout(mineBatch, 0);
                    }
                }
            }
            break;
        case 'stop':
            running = false;
            break;
        case 'ping':
            self.postMessage({ type: 'pong' });
            break;
        default:
            // fallback: nếu nhận data trực tiếp (không có type) thì coi như start
            if (e.data && (e.data.bounty_id || e.data.job_id)) {
                if (!running) {
                    initJob(e.data);
                    if (jobId) {
                        running = true;
                        if (typeof requestAnimationFrame !== 'undefined') {
                            requestAnimationFrame(mineBatch);
                        } else {
                            setTimeout(mineBatch, 0);
                        }
                    }
                }
            }
    }
};

self.postMessage({ type: 'ready' });
})();
