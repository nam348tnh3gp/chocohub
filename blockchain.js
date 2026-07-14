// blockchain.js - PoW chuẩn với blockchain liên tục, per-worker difficulty, reward 0.05 CC/block
// Tích hợp mempool và phí giao dịch
const crypto = require('crypto');
const db = require('./db');

// ─── Cấu hình ────────────────────────────────────
const REWARD_PER_BLOCK = 0.05;                  // 0.05 CC, maybe we change it, who knows...
const INITIAL_DIFFICULTY = 5;                  // Initial diff (global)
const TIER_INITIAL_DIFFICULTY = {
  embedded_avr: 2,
  embedded_arm: 5,
  embedded_esp: 50,
  embedded_esp32: 100,
  mobile: 300,
  cpu: 500,
  gpu: 1000,
  asic: 10000
};
const JOB_EXPIRE_SECONDS = 15;                  // Time to job expire
const MIN_DIFFICULTY = 1;                       // Minimum Possible diff
const MAX_DIFFICULTY = 1000000000;              // Max Possible Diff
const DIFFICULTY_ADJUSTMENT_FACTOR = 0.5;       // diff adjustment factor (max change)
const TARGET_SOLVE_TIME = 10;                   // Expected solve time for each worker (timeout causes diff to get lower)

const TIER_CONFIG = {
  // Defining Tiers, Multiplier, Max diff and max Hashrate, balanced for most users :)
  embedded_avr: {
    multiplier: 3.5,
    maxDifficulty: 25,
    maxHashrate: 50,
    description: 'Arduino, AVR microcontrollers (~30 H/s SHA-256)'
  },
  embedded_arm: {
    multiplier: 3.0,
    maxDifficulty: 500,
    maxHashrate: 1000,
    description: 'Raspberry Pi Pico, RP2040 (~500 H/s SHA-256)'
  },
  embedded_esp: {
    multiplier: 2.5,
    maxDifficulty: 5000,
    maxHashrate: 10000,
    description: 'ESP8266, NodeMCU (~5 kH/s SHA-256)'
  },
  embedded_esp32: {
    multiplier: 2.0,
    maxDifficulty: 7500,
    maxHashrate: 15000,
    description: 'ESP32, ESP32-S2, ESP32-C3 (~7 kH/s SHA-256)'
  },
  mobile: {
    multiplier: 1.8,
    maxDifficulty: 2500,
    maxHashrate: 500000,
    description: 'Android, iOS (~200 kH/s SHA-256)'
  },
  cpu: {
    multiplier: 1.0,
    maxDifficulty: 5000000,
    maxHashrate: 10000000,
    description: 'Desktop CPU, web miner (~500 kH/s-5 MH/s SHA-256)'
  },
  gpu: {
    multiplier: 2.0,
    maxDifficulty: 100000000,
    maxHashrate: 200000000,
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
const MAX_MEMPOOL_PER_BLOCK = 50;                // Max mempool per block, bruh
const MEMPOOL_HOLDING_ACCOUNT = 'mempool_holding'; // The account that holds mempool transactions

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
    console.log('🌱 Genesis block created Succesfuly :)');
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
    if (deviceType === 'mobile_web' || deviceType === 'mobile') {
      tier = 'mobile';
      try { db.setWorkerTier(diffKey, 'mobile'); } catch (e) { }
    } else if (deviceType === 'desktop_web') {
      tier = 'cpu';
    }
  }
  const tierConfig = TIER_CONFIG[tier] || TIER_CONFIG.cpu;

  let diff = db.getWorkerDifficulty(diffKey);
  if (diff === null) {
    diff = TIER_INITIAL_DIFFICULTY[tier] || INITIAL_DIFFICULTY;
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
      `UPDATE mining_jobs SET assigned_to = ?, difficulty = ?, target_hex = ?, created_at = datetime('now') WHERE id = ?`
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
  preCreateJobs(height + 1, 10, prevHash);

  const newJob = db.getActiveJob(jobId);
  return mapJob(newJob);
}

const JOB_POOL_SIZE = 1;

function preCreateJobs(fromHeight, count, lastPrevHash) {
  for (let i = 0; i < count; i++) {
    const h = fromHeight + i;
    const existing = db.prepare(
      'SELECT id FROM mining_jobs WHERE height = ? AND status = ?'
    ).get(h, 'active');
    if (existing) continue;

    const blockAtHeight = db.getBlockByHeight(h);
    if (blockAtHeight) continue;

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
function processMempoolForBlock(blockHeight, minerUser) {
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
    // Cộng fee vào miner who included this block
    if (tx.fee > 0 && minerUser) {
      db.updateBalance(minerUser, tx.fee);
      try {
        db.addTransaction('mempool_holding', minerUser, tx.fee);
      } catch (e) {}
    }
    totalFees += tx.fee;

    // Đánh dấu đã xác nhận
    db.markMempoolConfirmed(tx.id, blockHeight);
    processed++;

    // Ghi log giao dịch (tuỳ chọn)
    try {
      db.addTransaction(tx.from_username, tx.to_username, tx.amount);
    } catch (e) {
      // Bỏ qua lỗi ghi log
    }

    console.log(`✅ Mempool tx ${tx.id} confirmed in block ${blockHeight}: ${tx.amount} CC to ${tx.to_username}, fee ${tx.fee} CC → miner ${minerUser}`);
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

  // Reject if a block at this height already exists (prevents duplicates)
  const existingBlock = db.getBlockByHeight(job.height);
  if (existingBlock) {
    db.deleteJobsAtHeight(job.height, jobId);
    throw new Error(`Block ${job.height} already mined. Submit at next height.`);
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

  // Check user-level suspension (blocks ALL workers of this user)
  if (db.isUserSuspended(userName)) {
    console.warn(`🚫 User ${userName} is suspended at account level`);
    throw new Error('Account suspended for suspicious behavior. Contact admin to appeal.');
  }

  // Kiểm tra nonce (hash uses diffKey to match client computation)
  const input = job.prev_hash + String(nonce).padStart(20, '0') + diffKey;
  const hashHex = crypto.createHash('sha256').update(input).digest('hex');

  if (hashHex >= job.target_hex) {
    return { status: 'error', reason: `Invalid nonce: hash ${hashHex.substring(0,12)}... >= target` };
  }

  const timestamp = Math.floor(Date.now() / 1000);

  // Read tier from job record
  let tier = job.tier || 'cpu';
  let tierConfig = TIER_CONFIG[tier] || TIER_CONFIG.cpu;

  // Auto-tier: upgrade if sustained hashrate exceeds tier max (multi-device rigs)
  // Only adjusts between mobile → cpu → gpu (embedded tiers stay fixed)
  if (hashrateReported && hashrateReported > 0 && tierConfig.maxHashrate) {
    const reportedRatio = hashrateReported / tierConfig.maxHashrate;
    if (reportedRatio > 2.0) {
      const adjustableTiers = ['mobile', 'cpu', 'gpu'];
      for (const t of adjustableTiers) {
        if (TIER_CONFIG[t].maxHashrate >= hashrateReported) {
          if (t !== tier && adjustableTiers.includes(tier)) {
            console.log(`🔄 Auto-tier: ${userName} upgraded from ${tier} → ${t} (reported ${hashrateReported.toExponential(2)} H/s)`);
            try {
              db.setWorkerTier(userName, t);
            } catch (e) {
              console.warn(`⚠️ Auto-tier: could not persist tier change for ${userName} (${e.message}) — applying for this block only`);
            }
            tier = t;
            tierConfig = TIER_CONFIG[t];
          }
          break;
        }
      }
    }
  }

  // Cross-check reported hashrate vs device capability
  if (hashrateReported && hashrateReported > 0 && tierConfig.maxHashrate) {
    const reportedRatio = hashrateReported / tierConfig.maxHashrate;
    if (reportedRatio > 2.5) {
      const reason = `Reported ${hashrateReported.toExponential(2)} H/s for ${tier} (max ${tierConfig.maxHashrate.toExponential(2)} H/s, ${reportedRatio.toFixed(1)}x over). Device type mismatch.`;
      db.addWorkerWarning(userName, reason);
      console.warn(`🤔 This worker have a total of ${hashrateReported.toExponential(2)} H/s, when the normal is ${tierConfig.maxHashrate.toExponential(2)} H/s`)
      console.warn(`🤨 Impossible hashrate for device type: ${diffKey} - ${reason}`);
      const updatedFlags = db.getWorkerFlags(userName);
      if (updatedFlags.suspended) {
        console.warn(`🚫 User ${userName} auto-suspended for device type fraud`);
        return {
          status: 'error',
          reason: 'Worker suspended for device type fraud. Submit from correct device.',
          warnings: updatedFlags.warning_count
        };
      }
    }
  }

  // Hashrate validation (cross-check reported hashrate vs actual solve time)
  const jobCreatedTimestamp = parseFlexibleDate(job.created_at);
  const actualSolveTime = timestamp - jobCreatedTimestamp;

  // PoW solve times are exponentially (memoryless) distributed, not fixed —
  // a single solve landing far below the *average* implied time is normal
  // random variance, not evidence of cheating. VARIANCE_TOLERANCE widens the
  // window before flagging, and MIN_SOLVE_TIME_FLOOR prevents division blowups
  // on very fast (lucky, low-difficulty) solves.
  const VARIANCE_TOLERANCE = 8;
  const MIN_SOLVE_TIME_FLOOR = 0.25; // seconds

  // Cross-check actual hashrate vs device capability
  // For high-capability tiers (cpu/gpu), allow fast solves on low diff
  // For low-capability tiers (avr/esp), flag impossibly fast solves
  if (tierConfig.maxHashrate && tierConfig.maxHashrate <= 1000) {
    // Low-hashrate tier: check if solve time is realistic for the tier
    const minRealisticTime = job.difficulty / (tierConfig.maxHashrate * VARIANCE_TOLERANCE);
    console.log(`🔍 Anti-cheat: tier=${tier} maxHR=${tierConfig.maxHashrate} diff=${job.difficulty} solveTime=${actualSolveTime.toFixed(4)}s minRealistic=${minRealisticTime.toFixed(4)}s`);
    if (actualSolveTime <= minRealisticTime) {
      const solveTimeFloor = Math.max(actualSolveTime, MIN_SOLVE_TIME_FLOOR);
      const actualHashrate = job.difficulty / solveTimeFloor;
      const actualRatio = actualHashrate / tierConfig.maxHashrate;
      // Extra detail if hashrate was also missing/zero
      const hrNote = (!hashrateReported || hashrateReported <= 0)
        ? ` (also: hashrate_reported missing/zero — possible bypass attempt)`
        : ` (reported: ${hashrateReported} H/s)`;
      const reason = `Actual hashrate ${actualHashrate.toExponential(2)} H/s is ${actualRatio.toFixed(1)}x over ${tier} max (${tierConfig.maxHashrate.toExponential(2)} H/s). Solve time ${actualSolveTime.toFixed(4)}s is impossibly fast for ${tier}.${hrNote}`;
      db.addWorkerWarning(userName, reason);
      console.warn(`⚠️ Device fraud (fast tier): ${diffKey} - ${reason}`);
      const updatedFlags = db.getWorkerFlags(userName);
      if (updatedFlags.suspended) {
        console.warn(`🚫 User ${userName} auto-suspended for device type fraud`);
        return {
          status: 'error',
          reason: 'Worker suspended for device type fraud. Submit from correct device.',
          warnings: updatedFlags.warning_count
        };
      }
    }
  } else if (tierConfig.maxHashrate) {
    // High-capability tier: check if actual hashrate exceeds max.
    // Use the same variance-tolerant floor as the low-hashrate branch above —
    // a single fast/lucky solve at low difficulty is expected PoW randomness, 
    // not proof of a faster device.
    const solveTimeFloor = Math.max(actualSolveTime, MIN_SOLVE_TIME_FLOOR);
    const actualHashrate = job.difficulty / solveTimeFloor;
    const actualRatio = actualHashrate / tierConfig.maxHashrate;
    if (actualRatio > VARIANCE_TOLERANCE) {
      const reason = `Actual hashrate ${actualHashrate.toExponential(2)} H/s is ${actualRatio.toFixed(1)}x over ${tier} max (${tierConfig.maxHashrate.toExponential(2)} H/s). Device mismatch.`;
      db.addWorkerWarning(userName, reason);
      console.warn(`⚠️ Device fraud: ${diffKey} - ${reason}`);
      const updatedFlags = db.getWorkerFlags(userName);
      if (updatedFlags.suspended) {
        console.warn(`🚫 User ${userName} auto-suspended for device type fraud`);
        return {
          status: 'error',
          reason: 'Worker suspended for device type fraud. Submit from correct device.',
          warnings: updatedFlags.warning_count
        };
      }
    }
  }

  if (hashrateReported && hashrateReported > 0) {
    const expectedSolveTime = job.difficulty / hashrateReported;
    const ratio = actualSolveTime / expectedSolveTime;

    // Solve time is exponentially distributed around the expected value, so
    // a legit worker will regularly solve well under the "expected" time —
    // only flag truly extreme outliers (previously 20x, which fired constantly
    // on ordinary variance).
    if (ratio < (1 / (VARIANCE_TOLERANCE * 6))) {
      const reason = `Solved in ${actualSolveTime.toFixed(1)}s but reported hashrate ${hashrateReported} H/s implies ${expectedSolveTime.toFixed(1)}s (ratio ${ratio.toFixed(3)})`;
      db.addWorkerWarning(userName, reason);
      console.warn(`⚠️ Suspicious solve: ${diffKey} - ${reason}`);

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
  const mempoolResult = processMempoolForBlock(newBlock.height, userName);

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

  let idealDiff = currentDiff * (targetTime / solveTime);
  let newDiff = currentDiff + (idealDiff - currentDiff) * DIFFICULTY_ADJUSTMENT_FACTOR;
  const maxChange = currentDiff * 0.5;
  newDiff = Math.max(currentDiff - maxChange, Math.min(currentDiff + maxChange, newDiff));
  const tier = db.getWorkerTier(workerName) || 'cpu';
  const tierMax = TIER_CONFIG[tier] ? TIER_CONFIG[tier].maxDifficulty : MAX_DIFFICULTY;
  newDiff = Math.max(MIN_DIFFICULTY, Math.min(tierMax, newDiff));
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
  TIER_INITIAL_DIFFICULTY,
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
