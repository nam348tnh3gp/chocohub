<div align="center">

# 🍫 ChocoHub

<a href="https://chocohub-r011.onrender.com/">
  <img src="https://img.shields.io/badge/🌐_Official_Website-6e45e2?style=for-the-badge&logo=google-chrome&logoColor=white" width="260" style="height: 50px;">
</a>
<a href="https://discord.gg/sztTse9p">
  <img src="https://img.shields.io/badge/💬_Join_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" width="260" style="height: 50px;">
</a>
<a href="https://app.uniswap.org/explore/pools/polygon/0xd9cff2709fc89c25fac3779486d602bfd32eec4555d228e05ec4cf5de9398848?utm_source=share-pool&utm_medium=web">
  <img src="https://img.shields.io/badge/Swap_on_Uniswap-FF007A?style=for-the-badge&logo=uniswap&logoColor=white" width="260" style="height: 50px;">
</a>

</div>

## 📖 What is ChocoHub?

> **ChocoHub** started as a simple "snake faucet" game rewarding players with **DUCO**, and evolved into a full platform of utilities.  
> It's actively maintained by **Ruvyzvat** (Nam348tnh3gp) and **BloodFell** (Chocoetom).  
> *Earn, play, stake, mine and swap — all in one place.*

---

## Key Features

| Feature | Description |
|:---:|---|
| ⛏️ **Webminer** <br> *(SHA256)* | A browser-based miner for PC and mobile. 
| 💰 **CC Staking** | Validators get a % based on every swap made and each block mined, receiving on how much they have staked |
| 🎮 **Faucet Games** | Play the **Snake Faucet** and other games to receive CC rewards directly while you play. |
| 🔄 **Swap System** <br> | Swap to Duco or XNO directly on the platform. |

---

## 💎 What is CC & CCpol?

**CC (Choco Coins)** is the **main** & **stable** coin on chocohub, you can use for activities and others.
**ChocoCoinPoC** is the non-stable CC token, it can be mined with HDD, SSD, SD cards or anything with actual storage of 1gb (no actual minimum, but recommended)
**ChocoCoinPolygon (CCpol) is a non-stable coin too, used as option for external tradings to CCPoC Contract: 0x748454b64c415A2cb2EFD0162319479c5958d2D1 add to your wallet now !**

## CC PoC, what is and how it works? 

**CCpoc** is a decentralized blockchain network implementing Proof-of-Capacity (PoC) consensus with fair reward distribution through tier-based difficulty adjustment. The protocol prioritizes accessibility for small miners while maintaining security and network integrity.

## What are the actual blockchains issue and how CCpoc solves it?

1. **Mining Centralization**: Large miners with petabyte-scale storage dominate rewards, causing small miners to dont have actual profit.
2. **Hardware Limitation**: Miners forced to use specific hardware configurations, like 200-300gb.
3. **Energy Consumption**: PoW-based systems consume excessive electricity, in many cases, doesnt even pays eletricity bills.

## How we solve it?

- Proof-of-Capacity: Storage-based instead of compute-based
- Tier-Based Rewards: Diminishing returns for extremely large miners
- Flexible Hardware: Any storage device (SDCard, USB, NVME, HDD)
- Energy Efficient: Minimal CPU, low power consumption (only actual usage while plotting)

#### Proof-of-Capacity (PoC)

```
Challenge:
  ├─ block_height: Current chain height
  ├─ challenge_seed: Random seed from previous block
  └─ target_scoop_index: Calculation point

Block Submission:
  ├─ Miner scans plot file for scoops
  ├─ Computes deadline = quality_hash / base_target
  ├─ Submits proof with lowest deadline
  └─ Network validates PoC

Validation:
  ├─ Verify plot commitment (merkle root)
  ├─ Recompute quality hash
  ├─ Confirm deadline < max_deadline
  └─ Accept block if valid
```

**Advantages**:
- Asynchronous: Miners can work on multiple challenges
- Verifiable: Proofs are independently verifiable
- Fair: Larger storage = more proof attempts, but difficulty adjusts
- Efficient: Minimal CPU, mostly I/O bound

## What are our Target users?

People who dont have hardware for common pow mining, giving them the opportunity to mine with unused storage with PoC or PoW mining with microcontrollers.

## What about the gas fees, is it expensive?

No, it doesnt, we use a formula where more miners = lower fees, this means more users makes the network sending more cheaper.

| 🔁 Exchange Rate | 💡 Utility |
|:---:|:---|
| **10 CC = 1 DUCO** | Rewards for games, staking, mining, and soon swaps into other major micro-currencies. |

> ⚡ *Start earning CC today — mine, play, stake!*
