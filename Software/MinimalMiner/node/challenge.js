const crypto = require('crypto');
const { ZERO_HASH, sha256hex, sha256buf, safeInt, safeBigInt, hashBlock, hashTransaction, merkleRoot, computeStateRootAfterTxs, calculateMiningReward, verifyMerkleProofBuf, computeDeadline, plotScoopCount, getTier, computeBaseTargetWithTier, TIERS } = require('./crypto');
const { log } = require('./config');


const TIER_REWARD_PCT = { tier_1: 35, tier_2: 25, tier_3: 20, tier_4: 12, tier_5: 8 };

class ChallengeManager {
  constructor(db, chain, cfg) {
    this.db = db;
    this.cfg = cfg || {};
    this.chain = chain;
  }

  getOrCreate() {
    const now = Math.floor(Date.now() / 1000);
    const tip = this.chain.getBlock(this.chain.altura);
    const genSig = (tip && tip.generation_signature) || ZERO_HASH;
    const tipHash = tip ? tip.hash : ZERO_HASH;
    const challengeId = sha256hex(`${genSig}:${tipHash}`);
    const targetIdx = parseInt(genSig.slice(0, 8), 16) % 4096;
    const challengeGrace = Math.max(15, Math.floor((this.cfg.expectedTimePerBlock || 60) / 2));
    const existing = this.db.prepare('SELECT * FROM mining_challenges WHERE challenge_id = ? AND forged_block_height IS NULL AND expires_at > ?').get(challengeId, now);
    if (existing) return existing;
    const expired = this.db.prepare('SELECT * FROM mining_challenges WHERE challenge_id = ? AND forged_block_height IS NULL AND expires_at <= ? AND challenge_id IN (SELECT DISTINCT challenge_id FROM challenge_submissions)').get(challengeId, now);
    if (expired) return expired;
    const ttl = this.chain.altura === 0 ? Math.max(20, this.cfg.expectedTimePerBlock || 60) : Math.max(this.cfg.challengeTtlSec || 300, (this.cfg.expectedTimePerBlock || 60) * 5);
    this.db.prepare('DELETE FROM mining_challenges WHERE forged_block_height IS NULL AND (challenge_id != ? OR expires_at + ? < ?) AND challenge_id NOT IN (SELECT DISTINCT challenge_id FROM challenge_submissions)').run(challengeId, challengeGrace, now);
    this.db.prepare('DELETE FROM mining_challenges WHERE challenge_id = ? AND (forged_block_height IS NOT NULL OR expires_at < ?)').run(challengeId, now - challengeGrace);
    const nonce = crypto.randomBytes(4).toString('hex');
    try {
      this.db.prepare('INSERT INTO mining_challenges (challenge_id, challenge_seed, nonce, target_scoop_index, created_at, expires_at, block_height) VALUES (?,?,?,?,?,?,?)').run(challengeId, genSig, nonce, targetIdx, now, now + ttl, this.chain.altura);
      log('info', `New challenge ${challengeId.slice(0, 12)}  scoop=${targetIdx}  expires in ${ttl}s`);
    } catch {
      const r = this.db.prepare('SELECT * FROM mining_challenges WHERE challenge_id = ?').get(challengeId);
      return r || null;
    }
    return this.db.prepare('SELECT * FROM mining_challenges WHERE challenge_id = ?').get(challengeId);
  }

  submitProof(chain, challengeId, miner, plotId, deadline, proofPacket = null) {
    const now = Math.floor(Date.now() / 1000);
    const submitGrace = Math.max(15, Math.floor((this.cfg.expectedTimePerBlock || 60) / 2));
    const ch = this.db.prepare('SELECT * FROM mining_challenges WHERE challenge_id = ? AND forged_block_height IS NULL AND expires_at + ? >= ?').get(challengeId, submitGrace, now);
    if (!ch) return { ok: false, motivo: 'challenge not found or expired' };
    if (ch.forged_block_height != null) return { ok: false, motivo: 'challenge already finalized' };
    const maxDl = chain.computeMaxDeadline();
    deadline = safeInt(deadline, -1);
    if (deadline < 0 || deadline > maxDl) return { ok: false, motivo: `invalid deadline (must be 0–${maxDl}s)` };
    let sizeGb = 0;
    const plot = this.db.prepare('SELECT * FROM plot_commitments WHERE plot_id = ? AND miner = ?').get(plotId, miner);
    if (plot) sizeGb = plot.size_gb;
    else {
      const peerPlot = this.db.prepare('SELECT * FROM peer_plot_commitments WHERE plot_id = ? AND miner = ?').get(plotId, miner);
      sizeGb = peerPlot ? peerPlot.size_gb : 1;
    }
    if (!proofPacket || !proofPacket.scoop_data) return { ok: false, motivo: 'proof_packet with scoop_data required for PoC verification' };
    const genSig = ch.challenge_seed || ZERO_HASH;
    const computedDeadline = computeDeadline(proofPacket.scoop_data, genSig, sizeGb);
    if (Math.abs(computedDeadline - deadline) > 1) return { ok: false, motivo: `PoC verification failed: computed ${computedDeadline}s, submitted ${deadline}s` };
    const expectedDigest = sha256hex(Buffer.concat([Buffer.from(proofPacket.scoop_data, 'hex'), Buffer.from(String(deadline))]));
    if (proofPacket.proof_digest && proofPacket.proof_digest !== expectedDigest) return { ok: false, motivo: 'proof digest mismatch' };
    if (!plot || !plot.merkle_root) return { ok: false, motivo: 'plot has no merkle_root commitment' };
    const totalScoops = plotScoopCount(sizeGb);
    const scoopIndex = safeInt(proofPacket.scoop_index, -1);
    if (scoopIndex < 0 || scoopIndex >= totalScoops) return { ok: false, motivo: `invalid scoop_index ${scoopIndex} for ${totalScoops} scoops` };
    const merkleProof = proofPacket.merkle_proof || [];
    const leafHash = sha256buf(Buffer.from(proofPacket.scoop_data, 'hex'));
    if (!verifyMerkleProofBuf(leafHash, scoopIndex, totalScoops, merkleProof, plot.merkle_root)) return { ok: false, motivo: 'Merkle proof does not match committed plot root' };
    this.db.prepare('INSERT OR IGNORE INTO challenge_submissions (challenge_id, miner, plot_id, size_gb, deadline, proof_digest, submitted_at) VALUES (?,?,?,?,?,?,?)').run(challengeId, miner, plotId, sizeGb, deadline, expectedDigest, now);
    const updated = this.db.prepare('UPDATE mining_challenges SET winner_miner = ?, winner_deadline = ?, winner_plot_id = ?, finalized_at = ? WHERE challenge_id = ? AND (winner_deadline IS NULL OR ? < winner_deadline)').run(miner, deadline, plotId, now, challengeId, deadline);
    const subCount = this.db.prepare('SELECT COUNT(*) as cnt FROM challenge_submissions WHERE challenge_id = ?').get(challengeId).cnt;
    const result = { ok: true, submitted: true, challenge_id: challengeId, total_submissions: subCount };
    log('info', `PoC proof from ${(miner || '').slice(0, 10)}… d=${deadline}s plot=${(plotId || '').slice(0, 10)}… for challenge ${challengeId.slice(0, 12)}`);
    if (updated.changes > 0) {
      log('info', `Best deadline updated! Forging block for challenge ${challengeId.slice(0, 12)}`);
      const block = this._forgeBlock(chain, ch, miner, deadline, [], plotId, expectedDigest);
      if (block) {
        const addResult = chain.addBlock(block, { skipPocValidation: true, skipSignature: true, skipTxValidation: true, skipStateValidation: true });
        if (addResult.ok) {
          this.db.prepare('UPDATE mining_challenges SET forged_block_height = ? WHERE challenge_id = ? AND forged_block_height IS NULL').run(block.height, challengeId);
          result.bloco = block;
        }
      }
    }
    return result;
  }

  _forgeBlock(chain, challenge, miner, deadline, rewardDistribution = [], plotId = '', proofDigest = '') {
    try {
      const newHeight = chain.altura + 1;
      let now = Math.floor(Date.now() / 1000);
      const parent = chain.getBlock(chain.altura);
      if (parent && now <= parent.timestamp) now = parent.timestamp + 1;
      const mempoolTxs = chain.getMempoolForBlock(100);
      const txHashes = mempoolTxs.map(t => t.hash || hashTransaction(t));
      const txRoot = merkleRoot(txHashes);
      const totalReward = calculateMiningReward(newHeight, this.cfg);
      const rewardCc = String(totalReward);
      const targetValue = chain._targetForHeight(newHeight);
      const genSig = parent ? sha256hex((parent.generation_signature || ZERO_HASH) + parent.hash) : ZERO_HASH;
      const block = {
        height: newHeight, parent_hash: parent ? parent.hash : ZERO_HASH, generation_signature: genSig,
        timestamp: now, miner, tx_count: mempoolTxs.length, tx_root: txRoot,
        challenge_id: challenge.challenge_id, nonce: String(Math.floor(deadline)),
        difficulty: '0', target: String(targetValue), reward_units: '0', reward_cc: String(rewardCc),
        proof_digest: proofDigest, plot_id: plotId,
        state_root: computeStateRootAfterTxs(this.db, mempoolTxs, rewardDistribution),
        transactions: mempoolTxs, signature: '', gas_used: mempoolTxs.length * 21000, gas_limit: 30000000,
        _from_local_forge: true, rewards: rewardDistribution,
      };
      if (this.cfg.minerPrivateKey) {
        const { signMessage, blockMessage } = require('./crypto');
        block.signature = signMessage(blockMessage(block), this.cfg.minerPrivateKey);
      }
      block.hash = hashBlock(block);
      return block;
    } catch (e) { log('error', `forge block error: ${e.message}`); return null; }
  }

  finalizeExpiredChallenges(chain, syncEngine) {
    const now = Math.floor(Date.now() / 1000);
    const nextHeight = chain.altura + 1;
    const existingBlock = this.db.prepare('SELECT hash, challenge_id FROM blocks WHERE height = ? ORDER BY LENGTH(chain_work) DESC, chain_work DESC LIMIT 1').get(nextHeight);
    const expired = this.db.prepare(`SELECT * FROM mining_challenges WHERE expires_at < ? AND forged_block_height IS NULL
      AND challenge_id NOT IN (SELECT DISTINCT challenge_id FROM blocks WHERE blocks.challenge_id = mining_challenges.challenge_id AND blocks.challenge_id != '')
      AND challenge_id IN (SELECT DISTINCT challenge_id FROM challenge_submissions)`).all(now);
    for (const ch of expired) {
      const chId = ch.challenge_id;
      if (existingBlock) {
        this.db.prepare('UPDATE mining_challenges SET forged_block_height = ? WHERE challenge_id = ? AND forged_block_height IS NULL').run(nextHeight, chId);
        continue;
      }
      if (chain.altura >= nextHeight) {
        this.db.prepare('UPDATE mining_challenges SET forged_block_height = ? WHERE challenge_id = ? AND forged_block_height IS NULL').run(chain.altura, chId);
        continue;
      }
      this._forgeBlockForChallenge(chain, syncEngine, ch);
    }
  }

  _forgeBlockForChallenge(chain, syncEngine, challenge) {
    try {
      const nextHeight = chain.altura + 1;
      const existing = this.db.prepare('SELECT hash, challenge_id FROM blocks WHERE height = ? LIMIT 1').get(nextHeight);
      if (existing) return null;
      const submissions = this.db.prepare('SELECT * FROM challenge_submissions WHERE challenge_id = ? ORDER BY deadline ASC').all(challenge.challenge_id);
      if (!submissions.length) return null;
      const maxDl = chain.computeMaxDeadline();
      const validSubs = submissions.filter(s => s.deadline <= maxDl);
      if (!validSubs.length) return null;
      const tierWinners = {};
      for (const s of validSubs) {
        const [tierId] = getTier(s.size_gb);
        if (!tierWinners[tierId] || s.deadline < tierWinners[tierId].deadline) {
          tierWinners[tierId] = { ...s, tier: tierId };
        }
      }
      const sortedTiers = Object.entries(TIER_REWARD_PCT).sort((a, b) => b[1] - a[1]);
      let winner = null;
      for (const [tierId] of sortedTiers) {
        if (tierWinners[tierId]) { winner = tierWinners[tierId]; break; }
      }
      if (!winner) winner = validSubs[0];
      const totalReward = calculateMiningReward(chain.altura + 1, this.cfg);
      const activeTierIds = Object.keys(tierWinners);
      const emptyTierPct = Object.entries(TIER_REWARD_PCT).filter(([id]) => !activeTierIds.includes(id)).reduce((s, [, p]) => s + p, 0);
      const bonusPerActive = activeTierIds.length > 0 ? emptyTierPct / activeTierIds.length : 0;
      const distribution = [];
      let allocated = 0n;
      for (const [tierId, tierWinner] of Object.entries(tierWinners)) {
        const adjustedPct = (TIER_REWARD_PCT[tierId] || 0) + bonusPerActive;
        const adjustedPermille = BigInt(Math.round(adjustedPct * 1000));
        const tierReward = (totalReward * adjustedPermille) / 100000n;
        distribution.push({
          miner: tierWinner.miner, plot_id: tierWinner.plot_id || 'multi_plot', size_gb: tierWinner.size_gb,
          deadline: tierWinner.deadline, share_pct: adjustedPct, reward_cc: String(tierReward),
          type: 'poc', tier: tierId,
        });
        allocated += tierReward;
      }
      if (distribution.length && allocated < totalReward) {
        distribution[0].reward_cc = String(BigInt(distribution[0].reward_cc) + (totalReward - allocated));
      }
      const block = this._forgeBlock(chain, challenge, winner.miner, winner.deadline, distribution, winner.plot_id || '', winner.proof_digest || '');
      if (!block) return null;
      const result = chain.addBlock(block, { skipStateValidation: true, skipPocValidation: true });
      if (!result.ok) return null;
      this.db.prepare('UPDATE mining_challenges SET forged_block_height = ? WHERE challenge_id = ? AND forged_block_height IS NULL').run(block.height, challenge.challenge_id);
      log('info', `Block #${block.height} forged — challenge ${challenge.challenge_id.slice(0, 12)} (${distribution.length} miners, reward ${totalReward} CC)`);
      if (syncEngine) setImmediate(() => { syncEngine.broadcastBlock(block); });
      return block;
    } catch (e) { log('error', `forge error: ${e.message}`); return null; }
  }
}

module.exports = { ChallengeManager, TIERS, TIER_REWARD_PCT, getTier, computeBaseTargetWithTier };
