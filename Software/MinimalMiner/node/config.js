const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const BASE_DIR = __dirname + '/..';
const CONFIG_PATH = process.env.CHOCOHUB_CONFIG || path.join(BASE_DIR, 'node_config.json');

function loadConfig() {
  const defaults = {
    port: 3001,
    nodeUrl: null,
    seedPeers: ['https://seed.chocohub.org'],
    dbPath: path.join(BASE_DIR, 'db', 'choco-node.db'),
    dataDir: path.join(BASE_DIR, 'node-data'),
    plotsDir: path.join(BASE_DIR, 'plots'),
    snapshotsDir: path.join(BASE_DIR, 'snapshots'),
    syncIntervalMs: 10000,
    heartbeatMs: 20000,
    discoveryMs: 30000,
    blockTimeTarget: 20,
    miningEnabled: false,
    minerAddress: '',
    minerPrivateKey: '',
    minerPublicKey: '',
    chainId: 19971971,
    chainName: 'CCpoc',
    symbol: 'CC',
    decimals: 18,
    maxPeers: 50,
    peerTimeoutMs: 30000,
    maxBlocksPerSync: 200,
    peerFailThreshold: 25,
    peerBanThreshold: 50,
    version: '3.6.0-js',
    genesisTimestamp: 1735689600,
    maxFutureBlockSec: 120,
    difficultyAdjustBlocks: 2016,
    expectedTimePerBlock: 20,
    initialTarget: '0x00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF',
    initialReward: '1650000000000000000',
    halvingInterval: 6300000,
    maxSupply: 21000000 * (10 ** 18),
    maxMempoolSize: 5000,
    mempoolTxTtlSec: 3600,
    challengeTtlSec: 120,
    adminToken: '',
    verifyBlockSignatures: true,
    nodeActiveTtlMs: 5 * 60 * 1000,
    nodeRetainMs: 60 * 60 * 1000,
    maxNodes: 500,
    maxNodesPerIp: 10,
    maxPeersPerIp: 5,
    logLevel: 'info',
    minGasPrice: 10 ** 9,
    targetGasPerBlock: 2100000,
    maxGasPerBlock: 10500000,
    pruningEnabled: false,
    pruneKeepBlocks: 1000,
    pruneKeepDays: 30,
    upnpEnabled: true,
    discoveryUrl: '',
    discoveryPort: 7777,
  };

  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      Object.assign(defaults, saved);
      if (saved.seedPeers) defaults.seedPeers = normalizeSeedPeers(saved.seedPeers);
      if (saved.nodeUrl) defaults.nodeUrl = normalizeUrl(saved.nodeUrl) || defaults.nodeUrl;
    } catch {}
  }

  const envInt = (key, def) => { const v = process.env[key]; return v ? parseInt(v, 10) || def : def; };
  const envStr = (key, def) => process.env[key] || def;
  const envBool = (key, def) => { const v = process.env[key]; return v ? v.toLowerCase() === 'true' : def; };

  defaults.port = envInt('PORT', defaults.port);
  defaults.nodeUrl = normalizeUrl(envStr('NODE_URL', '')) || defaults.nodeUrl;
  const envSeedPeers = normalizeSeedPeers(envStr('SEED_PEERS', ''));
  if (envSeedPeers.length > 0) defaults.seedPeers = envSeedPeers;
  defaults.dbPath = envStr('DB_PATH', defaults.dbPath);
  defaults.dataDir = envStr('DATA_DIR', defaults.dataDir);
  defaults.plotsDir = envStr('PLOTS_DIR', defaults.plotsDir);
  defaults.syncIntervalMs = envInt('SYNC_MS', defaults.syncIntervalMs);
  defaults.heartbeatMs = envInt('HEARTBEAT_MS', defaults.heartbeatMs);
  defaults.discoveryMs = envInt('DISCOVERY_MS', defaults.discoveryMs);
  defaults.blockTimeTarget = Math.max(10, Math.min(30, envInt('BLOCK_TIME', defaults.blockTimeTarget)));
  defaults.miningEnabled = envBool('MINING_ENABLED', defaults.miningEnabled);
  defaults.minerAddress = envStr('MINER_ADDRESS', defaults.minerAddress);
  defaults.minerPrivateKey = envStr('MINER_PRIVATE_KEY', defaults.minerPrivateKey);
  defaults.minerPublicKey = envStr('MINER_PUBLIC_KEY', defaults.minerPublicKey);
  defaults.logLevel = envStr('LOG_LEVEL', defaults.logLevel);
  defaults.adminToken = envStr('ADMIN_TOKEN', defaults.adminToken);
  defaults.maxBlocksPerSync = envInt('MAX_BLOCKS_PER_SYNC', defaults.maxBlocksPerSync);
  defaults.maxMempoolSize = envInt('MAX_MEMPOOL_SIZE', defaults.maxMempoolSize);
  defaults.minGasPrice = envInt('MIN_GAS_PRICE', defaults.minGasPrice);
  defaults.targetGasPerBlock = envInt('TARGET_GAS_PER_BLOCK', defaults.targetGasPerBlock);
  defaults.maxGasPerBlock = envInt('MAX_GAS_PER_BLOCK', defaults.maxGasPerBlock);

  return defaults;
}

function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  url = url.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    if (url.includes(':')) {
      const parts = url.split(':');
      const port = parseInt(parts[parts.length - 1], 10);
      if (port >= 1 && port <= 65535) {
        const host = parts.slice(0, -1).join(':').replace(/^\[|]$/g, '');
        return `http://${host}:${port}`;
      }
    }
    return null;
  }
  try {
    const u = new URL(url);
    if (!u.hostname) return null;
    return u.port ? `${u.protocol}//${u.hostname}:${u.port}` : `${u.protocol}//${u.hostname}`;
  } catch { return null; }
}

function normalizeSeedPeers(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(',').map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  return raw.map(s => normalizeUrl(s)).filter(u => { if (!u || seen.has(u)) return false; seen.add(u); return true; });
}

function saveConfig(cfg) {
  const sensitive = new Set(['minerPrivateKey', 'adminToken', 'privateKey']);
  const safe = {};
  for (const [k, v] of Object.entries(cfg)) { if (!sensitive.has(k)) safe[k] = v; }
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(safe, null, 2)); } catch (e) { log('warn', `Config save failed: ${e.message}`); }
}

const LOG_LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
let _logLevel = 2;
let _logBuffer = [];
const MAX_LOG_BUFFER = 500;

function setLogLevel(level) { _logLevel = LOG_LEVELS[level] || 2; }

function log(level, ...args) {
  if ((LOG_LEVELS[level] || 2) < _logLevel) return;
  const ts = new Date().toISOString().slice(11, 23);
  const prefix = { trace: '[TRC]', debug: '[DBG]', info: '[INF]', warn: '[WRN]', error: '[ERR]' }[level] || '[INF]';
  const msg = `${ts} ${prefix} ${args.join(' ')}`;
  if (level === 'error' || level === 'warn') console.error(msg); else console.log(msg);
  _logBuffer.push({ ts: Date.now(), level, msg: args.join(' ') });
  if (_logBuffer.length > MAX_LOG_BUFFER) _logBuffer = _logBuffer.slice(-MAX_LOG_BUFFER);
}

function getLogBuffer() { return _logBuffer.slice(-200); }

module.exports = { loadConfig, saveConfig, normalizeUrl, normalizeSeedPeers, BASE_DIR, CONFIG_PATH, log, setLogLevel, getLogBuffer };
