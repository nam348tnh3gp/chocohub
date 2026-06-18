// routes/swap.js – complete module with automatic DUCO transfer for CC→DUCO swaps
// and detailed logging. Drop-in replacement for the existing file.

const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const http = require('http');
const https = require('https');
const db = require('../db');

const router = express.Router();

// ========== DUCO CONFIGURATION ==========
const DUCO_CONFIG = {
    API_URL: 'https://server.duinocoin.com',
    USERNAME: process.env.DUCO_USERNAME || '',
    PASSWORD: process.env.DUCO_PASSWORD || '',
    CC_TO_DUCO_RATE: 0.1,  // 1 CC = 0.1 DUCO
    DUCO_TO_CC_RATE: 10,   // 1 DUCO = 10 CC
};

// ========== XNO CONFIGURATION ==========
const XNO_CONFIG = {
    CC_TO_XNO_RATE: 0.000002,    // 1 CC = 0.000002 XNO
    XNO_TO_CC_RATE: 500000,      // 1 XNO = 500,000 CC
    XNO_RECEIVE_ADDRESS: "nano_3k41y61xxgmre13exyk3q69k78bxxwhmrmncezt49jg1sok18xo64jeff5hk",
};

// ========== LOGGING ==========
const LOG_FILE = path.join(__dirname, 'swap_api.log');
function log(message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}`;
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}
function logError(message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ERROR: ${message}`;
    console.error(line);
    try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch(e) {}
}

// Warn if DUCO credentials are missing
if (!DUCO_CONFIG.USERNAME || !DUCO_CONFIG.PASSWORD) {
    logError('DUCO_USERNAME or DUCO_PASSWORD not set. Automatic DUCO transfers WILL FAIL.');
} else {
    log(`DUCO holding account configured: ${DUCO_CONFIG.USERNAME}`);
}

// ========== DUCO API HELPERS ==========
function ducoApiRequest(endpoint, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(DUCO_CONFIG.API_URL + endpoint);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: method,
            timeout: 15000,
            headers: { 'User-Agent': 'ChocoHub-Swap/1.0' }
        };

        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    reject(new Error(`Invalid JSON from DUCO API: ${data}`));
                }
            });
        });

        req.on('error', (e) => reject(new Error(`DUCO API network error: ${e.message}`)));
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('DUCO API timeout (15s)'));
        });

        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function getDucoBalance(username) {
    log(`[DUCO] Checking balance for: ${username}`);
    try {
        const res = await ducoApiRequest(`/balances/${username}`);
        if (res.status === 200 && res.data.success) {
            const balance = res.data.result.balance;
            log(`[DUCO] Balance: ${balance} DUCO`);
            return balance;
        }
        logError(`[DUCO] Failed to fetch balance: ${JSON.stringify(res.data)}`);
        return null;
    } catch (e) {
        logError(`[DUCO] Error fetching balance: ${e.message}`);
        return null;
    }
}

async function transferDuco(from, password, to, amount, memo = 'ChocoHub swap') {
    log(`[DUCO] Transfer: ${from} → ${to} | ${amount} DUCO | memo: ${memo}`);
    const endpoint = `/transaction?username=${encodeURIComponent(from)}&password=${encodeURIComponent(password)}&recipient=${encodeURIComponent(to)}&amount=${amount}&memo=${encodeURIComponent(memo)}`;
    try {
        const res = await ducoApiRequest(endpoint, 'GET');
        if (res.status === 200 && res.data.success) {
            log(`[DUCO] Transfer successful: ${res.data.result}`);
            return res.data.result;
        }
        logError(`[DUCO] Transfer failed: ${JSON.stringify(res.data)}`);
        return null;
    } catch (e) {
        logError(`[DUCO] Transfer exception: ${e.message}`);
        return null;
    }
}

// Auth 
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

// Rate Limiter
const swapLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { status: 'error', message: 'Too many swap requests, please slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Persistence (JSON file)
let swapRequests = [];
const SWAP_FILE = path.join(__dirname, 'swap_requests.json');

function loadSwapRequests() {
    try {
        if (fs.existsSync(SWAP_FILE)) {
            const data = JSON.parse(fs.readFileSync(SWAP_FILE, 'utf8'));
            if (Array.isArray(data)) swapRequests = data;
            log(`📦 Loaded ${swapRequests.length} swap requests from file`);
        }
    } catch (e) {
        logError(`Could not load swap requests: ${e.message}`);
    }
}

function saveSwapRequests() {
    try {
        fs.writeFileSync(SWAP_FILE, JSON.stringify(swapRequests, null, 2));
    } catch (e) {
        logError(`Failed to save swap requests: ${e.message}`);
    }
}

loadSwapRequests();

// ────────────────────────── HOLDING ACCOUNT SETUP ──────────────────────────
function ensureHoldingAccount() {
    const holding = db.getUser('swap_holding');
    if (!holding) {
        const randomPin = crypto.randomBytes(16).toString('hex');
        db.authenticate('swap_holding', randomPin);
        log('🏦 Created swap_holding account with random pin');
    }
}
ensureHoldingAccount();

// Helper: refund CC from holding to user (only when pending swap is deleted)
function refundUser(request) {
    if (request.status === 'pending') {
        const amount = request.amount_cc;
        db.updateBalance('swap_holding', -amount);
        db.updateBalance(request.from_user, amount);
        if (db.addTransaction.length >= 4) {
            db.addTransaction('swap_holding', request.from_user, amount, `Refund for cancelled swap ${request.id}`);
        } else {
            db.addTransaction('swap_holding', request.from_user, amount);
        }
        log(`💰 Refunded ${amount} CC to ${request.from_user} from holding (swap ${request.id})`);
    }
}

// Helper: Mint CC from system (for DUCO → CC, XNO → CC, CCPoC → CC)
function mintCCForUser(username, amount, swapId, swapType) {
    db.updateBalance(username, amount);
    if (db.addTransaction.length >= 4) {
        db.addTransaction('swap_system', username, amount, `${swapType.toUpperCase()} → CC swap (${swapId})`);
    } else {
        db.addTransaction('swap_system', username, amount);
    }
    log(`✨ Minted ${amount} CC to ${username} from ${swapType} swap (${swapId})`);
    return true;
}

// ─────────────────────────────────  Swap Routes ─────────────────────────────────────────

// 1. CC → DUCO / CC → CC PoC / CC → XNO
router.post('/create', verifyToken, swapLimiter, async (req, res) => {
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

        // Deduct CC from user -> holding
        db.updateBalance(from_user, -amount);
        db.updateBalance('swap_holding', amount);
        if (db.addTransaction.length >= 4) {
            db.addTransaction(from_user, 'swap_holding', amount, `Swap escrow to ${swap_type.toUpperCase()} for ${receiver}`);
        } else {
            db.addTransaction(from_user, 'swap_holding', amount);
        }
        log(`🔒 Deducted ${amount} CC from ${from_user} -> holding (swap_type: ${swap_type})`);

        // ---- SPECIAL CASE: CC → DUCO (AUTOMATIC TRANSFER) ----
        if (swap_type === 'duco') {
            const ducoAmount = amount * DUCO_CONFIG.CC_TO_DUCO_RATE;
            log(`[AUTO] Attempting to send ${ducoAmount} DUCO to ${receiver}`);

            if (!DUCO_CONFIG.USERNAME || !DUCO_CONFIG.PASSWORD) {
                logError('[AUTO] DUCO credentials missing – swap stays pending');
                const swapId = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
                const newRequest = {
                    id: swapId,
                    from_user,
                    amount_cc: amount,
                    swap_type: 'duco',
                    receiver: receiver.trim(),
                    rate: DUCO_CONFIG.CC_TO_DUCO_RATE,
                    status: 'pending',
                    created_at: new Date().toISOString(),
                    note: 'Automatic DUCO transfer failed – admin must complete manually'
                };
                swapRequests.push(newRequest);
                saveSwapRequests();

                require('https').request('https://ntfy.sh/chocohub-pending-swaps', { method: 'POST' })
                    .end(`PENDING (auto failed): ${swapId} | ${from_user} → ${amount} CC for ${receiver}`);

                return res.json({
                    status: 'success',
                    message: `Swap request created (pending). DUCO credentials not configured. Admin will complete.`,
                    request_id: swapId,
                    new_balance: user.balance - amount,
                    swap_details: { rate: DUCO_CONFIG.CC_TO_DUCO_RATE, note: '1 DUCO = 10 CC' }
                });
            }

            const txid = await transferDuco(
                DUCO_CONFIG.USERNAME,
                DUCO_CONFIG.PASSWORD,
                receiver.trim(),
                ducoAmount,
                `ChocoHub swap (${from_user})`
            );

            const swapId = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
            const newRequest = {
                id: swapId,
                from_user,
                amount_cc: amount,
                swap_type: 'duco',
                receiver: receiver.trim(),
                rate: DUCO_CONFIG.CC_TO_DUCO_RATE,
                status: txid ? 'completed' : 'pending',
                created_at: new Date().toISOString(),
                completed_at: txid ? new Date().toISOString() : null,
                duco_txid: txid || null,
                auto_transfer: !!txid
            };

            swapRequests.push(newRequest);
            saveSwapRequests();

            if (txid) {
                // Release CC from holding (they were moved from user to holding; now the DUCO was sent, so we can remove from holding)
                db.updateBalance('swap_holding', -amount);
                log(`✅ [AUTO] DUCO transfer successful – swap completed. ID: ${swapId}`);
                require('https').request('https://ntfy.sh/chocohub-swaps', { method: 'POST' })
                    .end(`✅ AUTO CC→DUCO: ${from_user} -${amount} CC → ${receiver} +${ducoAmount} DUCO [${txid}]`);

                return res.json({
                    status: 'success',
                    message: `Automatic swap completed! ${amount} CC → ${ducoAmount} DUCO sent to ${receiver}`,
                    swap_id: swapId,
                    duco_txid: txid,
                    new_balance: user.balance - amount,
                    swap_details: { cc_sent: amount, duco_sent: ducoAmount, receiver }
                });
            } else {
                logError(`❌ [AUTO] DUCO transfer failed – swap pending. ID: ${swapId}`);
                require('https').request('https://ntfy.sh/chocohub-pending-swaps', { method: 'POST' })
                    .end(`PENDING (auto failed): ${swapId} | ${from_user} → ${amount} CC for ${receiver}`);
                return res.json({
                    status: 'success',
                    message: `Swap request created but automatic DUCO transfer failed. Admin will complete.`,
                    request_id: swapId,
                    new_balance: user.balance - amount,
                    swap_details: { rate: DUCO_CONFIG.CC_TO_DUCO_RATE, note: '1 DUCO = 10 CC' }
                });
            }
        }

        // ---- NORMAL CASE: CC → XNO / CCPoC (manual) ----
        let rateInfo = {};
        if (swap_type === 'cc_to_xno') {
            const xno_amount = amount * XNO_CONFIG.CC_TO_XNO_RATE;
            rateInfo = {
                exchange_rate: XNO_CONFIG.CC_TO_XNO_RATE,
                xno_amount: xno_amount,
                note: `${amount} CC = ${xno_amount.toFixed(8)} XNO`
            };
        } else if (swap_type === 'ccpoc') {
            rateInfo = { rate: 0.75, note: '1 CC PoC = 0.75 CC' };
        }

        const newRequest = {
            id: Date.now() + '-' + crypto.randomBytes(8).toString('hex'),
            from_user,
            amount_cc: amount,
            swap_type,
            receiver: receiver.trim(),
            rate: swap_type === 'cc_to_xno' ? XNO_CONFIG.CC_TO_XNO_RATE : 0.75,
            status: 'pending',
            created_at: new Date().toISOString(),
            ...rateInfo
        };

        swapRequests.push(newRequest);
        saveSwapRequests();

        require('https').request('https://ntfy.sh/chocohub-pending-swaps', { method: 'POST' })
            .end(`New swap: ${newRequest.id} | ${from_user} → ${amount} CC (${swap_type}) for ${receiver}`);
        
        log(`🔄 Swap request created (manual): ${newRequest.id} | ${from_user} -> ${amount} CC to ${swap_type} for ${receiver}`);

        res.json({
            status: 'success',
            message: `Swap request created. ${amount} CC moved to holding.`,
            request_id: newRequest.id,
            new_balance: user.balance - amount,
            swap_details: rateInfo
        });
    } catch (e) {
        logError(`Error in /create: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 2. DUCO → CC (create request, does NOT deduct CC from user)
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
            amount_cc: amount * DUCO_CONFIG.DUCO_TO_CC_RATE,
            amount_duco: amount,
            swap_type: 'duco_to_cc',
            receiver: target_username.trim(),
            status: 'pending',
            created_at: new Date().toISOString()
        };

        swapRequests.push(newRequest);
        saveSwapRequests();

        require('https').request('https://ntfy.sh/chocohub-pending-swaps', { method: 'POST' })
            .end(`new swap DUCO→CC: ${newRequest.id} | ${from_user} send ${amount} DUCO for ${target_username} (will receive ${newRequest.amount_cc} CC)`);

        log(`🔄 DUCO→CC request created: ${newRequest.id} | ${from_user} -> ${amount} DUCO to CC for ${target_username}`);

        res.json({
            status: 'success',
            message: `DUCO→CC request created. Send ${amount} DUCO to ${DUCO_CONFIG.USERNAME || 'ADMIN'} with memo: "SWAP CC for ${target_username}"`,
            request_id: newRequest.id
        });
    } catch (e) {
        logError(`Error in /create_duco_to_cc: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 3. XNO → CC (create request, does NOT deduct CC)
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

        const xno_amount = amount / XNO_CONFIG.XNO_TO_CC_RATE;

        const newRequest = {
            id: Date.now() + '-' + crypto.randomBytes(8).toString('hex'),
            from_user,
            amount_cc: amount,
            amount_xno: xno_amount,
            swap_type: 'xno_to_cc',
            receiver: target_username.trim(),
            xno_receive_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS,
            status: 'pending',
            created_at: new Date().toISOString(),
            exchange_rate: XNO_CONFIG.XNO_TO_CC_RATE
        };

        swapRequests.push(newRequest);
        saveSwapRequests();

        const ntfyMsg = `XNO→CC: ${newRequest.id} | ${from_user} wants ${amount} CC, send ${xno_amount.toFixed(8)} XNO to ${XNO_CONFIG.XNO_RECEIVE_ADDRESS} for ${target_username}`;
        require('https').request('https://ntfy.sh/chocohub-pending-swaps', { method: 'POST' }).end(ntfyMsg);

        log(`🪙 XNO→CC request created: ${newRequest.id} | ${from_user} -> ${xno_amount.toFixed(8)} XNO for ${amount} CC to ${target_username}`);

        res.json({
            status: 'success',
            message: `XNO→CC request created. Send ${xno_amount.toFixed(8)} XNO to: ${XNO_CONFIG.XNO_RECEIVE_ADDRESS}`,
            request_id: newRequest.id,
            xno_amount: xno_amount,
            xno_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS,
            will_receive_cc: amount
        });
    } catch (e) {
        logError(`Error in /create_xno_to_cc: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// List pending swaps
router.get('/pending', verifyToken, (req, res) => {
    try {
        let pending = swapRequests.filter(r => r.status === 'pending');
        if (!isAdmin(req.user.username)) {
            pending = pending.filter(r => r.from_user === req.user.username);
        }
        res.json({
            status: 'success',
            pending,
            count: pending.length
        });
    } catch (e) {
        logError(`Error in /pending: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ========== FULFILL SWAP (admin) – supports xno_txid ==========
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

        if (request.swap_type === 'duco' || request.swap_type === 'ccpoc') {
            // CC → DUCO / CC → CCPOC: move CC from holding to admin
            db.updateBalance('swap_holding', -request.amount_cc);
            db.updateBalance(adminName, request.amount_cc);
            if (db.addTransaction.length >= 4) {
                db.addTransaction('swap_holding', adminName, request.amount_cc, `Swap fee from ${request.from_user} (${request.id})`);
            } else {
                db.addTransaction('swap_holding', adminName, request.amount_cc);
            }
            log(`✅ Swap fee: ${request.amount_cc} CC from holding → ${adminName} (${request.swap_type})`);
        
        } else if (request.swap_type === 'duco_to_cc') {
            // DUCO → CC: mint new CC for user
            mintCCForUser(request.receiver, request.amount_cc, request.id, 'DUCO');
            log(`✅ Minted ${request.amount_cc} CC to ${request.receiver} from DUCO→CC swap`);
        
        } else if (request.swap_type === 'xno_to_cc') {
            // XNO → CC: mint new CC for receiver
            mintCCForUser(request.receiver, request.amount_cc, request.id, 'XNO');
            log(`✅ Minted ${request.amount_cc} CC to ${request.receiver} from XNO→CC swap`);
        
        } else if (request.swap_type === 'cc_to_xno') {
            // CC → XNO: move CC from holding to admin
            db.updateBalance('swap_holding', -request.amount_cc);
            db.updateBalance(adminName, request.amount_cc);
            if (db.addTransaction.length >= 4) {
                db.addTransaction('swap_holding', adminName, request.amount_cc, `CC→XNO swap fee from ${request.from_user} (${request.id})`);
            } else {
                db.addTransaction('swap_holding', adminName, request.amount_cc);
            }
            log(`✅ CC→XNO fee: ${request.amount_cc} CC from holding → ${adminName}`);
            
            // Record XNO transaction hash if provided
            if (xno_txid) {
                log(`   XNO transaction hash: ${xno_txid}`);
            } else {
                log(`   ⚠️ No XNO txid provided (admin must send manually later)`);
            }
        } else {
            return res.status(400).json({ status: 'error', message: 'Unknown swap type' });
        }

        // Update swap request
        swapRequests[reqIndex].status = 'completed';
        swapRequests[reqIndex].completed_at = new Date().toISOString();
        swapRequests[reqIndex].fulfilled_by = adminName;
        if (xno_txid) {
            swapRequests[reqIndex].xno_txid = xno_txid;
        }
        saveSwapRequests();

        res.json({ status: 'success', message: 'Swap completed' });
    } catch (e) {
        logError(`Error in /fulfill: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ========== NEW ENDPOINT: list pending CC→XNO swaps (for admin) ==========
router.get('/admin/pending_xno', verifyToken, verifyAdmin, (req, res) => {
    try {
        const pendingXno = swapRequests.filter(r => r.status === 'pending' && r.swap_type === 'cc_to_xno');
        res.json({
            status: 'success',
            swaps: pendingXno,
            count: pendingXno.length
        });
    } catch (e) {
        logError(`Error in /admin/pending_xno: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Get swap rates (public)
router.get('/rates', (req, res) => {
    res.json({
        status: 'success',
        rates: {
            cc_to_duco: DUCO_CONFIG.DUCO_TO_CC_RATE,  // note: original used 10 but consistent with config
            duco_to_cc: DUCO_CONFIG.DUCO_TO_CC_RATE,
            cc_to_ccpoc: 0.75,
            xno_to_cc: XNO_CONFIG.XNO_TO_CC_RATE,
            cc_to_xno: XNO_CONFIG.CC_TO_XNO_RATE,
            note: {
                duco: `1 DUCO = ${DUCO_CONFIG.DUCO_TO_CC_RATE} CC | 1 CC = ${DUCO_CONFIG.CC_TO_DUCO_RATE} DUCO`,
                ccpoc: '1 CC PoC = 0.75 CC',
                xno: `1 XNO = ${XNO_CONFIG.XNO_TO_CC_RATE.toLocaleString()} CC | 1 CC = ${XNO_CONFIG.CC_TO_XNO_RATE} XNO`,
                xno_receive_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS
            }
        }
    });
});

// History for authenticated user
router.get('/history', verifyToken, (req, res) => {
    try {
        const userHistory = swapRequests.filter(r => r.from_user === req.user.username);
        res.json({
            status: 'success',
            history: userHistory,
            total: userHistory.length
        });
    } catch (e) {
        logError(`Error in /history: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ───────────────────────── Admin Routes For Swap ─────────────────────────────────────────
// Get all swaps (admin only)
router.get('/admin/swaps', verifyToken, verifyAdmin, (req, res) => {
    try {
        res.json({
            status: 'success',
            swaps: swapRequests,
            total: swapRequests.length
        });
    } catch (e) {
        logError(`Error in /admin/swaps: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Delete a swap by ID (admin only) - refunds if pending
router.delete('/admin/swaps/:id', verifyToken, verifyAdmin, (req, res) => {
    try {
        const id = req.params.id;
        const index = swapRequests.findIndex(r => r.id === id);
        if (index === -1) {
            return res.status(404).json({ status: 'error', message: 'Swap not found' });
        }

        const request = swapRequests[index];
        
        // Refund if CC was deducted and swap is pending
        if (request.status === 'pending' && (request.swap_type === 'duco' || request.swap_type === 'ccpoc' || request.swap_type === 'cc_to_xno')) {
            refundUser(request);
        } else if (request.status === 'pending' && (request.swap_type === 'duco_to_cc' || request.swap_type === 'xno_to_cc')) {
            // DUCO → CC or XNO → CC: no CC was deducted, so no refund
            log(`🗑️ Deleted ${request.swap_type} request ${id} (no refund needed)`);
        }
        
        swapRequests.splice(index, 1);
        saveSwapRequests();

        res.json({ status: 'success', message: 'Swap deleted' });
    } catch (e) {
        logError(`Error in DELETE /admin/swaps: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// API to get XNO config (for client)
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

module.exports = router;
