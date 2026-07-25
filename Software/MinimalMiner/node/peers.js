const { log } = require('./config');

class PeerManager {
  constructor(db, cfg) {
    this.db = db;
    this.cfg = cfg;
  }

  all(limit = 100) {
    return this.db.prepare('SELECT * FROM peers WHERE banned = 0 ORDER BY health DESC, last_seen DESC LIMIT ?').all(limit);
  }

  active(limit = 50) {
    const now = Date.now();
    const ttl = this.cfg.peerTimeoutMs || 30000;
    return this.db.prepare('SELECT * FROM peers WHERE banned = 0 AND ? - last_seen < ? ORDER BY health DESC, last_seen DESC LIMIT ?').all(now, ttl, limit);
  }

  banned() {
    return this.db.prepare('SELECT * FROM peers WHERE banned = 1').all();
  }

  add(url) {
    if (!url) return false;
    const normalized = require('./config').normalizeUrl(url);
    if (!normalized) return false;
    const existing = this.db.prepare('SELECT * FROM peers WHERE url = ?').get(normalized);
    if (existing) {
      this.db.prepare('UPDATE peers SET last_seen = ?, health = MIN(1.0, health + 0.05) WHERE url = ?').run(Date.now(), normalized);
      return false;
    }
    this.db.prepare('INSERT OR IGNORE INTO peers (url, first_seen, last_seen, health) VALUES (?, ?, ?, ?)').run(normalized, Date.now(), Date.now(), 1.0);
    log('info', `Peer added: ${normalized}`);
    return true;
  }

  seen(url, height, nodeId) {
    if (!url) return;
    const normalized = require('./config').normalizeUrl(url);
    if (!normalized) return;
    this.db.prepare("UPDATE peers SET last_seen = ?, height = ?, node_id = COALESCE(NULLIF(?, ''), node_id), health = MIN(1.0, health + 0.02), fail_count = 0 WHERE url = ?").run(Date.now(), height || 0, nodeId || '', normalized);
  }

  remove(url) {
    this.db.prepare('DELETE FROM peers WHERE url = ?').run(url);
  }

  fail(url) {
    if (!url) return;
    const peer = this.db.prepare('SELECT * FROM peers WHERE url = ?').get(url);
    if (!peer) return;
    const failCount = (peer.fail_count || 0) + 1;
    const threshold = this.cfg.peerBanThreshold || 50;
    if (failCount >= threshold) {
      this.db.prepare('UPDATE peers SET fail_count = ?, health = health - 0.1, banned = 1 WHERE url = ?').run(failCount, url);
      log('warn', `Peer banned: ${url}`);
    } else {
      this.db.prepare('UPDATE peers SET fail_count = ?, health = health - 0.1 WHERE url = ?').run(failCount, url);
    }
  }

  decayHealth() {
    this.db.prepare('UPDATE peers SET health = MAX(0.1, health - 0.02) WHERE health > 0.1').run();
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) as c FROM peers WHERE banned = 0').get().c;
  }

  maxHeight() {
    const row = this.db.prepare('SELECT MAX(height) as h FROM peers WHERE banned = 0').get();
    return row ? row.h : 0;
  }

  stats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM peers').get().c;
    const active = this.db.prepare('SELECT COUNT(*) as c FROM peers WHERE banned = 0').get().c;
    const banned = this.db.prepare('SELECT COUNT(*) as c FROM peers WHERE banned = 1').get().c;
    return { total, active, banned };
  }

  gossipPeers(maxPeers = 20) {
    return this.active(maxPeers).map(p => ({ url: p.url, node_id: p.node_id, height: p.height }));
  }
}

module.exports = { PeerManager };
