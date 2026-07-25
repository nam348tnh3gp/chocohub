const WebSocket = require('ws');
const { log } = require('./config');

class DiscoveryServer {
  constructor(port) {
    this.port = port;
    this.nodes = new Map();
    this.wss = null;
    this._failed = false;
  }

  start(callback) {
    const basePort = this.port;
    const tryPort = (port) => {
      this.wss = new WebSocket.Server({ port });
      this.wss.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && port < basePort + 100) {
          this.wss = null;
          tryPort(port + 1);
        } else {
          console.log(`[Discovery] ${err.code === 'EADDRINUSE' ? 'Ports ' + basePort + '-' + (basePort + 99) + ' in use' : err.message}, discovery disabled`);
          this._failed = true;
          if (callback) callback(null);
        }
      });
      this.wss.on('listening', () => {
        this.port = port;
        console.log(`[Discovery] WS server listening on port ${port}`);
        this._setup();
        if (callback) callback(null, port);
      });
    };
    tryPort(basePort);
  }

  _setup() {
    this.wss.on('connection', (ws) => {
      ws._alive = true;
      ws.on('pong', () => { ws._alive = true; });
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'announce' && msg.url) {
            ws._nodeInfo = { url: msg.url, nodeId: msg.nodeId || '', height: msg.height || 0, lastSeen: Date.now() };
            this.nodes.set(msg.url, ws._nodeInfo);
            this.broadcastPeers();
          }
        } catch {}
      });
      ws.on('close', () => {
        if (ws._nodeInfo && this.nodes.get(ws._nodeInfo.url) === ws._nodeInfo) {
          this.nodes.delete(ws._nodeInfo.url);
          this.broadcastPeers();
        }
      });
      ws.on('error', () => {});
      this.sendPeers(ws);
    });
    this._pingTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!ws._alive) { ws.terminate(); continue; }
        ws._alive = false;
        ws.ping();
      }
    }, 10000);
    this._cleanTimer = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [url, info] of this.nodes) {
        if (now - info.lastSeen > 30000) { this.nodes.delete(url); changed = true; }
      }
      if (changed) this.broadcastPeers();
    }, 15000);
    this._broadcastTimer = setInterval(() => { this.broadcastPeers(); }, 10000);
  }

  sendPeers(ws) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'peers',
        peers: Array.from(this.nodes.values()).map(n => ({ url: n.url, nodeId: n.nodeId, height: n.height })),
      }));
    }
  }

  broadcastPeers() {
    if (!this.wss) return;
    const msg = JSON.stringify({
      type: 'peers',
      peers: Array.from(this.nodes.values()).map(n => ({ url: n.url, nodeId: n.nodeId, height: n.height })),
    });
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }

  stop() {
    clearInterval(this._pingTimer);
    clearInterval(this._cleanTimer);
    clearInterval(this._broadcastTimer);
    if (this.wss) try { this.wss.close(); } catch {}
  }
}

function connectDiscoveryServer(cfg, peers, chain, sync) {
  if (!cfg.discoveryUrl) return null;
  let ws, reconnectTimer, destroyed = false;
  const connect = () => {
    if (destroyed) return;
    try {
      ws = new WebSocket(cfg.discoveryUrl);
      ws.on('open', () => {
        log('info', `Discovery: connected to ${cfg.discoveryUrl}`);
        ws.send(JSON.stringify({ type: 'announce', url: cfg.nodeUrl, nodeId: sync ? sync.NODE_ID : '', height: chain ? chain.altura : 0 }));
      });
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'peers' && Array.isArray(msg.peers)) {
            for (const p of msg.peers) {
              if (p.url && p.url !== cfg.nodeUrl && peers) peers.add(p.url);
            }
          }
        } catch {}
      });
      ws.on('close', () => { if (!destroyed) reconnectTimer = setTimeout(connect, 5000); });
      ws.on('error', () => {});
    } catch {
      if (!destroyed) reconnectTimer = setTimeout(connect, 5000);
    }
  };
  connect();
  return () => { destroyed = true; clearTimeout(reconnectTimer); if (ws) try { ws.close(); } catch {} };
}

module.exports = { DiscoveryServer, connectDiscoveryServer };
