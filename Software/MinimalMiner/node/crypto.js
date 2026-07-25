const crypto = require('crypto');
const ZERO_HASH = '0'.repeat(64);

function sha256hex(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? data : data).digest('hex');
}

function sha256buf(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? data : data).digest();
}

function merkleRootBuf(hashes) {
  if (!hashes.length) return Buffer.alloc(32);
  const N = hashes.length;
  const buf = Buffer.allocUnsafe(N * 32);
  for (let i = 0; i < N; i++) {
    const h = hashes[i];
    if (Buffer.isBuffer(h)) h.copy(buf, i * 32);
    else Buffer.from(h, 'hex').copy(buf, i * 32);
  }
  return merkleRootBuf2(buf, N);
}

function merkleRootBuf2(buf, N) {
  buf = Buffer.from(buf);
  let len = N;
  const pairBuf = Buffer.allocUnsafe(64);
  while (len > 1) {
    const newLen = (len + 1) >> 1;
    for (let i = 0; i < newLen; i++) {
      const li = i * 2;
      const ri = Math.min(li + 1, len - 1);
      buf.copy(pairBuf, 0, li * 32);
      buf.copy(pairBuf, 32, ri * 32);
      sha256buf(pairBuf).copy(buf, i * 32);
    }
    len = newLen;
  }
  return buf.subarray(0, 32);
}

function computeMerkleTreeNodes(leafBuf, N) {
  const buf = Buffer.allocUnsafe(N * 32);
  leafBuf.copy(buf, 0, 0, N * 32);
  const totalInternal = merkleTreeInternalNodeCount(N);
  const result = Buffer.alloc(totalInternal * 32);
  let writeOffset = 0;
  let len = N;
  const pairBuf = Buffer.allocUnsafe(64);
  while (len > 1) {
    const newLen = (len + 1) >> 1;
    for (let i = 0; i < newLen; i++) {
      const li = i * 2;
      const ri = Math.min(li + 1, len - 1);
      buf.copy(pairBuf, 0, li * 32);
      buf.copy(pairBuf, 32, ri * 32);
      const h = sha256buf(pairBuf);
      h.copy(buf, i * 32);
      h.copy(result, writeOffset + i * 32);
    }
    writeOffset += newLen * 32;
    len = newLen;
  }
  return result;
}

function computeMerkleProofBuf(leaves, leafIndex) {
  const N = leaves.length;
  const buf = Buffer.allocUnsafe(N * 32);
  for (let i = 0; i < N; i++) {
    const h = leaves[i];
    if (Buffer.isBuffer(h)) h.copy(buf, i * 32);
    else Buffer.from(h, 'hex').copy(buf, i * 32);
  }
  return computeMerkleProofBuf2(buf, N, leafIndex);
}

function computeMerkleProofBuf2(buf, N, leafIndex) {
  const proof = [];
  let idx = leafIndex;
  let len = N;
  const pairBuf = Buffer.allocUnsafe(64);

  while (len > 1) {
    const sibIdx = idx ^ 1;
    if (sibIdx < len) {
      const sib = Buffer.allocUnsafe(32);
      buf.copy(sib, 0, sibIdx * 32);
      proof.push(sib);
    }

    const newLen = (len + 1) >> 1;
    for (let i = 0; i < newLen; i++) {
      const li = i * 2;
      const ri = Math.min(li + 1, len - 1);
      buf.copy(pairBuf, 0, li * 32);
      buf.copy(pairBuf, 32, ri * 32);
      const h = sha256buf(pairBuf);
      h.copy(buf, i * 32);
    }

    len = newLen;
    idx >>= 1;
  }

  return proof;
}

function verifyMerkleProofBuf(leafHash, leafIndex, totalLeaves, proof, root) {
  let hash = Buffer.isBuffer(leafHash) ? leafHash : Buffer.from(leafHash, 'hex');
  let idx = leafIndex;
  let count = totalLeaves;
  let pIdx = 0;
  while (count > 1) {
    const isOddLast = (count % 2 === 1 && idx === count - 1);
    if (isOddLast) {
      hash = sha256buf(Buffer.concat([hash, hash]));
    } else if (idx % 2 === 0) {
      if (pIdx >= proof.length) return false;
      const sibling = Buffer.isBuffer(proof[pIdx]) ? proof[pIdx] : Buffer.from(proof[pIdx], 'hex');
      hash = sha256buf(Buffer.concat([hash, sibling]));
      pIdx++;
    } else {
      if (pIdx >= proof.length) return false;
      const sibling = Buffer.isBuffer(proof[pIdx]) ? proof[pIdx] : Buffer.from(proof[pIdx], 'hex');
      hash = sha256buf(Buffer.concat([sibling, hash]));
      pIdx++;
    }
    idx = Math.floor(idx / 2);
    count = Math.ceil(count / 2);
  }
  const rootBuf = Buffer.isBuffer(root) ? root : Buffer.from(root, 'hex');
  return hash.equals(rootBuf);
}

function safeInt(value, def = 0) {
  const n = parseInt(value, 10);
  return isNaN(n) ? def : n;
}

function safeBigInt(value, def = 0n) {
  if (typeof value === 'bigint') return value;
  try { return BigInt(value); } catch { return def; }
}

function pubkeyToAddress(pubB64) {
  const raw = Buffer.from(pubB64, 'base64');
  if (raw.length !== 32) throw new Error('Invalid Ed25519 key');
  return '0xcc' + sha256hex(raw).slice(0, 40);
}

function pubKeyToAddress(pubKey) { return pubkeyToAddress(pubKey); }

function signMessage(message, privateKeyHex) {
  const key = Buffer.from(privateKeyHex, 'hex');
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8 = Buffer.concat([prefix, key]);
  const privKeyObj = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const sig = crypto.sign(null, Buffer.from(message), privKeyObj);
  return sig.toString('base64');
}

function verifySignature(message, sigB64, pubB64) {
  try {
    const pubRaw = Buffer.from(pubB64, 'base64');
    if (pubRaw.length !== 32) return false;
    const sig = Buffer.from(sigB64, 'base64');
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubRaw]);
    const pubObj = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message), pubObj, sig);
  } catch { return false; }
}

function merkleRoot(hashes) {
  if (!hashes.length) return ZERO_HASH;
  let nodes = [...hashes];
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i];
      const right = i + 1 < nodes.length ? nodes[i + 1] : left;
      next.push(sha256hex(left + right));
    }
    nodes = next;
  }
  return nodes[0];
}

function computeMerkleProof(leaves, leafIndex) {
  let nodes = [...leaves];
  let idx = leafIndex;
  const proof = [];
  while (nodes.length > 1) {
    const next = [];
    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i];
      const right = i + 1 < nodes.length ? nodes[i + 1] : left;
      next.push(sha256hex(left + right));
    }
    if (nodes.length % 2 === 1 && idx === nodes.length - 1) {
    } else if (idx % 2 === 0) {
      proof.push(nodes[idx + 1]);
    } else {
      proof.push(nodes[idx - 1]);
    }
    nodes = next;
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function verifyMerkleProof(leafHash, leafIndex, totalLeaves, proof, root) {
  let hash = leafHash;
  let idx = leafIndex;
  let count = totalLeaves;
  let pIdx = 0;
  while (count > 1) {
    const isOddLast = (count % 2 === 1 && idx === count - 1);
    if (isOddLast) {
      hash = sha256hex(hash + hash);
    } else if (idx % 2 === 0) {
      if (pIdx >= proof.length) return false;
      hash = sha256hex(hash + proof[pIdx++]);
    } else {
      if (pIdx >= proof.length) return false;
      hash = sha256hex(proof[pIdx++] + hash);
    }
    idx = Math.floor(idx / 2);
    count = Math.ceil(count / 2);
  }
  return hash === root;
}

function canonicalTxMessage(tx) {
  return JSON.stringify({
    chain_id: String(tx.chain_id || '0'),
    fee: String(tx.fee || '0'),
    from_addr: tx.from_addr,
    gas_limit: tx.gas_limit || 21000,
    gas_price: String(tx.gas_price || '1'),
    nonce: tx.nonce,
    priority_fee: String(tx.priority_fee || '0'),
    to_addr: tx.to_addr,
    value: String(tx.value),
  }, Object.keys(JSON.parse(JSON.stringify({
    chain_id: '0', fee: '0', from_addr: '', gas_limit: 21000,
    gas_price: '1', nonce: 0, priority_fee: '0', to_addr: '', value: '0'
  }))).sort(), ',').replace(/,/, ',').replace(/\{/g, '{');
}

function hashTransaction(tx) {
  const d = {
    chain_id: String(tx.chain_id || '0'),
    fee: String(tx.fee || '0'),
    from_addr: tx.from_addr,
    gas_limit: tx.gas_limit || 21000,
    gas_price: String(tx.gas_price || '1'),
    nonce: tx.nonce,
    priority_fee: String(tx.priority_fee || '0'),
    to_addr: tx.to_addr,
    value: String(tx.value),
  };
  return sha256hex(JSON.stringify(d, Object.keys(d).sort()));
}

function hashBlock(bloco) {
  let rewardsStr = '';
  if (Array.isArray(bloco.rewards)) {
    const normalized = bloco.rewards.map(r => {
      const n = {};
      for (const [k, v] of Object.entries(r)) n[k] = (typeof v === 'number' && Number.isInteger(v)) ? v : v;
      return n;
    });
    rewardsStr = JSON.stringify(normalized);
  }
  const d = {
    generation_signature: bloco.generation_signature || ZERO_HASH,
    height: bloco.height || 0,
    miner: bloco.miner || '',
    nonce: String(bloco.nonce || '0'),
    parent_hash: bloco.parent_hash || '',
    reward_cc: String(bloco.reward_cc || '0'),
    rewards: rewardsStr,
    target: String(bloco.target || '0'),
    timestamp: bloco.timestamp || 0,
    tx_count: parseInt(bloco.tx_count || 0, 10),
    tx_root: bloco.tx_root || '',
    state_root: bloco.state_root || '',
  };
  return sha256hex(JSON.stringify(d, Object.keys(d).sort()));
}

function blockMessage(bloco) { return hashBlock(bloco); }

function computeStateRoot(db) {
  const rows = db.prepare('SELECT address, balance, nonce FROM users ORDER BY address').all();
  const leaves = rows.map(r => sha256hex(`${r.address}:${r.balance}:${r.nonce}`));
  return merkleRoot(leaves);
}

function computeStateRootAfterTxs(db, txs, rewards) {
  const rows = db.prepare('SELECT address, balance, nonce FROM users ORDER BY address').all();
  const state = {};
  for (const r of rows) state[r.address] = { balance: safeBigInt(r.balance, 0n), nonce: safeInt(r.nonce, 0) };
  for (const tx of txs) {
    const sender = tx.from_addr || '';
    const to = tx.to_addr || '';
    const val = safeBigInt(tx.value, 0n);
    const fee = safeBigInt(tx.fee, 0n);
    if (state[sender]) { state[sender].balance -= val + fee; state[sender].nonce += 1; }
    if (to) { if (!state[to]) state[to] = { balance: 0n, nonce: 0 }; state[to].balance += val; }
  }
  if (rewards) {
    for (const r of rewards) {
      if (typeof r === 'object' && r.miner && safeBigInt(r.reward_cc, 0n) > 0n) {
        if (!state[r.miner]) state[r.miner] = { balance: 0n, nonce: 0 };
        state[r.miner].balance += safeBigInt(r.reward_cc, 0n);
      }
    }
  }
  const leaves = Object.entries(state).sort().map(([addr, s]) => sha256hex(`${addr}:${s.balance}:${s.nonce}`));
  return merkleRoot(leaves);
}

function calculateMiningReward(height, cfg) {
  let reward = BigInt((cfg && cfg.initialReward) || 1_650_000_000_000_000_000n);
  const halving = (cfg && cfg.halvingInterval) || 6300000;
  const halvings = Math.floor(height / halving);
  for (let i = 0; i < halvings; i++) reward = reward / 2n;
  return reward > 0n ? reward : 0n;
}

function isBetterChainCandidate(candidate, incumbent) {
  const cw = (b) => safeBigInt((b || {}).chain_work, 0n);
  const dl = (b) => safeInt((b || {}).nonce, 999999);
  const h = (b) => safeInt((b || {}).height, 0);
  if (cw(candidate) !== cw(incumbent)) return cw(candidate) > cw(incumbent);
  if (dl(candidate) !== dl(incumbent)) return dl(candidate) < dl(incumbent);
  if (h(candidate) !== h(incumbent)) return h(candidate) > h(incumbent);
  return String((candidate || {}).hash || '') < String((incumbent || {}).hash || '');
}

// ── PoC (Proof of Capacity) ──
const SCOOP_SIZE = 64;
const SCOOPS_PER_NONCE = 4096;
const PLOT_FORMAT_V1 = 1;       // sem merkle tree interna
const PLOT_FORMAT_V2 = 2;       // com merkle tree interna (nós internos após scoop data)

function merkleTreeInternalNodeCount(N) {
  // Correct count: sum_{k=1}^{∞} ceil(N / 2^k)
  // This is NOT N-1 when N is not a power of 2
  let total = 0;
  while (N > 1) {
    N = Math.ceil(N / 2);
    total += N;
  }
  return total;
}

function plotScoopCount(sizeGb) { return Math.max(1, Math.floor((sizeGb * 1024 * 1024 * 1024) / SCOOP_SIZE)); }
function plotScoopCountOrig(sizeGb) { return plotScoopCount(sizeGb); }

const EFFECTIVE_CAPACITY_CAP_GB = 10 * 1024;

const TIERS = [
  [0, 32, 'tier_1', 'drawer', 1.0],
  [32, 500, 'tier_2', 'small', 1.6],
  [500, 5 * 1024, 'tier_3', 'medium', 2.4],
  [5 * 1024, EFFECTIVE_CAPACITY_CAP_GB, 'tier_4', 'large', 3.2],
  [EFFECTIVE_CAPACITY_CAP_GB, Infinity, 'tier_5', 'capped', 3.2],
];

function getTier(sizeGb) {
  sizeGb = Math.max(0, parseFloat(sizeGb) || 0);
  for (const [min, max, id, name, mult] of TIERS) {
    if (sizeGb >= min && sizeGb < max) return [id, name, mult];
  }
  return ['tier_1', 'drawer', 1.0];
}

function computeEffectiveCapacityGb(sizeGb) {
  const size = Math.max(0.001, parseFloat(sizeGb) || 0.001);
  const cappedSize = Math.min(size, EFFECTIVE_CAPACITY_CAP_GB);
  const [tierId, , mult] = getTier(size);

  if (tierId === 'tier_1') {
    return Math.sqrt(cappedSize) * mult;
  }
  if (tierId === 'tier_2') {
    return (Math.sqrt(32) + Math.sqrt(cappedSize - 32)) * mult;
  }
  return Math.sqrt(cappedSize) * mult;
}

function computeBaseTargetWithTier(sizeGb) {
  const effectiveCapacity = computeEffectiveCapacityGb(sizeGb);
  const adjusted = 86400 / Math.max(1.0, effectiveCapacity);
  return Math.max(1, Math.min(Math.floor(adjusted), 1000000000));
}

function computeDeadline(scoopData, genSig, plotSizeGb) {
  const data = typeof scoopData === 'string' ? Buffer.from(scoopData, 'hex') : Buffer.isBuffer(scoopData) ? scoopData : Buffer.from(String(scoopData));
  const sig = typeof genSig === 'string' ? genSig : (genSig && genSig.challenge_seed) || String(genSig || '');
  const quality = crypto.createHash('sha256').update(Buffer.concat([data, Buffer.from(sig)])).digest();
  const qualityInt = quality.readBigUInt64BE(0);
  const size = Math.max(0.001, parseFloat(plotSizeGb));
  const baseTarget = computeBaseTargetWithTier(size);
  const dl = Number(qualityInt / BigInt(baseTarget));
  return Math.max(60, Math.min(dl, 86400));
}

function deriveSampleIndexes(challengeSeed, totalScoops, sampleCount, round, plotId) {
  const seed = sha256hex(`${challengeSeed}:${plotId}:${round}`);
  if (sampleCount >= totalScoops) {
    const indexes = Array.from({ length: totalScoops }, (_, i) => i);
    let state = seed;
    for (let i = indexes.length - 1; i > 0; i--) {
      state = sha256hex(`${state}:${i}`);
      const j = safeInt(state.slice(0, 16), 0) % (i + 1);
      [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
    }
    return indexes;
  }
  const indexes = [];
  const seen = new Set();
  let counter = 0;
  while (indexes.length < sampleCount) {
    const h = sha256hex(`${seed}:${counter++}`);
    const idx = safeInt(h.slice(0, 16), 0) % totalScoops;
    if (!seen.has(idx)) { seen.add(idx); indexes.push(idx); }
  }
  return indexes;
}

function getChainWorkForBlock(blk) {
  return safeBigInt((blk || {}).chain_work, 0n);
}

module.exports = {
  ZERO_HASH, sha256hex, sha256buf, safeInt, safeBigInt, pubkeyToAddress, pubKeyToAddress,
  signMessage, verifySignature, merkleRoot, merkleRootBuf, merkleRootBuf2, computeMerkleProof, computeMerkleProofBuf, computeMerkleProofBuf2, computeMerkleTreeNodes, verifyMerkleProof, verifyMerkleProofBuf,
  canonicalTxMessage, hashTransaction, hashBlock, blockMessage,
  computeStateRoot, computeStateRootAfterTxs, calculateMiningReward, isBetterChainCandidate,
  SCOOP_SIZE, SCOOPS_PER_NONCE, PLOT_FORMAT_V1, PLOT_FORMAT_V2, merkleTreeInternalNodeCount, plotScoopCount, plotScoopCountOrig,
  computeDeadline, deriveSampleIndexes, getChainWorkForBlock,
  TIERS, EFFECTIVE_CAPACITY_CAP_GB, getTier, computeEffectiveCapacityGb, computeBaseTargetWithTier,
};
