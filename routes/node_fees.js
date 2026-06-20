// routes/node_fees.js – Quản lý phí giao dịch tự động
// Sửa lỗi: dùng các hàm có sẵn từ db.js, không truy cập db.db trực tiếp

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');

const router = express.Router();

// ─── Cấu hình ──────────────────────────────────────────────────────────
const NODE_FEES_ADMINS = ['chocoetom', 'Nam2010'];
const NODE_FEES_RETENTION = 0.20;
const MEMPOOL_EXPIRE_SECONDS = 3600;

// ─── Tài khoản ──────────────────────────────────────────────────────────
function ensureHoldingAccount() {
    const holding = db.getUser('mempool_holding');
    if (!holding) {
        const randomPin = crypto.randomBytes(16).toString('hex');
        db.authenticate('mempool_holding', randomPin);
        console.log('🏦 Created mempool_holding account with random pin');
    }
}

function ensureNodeFeesAccount() {
    const nodeFees = db.getUser('node_fees');
    if (!nodeFees) {
        const randomPin = crypto.randomBytes(16).toString('hex');
        db.authenticate('node_fees', randomPin);
        console.log('🏦 Created node_fees account with random pin');
    }
}

// ─── Helper ──────────────────────────────────────────────────────────────
function roundAmount(value) {
    return Number((Number(value) || 0).toFixed(8));
}

function getNodeFeesBalance() {
    const nodeFees = db.getUser('node_fees');
    return nodeFees ? nodeFees.balance : 0;
}

function getHoldingBalance() {
    const holding = db.getUser('mempool_holding');
    return holding ? holding.balance : 0;
}

// ─── Thêm phí vào node_fees ─────────────────────────────────────────────
function addNodeFees(amount) {
    const fee = roundAmount(amount);
    if (fee <= 0) return 0;
    db.updateBalance('node_fees', fee);
    try {
        db.addTransaction('system', 'node_fees', fee);
    } catch (e) {}
    console.log(`💰 Added ${fee} CC to node_fees`);
    return fee;
}

// ─── Phân phối phí tự động ──────────────────────────────────────────────
function distributeNodeFees() {
    const balance = getNodeFeesBalance();
    if (balance <= 0.0001) return { distributed: 0, retained: 0 };

    const retainAmount = roundAmount(balance * NODE_FEES_RETENTION);
    const distributeAmount = roundAmount(balance - retainAmount);
    const adminShare = roundAmount(distributeAmount / NODE_FEES_ADMINS.length);

    const currentBalance = getNodeFeesBalance();
    const diff = retainAmount - currentBalance;
    db.updateBalance('node_fees', diff);

    for (const admin of NODE_FEES_ADMINS) {
        if (adminShare > 0) {
            db.updateBalance(admin, adminShare);
            try {
                db.addTransaction('node_fees', admin, adminShare);
            } catch (e) {}
            console.log(`💰 Distributed ${adminShare} CC to admin ${admin}`);
        }
    }

    console.log(`💰 Node fees: retained ${retainAmount} CC, distributed ${distributeAmount} CC to admins`);
    return {
        distributed: distributeAmount,
        retained: retainAmount,
        admin_share: adminShare,
        admins: NODE_FEES_ADMINS
    };
}

// ─── Xác nhận giao dịch (khi block được tạo) ──────────────────────────
function confirmMempoolTransactions(txIds, blockHeight) {
    if (!txIds || txIds.length === 0) return { confirmed: 0, failed: 0 };

    let confirmed = 0;
    let failed = 0;

    for (const txId of txIds) {
        const row = db.getMempoolTx(txId);
        if (!row || row.status !== 'pending') continue;

        const sender = db.getUser(row.from_username);
        if (!sender || sender.balance < row.total_deducted) {
            db.markMempoolFailed(txId);
            failed++;
            continue;
        }

        db.updateBalance(row.from_username, -row.total_deducted);
        db.updateBalance(row.to_username, row.amount);
        addNodeFees(row.fee);
        db.markMempoolConfirmed(txId, blockHeight);
        confirmed++;
        console.log(`✅ Mempool tx ${txId} confirmed in block ${blockHeight}: ${row.amount} CC to ${row.to_username}, fee ${row.fee} CC`);
    }

    if (confirmed > 0) {
        distributeNodeFees();
    }

    return { confirmed, failed };
}

// ─── Dọn dẹp mempool (xoá tx hết hạn, hoàn tiền) ──────────────────────
function cleanupExpiredMempool() {
    const expired = db.getExpiredMempool(MEMPOOL_EXPIRE_SECONDS);
    if (!expired || expired.length === 0) return { refunded: 0 };

    let refunded = 0;
    for (const row of expired) {
        const holding = db.getUser('mempool_holding');
        if (holding && holding.balance >= row.total_deducted) {
            db.updateBalance('mempool_holding', -row.total_deducted);
            db.updateBalance(row.from_username, row.total_deducted);
            db.markMempoolRefunded(row.id);
            refunded++;
            console.log(`🔄 Refunded ${row.total_deducted} CC to ${row.from_username} (expired tx ${row.id})`);
        } else {
            db.markMempoolFailed(row.id);
            console.warn(`⚠️ Cannot refund ${row.id}: mempool_holding insufficient`);
        }
    }
    return { refunded };
}

// ─── Hoàn tiền cho user (khi admin xoá request) ────────────────────────
function refundMempoolTransaction(txId) {
    const row = db.getMempoolTx(txId);
    if (!row) return { success: false, message: 'Transaction not found or already processed' };
    if (row.status !== 'pending') {
        return { success: false, message: 'Transaction is not pending' };
    }

    const holding = db.getUser('mempool_holding');
    if (!holding || holding.balance < row.total_deducted) {
        return { success: false, message: 'Insufficient holding balance' };
    }

    db.updateBalance('mempool_holding', -row.total_deducted);
    db.updateBalance(row.from_username, row.total_deducted);
    db.markMempoolRefunded(txId);

    console.log(`🔄 Refunded ${row.total_deducted} CC to ${row.from_username} (admin refund ${txId})`);
    return { success: true, refunded: row.total_deducted };
}

// ─── Middleware xác thực admin ──────────────────────────────────────────
function verifyAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ status: 'error', message: 'Missing or invalid token' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        const adminUsers = ['chocoetom', 'Nam2010'];
        if (!adminUsers.includes(decoded.username)) {
            return res.status(403).json({ status: 'error', message: 'Admin access required' });
        }
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ status: 'error', message: 'Invalid or expired token' });
    }
}

// ─── API ROUTES ─────────────────────────────────────────────────────────

// GET /node_fees/balance
router.get('/balance', verifyAdmin, (req, res) => {
    try {
        const nodeFeesBalance = getNodeFeesBalance();
        const holdingBalance = getHoldingBalance();
        const mempoolCount = db.getMempoolCount();
        res.json({
            status: 'success',
            node_fees: nodeFeesBalance,
            mempool_holding: holdingBalance,
            mempool_pending: mempoolCount,
            retention_rate: NODE_FEES_RETENTION * 100 + '%',
            admin_share: ((1 - NODE_FEES_RETENTION) / NODE_FEES_ADMINS.length * 100) + '% each'
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// POST /node_fees/distribute
router.post('/distribute', verifyAdmin, (req, res) => {
    try {
        const result = distributeNodeFees();
        res.json({
            status: 'success',
            message: 'Node fees distributed',
            distributed: result.distributed,
            retained: result.retained,
            admin_share: result.admin_share,
            admins: result.admins
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// POST /node_fees/withdraw
router.post('/withdraw', verifyAdmin, (req, res) => {
    try {
        const { amount, to_username } = req.body;
        if (!amount || !to_username) {
            return res.status(400).json({ status: 'error', message: 'Missing amount or to_username' });
        }
        const withdrawAmount = parseFloat(amount);
        if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
            return res.status(400).json({ status: 'error', message: 'Invalid amount' });
        }
        if (!NODE_FEES_ADMINS.includes(to_username)) {
            return res.status(403).json({ status: 'error', message: 'Can only withdraw to admin accounts' });
        }
        const balance = getNodeFeesBalance();
        if (balance < withdrawAmount) {
            return res.status(400).json({ status: 'error', message: 'Insufficient node_fees balance' });
        }
        db.updateBalance('node_fees', -withdrawAmount);
        db.updateBalance(to_username, withdrawAmount);
        try {
            db.addTransaction('node_fees', to_username, withdrawAmount);
        } catch (e) {}
        console.log(`💰 Withdrew ${withdrawAmount} CC from node_fees to ${to_username}`);
        res.json({
            status: 'success',
            message: `Withdrew ${withdrawAmount} CC to ${to_username}`,
            new_balance: getNodeFeesBalance()
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// GET /node_fees/history
router.get('/history', verifyAdmin, (req, res) => {
    try {
        const rows = db.getTransactions('node_fees', 50);
        const history = rows.map(row => ({
            ...row,
            type: row.from_username === 'system' ? 'incoming' : 'outgoing'
        }));
        res.json({
            status: 'success',
            history: history
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// GET /mempool/status – công khai
router.get('/mempool/status', (req, res) => {
    try {
        const count = db.getMempoolCount();
        const pending = db.getPendingMempool(20);
        const safePending = pending.map(tx => ({
            id: tx.id,
            from: tx.from_username,
            to: tx.to_username,
            amount: tx.amount,
            fee: tx.fee,
            total: tx.total_deducted,
            created_at: tx.created_at
        }));
        res.json({
            status: 'success',
            pending_count: count,
            transactions: safePending
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// GET /mempool/tx/:txid – công khai
router.get('/mempool/tx/:txid', (req, res) => {
    try {
        const row = db.getMempoolTx(req.params.txid);
        if (!row) {
            return res.status(404).json({ status: 'error', message: 'Transaction not found' });
        }
        res.json({
            status: 'success',
            transaction: {
                id: row.id,
                from: row.from_username,
                to: row.to_username,
                amount: row.amount,
                fee: row.fee,
                total: row.total_deducted,
                status: row.status,
                created_at: row.created_at,
                confirmed_at: row.confirmed_at,
                block_height: row.block_height
            }
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// POST /mempool/cleanup – admin
router.post('/mempool/cleanup', verifyAdmin, (req, res) => {
    try {
        const result = cleanupExpiredMempool();
        res.json({
            status: 'success',
            refunded: result.refunded
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// DELETE /mempool/tx/:txid – admin
router.delete('/mempool/tx/:txid', verifyAdmin, (req, res) => {
    try {
        const result = refundMempoolTransaction(req.params.txid);
        if (result.success) {
            res.json({
                status: 'success',
                message: `Refunded ${result.refunded} CC to user`
            });
        } else {
            res.status(400).json({ status: 'error', message: result.message });
        }
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ─── Khởi tạo ────────────────────────────────────────────────────────────
function initNodeFees() {
    ensureHoldingAccount();
    ensureNodeFeesAccount();

    setInterval(() => {
        try {
            const result = cleanupExpiredMempool();
            if (result.refunded > 0) {
                console.log(`🧹 Cleaned up ${result.refunded} expired mempool transactions`);
            }
        } catch (e) {
            console.error('❌ Mempool cleanup error:', e.message);
        }
    }, 300000);

    setInterval(() => {
        try {
            const balance = getNodeFeesBalance();
            if (balance > 0.01) {
                distributeNodeFees();
            }
        } catch (e) {
            console.error('❌ Auto distribution error:', e.message);
        }
    }, 600000);

    console.log('🏦 Node fees module initialized');
}

// ─── Exports ─────────────────────────────────────────────────────────────
module.exports = {
    router,
    initNodeFees,
    confirmMempoolTransactions,
    cleanupExpiredMempool,
    getNodeFeesBalance,
    getHoldingBalance,
    distributeNodeFees,
    addNodeFees,
    NODE_FEES_ADMINS,
    NODE_FEES_RETENTION,
    MEMPOOL_EXPIRE_SECONDS
};
