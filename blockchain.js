// blockchain.js - PoW chuẩn với blockchain liên tục, per-worker difficulty, reward 0.05 CC/block
// Tích hợp mempool và phí giao dịch
const crypto = require('crypto');
const db = require('./db');

// ─── Cấu hình ────────────────────────────────────
const REWARD_PER_BLOCK = 0.05;                  // 0.05 CC
const INITIAL_DIFFICULTY = 10;                  // mặc định cho worker mới
const JOB_EXPIRE_SECONDS = 60;                  // job hết hạn sau 60s
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 1000000000;
const DIFFICULTY_ADJUSTMENT_FACTOR = 0.5;       // hệ số điều chỉnh (0.5 = trung bình)
const TARGET_SOLVE_TIME = 10;                   // giây mong muốn (cho per‑worker điều chỉnh)

// ─── 🆕 TIER CONFIGURATION (replaces DEVICE_REWARD_MULTIPLIERS) ──
// Tier determines: reward multiplier + difficulty cap
// Embedded devices get higher multipliers (fair reward for lower power)
// GPU multiplier changed from 0.5x to 1.0x (difficulty adjustment already handles speed)
const TIER_CONFIG = {
  embedded_avr: {
    multiplier: 3.5,
    maxDifficulty: 5000,
    description: 'Arduino, AVR microcontrollers (~30 H/s SHA-256)'
  },
  embedded_arm: {
    multiplier: 3.0,
    maxDifficulty: 50000,
    description: 'Raspberry Pi Pico, RP2040 (~500 H/s SHA-256)'
  },
  embedded_esp: {
    multiplier: 2.5,
    maxDifficulty: 100000,
    description: 'ESP8266, NodeMCU (~5 kH/s SHA-256)'
  },
  embedded_esp32: {
    multiplier: 2.0,
    maxDifficulty: 500000,
    description: 'ESP32, ESP32-S2, ESP32-C3 (~30 kH/s SHA-256)'
  },
  mobile: {
    multiplier: 1.8,
    maxDifficulty: 10000,
    description: 'Android, iOS (~200 kH/s SHA-256)'
  },
  cpu: {
    multiplier: 1.0,
    maxDifficulty: 1000000000,
    description: 'Desktop CPU, web miner (~500 kH/s-5 MH/s SHA-256)'
  },
  gpu: {
    multiplier: 1.0,
    maxDifficulty: 1000000000,
    description: 'GPU mining (~5-100 MH/s SHA-256)'
  }
};

// ─── Old device multipliers (deprecated, kept for backward compatibility) ──
const DEVICE_REWARD_MULTIPLIERS = {
  'esp32': 3.0,
  'esp8266': 3.0,
  'arduino': 3.5,
  'rp2040': 3.5,
  'pico': 3.5,
  'mobile': 2.0,
  'android': 2.0,
  'ios': 2.0,
  'web_miner': 1.0,
  'cpu': 1.0,
  'cpu_miner': 1.0,
  'gpu': 1.0, // Changed from 0.5 to 1.0
  'gpu_miner': 1.0,
  'nvidia': 1.0,
  'amd': 1.0,
  'default': 1.0
};

// ─── Cấu hình mempool ────────────────────────────
const MAX_MEMPOOL_PER_BLOCK = 50;                // số giao dịch tối đa mỗi block
const MEMPOOL_HOLDING_ACCOUNT = 'mempool_holding';

// ─── Helper: chuyển difficulty → target hex ──
function difficultyToTarget(difficulty) {
  const maxTarget = (1n << 256n) - 1n;
  const diffScaled = BigInt(Math.floor(difficulty * 1000));
  if (diffScaled === 0n) return 'f'.repeat(64);
  const targetValue = maxTarget / diffScaled;
  return targetValue.toString(16).padStart(64, '0');
}

// ─── Khởi tạo blockchain (genesis) ─────────────
function initBlockchain() {
  const last = db.getLastBlock();
  if (!last) {
    const genesis = {
      height: 0,
      hash: '0'.repeat(64),
      prev_hash: '0'.repeat(64),
      miner: 'genesis',
      nonce: '0',
      timestamp: Math.floor(Date.now() / 1000),
      reward: 0,
      difficulty: INITIAL_DIFFICULTY,
      tx_count: 0,
      total_fees: 0
    };
    db.insertBlock(genesis);
    console.log('🌱 Genesis block created');
  }

  // Seed pool job at next height
  const lastBlock = getLastBlock();
  if (lastBlock) {
    preCreateJobs(lastBlock.height + 1, JOB_POOL_SIZE, lastBlock.hash);
  }
}

// ─── Lấy block cuối ────────────────────────────
function getLastBlock() {
  return db.getLastBlock();
}

// ─── Helper: parse SQLite datetime('now') or ISO string ──
function parseFlexibleDate(str) {
  if (!str) return 0;
  const iso = str.includes('T') ? str : str.replace(' ', 'T');
  return new Date(iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z').getTime() / 1000;
}

// ─── Decay difficulty when a job times out without a solve ──
function decayWorkerDifficulty(workerName, missedSeconds) {
  const currentDiff = db.getWorkerDifficulty(workerName) || INITIAL_DIFFICULTY;
  const overrun = missedSeconds / TARGET_SOLVE_TIME;
  let newDiff = currentDiff / Math.max(1.1, Math.min(overrun, 20));
  const maxChange = currentDiff * 0.9;
  newDiff = Math.max(currentDiff - maxChange, newDiff);
  newDiff = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, newDiff));
  newDiff = Math.round(newDiff * 10) / 10;
  db.setWorkerDifficulty(workerName, newDiff, Date.now());
  console.log(`⏱️ ${workerName} timed out (${missedSeconds.toFixed(1)}s, no solve): difficulty ${currentDiff.toFixed(1)} → ${newDiff.toFixed(1)}`);
}

// ─── Lấy job cho worker (tạo mới nếu chưa có) ─
function getJobForWorker(workerName, instanceId, deviceType) {
  const diffKey = instanceId ? workerName + ':' + instanceId : workerName;

  const staleJob = db.getJobForWorker(diffKey);
  if (staleJob) {
    const createdTs = parseFlexibleDate(staleJob.created_at);
    const ageSeconds = (Date.now() / 1000) - createdTs;
    if (ageSeconds > JOB_EXPIRE_SECONDS) {
      decayWorkerDifficulty(diffKey, ageSeconds);
      db.setWorkerDifficulty(diffKey + '_timeout', Date.now(), Date.now());
    }
  }

  const lastTimeout = db.getWorkerDifficulty(diffKey + '_timeout');
  if (lastTimeout) {
    const cooldownElapsed = (Date.now() - lastTimeout) / 1000;
    if (cooldownElapsed < 10) {
      const existingJob = db.getJobForWorker(diffKey);
      if (existingJob) return mapJob(existingJob);
      return { status: 'cooldown', message: 'Wait before requesting a new job', retry_after: Math.ceil(10 - cooldownElapsed) };
    }
    db.setWorkerDifficulty(diffKey + '_timeout', 0, 0);
  }

  db.cleanupExpiredJobs(JOB_EXPIRE_SECONDS);

  let job = db.getJobForWorker(diffKey);
  if (job) {
    const blockAtHeight = db.getBlockByHeight(job.height);
    if (blockAtHeight) {
      db.deleteJobsAtHeight(job.height);
      job = null;
    } else {
      return mapJob(job);
    }
  }

  const lastBlock = getLastBlock();
  const height = lastBlock ? lastBlock.height + 1 : 0;
  const prevHash = lastBlock ? lastBlock.hash : '0'.repeat(64);

  let tier = db.getWorkerTier(diffKey);
  if (!tier || tier === 'cpu') {
    tier = db.getWorkerTier(workerName);
  }
  if (!tier || tier === 'cpu') {
    if (deviceType === 'mobile_web') {
      tier = 'mobile';
      try { db.setWorkerTier(diffKey, 'mobile'); } catch (e) { }
    }
  }
  const tierConfig = TIER_CONFIG[tier] || TIER_CONFIG.cpu;

  let diff = db.getWorkerDifficulty(diffKey);
  if (diff === null) {
    if (deviceType === 'mobile_web') {
      diff = 100;
    } else {
      diff = INITIAL_DIFFICULTY;
    }
    db.setWorkerDifficulty(diffKey, diff, Date.now());
  }

  diff = Math.max(MIN_DIFFICULTY, Math.min(tierConfig.maxDifficulty, diff));

  // Persist the capped difficulty so stored value stays within tier limits
  db.setWorkerDifficulty(diffKey, diff, Date.now());

  // Try to grab a pool job at the next height
  const poolJob = db.prepare(
    'SELECT * FROM mining_jobs WHERE height = ? AND status = ? AND assigned_to = ? ORDER BY created_at ASC LIMIT 1'
  ).get(height, 'active', '_pool');

  if (poolJob) {
    const poolTargetHex = difficultyToTarget(diff);
    db.prepare(
      'UPDATE mining_jobs SET assigned_to = ?, difficulty = ?, target_hex = ? WHERE id = ?'
    ).run(diffKey, diff, poolTargetHex, poolJob.id);
    return mapJob(Object.assign({}, poolJob, { difficulty: diff, target_hex: poolTargetHex }));
  }

  const targetHex = difficultyToTarget(diff);
  const reward = REWARD_PER_BLOCK;
  const multiplier = tierConfig.multiplier;

  const jobId = 'job_' + crypto.randomBytes(6).toString('hex');
  db.createJob({
    id: jobId,
    height: height,
    prev_hash: prevHash,
    difficulty: diff,
    target_hex: targetHex,
    reward: reward,
    assigned_to: diffKey,
    tier: tier,
    reward_multiplier: multiplier
  });

  // Pre-create jobs at next heights so other miners have work too
  preCreateJobs(height + 1, 3, prevHash);

  const newJob = db.getActiveJob(jobId);
  return mapJob(newJob);
}

const JOB_POOL_SIZE = 1;

function preCreateJobs(fromHeight, count, lastPrevHash) {
  const h = fromHeight;
  const existing = db.prepare(
    'SELECT id FROM mining_jobs WHERE height = ? AND status = ?'
  ).get(h, 'active');
  if (existing) return;

  const blockAtHeight = db.getBlockByHeight(h);
  if (blockAtHeight) return;

  const targetHex = difficultyToTarget(INITIAL_DIFFICULTY);
  const jobId = 'job_' + crypto.randomBytes(6).toString('hex');
  db.createJob({
    id: jobId,
    height: h,
    prev_hash: lastPrevHash,
    difficulty: INITIAL_DIFFICULTY,
    target_hex: targetHex,
    reward: REWARD_PER_BLOCK,
    assigned_to: '_pool',
    tier: 'cpu',
    reward_multiplier: 1.0
  });
}

// ─── Chuyển đổi job object ─────────────────────
function mapJob(job) {
  if (!job) return null;
  return {
    job_id: job.id,
    height: job.height,
    prev_hash: job.prev_hash,
    difficulty: job.difficulty,
    target_hex: job.target_hex,
    reward: job.reward,
    assigned_to: job.assigned_to,
    tier: job.tier || 'cpu',
    reward_multiplier: job.reward_multiplier || 1.0
  };
}

// ─── Xử lý các giao dịch trong mempool khi tạo block ──
function processMempoolForBlock(blockHeight) {
  // Lấy tối đa MAX_MEMPOOL_PER_BLOCK giao dịch pending
  const txs = db.getPendingMempool(MAX_MEMPOOL_PER_BLOCK);
  if (!txs || txs.length === 0) {
    return { processed: 0, totalFees: 0 };
  }

  let processed = 0;
  let totalFees = 0;

  // Kiểm tra tài khoản holding
  const holding = db.getUser(MEMPOOL_HOLDING_ACCOUNT);
  if (!holding) {
    console.warn('⚠️ mempool_holding account does not exist!');
    // Đánh dấu tất cả là failed
    for (const tx of txs) {
      db.markMempoolFailed(tx.id);
    }
    return { processed: 0, totalFees: 0 };
  }

  for (const tx of txs) {
    // Kiểm tra người nhận có tồn tại không
    const receiver = db.getUser(tx.to_username);
    if (!receiver) {
      db.markMempoolFailed(tx.id);
      console.warn(`❌ Mempool tx ${tx.id}: receiver ${tx.to_username} not found`);
      continue;
    }

    // Kiểm tra số dư holding
    if (holding.balance < tx.total_deducted) {
      db.markMempoolFailed(tx.id);
      console.warn(`❌ Mempool tx ${tx.id}: insufficient holding balance (${holding.balance} < ${tx.total_deducted})`);
      continue;
    }

    // Trừ từ holding
    db.updateBalance(MEMPOOL_HOLDING_ACCOUNT, -tx.total_deducted);
    // Cộng amount cho receiver
    db.updateBalance(tx.to_username, tx.amount);
    // Cộng fee vào node_fees
    const feeAdded = db.addNodeFees(tx.fee);
    if (feeAdded > 0) {
      totalFees += feeAdded;
    }

    // Đánh dấu đã xác nhận
    db.markMempoolConfirmed(tx.id, blockHeight);
    processed++;

    // Ghi log giao dịch (tuỳ chọn)
    try {
      db.addTransaction(tx.from_username, tx.to_username, tx.amount);
    } catch (e) {
      // Bỏ qua lỗi ghi log
    }

    console.log(`✅ Mempool tx ${tx.id} confirmed in block ${blockHeight}: ${tx.amount} CC to ${tx.to_username}, fee ${tx.fee} CC`);
  }

  return { processed: processed, totalFees: totalFees };
}

// ─── Helper: multiplicador por tipo de dispositivo ─
function getDeviceMultiplier(deviceType) {
  const key = (deviceType || 'default').toLowerCase().trim();
  return DEVICE_REWARD_MULTIPLIERS[key] || DEVICE_REWARD_MULTIPLIERS['default'];
}

// ─── Submit solution ────────────────────────────
function submitSolution(jobId, nonce, workerName, deviceType, hashrateReported, instanceId, nodeId) {
  const diffKey = instanceId ? workerName + ':' + instanceId : workerName;
  const userName = diffKey.includes(':') ? diffKey.split(':')[0] : diffKey;
  const job = db.getActiveJob(jobId);
  if (!job) {
    throw new Error('Job not found or already solved');
  }
  if (job.assigned_to && job.assigned_to !== diffKey && job.assigned_to !== '_pool') {
    throw new Error('This job is assigned to another worker');
  }

  // Claim pool job for this worker
  if (job.assigned_to === '_pool') {
    db.prepare('UPDATE mining_jobs SET assigned_to = ? WHERE id = ?').run(diffKey, jobId);
  }

  // Suspension check uses the user account (shared across instances)
  const flags = db.getWorkerFlags(userName);
  if (flags && flags.suspended) {
    console.warn(`🚫 Suspended user ${userName} attempted to submit solution`);
    throw new Error('Worker suspended for suspicious behavior. Contact admin to appeal.');
  }

  // Kiểm tra nonce (hash uses diffKey to match client computation)
  const input = job.prev_hash + String(nonce).padStart(20, '0') + diffKey;
  const hashHex = crypto.createHash('sha256').update(input).digest('hex');

  if (hashHex >= job.target_hex) {
    return { status: 'error', reason: `Invalid nonce: hash ${hashHex.substring(0,12)}... >= target` };
  }

  const timestamp = Math.floor(Date.now() / 1000);

  // 🆕 Hashrate validation (cross-check reported hashrate vs actual solve time)
  if (hashrateReported && hashrateReported > 0) {
    const jobCreatedTimestamp = parseFlexibleDate(job.created_at);
    const actualSolveTime = timestamp - jobCreatedTimestamp;
    const expectedSolveTime = job.difficulty / hashrateReported;
    const ratio = actualSolveTime / expectedSolveTime;

    // If solved 20x faster than hashrate implies → suspicious
    if (ratio < 0.05 && actualSolveTime > 0.1) {
      const reason = `Solved in ${actualSolveTime.toFixed(1)}s but reported hashrate ${hashrateReported} H/s implies ${expectedSolveTime.toFixed(1)}s (ratio ${ratio.toFixed(3)})`;
      db.addWorkerWarning(userName, reason);
      console.warn(`⚠️ Suspicious solve: ${diffKey} - ${reason}`);

      // Check if this warning caused suspension
      const updatedFlags = db.getWorkerFlags(userName);
      if (updatedFlags.suspended) {
        console.warn(`🚫 User ${userName} auto-suspended after hashrate validation failure`);
        return {
          status: 'error',
          reason: 'Worker suspended due to suspicious behavior (3 warnings in 24h). Solution rejected.',
          warnings: updatedFlags.warning_count
        };
      }
    }
  }

  // 🆕 Read tier and multiplier from job record (immutable, server-controlled)
  const tier = job.tier || 'cpu';
  const tierMultiplier = job.reward_multiplier || 1.0;

  // ─── Device multiplier: use tier from job, legacy fallback for old jobs ──
  let deviceMultiplier = tierMultiplier;
  if (!job.tier) {
    deviceMultiplier = getDeviceMultiplier(deviceType);
    console.log(`⚠️ Legacy job ${jobId} using device_type multiplier: ${deviceMultiplier}x`);
  }

  // 🆕 Reward split: 5% to PoS pool (flat, always), rest to miner
  // If nodeId: 90% miner / 5% node / 5% PoS
  // If no node: 95% miner / 5% PoS
  const POS_REWARD_SHARE = 0.05;
  const posContribution = parseFloat((REWARD_PER_BLOCK * POS_REWARD_SHARE).toFixed(8)); // always 0.0025 CC

  let minerShare, nodeContribution;
  if (nodeId) {
    minerShare = 0.90;
    nodeContribution = parseFloat((REWARD_PER_BLOCK * 0.05).toFixed(8)); // 0.0025 CC
  } else {
    minerShare = 0.95;
    nodeContribution = 0;
  }
  const minerBase = parseFloat((REWARD_PER_BLOCK * minerShare).toFixed(8));

  // miner reward = minerBase × tier_multiplier
  const deviceReward = parseFloat((minerBase * deviceMultiplier).toFixed(8));

  // ─── Mining Boost: multiplicador 1.3x se ativo ──
  const boostMultiplier = db.getMiningBoostMultiplier(diffKey);
  const finalReward = parseFloat((deviceReward * boostMultiplier).toFixed(8));
  const bonusReward = parseFloat((finalReward - deviceReward).toFixed(8));

  // 🆕 Credit PoS pool + miner + node — ALL in one transaction to prevent race condition
  const newBlock = {
    height: job.height,
    hash: hashHex,
    prev_hash: job.prev_hash,
    miner: diffKey,
    nonce: String(nonce),
    timestamp: timestamp,
    reward: finalReward,
    difficulty: job.difficulty,
    tx_count: 0,
    total_fees: 0,
    device_type: deviceType || 'unknown',
    tier: tier,
    pos_contribution: posContribution
  };

  // Atomic: block insert + balance + PoS pool + node earnings — rolls back on failure
  db.submitBlockTransaction(newBlock, userName, finalReward, posContribution, nodeId, nodeContribution);

  if (nodeId && nodeContribution > 0) {
    console.log(`📡 Node ${nodeId} earned ${nodeContribution} CC`);
  }

  if (bonusReward > 0) {
    console.log(`⚡ Mining boost active for ${diffKey}: ${deviceReward} → ${finalReward} CC (${boostMultiplier}x)`);
  }

  // ─── Xử lý mempool ──────────────────────────────
  const mempoolResult = processMempoolForBlock(newBlock.height);

  // Cập nhật tx_count và total_fees cho block
  if (mempoolResult.processed > 0 || mempoolResult.totalFees > 0) {
    db.updateBlockFees(newBlock.height, mempoolResult.totalFees);
    newBlock.tx_count = mempoolResult.processed;
    newBlock.total_fees = mempoolResult.totalFees;
  }

  // Mark the winning job solved, then wipe ALL active jobs at this height
  // (other workers may still have active jobs targeting the same height —
  // leaving them alive is what caused the UNIQUE constraint rejection loop).
  db.markJobSolved(jobId);
  db.deleteJobsAtHeight(job.height, jobId);
  db.deleteJobsForWorker(diffKey, jobId);

  // Pre-create jobs at next heights for other miners
  preCreateJobs(newBlock.height + 1, JOB_POOL_SIZE, hashHex);

  // Điều chỉnh difficulty cho instance dựa trên thời gian giải
  const solveTime = (timestamp - parseFlexibleDate(job.created_at));
  if (solveTime > 0) {
    adjustWorkerDifficulty(diffKey, solveTime);
  }

  // Gửi thông báo (webhook)
  sendMinerWebhook(diffKey, newBlock.height, tier, finalReward);

  const logParts = [
    `⛏️ Block ${newBlock.height} solved by ${diffKey}`,
    `tier: ${tier} (${tierMultiplier}x)`,
    `PoS: ${posContribution} CC · miner: ${finalReward} CC`
  ];
  if (boostMultiplier > 1) logParts.push(`boost: ${boostMultiplier}x`);
  logParts.push(`${mempoolResult.processed} txs, fees ${mempoolResult.totalFees} CC`);
  console.log(logParts.join(' · '));

  return {
    status: 'success',
    message: `Block ${newBlock.height} solved! Miner reward: ${finalReward} CC (${tierMultiplier}x ${tier})${boostMultiplier > 1 ? ` (${boostMultiplier}x boost)` : ''}. PoS pool +${posContribution} CC. ${mempoolResult.processed} transactions processed`,
    reward: finalReward,
    pos_contribution: posContribution,
    block_hash: hashHex,
    tx_count: mempoolResult.processed,
    total_fees: mempoolResult.totalFees,
    tier: tier,
    tier_multiplier: tierMultiplier,
    boost_multiplier: boostMultiplier
  };
}

// ─── Điều chỉnh difficulty cho worker ──────────
function adjustWorkerDifficulty(workerName, solveTime) {
  const currentDiff = db.getWorkerDifficulty(workerName) || INITIAL_DIFFICULTY;
  const targetTime = TARGET_SOLVE_TIME;

  // Tính toán difficulty mới
  let idealDiff = currentDiff * (targetTime / solveTime);
  let newDiff = currentDiff + (idealDiff - currentDiff) * 0.75;
  // Giới hạn thay đổi tối đa 100% để tránh ramp quá nhanh
  const maxChange = currentDiff * 1.0;
  newDiff = Math.max(currentDiff - maxChange, Math.min(currentDiff + maxChange, newDiff));
  newDiff = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, newDiff));
  newDiff = Math.round(newDiff * 10) / 10;

  db.setWorkerDifficulty(workerName, newDiff, Date.now());
  console.log(`👷 Worker ${workerName}: difficulty ${currentDiff.toFixed(1)} → ${newDiff.toFixed(1)} (solve time ${solveTime.toFixed(1)}s)`);
}

// ─── Đặt lại difficulty về mức an toàn cho tier ──
function capWorkerDifficulty(workerName, tier) {
  const tierConfig = TIER_CONFIG[tier] || TIER_CONFIG.cpu;
  const currentDiff = db.getWorkerDifficulty(workerName);
  if (currentDiff === null) return;
  const capped = Math.min(currentDiff, tierConfig.maxDifficulty);
  if (capped < currentDiff) {
    db.setWorkerDifficulty(workerName, capped, Date.now());
    console.log(`📉 Worker ${workerName}: difficulty capped from ${currentDiff.toFixed(1)} → ${capped.toFixed(1)} (tier: ${tier})`);
  }
}

// ─── Webhook ─────────────────────────────────────
async function sendMinerWebhook(worker, height, device, reward) {
  try {
    await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: "⛏️ New Block Mined!",
          description: `Block **#${height}** was solved.\n\n**Worker:** \`${worker}\`\n**Device:** \`${device}\`\n**Reward:** ${reward.toFixed(4)} CC`,
          color: 0xf1c40f,
          timestamp: new Date().toISOString(),
          footer: { text: "ChocoHub PoW" }
        }]
      })
    });
  } catch (err) {
    console.error('⚠️ Webhook error:', err.message);
  }
}

// ─── PoS (giữ nguyên từ cũ) ────────────────────
const POS_BLOCK_INTERVAL = 30000;
const MIN_STAKE = 10;
let currentValidator = null;

function getTopValidator() {
  const validators = db.getValidators(MIN_STAKE);
  return validators.length ? validators[0] : null;
}

function getCurrentValidator() {
  return currentValidator;
}

function distributePoSRewards() {
  const validator = getTopValidator();
  currentValidator = validator ? validator.username : null;

  const result = db.distributePosRewards(MIN_STAKE);
  if (!result || result.distributed <= 0) {
    const pool = db.getPosRewardPool ? db.getPosRewardPool() : { balance: 0 };
    if (!validator) {
      console.log('🔒 No eligible validator (no one has staked >= 10 CC)');
    } else if ((pool.balance || 0) <= 0) {
      console.log(`💤 PoS pool empty. Top validator: ${validator.username} (stake: ${validator.amount} CC)`);
    } else {
      console.log(`💤 PoS rewards pending. Pool available: ${(pool.balance || 0).toFixed(4)} CC`);
    }
    return;
  }

  console.log(
    `🏦 Distributed ${(result.distributed || 0).toFixed(8)} CC PoS rewards ` +
    `to ${result.recipients} stakers (total stake: ${Number(result.totalStake || 0).toFixed(4)} CC)`
  );
}

function startPoSMinting() {
  distributePoSRewards();
  setInterval(distributePoSRewards, POS_BLOCK_INTERVAL);
  console.log('🏦 PoS reward distribution started (fee-funded pool, proportional stake share)');
}

// ─── Khởi tạo khi load module ──────────────────
initBlockchain();

// ─── Export các hàm ─────────────────────────────
module.exports = {
  // Config (for other modules to read)
  TIER_CONFIG,
  // PoW mới
  getLastBlock: getLastBlock,
  getJobForWorker: getJobForWorker,
  submitSolution: submitSolution,
  // PoS
  startPoSMinting: startPoSMinting,
  distributePoSRewards: distributePoSRewards,
  getCurrentValidator: getCurrentValidator,
  getCurrentDifficulty: function() { return INITIAL_DIFFICULTY; },
  // Hàm cũ (để tương thích – có thể bỏ dần)
  getActiveBounties: function() { return {}; },
  getJob: function(id) { return null; },
  startAutoBounty: function() {},
  checkAndRefillBounties: function() {},
  cleanupOldBounties: function() {}
};
