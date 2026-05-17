// cpu.js – Web Crypto SHA-256 (tối ưu tốc độ cao)
(function() {
    'use strict';

    let running = false;
    let bountyId = '';
    let targetHex = '';
    let lastHashBytes = null;
    let suffixBytes = null;
    let nonceBytes = new Uint8Array(20);   // nonce dạng ASCII (20 chữ số)
    let miningNonce = 0;

    // Chuyển buffer thành hex
    function bufToHex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(b => (b < 16 ? '0' : '') + b.toString(16))
            .join('');
    }

    // Băm một nonce (dùng Web Crypto – hardware acceleration)
    async function hashNonce(nonce) {
        // Ghi nonce dạng thập phân, 20 chữ số, căn phải
        const s = nonce.toString();
        const len = s.length;
        const start = 20 - len;
        for (let i = 0; i < len; i++) nonceBytes[start + i] = s.charCodeAt(i);
        for (let i = 0; i < start; i++) nonceBytes[i] = 48;

        // Tạo buffer đầu vào: last_hash (32 byte) + nonce (20 byte) + worker_name
        const total = lastHashBytes.length + 20 + suffixBytes.length;
        const input = new Uint8Array(total);
        input.set(lastHashBytes, 0);
        input.set(nonceBytes, lastHashBytes.length);
        input.set(suffixBytes, lastHashBytes.length + 20);

        const hashBuffer = await crypto.subtle.digest('SHA-256', input);
        const hashHex = bufToHex(hashBuffer);
        return { nonce, hashHex };
    }

    let batchSize = 500;          // số nonce mỗi lần chạy
    let hashesSinceReport = 0;

    async function mineLoop() {
        if (!running) return;
        const startTime = performance.now();
        let found = false;
        let foundNonce = null;
        let foundHash = null;

        for (let i = 0; i < batchSize; i++) {
            if (!running) break;
            const { nonce, hashHex } = await hashNonce(miningNonce);
            hashesSinceReport++;
            if (hashHex < targetHex) {
                found = true;
                foundNonce = nonce;
                foundHash = hashHex;
                running = false;
                break;
            }
            miningNonce++;
        }

        const elapsed = performance.now() - startTime;

        if (found) {
            self.postMessage({
                type: 'found',
                nonce: foundNonce,
                hash: foundHash,
                bounty_id: bountyId
            });
            return;
        }

        // Báo cáo tiến trình mỗi 1000 hash
        if (hashesSinceReport >= 1000) {
            self.postMessage({ type: 'progress', hashes: hashesSinceReport });
            hashesSinceReport = 0;
        }

        // Điều chỉnh batch size để mỗi lần chạy ~30ms
        if (elapsed < 20 && batchSize < 2000) batchSize = Math.min(2000, batchSize * 2);
        else if (elapsed > 50 && batchSize > 100) batchSize = Math.floor(batchSize / 2);

        if (running) setTimeout(mineLoop, 0);
    }

    self.onmessage = function(e) {
        switch (e.data.type) {
            case 'start':
                if (!running) {
                    bountyId = e.data.bounty_id;
                    targetHex = e.data.target_hex;

                    // Chuyển last_hash từ hex (64 ký tự) sang mảng 32 byte
                    const lastHashHex = e.data.last_hash;
                    const bytes = new Uint8Array(32);
                    for (let i = 0; i < 32; i++) {
                        bytes[i] = parseInt(lastHashHex.substr(i * 2, 2), 16);
                    }
                    lastHashBytes = bytes;

                    const enc = new TextEncoder();
                    suffixBytes = enc.encode(e.data.username);
                    nonceBytes.fill(48);
                    miningNonce = 0;
                    running = true;
                    mineLoop();
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
