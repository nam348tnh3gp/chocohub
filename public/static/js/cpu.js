// cpu.js - Web Worker tối ưu SHA-256
let running = false;
let jobData = null;

self.onmessage = function(e) {
    if (e.data.type === 'stop') {
        running = false;
        return;
    }
    jobData = e.data;
    running = true;
    mine();
};

async function sha256(str) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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

async function mine() {
    const { last_hash, username, target_bin, bounty_id } = jobData;
    let nonce = jobData.startNonce || 0;
    
    // Tăng BATCH để giảm overhead async
    const BATCH = 2000;
    
    while (running) {
        let batchHashes = 0;
        
        for (let i = 0; i < BATCH; i++) {
            if (!running) return;
            
            // Chuẩn: last_hash + nonce + workerName
            const input = last_hash + nonce + username;
            const hashed = await sha256(input);
            
            if (meetsTarget(hashed, target_bin)) {
                self.postMessage({ status: 'found', nonce: nonce, bounty_id: bounty_id });
                running = false;
                return;
            }
            
            nonce++;
            batchHashes++;
        }
        
        self.postMessage({ status: 'progress', hashesDone: batchHashes, nonce: nonce });
        
        // Yield mỗi 2000 hash (thay vì 500)
        await new Promise(r => setTimeout(r, 0));
    }
}
