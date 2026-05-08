// cpu.js - Web Worker khai thác SHA-256 hiệu năng tối đa
(function() {
'use strict';

let running = false;
let jobData = null;

// ==================== SHA-256 CORE - TỐI ƯU ====================
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

    // Cập nhật dữ liệu - tối ưu cho mảng lớn
    update(data, len) {
        // Nếu data là Uint8Array và len là toàn bộ, duyệt bằng vòng lặp tăng chỉ số
        const buf = this.buffer;
        let bufLen = this.bufferLen;
        let total = this.totalLen;
        for (let i = 0; i < len; i++) {
            buf[bufLen++] = data[i];
            total++;
            if (bufLen === 64) {
                this._processBlock(buf, 0);
                bufLen = 0;
            }
        }
        this.bufferLen = bufLen;
        this.totalLen = total;
    }

    // Cập nhật chỉ 1 byte - nhanh hơn cho padding
    updateByte(b) {
        const buf = this.buffer;
        const bufLen = this.bufferLen;
        buf[bufLen] = b;
        this.totalLen++;
        if (bufLen + 1 === 64) {
            this._processBlock(buf, 0);
            this.bufferLen = 0;
        } else {
            this.bufferLen = bufLen + 1;
        }
    }

    // Kết thúc và lấy hash - tối ưu hoá padding
    digest() {
        const buf = this.buffer;
        let bufLen = this.bufferLen;
        const total = this.totalLen;

        // Bước 1: thêm byte 0x80
        buf[bufLen++] = 0x80;
        if (bufLen > 56) {
            // Không đủ chỗ cho độ dài 64-bit -> thêm block mới
            for (let i = bufLen; i < 64; i++) buf[i] = 0;
            this._processBlock(buf, 0);
            bufLen = 0;
        }
        // Đệm thêm 0 cho đủ 56 byte
        for (let i = bufLen; i < 56; i++) buf[i] = 0;

        // Ghi độ dài (tính bằng bit) vào 8 byte cuối (big-endian)
        const bitLen = total * 8;
        buf[56] = (bitLen >>> 24) & 0xFF;
        buf[57] = (bitLen >>> 16) & 0xFF;
        buf[58] = (bitLen >>> 8) & 0xFF;
        buf[59] = bitLen & 0xFF;
        // 4 byte cao (với dữ liệu < 2^32 bit thì bằng 0)
        buf[60] = 0;
        buf[61] = 0;
        buf[62] = 0;
        buf[63] = 0;

        this._processBlock(buf, 0);

        const result = new Uint8Array(32);
        const state = this.state;
        // Ghi trực tiếp vào result bằng dịch chuyển, tránh DataView nếu có thể
        for (let i = 0; i < 8; i++) {
            const s = state[i];
            const off = i * 4;
            result[off] = (s >>> 24) & 0xFF;
            result[off + 1] = (s >>> 16) & 0xFF;
            result[off + 2] = (s >>> 8) & 0xFF;
            result[off + 3] = s & 0xFF;
        }
        return result;
    }

    // Xử lý một block 64 byte - tối ưu hoá bằng cách giảm tạo biến và dùng DataView tái sử dụng
    _processBlock(block, offset) {
        const w = this.w;
        const state = this.state;
        // Dùng DataView một lần duy nhất
        const view = new DataView(block.buffer || block, offset);

        // Mở rộng message schedule
        for (let i = 0; i < 16; i++) {
            w[i] = view.getUint32(i * 4, false);
        }
        for (let i = 16; i < 64; i++) {
            const w15 = w[i-15];
            const w2 = w[i-2];
            const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
            const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
            w[i] = (w[i-16] + s0 + w[i-7] + s1) | 0;
        }

        let a = state[0], b = state[1], c = state[2], d = state[3];
        let e = state[4], f = state[5], g = state[6], h = state[7];

        // Vòng lặp chính - tránh truy cập mảng K bên ngoài nhiều lần
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

        state[0] = (state[0] + a) | 0;
        state[1] = (state[1] + b) | 0;
        state[2] = (state[2] + c) | 0;
        state[3] = (state[3] + d) | 0;
        state[4] = (state[4] + e) | 0;
        state[5] = (state[5] + f) | 0;
        state[6] = (state[6] + g) | 0;
        state[7] = (state[7] + h) | 0;
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
// Nonce buffer con trỏ để ghi nhanh
const nonceDigits = new Uint8Array(20); // vùng đệm tạm cho chữ số

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
    // Đảm bảo vùng nonce được khởi tạo = '0' (48)
    const nonceStart = prefixLen;
    for (let i = 0; i < 20; i++) {
        inputBuffer[nonceStart + i] = 48; // ký tự '0'
    }
    inputBuffer.set(suffixBytes, nonceStart + 20);
}

// Viết nonce dưới dạng thập phân vào đúng 20 byte, đảo ngược từ phải sang trái
function writeNonce(nonce) {
    let n = nonce;
    const buf = inputBuffer;
    let pos = prefixLen + 19;
    // Trường hợp n = 0
    if (n === 0) {
        // Tất cả đã là '0', không cần làm gì, nhưng đảm bảo pos cuối cùng là '0'
        return pos; // vị trí bắt đầu của nonce (tận cùng bên trái sau khi đã xóa số 0)
    }
    // Xoá các chữ số cũ (ghi '0' vào các vị trí cao hơn)
    // Chúng ta không cần xoá toàn bộ 20 byte, chỉ cần ghi đè lên các chữ số mới,
    // nhưng phải đảm bảo các byte không dùng đến vẫn là '0'.
    // Giải pháp: ghi đầy đủ 20 chữ số, bắt đầu từ cuối.
    let idx = pos;
    while (n > 0 && idx >= prefixLen) {
        buf[idx--] = 48 + (n % 10);
        n = (n / 10) | 0;
    }
    // Các vị trí còn lại (từ prefixLen đến idx) giữ nguyên là '0' (đã được khởi tạo ban đầu và giữ nguyên)
    return idx + 1; // vị trí bắt đầu của chuỗi số (bỏ qua các số 0 dẫn đầu)
}

// Kiểm tra hash với target (dạng chuỗi nhị phân "010101...")
function verifyHash(hashBytes) {
    const bitLen = targetBinStr.length;
    // So sánh từng bit, nhưng tối ưu bằng cách kiểm tra byte trước
    const byteLen = (bitLen + 7) >>> 3;
    for (let i = 0; i < byteLen; i++) {
        const byte = hashBytes[i];
        const targetByte = (i < targetBinStr.length >>> 3) ?
            parseInt(targetBinStr.substr(i*8, 8), 2) : 0;
        if (byte !== targetByte) {
            // Khác biệt ở byte này, cần kiểm tra bit để xác định lớn hơn hay nhỏ hơn
            for (let j = 0; j < 8; j++) {
                const bitPos = i * 8 + j;
                if (bitPos >= bitLen) break;
                const bit = (byte >>> (7 - j)) & 1;
                const expected = targetBinStr.charCodeAt(bitPos) - 48;
                if (bit !== expected) {
                    return bit < expected; // true nếu hash < target
                }
            }
            // Nếu tất cả bit đã so sánh đều bằng nhau, byte hiện tại khác biệt ở các bit thấp hơn không nằm trong target length? 
            // an toàn: trả về false
            return false;
        }
    }
    return true; // bằng nhau hoàn toàn
}

// Hàm chuyển hash bytes sang hex string (dùng pre-computed table)
function bytesToHex(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
        hex += HEX[bytes[i]];
    }
    return hex;
}

// ==================== MINING LOOP TỰ ĐIỀU CHỈNH ====================
function mine() {
    let nonce = jobData.startNonce || 0;
    // Batch size động
    let batchSize = 20000; // Bắt đầu an toàn
    let lastTime = performance.now();
    const TARGET_FRAME_MS = 40; // tối đa 40ms mỗi batch để không khựng UI

    while (running) {
        const startTime = performance.now();
        let count = 0;

        for (let i = 0; i < batchSize && running; i++) {
            // Ghi nonce vào buffer (hàm đã tối ưu)
            const nonceStartIdx = writeNonce(nonce);
            // Độ dài thực tế cần hash = từ nonceStartIdx đến hết buffer (bỏ qua các số 0 dẫn đầu)
            // Nhưng cẩn thận: SHA256 yêu cầu hash toàn bộ buffer từ đầu đến cuối,
            // vì vậy không thể bỏ qua phần đầu. Tuy nhiên giao thức yêu cầu hash cả buffer đầy đủ?
            // Code cũ: hasher.update(inputBuffer, len) với len = prefixLen + (prefixLen+20 - start) + suffixLen.
            // Tức là bỏ qua các số 0 dẫn đầu. Điều này rất quan trọng: nonce được biểu diễn dạng thập phân không có số 0 ở đầu.
            // Vậy len = từ vị trí bắt đầu của nonce (sau khi đã bỏ 0) đến hết.
            const len = nonceStartIdx + (prefixLen + 20 - nonceStartIdx) + suffixLen; // thực ra = prefixLen + 20 + suffixLen - (nonceStartIdx - prefixLen)???
            // Tính chính xác: len = bufferLen - (nonceStartIdx - prefixLen)
            const hashLen = bufferLen - (nonceStartIdx - prefixLen);

            hasher.reset();
            hasher.update(inputBuffer.subarray(nonceStartIdx), hashLen);
            const hashBytes = hasher.digest();

            if (verifyHash(hashBytes)) {
                const hex = bytesToHex(hashBytes);
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

        // Đo thời gian và điều chỉnh batchSize
        const elapsed = performance.now() - startTime;
        if (elapsed > TARGET_FRAME_MS && batchSize > 1000) {
            batchSize = Math.max(1000, Math.floor(batchSize * 0.8));
        } else if (elapsed < TARGET_FRAME_MS * 0.6 && batchSize < 200000) {
            batchSize = Math.min(200000, Math.floor(batchSize * 1.2));
        }

        // Báo tiến độ
        self.postMessage({
            type: 'progress',
            nonce: nonce,
            hashes: count
        });

        // Nhường quyền điều khiển cho browser
        // Sử dụng setTimeout(F,0) thay vì postMessage để không tự gọi đệ quy ngay
        if (running) {
            // Dùng setTimeout để break vòng lặp và cho phép message 'stop' được xử lý
            setTimeout(() => { if (running) mine(); }, 0);
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
            // Bắt đầu mining, dùng setTimeout để không chặn onmessage
            setTimeout(mine, 0);
            break;

        case 'stop':
            running = false;
            break;

        case 'ping':
            self.postMessage({ type: 'pong' });
            break;
    }
};

// Thông báo sẵn sàng
self.postMessage({ type: 'ready' });

})();
