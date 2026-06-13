// separate module from server, so editing will be easier :3
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

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

// Persistência em arquivo JSON
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

// ────────────────────────── HOLDING ACCOUNT SETUP ──────────────────────────
function ensureHoldingAccount() {
    const holding = db.getUser('swap_holding');
    if (!holding) {
        // Tạo holding account với PIN ngẫu nhiên (không ai đăng nhập được)
        const randomPin = crypto.randomBytes(16).toString('hex');
        db.authenticate('swap_holding', randomPin); // tự động tạo user
        console.log('🏦 Created swap_holding account with random pin');
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
        console.log(`💰 Refunded ${amount} CC to ${request.from_user} from holding (swap ${request.id})`);
    }
}

// ─────────────────────────────────  Swap Routes ─────────────────────────────────────────

// Create swap request
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

        if (swap_type !== 'duco' && swap_type !== 'ccpoc') {
            return res.status(400).json({ status: 'error', message: 'Invalid swap type. Must be "duco" or "ccpoc"' });
        }

        const user = db.getUser(from_user);
        if (!user) {
            return res.status(404).json({ status: 'error', message: 'User not found' });
        }

        if (user.balance < amount) {
            return res.status(400).json({ status: 'error', message: 'Insufficient CC balance' });
        }

        // 1. Trừ CC user
        db.updateBalance(from_user, -amount);
        // 2. Cộng vào holding
        db.updateBalance('swap_holding', amount);
        // 3. Ghi transaction
        if (db.addTransaction.length >= 4) {
            db.addTransaction(from_user, 'swap_holding', amount, `Swap escrow to ${swap_type.toUpperCase()} for ${receiver}`);
        } else {
            db.addTransaction(from_user, 'swap_holding', amount);
        }

        const newRequest = {
            id: Date.now() + '-' + crypto.randomBytes(8).toString('hex'),
            from_user,
            amount_cc: amount,
            swap_type,
            receiver: receiver.trim(),
            rate: swap_type === 'duco' ? 10 : 0.75,
            status: 'pending',
            created_at: new Date().toISOString()
        };

        swapRequests.push(newRequest);
        saveSwapRequests();

        console.log(`🔄 Swap request created: ${newRequest.id} | ${from_user} -> ${amount} CC to ${swap_type} for ${receiver}`);

        res.json({
            status: 'success',
            message: `Swap request created. ${amount} CC moved to holding.`,
            request_id: newRequest.id,
            new_balance: user.balance - amount
        });
    } catch (e) {
        console.error('Swap create error:', e);
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
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Fulfill (complete) a swap - admin only
router.post('/fulfill', verifyToken, verifyAdmin, (req, res) => {
    try {
        const { request_id } = req.body;
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
        const adminName = req.user.username; // admin thực hiện fulfill

        // Chuyển CC từ holding sang admin
        db.updateBalance('swap_holding', -request.amount_cc);
        db.updateBalance(adminName, request.amount_cc);
        if (db.addTransaction.length >= 4) {
            db.addTransaction('swap_holding', adminName, request.amount_cc, `Swap fee from ${request.from_user} (${request.id})`);
        } else {
            db.addTransaction('swap_holding', adminName, request.amount_cc);
        }

        swapRequests[reqIndex].status = 'completed';
        swapRequests[reqIndex].completed_at = new Date().toISOString();
        swapRequests[reqIndex].fulfilled_by = adminName;
        saveSwapRequests();

        console.log(`✅ Swap fulfilled by ${adminName}: ${request_id} | ${request.amount_cc} CC transferred to admin`);
        res.json({ status: 'success', message: 'Swap completed and CC sent to admin' });
    } catch (e) {
        console.error('Swap fulfill error:', e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Get swap rates (public)
router.get('/rates', (req, res) => {
    res.json({
        status: 'success',
        rates: {
            cc_to_duco: 10,
            cc_to_ccpoc: 0.75,
            note: '1 DUCO = 10 CC, 1 CC PoC = 0.75 CC'
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
        if (request.status === 'pending') {
            refundUser(request);
        }
        swapRequests.splice(index, 1);
        saveSwapRequests();

        res.json({ status: 'success', message: 'Swap deleted' + (request.status === 'pending' ? ' and user refunded' : '') });
    } catch (e) {
        console.error('Swap delete error:', e);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

module.exports = router;
