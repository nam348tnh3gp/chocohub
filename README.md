<div align="center">

# ChocoHub — CCpow Whitepaper

<a href="https://chocohub-r011.onrender.com/">
  <img src="https://img.shields.io/badge/Platform-6e45e2?style=for-the-badge&logo=google-chrome&logoColor=white" width="260" style="height: 50px;">
</a>
<a href="https://discord.gg/sztTse9p">
  <img src="https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" width="260" style="height: 50px;">
</a>

**ChocoHub** is a centralized mining platform built on a hybrid Proof-of-Work + Proof-of-Stake consensus. Mine CC (Choco Coin) directly from your browser, earn rewards through staking, play games, and swap across currencies — all in one place.

</div>

---

## Abstract

ChocoHub introduces **CCpow**, a fair and accessible Proof-of-Work mining protocol designed to democratize cryptocurrency mining. Unlike traditional PoW systems that favor ASIC-rich miners, CCpow implements per-worker difficulty adjustment, tier-based reward multipliers, and browser-based mining to ensure anyone with any device can participate profitably. The network is secured by a hybrid PoW + PoS model where validators stake CC to earn a share of transaction fees and block rewards.

---

## 1. The Problem

### 1.1 Mining Centralization

Traditional PoW networks (Bitcoin, Litecoin) have become dominated by ASIC farms and industrial-scale mining operations. Small miners with consumer hardware cannot compete, leading to centralization of hash power and rewards.

### 1.2 Hardware Barriers

Most cryptocurrencies require specific, expensive hardware setups. CPU mining is often unprofitable, and GPU mining requires significant capital investment. Microcontrollers and mobile devices are completely locked out.

### 1.3 Energy Inefficiency

Conventional PoW consumes enormous amounts of electricity. Miners in regions with high energy costs often mine at a loss, making participation unsustainable for the average user.

### 1.4 Unfair Reward Distribution

Without tier-based adjustment, high-hashrate miners capture nearly all rewards, leaving small miners with negligible earnings. This creates a winner-takes-all dynamic that discourages broad participation.

---

## 2. The Solution — CCpow

CCpow is a **SHA-256 based Proof-of-Work consensus** engineered for fairness and accessibility. Key innovations:

### 2.1 Per-Worker Dynamic Difficulty

Each miner has an **independent difficulty target** that adjusts based on their historical solve time. The network targets a 10-second solve window per worker:

```
newDifficulty = currentDifficulty * (targetSolveTime / actualSolveTime)
```

- **Solve too fast** (&lt; 10s): Difficulty increases, reducing wasted hash power on trivial targets.
- **Solve too slow** (&gt; 10s): Difficulty decreases, ensuring the miner can still find blocks.
- **Job expires** (60s timeout without solve): Difficulty decays by up to 90%, preventing miners from getting stuck at impossible difficulty levels.

### 2.2 Tier-Based Reward Multipliers

| Tier | Multiplier | Max Difficulty | Examples |
|:---:|:---:|:---:|---|
| embedded_avr | 3.5x | 5,000 | Arduino Uno, Nano, Mega (~30 H/s) |
| embedded_arm | 3.0x | 50,000 | Raspberry Pi Pico, RP2040 (~500 H/s) |
| embedded_esp | 2.5x | 100,000 | ESP8266, NodeMCU (~5 kH/s) |
| embedded_esp32 | 2.0x | 500,000 | ESP32, ESP32-S2, ESP32-C3 (~30 kH/s) |
| mobile | 1.8x | 10,000 | Android, iOS browsers (~200 kH/s) |
| cpu | 1.0x | 1,000,000,000 | Desktop browser miner (~1–10 MH/s) |
| gpu | 1.0x | 1,000,000,000 | GPU mining (~10–500 MH/s) |

Lower-power devices receive **higher multipliers**, ensuring fair rewards proportional to their computational contribution relative to their capability.

### 2.3 Hashrate Validation

The server cross-checks each miner's reported hashrate against actual solve time. If a block is solved 20x faster than the reported hashrate would permit, a warning is issued. After **3 warnings within 24 hours**, the worker is automatically suspended:

```
validationRatio = actualSolveTime / (difficulty / reportedHashrate)
if validationRatio < 0.05 → suspicious activity flagged
```

This prevents abuse where miners under-report their hashrate to manipulate difficulty.

### 2.4 Reward Distribution per Block

Each block rewards **0.05 CC** distributed as follows:

| Share | No Node Relay | With Node Relay |
|:---:|:---:|:---:|
| Miner | 95% (0.0475 CC) | 90% (0.0450 CC) |
| PoS Pool | 5% (0.0025 CC) | 5% (0.0025 CC) |
| Relay Node | — | 5% (0.0025 CC) |

Miner rewards are further multiplied by their **tier multiplier** (e.g., 3.5x for Arduino = 0.16625 CC per block).

---

## 3. Platform Architecture

### 3.1 Core Server (`server.js`)

The main ChocoHub server runs on Node.js with Express, providing:
- Hybrid HTTP/1.1 + HTTP/2 with TLS 1.3
- Admin web interface with user management (create, delete, ban)
- Swap engine (CC ↔ DUCO, CC ↔ XNO)
- Mempool for transaction processing
- Backup synchronization with DH-encrypted sessions
- Mining node registry and heartbeat monitoring
- Game session management (anti-abuse)

### 3.2 Blockchain Engine (`blockchain.js`)

The PoW engine manages:
- **Job creation**: Each height creates jobs for miners with appropriate difficulty and target
- **Job pooling**: Pre-created jobs at future heights for instant assignment
- **Solution validation**: SHA-256 hash verification against target
- **Mempool processing**: Confirms pending transactions when blocks are solved
- **Difficulty adjustment**: Per-worker dynamic targeting 10s solve time
- **PoS distribution**: Fee pool redistribution every 30 seconds

### 3.3 Database (`db.js`)

SQLite with WAL mode stores:
- Users & balances
- Blockchain (blocks, mining jobs)
- Stakes and PoS reward pool
- Mempool transactions
- Worker difficulties and tier registrations
- Worker flags (warnings, suspensions)
- Mining nodes registry
- Game sessions
- Snake claims and leaderboards

### 3.4 Standalone Mining Nodes

ChocoHub supports distributed mining nodes that relay work between miners and the main server:

- **mining-node/** — Self-contained node with localtunnel/cloudflared/ngrok support, SQLite blockchain backup, auto-reconnect, and full-chain restore endpoints
- **railway-node/** — Optimized for Railway deployment with DH-encrypted backup sync, RSA-authenticated key exchange, snapshot backup/restore, and main server health monitoring

---

## 4. Features

### 4.1 Webminer (SHA-256)

A browser-based miner runs in any modern browser (desktop and mobile). It connects to the server, receives jobs, computes SHA-256 hashes, and submits solutions. No software installation required.

Implementation details:
- **Algorithm**: SHA-256 (`crypto.createHash('sha256')`)
- **Input**: `prev_hash + padded_nonce + worker_key`
- **Validation**: `hash < target_hex`
- **Job expiry**: 60 seconds
- **Per-worker difficulty**: Dynamically adjusted

### 4.2 Staking (Proof-of-Stake)

CC holders can stake a minimum of **10 CC** to become validators. Staking rewards are distributed every **30 seconds** from the PoS pool, which accumulates:
- 5% of every block reward
- Transaction fees from the mempool

Validator rewards are proportional to their stake relative to total staked CC:

```
validatorReward = (validatorStake / totalStake) * poolBalance
```

Stakers can withdraw their stake plus accumulated rewards at any time.

### 4.3 Swap System

CC can be swapped for other currencies on the platform:

- **CC → DUCO**: Fixed rate of **10 CC = 1 DUCO**
- **CC → XNO**: Rate calculated as `amountCC * 0.000002 XNO`
- **XNO → CC**: Convert Nano to CC at market rate
- **DUCO → CC**: Convert DUCO to CC

All swaps are processed through an admin-fulfilled system with pending/completed status tracking.

### 4.4 Faucet Games

The **Snake Faucet** game lets players earn CC by playing the classic Snake game:
- **Normal mode**: Standard snake with CC rewards proportional to apples collected
- **Hardcore mode**: Faster-paced variant with higher reward potential

Game sessions are tracked with expiry (30-minute window) to prevent abuse. Rate limits ensure fair play (max 30 sessions/hour, max 5 claims/15 minutes).

### 4.5 Mining Boost

Miners can activate a **1.3x reward multiplier** for 1 hour by completing an ad view (via ad network integration). Boosts stack by extending the active duration rather than multiplying further.

### 4.6 Admin Dashboard

A full-featured admin panel provides:
- User management (create, delete, ban)
- Balance adjustments (add/set)
- Swap fulfillment (complete, delete)
- Worker monitoring (flagged/suspended workers)
- System statistics

---

## 5. Tokenomics

### 5.1 CC (Choco Coin)

- **Type**: Utility & reward token
- **Supply**: Mined through PoW + distributed through staking and games
- **Exchange Rate**: 10 CC = 1 DUCO (fixed)
- **Use Cases**: Staking, swap fees, in-platform transactions, game rewards

### 5.2 Block Reward Schedule

| Parameter | Value |
|:---|---:|
| Base reward per block | 0.05 CC |
| Target solve time | 10 seconds |
| Max blocks per minute (single worker) | ~6 |
| Min difficulty | 1 |
| Max difficulty | 1,000,000,000 |
| Job expiry | 60 seconds |

### 5.3 Fee Structure

Transaction fees use a dynamic model where **more network activity = lower fees**:

```
fee = baseFee * (1 / activeMiners)
```

This means the fee decreases as the network grows, making CC more economical with wider adoption.

### 5.4 PoS Reward Pool

| Source | Contribution |
|:---|---:|
| Block rewards | 5% of each block |
| Transaction fees | Variable per tx |
| Distribution interval | Every 30 seconds |
| Minimum stake | 10 CC |

---

## 6. Network Security

### 6.1 Worker Suspension System

The platform monitors worker behavior and auto-suspends accounts exhibiting suspicious patterns:
- **Hashrate fraud**: Submitting solutions faster than reported hashrate allows
- **Warning threshold**: 3 warnings within 24 hours = automatic suspension
- **Manual admin control**: Admins can suspend/clear any worker

### 6.2 Rate Limiting

All endpoints are protected with rate limits:
- **Auth**: 10 requests / 15 minutes
- **Send**: 5 requests / minute
- **Stake**: 3 requests / minute
- **Swap**: 5 requests / minute
- **Job requests**: 120 / minute
- **Solution submissions**: 60 / minute
- **Game sessions**: 30 / hour
- **Game claims**: 5 / 15 minutes

### 6.3 Input Validation

All user inputs are validated and sanitized:
- Usernames: Trimmed, min 3 characters
- URLs: Regex validation for http/https
- Numeric bounds: Miners count capped (0–10,000), hash rates validated
- JSON body size limited (1MB–50MB depending on endpoint)

### 6.4 Backup & Redundancy

- **SQLite WAL mode**: Crash-safe database operations
- **Mining nodes**: Distributed relay nodes with local blockchain backup
- **Node-to-node sync**: DH-encrypted snapshot transfer between nodes
- **Full-chain restore**: Any node can serve as a backup source

---

## 7. Deployment

The platform is designed for cloud hosting (Railway, Render) with the following components:

| Component | Location | Purpose |
|:---|---:|:---|
| Main server | `server.js` | Web interface, API, PoW engine |
| Database | `chocohub.db` | SQLite blockchain + user data |
| Mining node | `mining-node/` | Standalone relay node |
| Railway node | `railway-node/` | Cloud-hosted relay + backup |
| Arduino miner | `arduino/` | ESP32/AVR microcontroller miner |
| Web frontend | `public/` | Browser-based miner + UI |

---

## 8. Roadmap

- **Phase 1**: Webminer launch + CC staking (complete)
- **Phase 2**: Swap system (DUCO, XNO) (complete)
- **Phase 3**: Mining nodes + backup sync (complete)
- **Phase 4**: Arduino/ESP32 microcontroller mining (complete)
- **Phase 5**: Mobile app mining, expanded swap pairs, cross-chain bridges

---

## 9. Conclusion

CCpow represents a paradigm shift in accessible cryptocurrency mining. By combining per-worker difficulty adjustment, tier-based reward multipliers, and browser-based mining, ChocoHub enables anyone with a device to participate in securing the network and earning CC. The hybrid PoW + PoS model ensures long-term sustainability, while the distributed mining node architecture provides resilience and redundancy.

---

## Quick Start

```bash
# Clone the repository
git clone https://github.com/nam348tnh3gp/chocohub
cd chocohub

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Start the server
npm start
```

For Arduino/ESP32 miners, flash the appropriate `.ino` file from the `arduino/` folder. For standalone mining nodes, see `mining-node/` or `railway-node/`.

---

<div align="center">
  <em>Start earning CC today — mine, play, stake!</em>
</div>
