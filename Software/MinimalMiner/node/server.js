const path = require('path');
const crypto = require('crypto');
const crypto2 = require('crypto');
const { safeInt, safeBigInt, sha256hex, hashTransaction, pubkeyToAddress, pubKeyToAddress, calculateMiningReward, hashBlock } = require('./crypto');
const { log, getLogBuffer } = require('./config');
const { createPlotFile } = require('./plot');


class Server {
  constructor(cfg, db, chain, peers, sync, miner, challengeMgr, registry, NODE_ID) {
    this.cfg = cfg;
    this.db = db;
    this.chain = chain;
    this.peers = peers;
    this.sync = sync;
    this.miner = miner;
    this.challengeMgr = challengeMgr;
    this.registry = registry;
    this.NODE_ID = NODE_ID;
    this.app = null;
    this.server = null;
    this.discoveryServer = null;
  }

  start() {
    const express = require('express');
    const helmet = require('helmet');
    const app = express();
    this.app = app;

    app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
    app.use(express.json({ limit: '10mb' }));

    app.use((req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Headers', '*'); res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE'); if (req.method === 'OPTIONS') return res.sendStatus(200); next(); });

    app.get('/api/stats', (req, res) => {
      const stats = this.chain.getStats();
      const tip = this.chain.getBlock(this.chain.altura);
      const ns = this.registry.getStats();
      res.json({
        ...stats, chain_id: this.cfg.chainId, chain_name: this.cfg.chainName,
        symbol: this.cfg.symbol, current_reward: calculateMiningReward(this.chain.altura + 1, this.cfg).toString(),
        current_reward_cc: Number(calculateMiningReward(this.chain.altura + 1, this.cfg)) / 1e18,
        blocks_to_halving: this.cfg.halvingInterval - (this.chain.altura % this.cfg.halvingInterval),
        halving_interval: this.cfg.halvingInterval, max_supply: this.cfg.maxSupply,
        seed_version: this.cfg.version, node_url: this.cfg.nodeUrl,
        node_id: this.NODE_ID, peers: { total: this.peers.count(), active: this.peers.active().length, banned: this.peers.banned().length, avg_health: 0 },
        version: this.cfg.version,
      });
    });

    app.get('/api/blocks', (req, res) => {
      const from = parseInt(req.query.from) || 0;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      let blocks;
      if (req.query.hash) {
        const b = this.chain.getBlock(req.query.hash);
        blocks = b ? [b] : [];
      } else {
        blocks = [];
        for (let h = from; h < from + limit; h++) {
          const b = this.chain.getBlock(h);
          if (b) blocks.push(b); else break;
        }
      }
      res.json({ blocks, total: this.chain.altura + 1 });
    });

    app.get('/api/block/:heightOrHash', (req, res) => {
      const b = this.chain.getBlock(req.params.heightOrHash);
      if (!b) return res.status(404).json({ error: 'block not found' });
      res.json(b);
    });

    app.get('/api/mempool', (req, res) => {
      const txs = this.db.prepare('SELECT * FROM mempool ORDER BY CAST(fee AS INTEGER) DESC LIMIT 200').all().map(r => { try { return JSON.parse(r.raw); } catch { return null; } }).filter(Boolean);
      res.json({ transactions: txs, count: txs.length });
    });

    app.post('/api/mempool', (req, res) => {
      const tx = req.body;
      if (!tx || !tx.from_addr || !tx.to_addr) return res.status(400).json({ error: 'invalid transaction' });
      if (!tx.hash) tx.hash = hashTransaction(tx);
      const result = this.chain.addMempoolTx(tx);
      if (result.ok) setImmediate(() => this.sync.broadcastTx(tx));
      res.json(result);
    });

    app.get('/api/wallets', (req, res) => {
      const wallets = this.db.prepare('SELECT address, balance, nonce, created_at, updated_at FROM users ORDER BY CAST(balance AS INTEGER) DESC LIMIT 200').all();
      res.json({ wallets, count: wallets.length });
    });
    app.get('/api/accounts', (req, res) => {
      const address = req.query.address;
      if (!address) return res.status(400).json({ error: 'address query param required' });
      const u = this.db.prepare('SELECT address, balance, nonce, created_at, updated_at FROM users WHERE address = ?').get(address);
      if (!u) return res.json({ address, balance: '0', nonce: 0 });
      res.json(u);
    });
    app.get('/api/gas/price', (req, res) => res.json({ gas_price: '1', unit: 'wei' }));
    app.get('/api/users/:address', (req, res) => {
      const u = this.db.prepare('SELECT * FROM users WHERE address = ?').get(req.params.address);
      if (!u) return res.status(404).json({ error: 'user not found' });
      res.json(u);
    });

    app.post('/api/wallet/create', (req, res) => {
      const { publicKey } = crypto2.generateKeyPairSync('ed25519');
      const pubB64 = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
      const addr = pubkeyToAddress(pubB64);
      const privHex = publicKey.export({ type: 'pkcs8', format: 'der' }).toString('hex');
      const now = Math.floor(Date.now() / 1000);
      this.db.prepare('INSERT OR IGNORE INTO users (address, public_key_ed25519, balance, nonce, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(addr, pubB64, '0', 0, now, now);
      res.json({ ok: true, address: addr, public_key: pubB64, private_key: privHex });
    });

    app.post('/api/wallet/import', (req, res) => {
      const { address, public_key } = req.body;
      if (!address || !public_key) return res.status(400).json({ error: 'address and public_key required' });
      try { if (pubkeyToAddress(public_key) !== address) return res.status(400).json({ error: 'address does not match public key' }); } catch { return res.status(400).json({ error: 'Invalid public key' }); }
      const now = Math.floor(Date.now() / 1000);
      this.db.prepare('INSERT INTO users (address, public_key_ed25519, balance, nonce, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?) ON CONFLICT(address) DO UPDATE SET public_key_ed25519 = excluded.public_key_ed25519, updated_at = excluded.updated_at').run(address, public_key, now, now);
      res.json({ ok: true, address });
    });

    app.get('/api/node/info', (req, res) => {
      const ns = this.registry.getStats();
      res.json({ ...this.chain.getStats(), chain_id: this.cfg.chainId, chain_name: this.cfg.chainName, symbol: this.cfg.symbol, node_url: this.cfg.nodeUrl, node_id: this.NODE_ID, version: this.cfg.version, peers: this.peers.gossipPeers(20) });
    });
    app.get('/api/node/status', (req, res) => res.json({
      height: this.chain.altura, hash: this.chain.melhorHash,
      chain_work: (this.chain.getBlock(this.chain.altura) || {}).chain_work || '0',
      peer_count: this.peers.count(), mining_active: this.miner.active,
      miner_address: this.miner.address, node_url: this.cfg.nodeUrl,
    }));
    app.get('/api/node/peers', (req, res) => res.json({ peers: this.peers.all(100) }));
    app.get('/api/node/peers/gossip', (req, res) => res.json({ peers: this.peers.gossipPeers(50) }));

    app.get('/api/peers', (req, res) => res.json({ peers: this.peers.all(100) }));
    app.post('/api/peers/add', (req, res) => {
      const url = require('./config').normalizeUrl(req.body.url);
      if (!url) return res.status(400).json({ error: 'invalid url' });
      this.peers.add(url);
      res.json({ ok: true, url });
    });

    app.get('/api/mining/challenge', (req, res) => {
      const ch = this.challengeMgr.getOrCreate();
      if (!ch) return res.status(404).json({ error: 'no challenge available' });
      res.json(ch);
    });

    app.post('/api/mining/submit-proof', (req, res) => {
      const { challenge_id, miner, plot_id, deadline, proof_packet } = req.body;
      if (!challenge_id || !miner || !plot_id || deadline == null) return res.status(400).json({ error: 'challenge_id, miner, plot_id, deadline required' });
      const result = this.challengeMgr.submitProof(this.chain, challenge_id, miner, plot_id, safeInt(deadline, -1), proof_packet);
      if (!result.ok) return res.status(400).json({ error: result.motivo });
      if (result.bloco && this.sync) {
        const block = result.bloco;
        setImmediate(() => { this.sync.broadcastBlock(block); });
      }
      res.json(result);
    });

    app.get('/api/mining/metrics', (req, res) => res.json(this.miner.getMetrics()));
    app.get('/api/mining/status', (req, res) => res.json({ mining: this.miner.active, address: this.miner.address }));
    app.post('/api/mining/start', (req, res) => { this.miner.start(req.body.address || this.cfg.minerAddress); res.json({ ok: true, mining: this.miner.active, address: this.miner.address }); });
    app.post('/api/mining/stop', (req, res) => { this.miner.stop(); res.json({ ok: true, mining: false }); });

    app.post('/api/mining/config', (req, res) => {
      const { address, threads, priority } = req.body;
      if (address) this.miner.address = address;
      res.json({ ok: true, address: this.miner.address });
    });

    app.post('/api/poc/create_plot', (req, res) => {
      const { miner, plot_id, size_gb, plot_dir } = req.body;
      const address = miner || this.cfg.minerAddress;
      if (!address || !plot_id || !size_gb) return res.status(400).json({ error: 'miner address, plot_id, size_gb required' });
      try {
        const size = parseFloat(size_gb);
        if (size <= 0 || size > 1e9) return res.status(400).json({ error: 'invalid size_gb' });
        const plotPath = path.join(plot_dir || this.cfg.plotsDir, `${plot_id}.plot`);
        const plotInfo = createPlotFile(plotPath, plot_id, address, size);
        this.db.prepare('INSERT OR IGNORE INTO plot_commitments (plot_id, miner, merkle_root, size_gb, created_at) VALUES (?,?,?,?,?)').run(plot_id, address, plotInfo.merkleRoot, size, Math.floor(Date.now() / 1000));
        res.json({ ok: true, plot_id, merkle_root: plotInfo.merkleRoot, size_gb: size, path: plotPath });
      } catch (e) { res.status(500).json({ error: e.message }); }
    });

    app.get('/api/poc/plots/:miner', (req, res) => res.json({ plots: this.db.prepare('SELECT * FROM plot_commitments WHERE miner = ?').all(req.params.miner) }));
    app.post('/api/poc/register_plot', (req, res) => {
      const { miner, plot_id, size_gb, merkle_root = '' } = req.body;
      if (!miner || !plot_id || !size_gb) return res.status(400).json({ error: 'miner, plot_id, size_gb required' });
      this.db.prepare('INSERT OR IGNORE INTO plot_commitments (plot_id, miner, merkle_root, size_gb, created_at) VALUES (?,?,?,?,?)').run(plot_id, miner, merkle_root, parseFloat(size_gb), Math.floor(Date.now() / 1000));
      res.json({ ok: true, plot_id, miner });
    });

    app.post('/api/stake', (req, res) => {
      const { amount, address } = req.body;
      if (!amount || !address) return res.status(400).json({ error: 'amount and address required' });
      res.json({ ok: true, amount: String(amount), address, stakeId: 'stake_' + Date.now() });
    });

    app.post('/api/node/settings', (req, res) => {
      const updates = req.body;
      if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'settings object required' });
      Object.assign(this.cfg, updates);
      require('./config').saveConfig(this.cfg);
      res.json({ ok: true, config: this.cfg });
    });

    const requireAdmin = (req, res, next) => {
      if (req.headers['x-admin-token'] === this.cfg.adminToken) return next();
      res.status(401).json({ error: 'unauthorized' });
    };
    app.get('/api/logs', requireAdmin, (req, res) => res.json({ logs: getLogBuffer() }));

    app.post('/api/node/broadcast/block', (req, res) => {
      const block = req.body.block;
      if (!block) return res.status(400).json({ error: 'block required' });
      const result = this.chain.addBlock(block, { skipPocValidation: true, skipSignature: true, skipTargetValidation: true, skipStateValidation: true, skipHashValidation: true, forceSync: true });
      log('debug', `broadcast block h=${block.height} hash=${(block.hash || '').slice(0, 10)} result=${result.motivo} altura=${this.chain.altura}`);
      res.json(result);
    });

    app.post('/api/node/broadcast/tx', (req, res) => {
      const tx = req.body.tx;
      if (!tx) return res.status(400).json({ error: 'tx required' });
      const result = this.chain.addMempoolTx(tx);
      if (result.ok && result.motivo !== 'Tx already in mempool') {
        const relayHops = safeInt(tx.relay_hops, 0);
        if (relayHops < 2) setImmediate(() => this.sync.broadcastTx({ ...tx, relay_hops: relayHops + 1 }));
      }
      res.json(result);
    });

    app.post('/api/node/announce', (req, res) => {
      const url = require('./config').normalizeUrl(req.body.url);
      if (!url) return res.status(400).json({ error: 'url required' });
      this.peers.add(url);
      this.peers.seen(url, safeInt(req.body.height, 0), req.body.node_id);
      res.json({ ok: true, our_height: this.chain.altura, node_id: this.NODE_ID, peers: this.peers.gossipPeers(10) });
    });

    app.get('/peers', (req, res) => res.json({ peers: this.peers.gossipPeers(50), count: this.peers.count() }));
    app.get('/stats', (req, res) => {
      const ns = this.registry.getStats();
      res.json({ ...ns, chain_id: this.cfg.chainId, chain_name: this.cfg.chainName, symbol: this.cfg.symbol, seed_version: this.cfg.version, node_url: this.cfg.nodeUrl, node_id: this.NODE_ID });
    });

    app.post('/register', (req, res) => {
      const url = require('./config').normalizeUrl(req.body.url);
      if (!url || !req.body.node_id) return res.status(400).json({ error: 'url and node_id required' });
      this.peers.add(url);
      this.peers.seen(url, safeInt(req.body.height, 0), req.body.node_id);
      this.registry.registerNode(url, req.body.node_id, { height: safeInt(req.body.height, 0), chain_work: req.body.chain_work, version: req.body.version, peers: safeInt(req.body.peers, 0) });
      res.json({ ok: true, peers: this.peers.gossipPeers(20), stats: this.registry.getStats(), chain_id: this.cfg.chainId });
    });

    app.post('/api/challenge/submit', (req, res) => {
      const { challenge_id, miner, plot_id, deadline, proof_packet } = req.body;
      if (!challenge_id || !miner || !plot_id || deadline == null) return res.status(400).json({ error: 'challenge_id, miner, plot_id, deadline required' });
      const result = this.challengeMgr.submitProof(this.chain, challenge_id, miner, plot_id, safeInt(deadline, -1), proof_packet);
      res.json(result);
    });

    app.post('/api/node/vote/request', (req, res) => {
      const { vote_id, proposer } = req.body;
      if (!vote_id || !proposer) return res.status(400).json({ error: 'vote_id and proposer required' });
      res.json({ vote_id, approve: true, reason: 'accepted', voter_address: this.cfg.minerAddress || '', stake: 0 });
    });

    app.post('/api/plots/add', (req, res) => {
      const { miner, plot_id, size_gb, merkle_root = '' } = req.body;
      if (!miner || !plot_id || !size_gb) return res.status(400).json({ error: 'miner, plot_id, size_gb required' });
      this.db.prepare('INSERT OR IGNORE INTO plot_commitments (plot_id, miner, merkle_root, size_gb, created_at) VALUES (?,?,?,?,?)').run(plot_id, miner, merkle_root, parseFloat(size_gb), Math.floor(Date.now() / 1000));
      res.json({ ok: true, plot_id, miner });
    });
    app.delete('/api/plots/:id', (req, res) => { this.db.prepare('DELETE FROM plot_commitments WHERE plot_id = ?').run(req.params.id); res.json({ ok: true }); });

    app.post('/api/node/forge', (req, res) => {
      const challenge = this.challengeMgr.getOrCreate();
      if (!challenge) return res.status(400).json({ error: 'no challenge' });
      this.challengeMgr._forgeBlockForChallenge(this.chain, this.sync, challenge);
      res.json({ ok: true });
    });

    app.get('/api/admin/wallets', requireAdmin, (req, res) => {
      res.json({ wallets: this.db.prepare('SELECT address, balance, nonce, created_at, updated_at FROM users ORDER BY CAST(balance AS INTEGER) DESC LIMIT 200').all() });
    });

    app.get('/api/rewards/:address', (req, res) => {
      const rewards = this.db.prepare('SELECT * FROM block_rewards WHERE miner = ? ORDER BY block_height DESC LIMIT 100').all(req.params.address);
      res.json({ rewards });
    });

    app.get('/api/transactions', (req, res) => {
      const address = req.query.address;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      let rows;
      if (address) rows = this.db.prepare('SELECT * FROM transactions WHERE from_addr = ? OR to_addr = ? ORDER BY block_height DESC LIMIT ?').all(address, address, limit);
      else rows = this.db.prepare('SELECT * FROM transactions ORDER BY block_height DESC LIMIT ?').all(limit);
      res.json({ transactions: rows });
    });

    app.get('/api/transaction/:hash', (req, res) => {
      const tx = this.db.prepare('SELECT * FROM transactions WHERE hash = ?').get(req.params.hash);
      if (!tx) return res.status(404).json({ error: 'not found' });
      res.json(tx);
    });

    app.get('/api/nodes', (req, res) => res.json({ nodes: this.registry.all() }));

    app.get('/api/health', (req, res) => res.json({
      ok: true, status: 'ok', height: this.chain.altura, hash: this.chain.melhorHash,
      peers: this.peers.count(), mempool: this.db.prepare('SELECT COUNT(*) as c FROM mempool').get().c,
      mining: this.miner.active, uptime: Math.floor((Date.now() - this._startTime) / 1000),
    }));
    app.get('/health', (req, res) => res.json({ ok: true }));
    app.get('/health/liveness', (req, res) => res.json({ ok: true }));
    app.get('/health/readiness', (req, res) => res.json({ ok: true }));

    let port = this.cfg.port;
    this.server = require('http').createServer(app);
    this.server.listen(port, '0.0.0.0', () => {
      log('info', `HTTP server listening on port ${port}`);
    });
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        port++;
        this.cfg.port = port;
        this.server.listen(port);
        log('info', `Port busy, using ${port}`);
      } else {
        log('error', `Server error: ${err.message}`);
        process.exit(1);
      }
    });
    this._startTime = Date.now();
  }

  stop() {
    if (this.server) try { this.server.close(); } catch {}
  }
}

module.exports = { Server };
