const fs = require('fs');
const { sha256hex, sha256buf, merkleRootBuf2, computeMerkleProofBuf2, computeMerkleTreeNodes, merkleTreeInternalNodeCount, computeDeadline, plotScoopCount, SCOOP_SIZE, SCOOPS_PER_NONCE, ZERO_HASH, PLOT_FORMAT_V1, PLOT_FORMAT_V2 } = require('./crypto');
const { log } = require('./config');

const HEADER_SIZE = 256;

function plotTotalSize(totalScoops, formatVersion) {
  const scoopDataSize = totalScoops * SCOOP_SIZE;
  if (formatVersion === PLOT_FORMAT_V2) {
    return HEADER_SIZE + scoopDataSize + merkleTreeInternalNodeCount(totalScoops) * 32;
  }
  return HEADER_SIZE + scoopDataSize;
}

function detectPlotFormat(plotPath) {
  try {
    const stat = fs.statSync(plotPath);
    if (stat.size < HEADER_SIZE + 64) return null;
    const fd = fs.openSync(plotPath, 'r');
    try {
      const header = Buffer.alloc(72);
      fs.readSync(fd, header, 0, 72, 0);
      if (header.toString('ascii', 0, 8) !== 'CHOCOHUB') return null;
      const totalScoops = header.readUInt32LE(64);
      if (totalScoops < 1) return null;
      const expectedV1 = plotTotalSize(totalScoops, PLOT_FORMAT_V1);
      const expectedV2 = plotTotalSize(totalScoops, PLOT_FORMAT_V2);
      if (stat.size === expectedV2) return { version: PLOT_FORMAT_V2, totalScoops };
      return { version: PLOT_FORMAT_V1, totalScoops };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function readMerkleProofFromFile(plotPath, totalScoops, scoopIndex) {
  const treeStart = HEADER_SIZE + totalScoops * SCOOP_SIZE;
  const fd = fs.openSync(plotPath, 'r');
  try {
    const proof = [];
    let idx = scoopIndex;
    let count = totalScoops;
    let treeOffset = 0;

    while (count > 1) {
      const siblingIdx = idx ^ 1;
      if (siblingIdx < count) {
        if (count === totalScoops) {
          const pos = HEADER_SIZE + siblingIdx * SCOOP_SIZE;
          const buf = Buffer.alloc(SCOOP_SIZE);
          fs.readSync(fd, buf, 0, SCOOP_SIZE, pos);
          proof.push(sha256buf(buf));
        } else {
          const pos = treeStart + (treeOffset + siblingIdx) * 32;
          const nodeBuf = Buffer.alloc(32);
          fs.readSync(fd, nodeBuf, 0, 32, pos);
          proof.push(nodeBuf);
        }
      }
      idx >>= 1;
      const nextCount = (count + 1) >> 1;
      if (count !== totalScoops) treeOffset += count;
      count = nextCount;
    }
    return proof;
  } finally { fs.closeSync(fd); }
}

function readPlotScoops(plotPath, totalScoops) {
  const fd = fs.openSync(plotPath, 'r');
  try {
    const buf = Buffer.alloc(totalScoops * 32);
    const scoop = Buffer.alloc(SCOOP_SIZE);
    for (let i = 0; i < totalScoops; i++) {
      const pos = HEADER_SIZE + i * SCOOP_SIZE;
      const bytes = fs.readSync(fd, scoop, 0, SCOOP_SIZE, pos);
      if (bytes < SCOOP_SIZE) scoop.fill(0, bytes);
      sha256buf(scoop).copy(buf, i * 32);
    }
    return buf;
  } finally { fs.closeSync(fd); }
}

function buildPocProof(plotPath, plotId, challenge, plotSizeGb) {
  if (!fs.existsSync(plotPath)) return null;
  const totalScoops = plotScoopCount(plotSizeGb);
  if (totalScoops < 1) return null;
  const fmt = detectPlotFormat(plotPath);
  if (!fmt) return null;
  const realScoops = fmt.totalScoops || totalScoops;
  try {
    const fd = fs.openSync(plotPath, 'r');
    try {
      const height = parseInt(challenge.block_height || challenge.height || 0, 10) || 0;
      const genSig = challenge.challenge_seed || challenge.generation_signature || '';
      const scoopNum = (height + parseInt(sha256hex(genSig).slice(0, 8), 16)) % 4096;
      let bestDeadline = Infinity, bestScoopData = null;
      let bestScoopIndex = 0;
      for (let i = 0; i < totalScoops; i++) {
        if ((i % SCOOPS_PER_NONCE) !== scoopNum) continue;
        const pos = HEADER_SIZE + i * SCOOP_SIZE;
        const buf = Buffer.alloc(SCOOP_SIZE);
        const bytes = fs.readSync(fd, buf, 0, SCOOP_SIZE, pos);
        if (bytes < SCOOP_SIZE) buf.fill(0, bytes);
        const dl = computeDeadline(buf, genSig, plotSizeGb);
        if (dl < bestDeadline) { bestDeadline = dl; bestScoopData = buf; bestScoopIndex = i; }
      }
      if (bestDeadline === Infinity || bestDeadline <= 0) return null;

      let merkleProof;
      if (fmt.version === PLOT_FORMAT_V2) {
        merkleProof = readMerkleProofFromFile(plotPath, realScoops, bestScoopIndex);
      } else {
        const leafBuf = readPlotScoops(plotPath, realScoops);
        merkleProof = computeMerkleProofBuf2(leafBuf, realScoops, bestScoopIndex);
      }

      const proofDigest = sha256hex(Buffer.concat([bestScoopData, Buffer.from(String(bestDeadline))]));
      return { proof_version: 1, scoop_num: scoopNum, deadline: Math.floor(bestDeadline), proof_digest: proofDigest, read_count: Math.ceil(totalScoops / SCOOPS_PER_NONCE), scoop_data: bestScoopData.toString('hex'), merkle_proof: merkleProof.map(b => b.toString('hex')), scoop_index: bestScoopIndex };
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function computePlotMerkleRoot(plotPath, plotSizeGb) {
  if (!fs.existsSync(plotPath)) return null;
  const totalScoops = plotScoopCount(plotSizeGb);
  if (totalScoops < 1) return null;
  const fmt = detectPlotFormat(plotPath);
  if (!fmt) return null;
  if (fmt.version === PLOT_FORMAT_V2) {
    const treeCount = merkleTreeInternalNodeCount(fmt.totalScoops);
    const treeStart = HEADER_SIZE + fmt.totalScoops * SCOOP_SIZE;
    const rootOffset = treeStart + (treeCount - 1) * 32;
    const buf = Buffer.alloc(32);
    const fd = fs.openSync(plotPath, 'r');
    try {
      fs.readSync(fd, buf, 0, 32, rootOffset);
      return buf.toString('hex');
    } finally { fs.closeSync(fd); }
  }
  const leafBuf = readPlotScoops(plotPath, totalScoops);
  return merkleRootBuf2(leafBuf, totalScoops).toString('hex');
}

function _computeScoopData(totalScoops) {
  const data = Buffer.alloc(totalScoops * SCOOP_SIZE);
  for (let i = 0; i < data.length; i++) data[i] = (i * 31 + 7) & 0xFF;
  return data;
}

function createPlotFile(plotPath, plotId, minerAddress, sizeGb) {
  const totalScoops = plotScoopCount(sizeGb);
  if (totalScoops < 1) return null;

  const scoopData = _computeScoopData(totalScoops);

  const leafBuf = Buffer.alloc(totalScoops * 32);
  for (let i = 0; i < totalScoops; i++) {
    sha256buf(scoopData.slice(i * SCOOP_SIZE, (i + 1) * SCOOP_SIZE)).copy(leafBuf, i * 32);
  }

  const treeNodes = computeMerkleTreeNodes(leafBuf, totalScoops);
  const root = treeNodes.subarray(-32).toString('hex') || ZERO_HASH;

  const plotSize = plotTotalSize(totalScoops, PLOT_FORMAT_V2);
  const buf = Buffer.alloc(plotSize);

  buf.write('CHOCOHUB', 0, 'ascii');
  buf.writeUInt32LE(PLOT_FORMAT_V2, 8); // version = 2
  const idHigh = parseInt(plotId.slice(0, 8), 16) || 0;
  const idLow = parseInt(plotId.slice(8, 16), 16) || 0;
  buf.writeUInt32LE(idHigh, 12);
  buf.writeUInt32LE(idLow, 16);
  buf.write(minerAddress.padEnd(44, '\0'), 20, 44, 'ascii');
  buf.writeUInt32LE(totalScoops, 64);
  buf.writeUInt32LE(SCOOP_SIZE, 68);
  buf.write(root, 72, 64, 'hex');

  scoopData.copy(buf, HEADER_SIZE);

  treeNodes.copy(buf, HEADER_SIZE + totalScoops * SCOOP_SIZE);

  fs.writeFileSync(plotPath, buf);
  return { plotId, sizeGb, totalScoops, merkleRoot: root };
}

module.exports = { buildPocProof, computePlotMerkleRoot, createPlotFile, detectPlotFormat };
