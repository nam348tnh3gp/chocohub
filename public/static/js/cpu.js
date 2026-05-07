// cpu.js - Web Worker dùng SHA-256
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
    let bitsRequired = targetBinStr.length;
    let hexLen = Math.ceil(bitsRequired / 4);
    let prefixHex = hashHex.substring(0, hexLen);
    let binFull = '';
    for (let ch of prefixHex) binFull += parseInt(ch, 16).toString(2).padStart(4, '0');
    return binFull.startsWith(targetBinStr);
}

async function mine() {
    let nonce = jobData.startNonce || 0;
    const { last_hash, username, target_bin, bounty_id, server_url } = jobData;
    
    while (running) {
        const BATCH = 500;
        let batchHashes = 0;
        
        for (let i = 0; i < BATCH; i++) {
            if (!running) return;
            
            const candidate = last_hash + username + bounty_id + nonce.toString();
            const hashed = await sha256(candidate);
            
            if (meetsTarget(hashed, target_bin)) {
                self.postMessage({ status: 'found', nonce: nonce, bounty_id: bounty_id });
                running = false;
                return;
            }
            
            nonce++;
            batchHashes++;
        }
        
        self.postMessage({ status: 'progress', hashesDone: batchHashes });
    }
}
