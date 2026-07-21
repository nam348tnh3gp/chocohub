// separate module from server, so editing will be easier :3
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

const XNO_CONFIG = {
  CC_TO_XNO_RATE: 0.000002,
  XNO_TO_CC_RATE: 500000,
  XNO_RECEIVE_ADDRESS: 'nano_3ax7ayzdruyc1z14ezpkp9q7ry5out75uopxtugyxewi75ypmianr3cse8uy',
};

const SWAP_FEE_RATE = 0.02;
const ADMIN_USERS = ['chocoetom', 'Nam2010'];

function isAdmin(username) {
  return ADMIN_USERS.includes(username);
}

function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Missing or invalid token' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ status: 'error', message: 'Invalid or expired token' });
  }
}

function verifyAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ status: 'error', message: 'Not authenticated' });
  }
  if (!isAdmin(req.user.username)) {
    return res.status(403).json({ status: 'error', message: 'Admin access required' });
  }
  next();
}

const swapLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { status: 'error', message: 'Too many swap requests, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

let swapRequests = [];
const SWAP_FILE = path.join(__dirname, 'swap_requests.json');

function loadSwapRequests() {
  try {
    if (fs.existsSync(SWAP_FILE)) {
      const data = JSON.parse(fs.readFileSync(SWAP_FILE, 'utf8'));
      if (Array.isArray(data)) swapRequests = data;
      console.log(`📦 Loaded ${swapRequests.length} swap requests from file`);
    }
  } catch (e) {
    console.warn('Could not load swap requests:', e.message);
  }
}

function saveSwapRequests() {
  try {
    fs.writeFileSync(SWAP_FILE, JSON.stringify(swapRequests, null, 2));
  } catch (e) {
    console.error('Failed to save swap requests:', e.message);
  }
}

loadSwapRequests();

function ensureHoldingAccount() {
  const holding = db.getUser('swap_holding');
  if (!holding) {
    const randomPin = crypto.randomBytes(16).toString('hex');
    db.authenticate('swap_holding', randomPin);
    console.log('🏦 Created swap_holding account with random pin');
  }
}
ensureHoldingAccount();

function ensureLiquidityAccount() {
  const liquidity = db.getUser('swap_liquidity');
  if (!liquidity) {
    const randomPin = crypto.randomBytes(16).toString('hex');
    db.authenticate('swap_liquidity', randomPin);
    console.log('🏊 Created swap_liquidity account (liquidity pool)');
  }
}
ensureLiquidityAccount();

function roundAmount(value) {
  return Number((Number(value) || 0).toFixed(8));
}

function splitSwapValue(amount) {
  const gross = roundAmount(amount);
  const fee = roundAmount(gross * SWAP_FEE_RATE);
  const net = roundAmount(gross - fee);
  return { gross, fee, net };
}

function creditSwapFee(amount, swapId, swapType) {
  const fee = roundAmount(amount);
  if (fee <= 0) return 0;

  if (typeof db.addPosRewardPool === 'function') {
    db.addPosRewardPool(fee);
  }

  if (typeof db.addTransaction === 'function') {
    if (db.addTransaction.length >= 4) {
      db.addTransaction('swap_fee_pool', 'pos_reward_pool', fee, `${swapType.toUpperCase()} swap fee (${swapId})`);
    } else {
      db.addTransaction('swap_fee_pool', 'pos_reward_pool', fee);
    }
  }

  return fee;
}

function refundUser(request) {
  if (request.status !== 'pending') return;

  const amount = request.amount_cc;
  db.updateBalance('swap_holding', -amount);
  db.updateBalance(request.from_user, amount);
  if (db.addTransaction.length >= 4) {
    db.addTransaction('swap_holding', request.from_user, amount, `Refund for cancelled swap ${request.id}`);
  } else {
    db.addTransaction('swap_holding', request.from_user, amount);
  }
  console.log(`💰 Refunded ${amount} CC to ${request.from_user} from holding (swap ${request.id})`);
}

function creditFromLiquidity(username, amount, swapId, swapType) {
  const receiver = db.getUser(username);
  if (!receiver) {
    throw new Error(`Receiver ${username} not found`);
  }
  ensureLiquidityAccount();
  const liquidity = db.getUser('swap_liquidity');
  if (!liquidity || liquidity.balance < amount) {
    throw new Error(`Insufficient liquidity: need ${amount} CC, pool has ${liquidity ? liquidity.balance : 0} CC`);
  }
  db.updateBalance('swap_liquidity', -amount);
  db.updateBalance(username, amount);
  if (db.addTransaction.length >= 4) {
    db.addTransaction('swap_liquidity', username, amount, `${swapType.toUpperCase()} → CC swap (${swapId})`);
  } else {
    db.addTransaction('swap_liquidity', username, amount);
  }
  console.log(`🏊 Credited ${amount} CC to ${username} from liquidity pool (${swapType} swap ${swapId})`);
  return true;
}

router.post('/create', verifyToken, swapLimiter, (req, res) => {
  try {
    const { from_user, amount_cc, swap_type, receiver } = req.body;

    if (req.user.username !== from_user) {
      return res.status(403).json({ status: 'error', message: 'Unauthorized: username mismatch' });
    }

    if (!amount_cc || !swap_type || !receiver) {
      return res.status(400).json({ status: 'error', message: 'Missing required fields' });
    }

    const amount = parseFloat(amount_cc);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid amount' });
    }

    if (swap_type !== 'duco' && swap_type !== 'ccpoc' && swap_type !== 'cc_to_xno') {
      return res.status(400).json({ status: 'error', message: 'Invalid swap type. Must be "duco", "ccpoc", or "cc_to_xno"' });
    }

    const user = db.getUser(from_user);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    if (user.balance < amount) {
      return res.status(400).json({ status: 'error', message: 'Insufficient CC balance' });
    }

    ensureHoldingAccount();
    db.updateBalance(from_user, -amount);
    db.updateBalance('swap_holding', amount);
    if (db.addTransaction.length >= 4) {
      db.addTransaction(from_user, 'swap_holding', amount, `Swap escrow to ${swap_type.toUpperCase()} for ${receiver}`);
    } else {
      db.addTransaction(from_user, 'swap_holding', amount);
    }

    let rateInfo = { fee_rate: SWAP_FEE_RATE };
    if (swap_type === 'cc_to_xno') {
      const xnoAmount = amount * XNO_CONFIG.CC_TO_XNO_RATE;
      rateInfo = {
        ...rateInfo,
        exchange_rate: XNO_CONFIG.CC_TO_XNO_RATE,
        xno_amount: xnoAmount,
        note: `${amount} CC = ${xnoAmount.toFixed(8)} XNO before fee`,
      };
    } else if (swap_type === 'duco') {
      rateInfo = { ...rateInfo, rate: 10, note: '1 DUCO = 10 CC before fee' };
    } else if (swap_type === 'ccpoc') {
      rateInfo = { ...rateInfo, rate: 0.75, note: '1 CC PoC = 0.75 CC before fee' };
    }

    const newRequest = {
      id: Date.now() + '-' + crypto.randomBytes(8).toString('hex'),
      from_user,
      amount_cc: amount,
      swap_type,
      receiver: receiver.trim(),
      rate: swap_type === 'duco' ? 10 : (swap_type === 'ccpoc' ? 0.75 : XNO_CONFIG.CC_TO_XNO_RATE),
      fee_rate: SWAP_FEE_RATE,
      status: 'pending',
      created_at: new Date().toISOString(),
      ...rateInfo
    };

    swapRequests.push(newRequest);
    saveSwapRequests();

    require('https').request('https://ntfy.sh/chocohub-pending-swaps', { method: 'POST' })
      .end(`New swap: ${newRequest.id} | ${from_user} → ${amount} CC (${swap_type}) for ${receiver}`);

    console.log(`🔄 Swap request created: ${newRequest.id} | ${from_user} -> ${amount} CC to ${swap_type} for ${receiver}`);

    res.json({
      status: 'success',
      message: `Swap request created. ${amount} CC moved to holding.`,
      request_id: newRequest.id,
      new_balance: user.balance - amount,
      swap_details: rateInfo
    });
  } catch (e) {
    console.error('Swap create error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.post('/create_duco_to_cc', verifyToken, swapLimiter, (req, res) => {
  try {
    const { from_user, amount_duco, target_username } = req.body;

    if (req.user.username !== from_user) {
      return res.status(403).json({ status: 'error', message: 'Unauthorized: username mismatch' });
    }

    if (!amount_duco || !target_username) {
      return res.status(400).json({ status: 'error', message: 'Missing required fields' });
    }

    const amount = parseFloat(amount_duco);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid amount' });
    }

    const user = db.getUser(from_user);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    const newRequest = {
      id: Date.now() + '-' + crypto.randomBytes(8).toString('hex'),
      from_user,
      amount_cc: amount * 10,
      amount_duco: amount,
      swap_type: 'duco_to_cc',
      receiver: target_username.trim(),
      fee_rate: SWAP_FEE_RATE,
      status: 'pending',
      created_at: new Date().toISOString()
    };

    swapRequests.push(newRequest);
    saveSwapRequests();

    require('https').request('https://ntfy.sh/chocohub-pending-swaps', { method: 'POST' })
      .end(`new swap DUCO→CC: ${newRequest.id} | ${from_user} send ${amount} DUCO for ${target_username} (will receive ${newRequest.amount_cc} CC before fee)`);

    console.log(`🔄 DUCO→CC request created: ${newRequest.id} | ${from_user} -> ${amount} DUCO to CC for ${target_username}`);

    res.json({
      status: 'success',
      message: `DUCO→CC request created. Send ${amount} DUCO to chocoetom with memo: "SWAP CC for ${target_username}"`,
      request_id: newRequest.id,
      fee_rate: SWAP_FEE_RATE
    });
  } catch (e) {
    console.error('DUCO→CC create error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.post('/create_xno_to_cc', verifyToken, swapLimiter, (req, res) => {
  try {
    const { from_user, amount_cc, target_username } = req.body;

    if (req.user.username !== from_user) {
      return res.status(403).json({ status: 'error', message: 'Unauthorized: username mismatch' });
    }

    if (!amount_cc || !target_username) {
      return res.status(400).json({ status: 'error', message: 'Missing required fields' });
    }

    const amount = parseFloat(amount_cc);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ status: 'error', message: 'Invalid amount' });
    }

    const user = db.getUser(from_user);
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }

    const xnoAmount = amount / XNO_CONFIG.XNO_TO_CC_RATE;
    const newRequest = {
      id: Date.now() + '-' + crypto.randomBytes(8).toString('hex'),
      from_user,
      amount_cc: amount,
      amount_xno: xnoAmount,
      swap_type: 'xno_to_cc',
      receiver: target_username.trim(),
      xno_receive_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS,
      fee_rate: SWAP_FEE_RATE,
      status: 'pending',
      created_at: new Date().toISOString(),
      exchange_rate: XNO_CONFIG.XNO_TO_CC_RATE
    };

    swapRequests.push(newRequest);
    saveSwapRequests();

    const ntfyMsg = `XNO→CC: ${newRequest.id} | ${from_user} wants ${amount} CC, send ${xnoAmount.toFixed(8)} XNO to ${XNO_CONFIG.XNO_RECEIVE_ADDRESS} for ${target_username}`;
    require('https').request('https://ntfy.sh/chocohub-pending-swaps', { method: 'POST' }).end(ntfyMsg);

    console.log(`🪙 XNO→CC request created: ${newRequest.id} | ${from_user} -> ${xnoAmount.toFixed(8)} XNO for ${amount} CC to ${target_username}`);

    res.json({
      status: 'success',
      message: `XNO→CC request created. Send ${xnoAmount.toFixed(8)} XNO to: ${XNO_CONFIG.XNO_RECEIVE_ADDRESS}`,
      request_id: newRequest.id,
      xno_amount: xnoAmount,
      xno_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS,
      will_receive_cc: amount,
      fee_rate: SWAP_FEE_RATE
    });
  } catch (e) {
    console.error('XNO→CC create error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.get('/pending', verifyToken, (req, res) => {
  try {
    let pending = swapRequests.filter(r => r.status === 'pending');
    if (!isAdmin(req.user.username)) {
      pending = pending.filter(r => r.from_user === req.user.username);
    }
    res.json({ status: 'success', pending, count: pending.length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.post('/fulfill', verifyToken, verifyAdmin, (req, res) => {
  try {
    const { request_id, xno_txid } = req.body;
    if (!request_id) {
      return res.status(400).json({ status: 'error', message: 'Missing request_id' });
    }

    const reqIndex = swapRequests.findIndex(r => r.id === request_id);
    if (reqIndex === -1) {
      return res.status(404).json({ status: 'error', message: 'Swap request not found' });
    }

    if (swapRequests[reqIndex].status !== 'pending') {
      return res.status(400).json({ status: 'error', message: 'Swap already processed' });
    }

    const request = swapRequests[reqIndex];
    const adminName = req.user.username;
    ensureLiquidityAccount();
    ensureHoldingAccount();
    const { gross, fee, net } = splitSwapValue(request.amount_cc);
    creditSwapFee(fee, request.id, request.swap_type);

    if (request.swap_type === 'duco' || request.swap_type === 'ccpoc' || request.swap_type === 'cc_to_xno') {
      db.updateBalance('swap_holding', -gross);
      db.updateBalance('swap_liquidity', net);
      if (db.addTransaction.length >= 4) {
        db.addTransaction('swap_holding', 'swap_liquidity', net, `Swap → liquidity (${request.from_user}, ${request.id})`);
      } else {
        db.addTransaction('swap_holding', 'swap_liquidity', net);
      }
      console.log(`🏊 Swap → liquidity: ${net} CC from ${request.from_user} added to pool (fee: ${fee} CC to pos_reward_pool) [${request.swap_type}]`);

      if (request.swap_type === 'cc_to_xno') {
        if (xno_txid) {
          console.log(`   XNO transaction hash: ${xno_txid}`);
        } else {
          console.log('   ⚠️ No XNO txid provided (admin must send manually later)');
        }
      }
    } else if (request.swap_type === 'duco_to_cc') {
      creditFromLiquidity(request.receiver, net, request.id, 'DUCO');
      console.log(`🏊 ${net} CC credited to ${request.receiver} from liquidity pool (DUCO→CC, fee ${fee} CC)`);
    } else if (request.swap_type === 'xno_to_cc') {
      creditFromLiquidity(request.receiver, net, request.id, 'XNO');
      console.log(`🏊 ${net} CC credited to ${request.receiver} from liquidity pool (XNO→CC, fee ${fee} CC)`);
    } else {
      return res.status(400).json({ status: 'error', message: 'Unknown swap type' });
    }

    swapRequests[reqIndex].status = 'completed';
    swapRequests[reqIndex].completed_at = new Date().toISOString();
    swapRequests[reqIndex].fulfilled_by = adminName;
    if (xno_txid) {
      swapRequests[reqIndex].xno_txid = xno_txid;
    }
    saveSwapRequests();

    res.json({
      status: 'success',
      message: 'Swap completed',
      fee,
      gross_amount: gross,
      net_amount: net
    });
  } catch (e) {
    console.error('Swap fulfill error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.get('/admin/pending_xno', verifyToken, verifyAdmin, (req, res) => {
  try {
    const pendingXno = swapRequests.filter(r => r.status === 'pending' && r.swap_type === 'cc_to_xno');
    res.json({ status: 'success', swaps: pendingXno, count: pendingXno.length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.get('/rates', (req, res) => {
  const liquidity = db.getUser('swap_liquidity');
  const holding = db.getUser('swap_holding');
  res.json({
    status: 'success',
    rates: {
      cc_to_duco: 10,
      cc_to_ccpoc: 0.75,
      xno_to_cc: XNO_CONFIG.XNO_TO_CC_RATE,
      cc_to_xno: XNO_CONFIG.CC_TO_XNO_RATE,
      fee_rate: SWAP_FEE_RATE,
      liquidity_cc: liquidity ? liquidity.balance : 0,
      holding_cc: holding ? holding.balance : 0,
      note: {
        duco: '1 DUCO = 10 CC before fee',
        ccpoc: '1 CC PoC = 0.75 CC before fee',
        xno: `1 XNO = ${XNO_CONFIG.XNO_TO_CC_RATE.toLocaleString()} CC | 1 CC = ${XNO_CONFIG.CC_TO_XNO_RATE} XNO before fee`,
        xno_receive_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS,
      }
    }
  });
});

router.get('/liquidity', (req, res) => {
  try {
    const liquidity = db.getUser('swap_liquidity');
    const holding = db.getUser('swap_holding');
    const pendingBuys = swapRequests.filter(r => r.status === 'pending' && (r.swap_type === 'duco_to_cc' || r.swap_type === 'xno_to_cc'));
    const pendingBuyTotal = pendingBuys.reduce((sum, r) => {
      const { net } = splitSwapValue(r.amount_cc);
      return sum + net;
    }, 0);
    res.json({
      status: 'success',
      liquidity: {
        available: liquidity ? liquidity.balance : 0,
        escrowed: holding ? holding.balance : 0,
        pending_buy_liability: roundAmount(pendingBuyTotal),
        net_liquidity: roundAmount((liquidity ? liquidity.balance : 0) - pendingBuyTotal)
      }
    });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.get('/history', verifyToken, (req, res) => {
  try {
    const userHistory = swapRequests.filter(r => r.from_user === req.user.username);
    res.json({ status: 'success', history: userHistory, total: userHistory.length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.get('/admin/swaps', verifyToken, verifyAdmin, (req, res) => {
  try {
    res.json({ status: 'success', swaps: swapRequests, total: swapRequests.length });
  } catch (e) {
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.delete('/admin/swaps/:id', verifyToken, verifyAdmin, (req, res) => {
  try {
    const result = _deleteSwapById(req.params.id, true);
    if (!result.ok) {
      return res.status(result.code || 400).json({ status: 'error', message: result.message });
    }
    res.json({ status: 'success', message: 'Swap deleted' });
  } catch (e) {
    console.error('Swap delete error:', e);
    res.status(500).json({ status: 'error', message: e.message });
  }
});

router.get('/xno/config', (req, res) => {
  res.json({
    status: 'success',
    xno_receive_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS,
    rates: {
      xno_to_cc: XNO_CONFIG.XNO_TO_CC_RATE,
      cc_to_xno: XNO_CONFIG.CC_TO_XNO_RATE
    }
  });
});

function _deleteSwapById(id, refund = true) {
  const index = swapRequests.findIndex(r => r.id === id);
  if (index === -1) return { ok: false, code: 404, message: 'Swap not found' };
  const request = swapRequests[index];
  if (refund && request.status === 'pending' && (request.swap_type === 'duco' || request.swap_type === 'ccpoc' || request.swap_type === 'cc_to_xno')) {
    refundUser(request);
  } else if (refund && request.status === 'pending' && (request.swap_type === 'duco_to_cc' || request.swap_type === 'xno_to_cc')) {
    console.log(`🗑️ Deleted ${request.swap_type} request ${id} (no refund needed)`);
  }
  swapRequests.splice(index, 1);
  saveSwapRequests();
  return { ok: true };
}

module.exports = router;
module.exports.getAllSwapRequests = () => swapRequests;
module.exports.deleteSwapById = _deleteSwapById;
