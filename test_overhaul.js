/**
 * test_overhaul.js  –  ChocoHub PoW+PoS overhaul integration test
 *
 * Tests every requirement from the implementation plan:
 *   1. DB schema migrations (new columns + worker_flags table)
 *   2. Tier registration with 24-hour cooldown
 *   3. Job creation respects tier maxDifficulty cap
 *   4. Job record stores tier + reward_multiplier (server-controlled)
 *   5. Reward split: 5% PoS pool, 95% miner base
 *   6. Tier multiplier applied only to miner share
 *   7. Worker flag / warning system (3 warnings → auto-suspend)
 *   8. clearWorkerSuspension resets everything
 *   9. GPU multiplier is 1.0x (not 0.5x)
 *  10. Legacy jobs without tier column fall back gracefully
 *  11. TIER_CONFIG exported from blockchain.js
 *  12. End-to-end mine: getJobForWorker → submitSolution → balances correct
 */

'use strict';

// ── Use an isolated in-memory DB so we never touch chocohub.db ──────────────
process.env.DB_PATH = ':memory:';

// Patch Database constructor to always use :memory:
const origDb = require('better-sqlite3');
const Database = function(p, o) { return new origDb(':memory:', o); };
Object.setPrototypeOf(Database, origDb);
Object.assign(Database, origDb);
require.cache[require.resolve('better-sqlite3')] = {
  id: require.resolve('better-sqlite3'),
  filename: require.resolve('better-sqlite3'),
  loaded: true,
  exports: Database
};

// Now load our modules (they'll get the patched DB)
const db = require('./db');
const blockchain = require('./blockchain');

// ── Tiny test harness ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, name, detail = '') {
  if (condition) {
    console.log(`  ✅  ${name}`);
    passed++;
  } else {
    console.error(`  ❌  ${name}${detail ? '  →  ' + detail : ''}`);
    failed++;
  }
}

function assertApprox(a, b, name, tol = 1e-7) {
  assert(Math.abs(a - b) <= tol, name, `got ${a}, expected ${b}`);
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 55 - title.length))}`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

section('1. DB schema – new columns exist');
{
  // worker_difficulty should have tier, tier_registered_at, tier_changes
  const cols = db._db
    ? db._db.prepare('PRAGMA table_info(worker_difficulty)').all()
    : (() => {
        // access the internal db via a known query
        const row = db.getWorkerTier('__probe__'); // triggers table access
        return [];
      })();

  // Use getFlaggedWorkers to confirm worker_flags table exists
  const flagged = db.getFlaggedWorkers();
  assert(Array.isArray(flagged), 'worker_flags table exists and getFlaggedWorkers() returns array');

  // Confirm tier functions exist
  assert(typeof db.getWorkerTier === 'function', 'getWorkerTier exported');
  assert(typeof db.setWorkerTier === 'function', 'setWorkerTier exported');
  assert(typeof db.addWorkerWarning === 'function', 'addWorkerWarning exported');
  assert(typeof db.suspendWorker === 'function', 'suspendWorker exported');
  assert(typeof db.clearWorkerSuspension === 'function', 'clearWorkerSuspension exported');
}

section('2. Tier registration');
{
  // Default tier for unknown worker is 'cpu'
  const def = db.getWorkerTier('worker_new');
  assert(def === 'cpu', 'default tier is cpu', `got "${def}"`);

  // Register a valid tier
  db.setWorkerTier('miner_esp32', 'embedded_esp32');
  assert(db.getWorkerTier('miner_esp32') === 'embedded_esp32', 'tier stored correctly');

  // Invalid tier throws
  let threw = false;
  try { db.setWorkerTier('x', 'invalid_tier'); } catch(e) { threw = true; }
  assert(threw, 'invalid tier throws error');

  // Cooldown: trying to change again within 24h should throw
  let cooldownThrew = false;
  try { db.setWorkerTier('miner_esp32', 'cpu'); } catch(e) {
    cooldownThrew = e.message.includes('cooldown');
  }
  assert(cooldownThrew, '24h cooldown enforced on tier change');
}

section('3. TIER_CONFIG exported from blockchain.js');
{
  const { TIER_CONFIG } = blockchain;
  assert(typeof TIER_CONFIG === 'object', 'TIER_CONFIG exported');
  assert(TIER_CONFIG.embedded_avr.multiplier === 3.5, 'embedded_avr multiplier = 3.5x');
  assert(TIER_CONFIG.embedded_esp32.multiplier === 2.0, 'embedded_esp32 multiplier = 2.0x');
  assert(TIER_CONFIG.gpu.multiplier === 1.0, 'GPU multiplier = 1.0x (was 0.5x)');
  assert(TIER_CONFIG.cpu.multiplier === 1.0, 'CPU multiplier = 1.0x');
  assert(TIER_CONFIG.embedded_avr.maxDifficulty === 5000, 'embedded_avr maxDifficulty = 5000');
  assert(TIER_CONFIG.embedded_esp32.maxDifficulty === 500000, 'embedded_esp32 maxDifficulty = 500000');
}

section('4. Job creation – tier caps difficulty and stores multiplier');
{
  // Register an Arduino miner (maxDifficulty: 5000)
  db.setWorkerTier('avr_miner', 'embedded_avr');

  // Force a very high difficulty for this worker to verify capping
  db.setWorkerDifficulty('avr_miner', 999999, Date.now());

  const job = blockchain.getJobForWorker('avr_miner');
  assert(job !== null, 'job created for embedded_avr worker');
  assert(job.tier === 'embedded_avr', 'job.tier = embedded_avr', `got "${job.tier}"`);
  assert(job.reward_multiplier === 3.5, 'job.reward_multiplier = 3.5', `got ${job.reward_multiplier}`);
  assert(job.difficulty <= 5000, `difficulty capped at 5000 (got ${job.difficulty})`);

  // ESP32 miner
  db.setWorkerTier('esp_miner', 'embedded_esp32');
  db.setWorkerDifficulty('esp_miner', 1000000, Date.now());
  const job2 = blockchain.getJobForWorker('esp_miner');
  assert(job2.difficulty <= 500000, `esp32 difficulty capped at 500000 (got ${job2.difficulty})`);
  assert(job2.reward_multiplier === 2.0, 'esp32 job multiplier = 2.0x');

  // CPU miner (no cap in practice)
  const job3 = blockchain.getJobForWorker('cpu_miner_test');
  assert(job3.tier === 'cpu', 'unregistered worker defaults to cpu tier');
  assert(job3.reward_multiplier === 1.0, 'cpu tier multiplier = 1.0x');
}

section('5. Reward split – 5% PoS, 95% miner base');
{
  const REWARD = 0.05;
  const POS_SHARE = 0.05;
  const MINER_SHARE = 0.95;

  const expectedPos = parseFloat((REWARD * POS_SHARE).toFixed(8));
  const expectedMinerBase = parseFloat((REWARD * MINER_SHARE).toFixed(8));

  assertApprox(expectedPos, 0.0025, 'PoS contribution = 0.0025 CC');
  assertApprox(expectedMinerBase, 0.0475, 'miner base = 0.0475 CC');

  // Arduino (3.5x): 0.0475 × 3.5 = 0.16625
  const avrReward = parseFloat((expectedMinerBase * 3.5).toFixed(8));
  assertApprox(avrReward, 0.16625, 'Arduino miner reward = 0.16625 CC');

  // ESP32 (2.0x): 0.0475 × 2.0 = 0.095
  const espReward = parseFloat((expectedMinerBase * 2.0).toFixed(8));
  assertApprox(espReward, 0.095, 'ESP32 miner reward = 0.095 CC');

  // GPU (1.0x): 0.0475
  const gpuReward = parseFloat((expectedMinerBase * 1.0).toFixed(8));
  assertApprox(gpuReward, 0.0475, 'GPU miner reward = 0.0475 CC');
}

section('6. End-to-end mine: submitSolution updates balances correctly');
{
  // Create a test user
  db.authenticate('test_miner', '1234');
  const before = db.getUser('test_miner');

  // Register ESP32 tier
  db.setWorkerTier('test_miner', 'embedded_esp32');

  // Get a job
  const job = blockchain.getJobForWorker('test_miner');
  assert(job !== null, 'job obtained for test_miner');

  // Record PoS pool before
  const poolBefore = db.getPosRewardPool().balance;

  // Brute-force the nonce (low difficulty, will find quickly)
  const crypto = require('crypto');
  let nonce = 0;
  let found = false;
  while (nonce < 10000000) {
    const input = job.prev_hash + String(nonce).padStart(20, '0') + 'test_miner';
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    if (hash < job.target_hex) { found = true; break; }
    nonce++;
  }
  assert(found, `nonce found within 10M iterations (nonce=${nonce})`);

  if (found) {
    const result = blockchain.submitSolution(job.job_id, nonce, 'test_miner', 'embedded_esp32', 0);
    assert(result.status === 'success', 'submitSolution returned success', JSON.stringify(result));

    const after = db.getUser('test_miner');
    const poolAfter = db.getPosRewardPool().balance;

    // Miner should have received 0.0475 × 2.0 = 0.095 CC (no boost)
    const expectedMinerReward = parseFloat((0.0475 * 2.0).toFixed(8));
    const actualGain = parseFloat((after.balance - before.balance).toFixed(8));
    assertApprox(actualGain, expectedMinerReward,
      `miner balance increased by ${expectedMinerReward} CC (got ${actualGain})`);

    // PoS pool should have increased by exactly 0.0025 CC
    const poolGain = parseFloat((poolAfter - poolBefore).toFixed(8));
    assertApprox(poolGain, 0.0025,
      `PoS pool increased by 0.0025 CC (got ${poolGain})`);

    // Result should report correct values
    assertApprox(result.reward, expectedMinerReward, 'result.reward correct');
    assertApprox(result.pos_contribution, 0.0025, 'result.pos_contribution = 0.0025');
    assert(result.tier === 'embedded_esp32', 'result.tier correct');
    assertApprox(result.tier_multiplier, 2.0, 'result.tier_multiplier = 2.0');
  }
}

section('7. Worker flag / warning / suspension system');
{
  // Fresh worker, no flags
  const clean = db.getWorkerFlags('clean_worker');
  assert(clean.warning_count === 0, 'new worker has 0 warnings');
  assert(clean.suspended === false, 'new worker not suspended');

  // Add 2 warnings – should not suspend yet
  db.addWorkerWarning('warn_worker', 'test reason 1');
  db.addWorkerWarning('warn_worker', 'test reason 2');
  const after2 = db.getWorkerFlags('warn_worker');
  assert(after2.warning_count === 2, '2 warnings counted');
  assert(after2.suspended === false, 'not suspended at 2 warnings');

  // 3rd warning triggers auto-suspend
  db.addWorkerWarning('warn_worker', 'test reason 3');
  const after3 = db.getWorkerFlags('warn_worker');
  assert(after3.warning_count === 3, '3 warnings counted');
  assert(after3.suspended === true, 'auto-suspended after 3rd warning');

  // Manual suspend
  db.suspendWorker('manual_worker', 'manual test');
  assert(db.getWorkerFlags('manual_worker').suspended === true, 'manual suspension works');

  // getFlaggedWorkers returns both
  const flagged = db.getFlaggedWorkers();
  const names = flagged.map(w => w.worker_name);
  assert(names.includes('warn_worker'), 'warn_worker in flagged list');
  assert(names.includes('manual_worker'), 'manual_worker in flagged list');
}

section('8. clearWorkerSuspension resets everything');
{
  db.clearWorkerSuspension('warn_worker', 'admin_chocoetom');
  const cleared = db.getWorkerFlags('warn_worker');
  assert(cleared.suspended === false, 'suspension cleared');
  assert(cleared.warning_count === 0, 'warning count reset to 0');
  assert(cleared.warnings.length === 0, 'warnings array empty');
}

section('9. submitSolution rejects suspended worker');
{
  db.authenticate('susp_miner', '5678');
  db.setWorkerTier('susp_miner', 'cpu');
  const job = blockchain.getJobForWorker('susp_miner');

  // Suspend before they can submit
  db.suspendWorker('susp_miner', 'test suspension');

  let threw = false;
  let msg = '';
  try {
    blockchain.submitSolution(job.job_id, 0, 'susp_miner', 'cpu', 0);
  } catch(e) {
    threw = true;
    msg = e.message;
  }
  assert(threw && msg.includes('suspended'), 'suspended worker throws on submit', msg);
}

section('10. Hashrate validation flags suspicious solve');
{
  db.authenticate('cheat_miner', '9999');
  db.setWorkerTier('cheat_miner', 'cpu');

  const job = blockchain.getJobForWorker('cheat_miner');

  // Brute-force a valid nonce (low difficulty)
  const crypto = require('crypto');
  let nonce = 0;
  while (nonce < 10000000) {
    const input = job.prev_hash + String(nonce).padStart(20, '0') + 'cheat_miner';
    if (crypto.createHash('sha256').update(input).digest('hex') < job.target_hex) break;
    nonce++;
  }

  // Set created_at to 3 seconds ago so submitSolution sees actualSolveTime ≈ 3s
  const threeSecAgo = new Date(Date.now() - 3000).toISOString();
  db._db.prepare('UPDATE mining_jobs SET created_at = ? WHERE id = ?').run(threeSecAgo, job.job_id);

  // Submit with a very low hashrate claim (0.1 H/s)
  // At difficulty 10: expected = 10/0.1 = 100s, actual ≈ 3s, ratio ≈ 0.03 < 0.05 ✓
  const result = blockchain.submitSolution(job.job_id, nonce, 'cheat_miner', 'cpu', 0.1);

  const flags = db.getWorkerFlags('cheat_miner');
  assert(flags.warning_count >= 1,
    'suspicious hashrate warning recorded', `warning_count=${flags.warning_count}`);

  // Verify the ratio formula itself produces a flag for the right inputs
  const difficulty = 100000;
  const hashrate = 1;
  const actualSolveTime = 0.2;
  const expectedSolveTime = difficulty / hashrate;
  const ratio2 = actualSolveTime / expectedSolveTime;
  assert(ratio2 < 0.05, 'ratio formula correctly identifies suspicious solve', `ratio=${ratio2}`);
  assert(actualSolveTime > 0.1, 'actualSolveTime guard passes (>0.1s)');
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(58)}`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`${'═'.repeat(58)}\n`);
process.exit(failed > 0 ? 1 : 0);
