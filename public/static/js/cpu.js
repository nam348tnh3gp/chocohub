// cpu.js
let running = true;
let nonce = 0;
let lastHash, targetBin, workerName, bountyId, serverUrl, workerId;

self.onmessage = function(e) {
  if (e.data.type === 'stop') {
    running = false;
    return;
  }
  // Khởi tạo job
  const { last_hash, username, startNonce, target_bin, bounty_id, server_url, use_gpu, workerId: wid } = e.data;
  lastHash = last_hash;
  targetBin = target_bin;
  workerName = username;
  bountyId = bounty_id;
  serverUrl = server_url;
  workerId = wid || 0;
  nonce = startNonce || 0;
  running = true;
  mine();
};

async function mine() {
  while (running) {
    const input = lastHash + nonce + workerName;
    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    const binary = hexToBinary(hashHex);
    if (binary.startsWith(targetBin)) {
      // Found!
      self.postMessage({ status: 'found', nonce, bounty_id: bountyId });
      running = false;
      return;
    }
    // Báo cáo tiến độ mỗi 1000 lần
    if (nonce % 1000 === 0) {
      self.postMessage({ status: 'progress', hashesDone: 1000, nonce });
      // Heartbeat để server không timeout (tuỳ chọn)
      if (serverUrl) {
        try {
          fetch(`${serverUrl}/miner_heartbeat?worker=${workerName}&bounty=${bountyId}`, { mode: 'no-cors' });
        } catch(e){}
      }
    }
    nonce++;
  }
}

function hexToBinary(hex) {
  return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}
