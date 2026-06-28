// blockchain.js - PoW chuẩn với blockchain liên tục, per-worker difficulty, reward 0.05 CC/block
// Tích hợp mempool và phí giao dịch
const crypto = require('crypto');
const db = require('./db');

// ─── Cấu hình ────────────────────────────────────
const REWARD_PER_BLOCK = 0.05;                  // 0.05 CC
const INITIAL_DIFFICULTY = 10;                  // mặc định cho worker mới
const JOB_EXPIRE_SECONDS = 60;                  // job hết hạn sau 60s
const MIN_DIFFICULTY = 1;
const MAX_DIFFICULTY = 1000000;
const DIFFICULTY_ADJUSTMENT_FACTOR = 0.5;       // hệ số điều chỉnh (0.5 = trung bình)
const TARGET_SOLVE_TIME = 10;                   // giây mong muốn (cho per‑worker điều chỉnh)

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
}

// ─── Lấy block cuối ────────────────────────────
function getLastBlock() {
  return db.getLastBlock();
}

// ─── Lấy job cho worker (tạo mới nếu chưa có) ─
function getJobForWorker(workerName) {
  // Dọn dẹp job hết hạn
  db.cleanupExpiredJobs(JOB_EXPIRE_SECONDS);

  // Kiểm tra worker đã có job active chưa
  let job = db.getJobForWorker(workerName);
  if (job) {
    return mapJob(job);
  }

  // Lấy block cuối
  const lastBlock = getLastBlock();
  const height = lastBlock ? lastBlock.height + 1 : 0;
  const prevHash = lastBlock ? lastBlock.hash : '0'.repeat(64);

  // Lấy difficulty riêng của worker (nếu chưa có, tạo mới)
  let diff = db.getWorkerDifficulty(workerName);
  if (diff === null) {
    diff = INITIAL_DIFFICULTY;
    db.setWorkerDifficulty(workerName, diff, Date.now());
  }

  // Đảm bảo diff trong khoảng cho phép
  diff = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, diff));

  const targetHex = difficultyToTarget(diff);
  const reward = REWARD_PER_BLOCK;

  const jobId = 'job_' + crypto.randomBytes(6).toString('hex');
  db.createJob({
    id: jobId,
    height: height,
    prev_hash: prevHash,
    difficulty: diff,
    target_hex: targetHex,
    reward: reward,
    assigned_to: workerName
  });

  const newJob = db.getActiveJob(jobId);
  return mapJob(newJob);
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
    assigned_to: job.assigned_to
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

// ─── Submit solution ────────────────────────────
function submitSolution(jobId, nonce, workerName, deviceType) {
  const job = db.getActiveJob(jobId);
  if (!job) {
    throw new Error('Job not found or already solved');
  }
  if (job.assigned_to && job.assigned_to !== workerName) {
    throw new Error('This job is assigned to another worker');
  }

  // Kiểm tra nonce
  const input = job.prev_hash + String(nonce).padStart(20, '0') + workerName;
  const hashHex = crypto.createHash('sha256').update(input).digest('hex');

  if (hashHex >= job.target_hex) {
    return { status: 'error', reason: `Invalid nonce: hash ${hashHex.substring(0,12)}... >= target` };
  }

  // Tạo block (chưa có tx_count và total_fees)
  const timestamp = Math.floor(Date.now() / 1000);
  const newBlock = {
    height: job.height,
    hash: hashHex,
    prev_hash: job.prev_hash,
    miner: workerName,
    nonce: String(nonce),
    timestamp: timestamp,
    reward: job.reward,
    difficulty: job.difficulty,
    tx_count: 0,
    total_fees: 0
  };

  // Lưu block
  db.insertBlock(newBlock);

  // ─── Mining Boost: multiplicador 1.3x se ativo ──
  const boostMultiplier = db.getMiningBoostMultiplier(workerName);
  const boostedReward = parseFloat((job.reward * boostMultiplier).toFixed(8));
  const bonusReward = parseFloat((boostedReward - job.reward).toFixed(8));

  // Thưởng cho miner (com boost se ativo)
  db.updateBalance(workerName, boostedReward);

  // Se houve boost, registra no log e reabastece o pool
  if (bonusReward > 0) {
    console.log(`⚡ Mining boost active for ${workerName}: ${job.reward} → ${boostedReward} CC (${boostMultiplier}x)`);
  }

  // ─── Xử lý mempool ──────────────────────────────
  const mempoolResult = processMempoolForBlock(newBlock.height);

  // Cập nhật tx_count và total_fees cho block
  if (mempoolResult.processed > 0 || mempoolResult.totalFees > 0) {
    db.updateBlockFees(newBlock.height, mempoolResult.totalFees);
    newBlock.tx_count = mempoolResult.processed;
    newBlock.total_fees = mempoolResult.totalFees;
  }

  // Đánh dấu job solved và xóa job cũ của worker
  db.markJobSolved(jobId);
  db.deleteJobsForWorker(workerName, jobId);

  // Điều chỉnh difficulty cho worker dựa trên thời gian giải
  const solveTime = (timestamp - new Date(job.created_at).getTime() / 1000);
  if (solveTime > 0) {
    adjustWorkerDifficulty(workerName, solveTime);
  }

  // Gửi thông báo (webhook)
  sendMinerWebhook(workerName, newBlock.height, deviceType);

  console.log(`⛏️ Block ${newBlock.height} solved by ${workerName} (${deviceType}) reward ${boostedReward} CC (boost: ${boostMultiplier}x), ${mempoolResult.processed} txs processed, fees ${mempoolResult.totalFees} CC`);

  return {
    status: 'success',
    message: `Block ${newBlock.height} solved! Reward: ${boostedReward} CC${boostMultiplier > 1 ? ` (${boostMultiplier}x boost)` : ''}, ${mempoolResult.processed} transactions processed`,
    reward: boostedReward,
    block_hash: hashHex,
    tx_count: mempoolResult.processed,
    total_fees: mempoolResult.totalFees,
    boost_multiplier: boostMultiplier
  };
}

// ─── Điều chỉnh difficulty cho worker ──────────
function adjustWorkerDifficulty(workerName, solveTime) {
  const currentDiff = db.getWorkerDifficulty(workerName) || INITIAL_DIFFICULTY;
  const targetTime = TARGET_SOLVE_TIME;

  // Tính toán difficulty mới
  let idealDiff = currentDiff * (targetTime / solveTime);
  let newDiff = currentDiff + (idealDiff - currentDiff) * DIFFICULTY_ADJUSTMENT_FACTOR;
  // Giới hạn thay đổi tối đa 25% để tránh biến động mạnh
  const maxChange = currentDiff * 0.25;
  newDiff = Math.max(currentDiff - maxChange, Math.min(currentDiff + maxChange, newDiff));
  newDiff = Math.max(MIN_DIFFICULTY, Math.min(MAX_DIFFICULTY, newDiff));
  newDiff = Math.round(newDiff * 10) / 10;

  db.setWorkerDifficulty(workerName, newDiff, Date.now());
  console.log(`👷 Worker ${workerName}: difficulty ${currentDiff.toFixed(1)} → ${newDiff.toFixed(1)} (solve time ${solveTime.toFixed(1)}s)`);
}

// ─── Webhook ─────────────────────────────────────
async function sendMinerWebhook(worker, height, device) {
  try {
    await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: "⛏️ New Block Mined!",
          description: `Block **#${height}** was solved.\n\n**Worker:** \`${worker}\`\n**Device:** \`${device}\`\n**Reward:** 0.05 CC`,
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
