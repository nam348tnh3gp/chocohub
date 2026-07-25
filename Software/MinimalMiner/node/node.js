const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { loadConfig, saveConfig, log, setLogLevel } = require('./config');
const { initDB } = require('./db');
const { Chain } = require('./chain');
const { ChallengeManager, getTier } = require('./challenge');
const { PeerManager } = require('./peers');
const { SyncEngine } = require('./sync');
const { Miner } = require('./miner');
const { Server } = require('./server');
const { DiscoveryServer, connectDiscoveryServer } = require('./discovery');

class NodeRegistry {
  constructor(db) {
    this.db = db;
  }
  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
    return { total_nodes: total, active_nodes: total, seed_version: '3.6.0-js' };
  }
  registerNode(url, nodeId, opts = {}) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('INSERT OR REPLACE INTO nodes (url, node_id, height, chain_work, version, peers, first_seen, last_seen) VALUES (?,?,?,?,?,?,COALESCE((SELECT first_seen FROM nodes WHERE url = ?), ?),?)').run(url, nodeId, opts.height || 0, opts.chain_work || '0', opts.version || '', opts.peers || 0, url, now, now);
  }
  all() { return this.db.prepare('SELECT * FROM nodes ORDER BY last_seen DESC').all(); }
}

class ChocoNode {
  constructor(cfg) {
    this.cfg = cfg;
    this.NODE_ID = crypto.randomBytes(16).toString('hex');
    this.db = null;
    this.chain = null;
    this.peers = null;
    this.challengeMgr = null;
    this.sync = null;
    this.miner = null;
    this.server = null;
    this.discoveryServer = null;
    this._stopDiscovery = null;
  }

  start() {
    const cfg = this.cfg;
    setLogLevel(cfg.logLevel);

    for (const d of [cfg.dataDir, path.dirname(cfg.dbPath), cfg.plotsDir]) {
      try { fs.mkdirSync(d, { recursive: true }); } catch {}
    }

    if (!cfg.adminToken || cfg.adminToken.length < 16) {
      cfg.adminToken = crypto.randomBytes(16).toString('hex');
      try { fs.writeFileSync(path.join(cfg.dataDir, 'admin_token.txt'), cfg.adminToken); } catch {}
      log('info', `Admin token: ${cfg.adminToken}`);
    }

    this._configPath = require('./config').CONFIG_PATH;

    this._printBanner();

    this.db = initDB(cfg.dbPath, cfg);

    this.chain = new Chain(this.db, cfg);
    this.peers = new PeerManager(this.db, cfg);
    this.challengeMgr = new ChallengeManager(this.db, this.chain, cfg);
    this.registry = new NodeRegistry(this.db);
    this.sync = new SyncEngine(this.db, cfg, this.chain, this.peers, this.challengeMgr, this.NODE_ID);
    this.miner = new Miner(this.db, cfg, this.chain, this.challengeMgr, this.sync, this.peers, this.NODE_ID);

    if (cfg.discoveryPort > 0) {
      this.discoveryServer = new DiscoveryServer(cfg.discoveryPort);
      this.discoveryServer.start();
    }

    this.server = new Server(cfg, this.db, this.chain, this.peers, this.sync, this.miner, this.challengeMgr, this.registry, this.NODE_ID);
    this.server.start();

    setInterval(() => { try { this.peers.decayHealth(); } catch {} }, 300000);
    setInterval(() => { try { this.chain.cleanMempool(); } catch {} }, 60000);
    setInterval(() => { try { this.chain.prune(); } catch {} }, 600000);
    setInterval(() => { try { this.challengeMgr.finalizeExpiredChallenges(this.chain, this.sync); } catch (e) { log('error', `Finalize error: ${e.message}`); } }, 10000);
    setInterval(() => { this.sync.loopSync().catch(() => {}); }, cfg.syncIntervalMs || 10000);
    setInterval(() => { this.sync.heartbeat().catch(() => {}); }, cfg.heartbeatMs || 20000);
    setInterval(() => { this.sync.discoverPeers().catch(() => {}); }, cfg.discoveryMs || 30000);

    setTimeout(async () => {
      log('info', 'Initial sync...');
      for (let i = 0; i < 3; i++) { try { await this.sync.loopSync(); } catch {} if (this.chain.altura > 0) break; }
      try { await this.sync.mempoolSync(); } catch {}
      if (cfg.nodeUrl) {
        await this.sync.announce();
        await this.sync.announce();
      }
      if (cfg.miningEnabled && cfg.minerAddress) {
        setTimeout(() => this.miner.start(cfg.minerAddress), 3000);
      }
      if (cfg.discoveryUrl) {
        this._stopDiscovery = connectDiscoveryServer(cfg, this.peers, this.chain, this.sync);
      }
    }, 2000);

    this._setupShutdown();
  }

  _printBanner() {
    const cfg = this.cfg;
    console.log(`\n  ${'■'.repeat(48)}`);
    console.log(`  CHOCONODE v${cfg.version} — ${cfg.chainName} (ID ${cfg.chainId})`);
    console.log(`  ${'■'.repeat(48)}`);
    console.log(`  Port: ${cfg.port}  |  Peers: ${cfg.seedPeers.length} seeds  |  Mining: ${cfg.miningEnabled ? 'ON' : 'OFF'}`);
    if (cfg.discoveryPort > 0) console.log(`  Discovery: WS on port ${cfg.discoveryPort}`);
    if (cfg.discoveryUrl) console.log(`  Discovery client: ${cfg.discoveryUrl}`);
    console.log(`  ${'■'.repeat(48)}\n`);
  }

  _setupShutdown() {
    const shutdown = () => {
      if (this._stopDiscovery) this._stopDiscovery();
      if (this.discoveryServer) try { this.discoveryServer.stop(); } catch {}
      log('info', 'Shutting down...');
      this.miner.stop();
      try { this.db.close(); } catch {}
      if (this.server) this.server.stop();
      setTimeout(() => process.exit(0), 5000);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
}

module.exports = { ChocoNode, NodeRegistry };
