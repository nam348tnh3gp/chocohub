const crypto = require('crypto');
const db = require('./db');

const REWARD_PER_BLOCK = 0.05;                  // 0.05 CC block reward.
const INITIAL_DIFFICULTY = 5;                  // Initial global difficulty
const TIER_INITIAL_DIFFICULTY = {
  embedded_avr: 1,
  embedded_arm: 5,
  embedded_esp: 50,
  embedded_esp32: 100,
  mobile: 300,
  cpu: 500,
  gpu: 1000,
  asic: 10000
};
const JOB_EXPIRE_SECONDS = 15;                  // Time until a job expires
const MIN_DIFFICULTY = 1;                       // Minimum possible difficulty
const MAX_DIFFICULTY = 1000000000;              // Maximum possible difficulty
const DIFFICULTY_ADJUSTMENT_FACTOR = 0.5;       // Difficulty adjustment factor (maximum change)
const TARGET_SOLVE_TIME = 10;                   // Expected solve time for each worker; timeouts cause difficulty to drop

const TIER_CONFIG = {
  // Tier definitions, multiplier, max difficulty, and max hash rate, tuned for most users
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
    maxHashrate: 25000,
    description: 'ESP32, ESP32-S2, ESP32-C3 (~15 kH/s SHA-256)'
  },
  mobile: {
    multiplier: 1.8,
    maxDifficulty: 50000,
    maxHashrate: 200000,
    description: 'Android, iOS (~50-200 kH/s SHA-256)'
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

const MAX_MEMPOOL_PER_BLOCK = 50;                // Maximum mempool transactions per block
const MEMPOOL_HOLDING_ACCOUNT = 'mempool_holding'; // Escrow account for mempool transactions

function difficultyToTarget(difficulty) {
  const maxTarget = (1n << 256n) - 1n;
  const diffScaled = BigInt(Math.floor(difficulty * 1000));
  if (diffScaled === 0n) return 'f'.repeat(64);
  const targetValue = maxTarget / diffScaled;
  return targetValue.toString(16).padStart(64, '0');
}

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

function getLastBlock() {
  return db.getLastBlock();
}

function parseFlexibleDate(str) {
  if (!str) return 0;
  const iso = str.includes('T') ? str : str.replace(' ', 'T');
  return new Date(iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso) ? iso : iso + 'Z').getTime() / 1000;
}

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
    db.setWorkerDifficulty(diffKey, diff, Date.now(), deviceType);
  }

  diff = Math.max(MIN_DIFFICULTY, Math.min(tierConfig.maxDifficulty, diff));

  // Persist the capped difficulty so stored value stays within tier limits
  db.setWorkerDifficulty(diffKey, diff, Date.now(), deviceType);

  // Try to grab a pool job at the next height
  const poolJob = db.prepare(
    'SELECT * FROM mining_jobs WHERE height = ? AND status = ? AND assigned_to = ? ORDER BY created_at ASC LIMIT 1'
  ).get(height, 'active', '_pool');

  if (poolJob) {
    const poolTargetHex = difficultyToTarget(diff);
    const poolMultiplier = tierConfig.multiplier;
    db.prepare(
      `UPDATE mining_jobs SET assigned_to = ?, difficulty = ?, target_hex = ?, tier = ?, reward_multiplier = ?, created_at = datetime('now') WHERE id = ?`
    ).run(diffKey, diff, poolTargetHex, tier, poolMultiplier, poolJob.id);
    return mapJob(Object.assign({}, poolJob, { difficulty: diff, target_hex: poolTargetHex, tier: tier, reward_multiplier: poolMultiplier }));
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

function processMempoolForBlock(blockHeight, minerUser) {
  const txs = db.getPendingMempool(MAX_MEMPOOL_PER_BLOCK);
  if (!txs || txs.length === 0) {
    return { processed: 0, totalFees: 0 };
  }

  let processed = 0;
  let totalFees = 0;

  // Check the holding account.
  const holding = db.getUser(MEMPOOL_HOLDING_ACCOUNT);
  if (!holding) {
    console.warn('⚠️ mempool_holding account does not exist!');
    // Mark all as failed.
    for (const tx of txs) {
      db.markMempoolFailed(tx.id);
    }
    return { processed: 0, totalFees: 0 };
  }

  for (const tx of txs) {
    // Check whether the recipient exists.
    const receiver = db.getUser(tx.to_username);
    if (!receiver) {
      db.markMempoolFailed(tx.id);
      console.warn(`❌ Mempool tx ${tx.id}: receiver ${tx.to_username} not found`);
      continue;
    }

    // Check the holding balance.
    if (holding.balance < tx.total_deducted) {
      db.markMempoolFailed(tx.id);
      console.warn(`❌ Mempool tx ${tx.id}: insufficient holding balance (${holding.balance} < ${tx.total_deducted})`);
      continue;
    }

    // Deduct from holding.
    db.updateBalance(MEMPOOL_HOLDING_ACCOUNT, -tx.total_deducted);
    // Credit the receiver with the amount.
    db.updateBalance(tx.to_username, tx.amount);
    // Credit the fee to the miner who included this block.
    if (tx.fee > 0 && minerUser) {
      db.updateBalance(minerUser, tx.fee);
      try {
        db.addTransaction('mempool_holding', minerUser, tx.fee);
      } catch (e) {}
    }
    totalFees += tx.fee;

    // Mark the transaction as confirmed.
    db.markMempoolConfirmed(tx.id, blockHeight);
    processed++;

    // Record the transaction log (optional).
    try {
      db.addTransaction(tx.from_username, tx.to_username, tx.amount);
    } catch (e) {
      // Ignore logging errors.
    }

    console.log(`✅ Mempool tx ${tx.id} confirmed in block ${blockHeight}: ${tx.amount} CC to ${tx.to_username}, fee ${tx.fee} CC → miner ${minerUser}`);
  }

  return { processed: processed, totalFees: totalFees };
}

function getDeviceMultiplier(deviceType) {
  const key = (deviceType || 'default').toLowerCase().trim();
  return DEVICE_REWARD_MULTIPLIERS[key] || DEVICE_REWARD_MULTIPLIERS['default'];
}

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

  // Atomically claim this job for solving: flip status active→solving in one
  // UPDATE...WHERE. If a concurrent request already claimed it (or it was
  // already solved), this affects 0 rows and we reject immediately — closes
  // the race window where two polls/submits could both see status='active'
  // for the same job_id and both proceed to submit a (still-valid) nonce.
  const claimResult = db.prepare(
    `UPDATE mining_jobs SET status = 'solving' WHERE id = ? AND status = 'active'`
  ).run(jobId);
  if (claimResult.changes === 0) {
    throw new Error('Job not found or already solved');
  }

  // Claim pool job for this worker
  if (job.assigned_to === '_pool') {
    db.prepare('UPDATE mining_jobs SET assigned_to = ? WHERE id = ?').run(diffKey, jobId);
  }

  // Suspension check: per-instance flag first (targeted), then account-level (broad/manual)
  const flags = db.getWorkerFlags(diffKey);
  if (flags && flags.suspended) {
    console.warn(`🚫 Worker ${diffKey} attempted to submit solution`);
    throw new Error('Worker suspended for suspicious behavior. Contact admin to appeal.');
  }

  // Check user-level suspension (blocks ALL workers of this user)
  if (db.isUserSuspended(userName)) {
    console.warn(`🚫 User ${userName} is suspended at account level`);
    throw new Error('Account suspended for suspicious behavior. Contact admin to appeal.');
  }

  // Check the nonce (hash uses diffKey to match client-side computation).
  const input = job.prev_hash + String(nonce).padStart(20, '0') + diffKey;
  const hashHex = crypto.createHash('sha256').update(input).digest('hex');

  if (hashHex >= job.target_hex) {
    // Invalid nonce: release the claim so the job can be retried/re-served
    db.prepare(`UPDATE mining_jobs SET status = 'active' WHERE id = ?`).run(jobId);
    return { status: 'error', reason: `Invalid nonce: hash ${hashHex.substring(0,12)}... >= target` };
  }

  const timestamp = Math.floor(Date.now() / 1000);

  // Read tier from job record
  let tier = job.tier || 'cpu';
  let tierConfig = TIER_CONFIG[tier] || TIER_CONFIG.cpu;

  // Auto-tier: upgrade if sustained hashrate exceeds tier max (multi-device rigs)
  // Only adjusts between mobile → cpu → gpu (embedded tiers stay fixed)
  // Hysteresis: skip if this diffKey changed tier in the last 60s, to avoid
  // thread-race flapping (e.g. two CPU threads under one instance reporting
  // inconsistent per-solve hashrates and bouncing the tier back and forth).
  if (hashrateReported && hashrateReported > 0 && tierConfig.maxHashrate) {
    const reportedRatio = hashrateReported / tierConfig.maxHashrate;
    if (reportedRatio > 2.0) {
      const lastTierChange = db.getWorkerDifficulty(diffKey + '_tierchange') || 0;
      const sinceChange = Date.now() - lastTierChange;
      if (sinceChange < 60000) {
        console.log(`⏸️ Auto-tier: skipping flip for ${diffKey} (last change ${(sinceChange/1000).toFixed(1)}s ago, cooldown 60s)`);
      } else {
        const adjustableTiers = ['mobile', 'cpu', 'gpu'];
        for (const t of adjustableTiers) {
          if (TIER_CONFIG[t].maxHashrate >= hashrateReported) {
            if (t !== tier && adjustableTiers.includes(tier)) {
              console.log(`🔄 Auto-tier: ${userName} upgraded from ${tier} → ${t} (reported ${hashrateReported.toExponential(2)} H/s)`);
              try {
                db.setWorkerTier(userName, t);
                db.setWorkerDifficulty(diffKey + '_tierchange', Date.now(), Date.now());
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
  }

  // Cross-check reported hashrate vs device capability
  // Use worker's CURRENT tier from DB (not stale job.tier) to avoid false flags after auto-tier
  let currentTier = tier;
  let currentTierConfig = tierConfig;
  try {
    const workerInfo = db.getWorkerInfo(userName);
    if (workerInfo && workerInfo.tier && TIER_CONFIG[workerInfo.tier]) {
      currentTier = workerInfo.tier;
      currentTierConfig = TIER_CONFIG[currentTier];
    }
  } catch (e) {
    // Fall back to job tier if DB query fails
  }

  if (hashrateReported && hashrateReported > 0 && currentTierConfig.maxHashrate) {
    const reportedRatio = hashrateReported / currentTierConfig.maxHashrate;
    // Threshold raised from 2.5x to 3.5x to accommodate variance in mobile/embedded devices
    if (reportedRatio > 3.5) {
      const reason = `Reported ${hashrateReported.toExponential(2)} H/s for ${currentTier} (max ${currentTierConfig.maxHashrate.toExponential(2)} H/s, ${reportedRatio.toFixed(1)}x over). Device type mismatch.`;
      db.addWorkerWarning(diffKey, reason);
      console.warn(`🤔 This worker has ${hashrateReported.toExponential(2)} H/s, expected ~${currentTierConfig.maxHashrate.toExponential(2)} H/s for ${currentTier}`)
      console.warn(`🤨 Impossible hashrate for device type: ${diffKey} - ${reason}`);
      const updatedFlags = db.getWorkerFlags(diffKey);
      if (updatedFlags.suspended) {
        console.warn(`🚫 Worker ${diffKey} auto-suspended for device type fraud`);
        db.prepare(`UPDATE mining_jobs SET status = 'active' WHERE id = ?`).run(jobId);
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
      db.addWorkerWarning(diffKey, reason);
      console.warn(`⚠️ Device fraud (fast tier): ${diffKey} - ${reason}`);
      const updatedFlags = db.getWorkerFlags(diffKey);
      if (updatedFlags.suspended) {
        console.warn(`🚫 Worker ${diffKey} auto-suspended for device type fraud`);
        db.prepare(`UPDATE mining_jobs SET status = 'active' WHERE id = ?`).run(jobId);
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
    console.log(`🔍 Anti-cheat [check3/high-tier]: tier=${tier} maxHR=${tierConfig.maxHashrate} diff=${job.difficulty} rawActualSolveTime=${actualSolveTime.toFixed(4)}s (floored=${solveTimeFloor.toFixed(4)}s) actualHashrate=${actualHashrate.toFixed(1)} actualRatio=${actualRatio.toFixed(3)} (flag if >${VARIANCE_TOLERANCE}) job.created_at=${job.created_at} now_ts=${timestamp}`);
    if (actualRatio > VARIANCE_TOLERANCE) {
      const reason = `Actual hashrate ${actualHashrate.toExponential(2)} H/s is ${actualRatio.toFixed(1)}x over ${tier} max (${tierConfig.maxHashrate.toExponential(2)} H/s). Device mismatch.`;
      const warnResult = db.addWorkerWarning(diffKey, reason);
      console.warn(`⚠️ Device fraud: ${diffKey} - ${reason} [warning_count=${warnResult.warning_count}]`);
      const updatedFlags = db.getWorkerFlags(diffKey);
      if (updatedFlags.suspended) {
        console.warn(`🚫 Worker ${diffKey} auto-suspended for device type fraud`);
        db.prepare(`UPDATE mining_jobs SET status = 'active' WHERE id = ?`).run(jobId);
        return {
          status: 'error',
          reason: 'Worker suspended for device type fraud. Submit from correct device.',
          warnings: updatedFlags.warning_count
        };
      }
    }
  }

  if (hashrateReported && hashrateReported > 0) {
    // Use a solve-time floor here too — actualSolveTime is measured with
    // second-precision timestamps, so any solve completing within the same
    // second as job creation reads as exactly 0, making ratio = 0/expected
    // always trip the check regardless of whether the hashrate was honest.
    // Floor both sides so the ratio reflects real variance, not timestamp
    // quantization.
    const solveTimeForRatio = Math.max(actualSolveTime, MIN_SOLVE_TIME_FLOOR);
    const expectedSolveTime = job.difficulty / hashrateReported;
    const ratio = solveTimeForRatio / expectedSolveTime;
    console.log(`🔍 Anti-cheat [check4/reported-vs-actual]: tier=${tier} diff=${job.difficulty} hashrateReported=${hashrateReported} rawActualSolveTime=${actualSolveTime.toFixed(4)}s (floored=${solveTimeForRatio.toFixed(4)}s) expectedSolveTime=${expectedSolveTime.toFixed(4)}s ratio=${ratio.toFixed(4)} (flag if <${(1/(VARIANCE_TOLERANCE*6)).toFixed(4)}) job.created_at=${job.created_at} now_ts=${timestamp}`);

    // Solve time is exponentially distributed around the expected value, so
    // a legit worker will regularly solve well under the "expected" time —
    // only flag truly extreme outliers (previously 20x, which fired constantly
    // on ordinary variance).
    if (ratio < (1 / (VARIANCE_TOLERANCE * 6))) {
      const reason = `Solved in ${actualSolveTime.toFixed(1)}s but reported hashrate ${hashrateReported} H/s implies ${expectedSolveTime.toFixed(1)}s (ratio ${ratio.toFixed(3)})`;
      const warnResult = db.addWorkerWarning(diffKey, reason);
      console.warn(`⚠️ Suspicious solve: ${diffKey} - ${reason} [warning_count=${warnResult.warning_count}]`);

      const updatedFlags = db.getWorkerFlags(diffKey);
      if (updatedFlags.suspended) {
        console.warn(`🚫 Worker ${diffKey} auto-suspended after hashrate validation failure`);
        db.prepare(`UPDATE mining_jobs SET status = 'active' WHERE id = ?`).run(jobId);
        return {
          status: 'error',
          reason: 'Worker suspended due to suspicious behavior (3 warnings in 24h). Solution rejected.',
          warnings: updatedFlags.warning_count
        };
      }
    }
  }
  const tierMultiplier = job.reward_multiplier || 1.0;

  // ─── Device multiplier: use tier from job, legacy fallback for old jobs ──
  let deviceMultiplier = tierMultiplier;
  if (!job.tier) {
    deviceMultiplier = getDeviceMultiplier(deviceType);
    console.log(`⚠️ Legacy job ${jobId} using device_type multiplier: ${deviceMultiplier}x`);
  }
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

  // Adjust the instance difficulty based on solve time.
  const solveTime = (timestamp - parseFlexibleDate(job.created_at));
  if (solveTime > 0) {
    adjustWorkerDifficulty(diffKey, solveTime);
  }

  // Send a webhook notification.
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

initBlockchain();

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
  getActiveBounties: function() { return {}; },
  getJob: function(id) { return null; },
  startAutoBounty: function() {},
  checkAndRefillBounties: function() {},
  cleanupOldBounties: function() {}
};
