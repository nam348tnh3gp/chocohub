// routes/node_fees.js – Quản lý phí giao dịch tự động
// Đầy đủ, không rút gọn

const express = require('express');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

// ─── Cấu hình ──────────────────────────────────────────────────────────────
const NODE_FEES_ADMINS = ['chocoetom', 'Nam2010'];   // Danh sách admin nhận phí
const NODE_FEES_RETENTION = 0.20;                   // Giữ lại 20% cho node_fees
const ADMIN_SHARE = 0.40;                           // 80% còn lại chia đều cho 2 admin (40% mỗi người)
const MEMPOOL_EXPIRE_SECONDS = 3600;                // 1 giờ

// ─── Tài khoản mempool_holding ──────────────────────────────────────────
function ensureHoldingAccount() {
    const holding = db.getUser('mempool_holding');
    if (!holding) {
        const randomPin = crypto.randomBytes(16).toString('hex');
        db.authenticate('mempool_holding', randomPin);
        console.log('🏦 Created mempool_holding account with random pin');
    }
}

// ─── Tài khoản node_fees ────────────────────────────────────────────────
function ensureNodeFeesAccount() {
    const nodeFees = db.getUser('node_fees');
    if (!nodeFees) {
        const randomPin = crypto.randomBytes(16).toString('hex');
        db.authenticate('node_fees', randomPin);
        console.log('🏦 Created node_fees account with random pin');
    }
}

// ─── Hàm hỗ trợ ──────────────────────────────────────────────────────────
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
    // Ghi log vào transactions (tuỳ chọn)
    try {
        db.addTransaction('system', 'node_fees', fee);
    } catch (e) {
        // Bỏ qua nếu không có hàm addTransaction
    }
    console.log(`💰 Added ${fee} CC to node_fees`);
    return fee;
}

// ─── Phân phối phí tự động ──────────────────────────────────────────────
function distributeNodeFees() {
    const balance = getNodeFeesBalance();
    if (balance <= 0.0001) return { distributed: 0, retained: 0 };

    // Giữ lại 20%
    const retainAmount = roundAmount(balance * NODE_FEES_RETENTION);
    // 80% còn lại chia đều cho 2 admin
    const distributeAmount = roundAmount(balance - retainAmount);
    const adminShare = roundAmount(distributeAmount / NODE_FEES_ADMINS.length);

    // Cập nhật node_fees: giữ lại 20%
    // Cần set balance = retainAmount (thay vì cộng thêm)
    const currentBalance = getNodeFeesBalance();
    const diff = retainAmount - currentBalance;
    db.updateBalance('node_fees', diff);

    // Chia cho admin
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

// ─── Thêm giao dịch vào mempool ─────────────────────────────────────────
function addToMempool(fromUser, toUser, amount, fee, totalDeducted) {
    const txId = 'tx_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    
    // Lưu vào bảng mempool (nếu có)
    try {
        // Kiểm tra bảng mempool tồn tại
        const tableCheck = db.db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name='mempool'
        `).get();
        
        if (tableCheck) {
            db.db.prepare(`
                INSERT INTO mempool (id, from_username, to_username, amount, fee, total_deducted, status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
            `).run(txId, fromUser, toUser, amount, fee, totalDeducted);
        } else {
            // Fallback: lưu vào file hoặc bỏ qua
            console.warn('⚠️ Mempool table not found, transaction stored in memory only');
        }
    } catch (e) {
        console.error('❌ Failed to add to mempool:', e.message);
    }
    
    return txId;
}

// ─── Lấy giao dịch pending từ mempool ──────────────────────────────────
function getPendingMempool(limit = 50) {
    try {
        const rows = db.db.prepare(`
            SELECT * FROM mempool 
            WHERE status = 'pending' 
            ORDER BY created_at ASC 
            LIMIT ?
        `).all(limit);
        return rows || [];
    } catch (e) {
        console.error('❌ Failed to get mempool:', e.message);
        return [];
    }
}

function getMempoolCount() {
    try {
        const row = db.db.prepare(`
            SELECT COUNT(*) as count FROM mempool WHERE status = 'pending'
        `).get();
        return row ? row.count : 0;
    } catch (e) {
        return 0;
    }
}

// ─── Xác nhận giao dịch (khi block được tạo) ──────────────────────────
function confirmMempoolTransactions(txIds, blockHeight) {
    if (!txIds || txIds.length === 0) return { confirmed: 0, failed: 0 };
    
    let confirmed = 0;
    let failed = 0;
    
    try {
        const tx = db.db.transaction(() => {
            for (const txId of txIds) {
                // Lấy thông tin tx
                const row = db.db.prepare(`
                    SELECT * FROM mempool WHERE id = ? AND status = 'pending'
                `).get(txId);
                
                if (!row) continue;
                
                // Kiểm tra sender có đủ balance không
                const sender = db.getUser(row.from_username);
                if (!sender || sender.balance < row.total_deducted) {
                    // Không đủ balance → đánh dấu failed
                    db.db.prepare(`
                        UPDATE mempool SET status = 'failed', confirmed_at = datetime('now')
                        WHERE id = ?
                    `).run(txId);
                    failed++;
                    continue;
                }
                
                // Trừ tiền sender
                db.updateBalance(row.from_username, -row.total_deducted);
                // Cộng tiền receiver
                db.updateBalance(row.to_username, row.amount);
                
                // Cộng phí vào node_fees (thay vì mempool_holding)
                addNodeFees(row.fee);
                
                // Đánh dấu confirmed
                db.db.prepare(`
                    UPDATE mempool 
                    SET status = 'confirmed', confirmed_at = datetime('now'), block_height = ?
                    WHERE id = ?
                `).run(blockHeight, txId);
                
                confirmed++;
            }
        });
        
        tx();
        
        // Sau khi confirm, phân phối phí tự động
        if (confirmed > 0) {
            distributeNodeFees();
        }
        
        return { confirmed, failed };
    } catch (e) {
        console.error('❌ Failed to confirm mempool transactions:', e.message);
        return { confirmed: 0, failed: txIds.length };
    }
}

// ─── Dọn dẹp mempool (xoá tx hết hạn, hoàn tiền) ──────────────────────
function cleanupExpiredMempool() {
    try {
        const expired = db.db.prepare(`
            SELECT * FROM mempool 
            WHERE status = 'pending' 
            AND (strftime('%s', 'now') - strftime('%s', created_at)) > ?
        `).all(MEMPOOL_EXPIRE_SECONDS);
        
        if (expired.length === 0) return { refunded: 0 };
        
        let refunded = 0;
        const tx = db.db.transaction(() => {
            for (const row of expired) {
                // Hoàn tiền cho sender (cả amount + fee) từ mempool_holding
                // Lấy từ mempool_holding (đã bị trừ khi vào mempool)
                const holding = db.getUser('mempool_holding');
                if (holding && holding.balance >= row.total_deducted) {
                    db.updateBalance('mempool_holding', -row.total_deducted);
                    db.updateBalance(row.from_username, row.total_deducted);
                    
                    // Đánh dấu refunded
                    db.db.prepare(`
                        UPDATE mempool SET status = 'refunded', confirmed_at = datetime('now')
                        WHERE id = ?
                    `).run(row.id);
                    
                    refunded++;
                    console.log(`🔄 Refunded ${row.total_deducted} CC to ${row.from_username} (expired tx ${row.id})`);
                } else {
                    // Nếu mempool_holding không đủ, đánh dấu failed
                    db.db.prepare(`
                        UPDATE mempool SET status = 'failed', confirmed_at = datetime('now')
                        WHERE id = ?
                    `).run(row.id);
                    console.warn(`⚠️ Cannot refund ${row.id}: mempool_holding insufficient`);
                }
            }
        });
        
        tx();
        return { refunded };
    } catch (e) {
        console.error('❌ Failed to cleanup mempool:', e.message);
        return { refunded: 0 };
    }
}

// ─── Hoàn tiền cho user (khi admin xoá request) ────────────────────────
function refundMempoolTransaction(txId) {
    try {
        const row = db.db.prepare(`
            SELECT * FROM mempool WHERE id = ? AND status = 'pending'
        `).get(txId);
        
        if (!row) return { success: false, message: 'Transaction not found or already processed' };
        
        // Hoàn tiền từ mempool_holding
        const holding = db.getUser('mempool_holding');
        if (!holding || holding.balance < row.total_deducted) {
            return { success: false, message: 'Insufficient holding balance' };
        }
        
        db.updateBalance('mempool_holding', -row.total_deducted);
        db.updateBalance(row.from_username, row.total_deducted);
        
        db.db.prepare(`
            UPDATE mempool SET status = 'refunded', confirmed_at = datetime('now')
            WHERE id = ?
        `).run(txId);
        
        console.log(`🔄 Refunded ${row.total_deducted} CC to ${row.from_username} (admin refund ${txId})`);
        return { success: true, refunded: row.total_deducted };
    } catch (e) {
        console.error('❌ Failed to refund transaction:', e.message);
        return { success: false, message: e.message };
    }
}

// ─── Middleware xác thực admin ──────────────────────────────────────────
function verifyAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ status: 'error', message: 'Missing or invalid token' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const jwt = require('jsonwebtoken');
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

// GET /node_fees/balance – Xem số dư node_fees và mempool_holding
router.get('/balance', verifyAdmin, (req, res) => {
    try {
        const nodeFeesBalance = getNodeFeesBalance();
        const holdingBalance = getHoldingBalance();
        const mempoolCount = getMempoolCount();
        res.json({
            status: 'success',
            node_fees: nodeFeesBalance,
            mempool_holding: holdingBalance,
            mempool_pending: mempoolCount,
            retention_rate: NODE_FEES_RETENTION * 100 + '%',
            admin_share: (NODE_FEES_RETENTION ? (1 - NODE_FEES_RETENTION) / NODE_FEES_ADMINS.length * 100 : 50) + '% each'
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// POST /node_fees/distribute – Phân phối phí thủ công (admin)
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

// POST /node_fees/withdraw – Rút tiền từ node_fees về admin (chỉ dành cho admin)
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
        
        // Kiểm tra admin hợp lệ
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

// GET /node_fees/history – Lịch sử phân phối (admin)
router.get('/history', verifyAdmin, (req, res) => {
    try {
        // Lấy lịch sử từ transactions (nếu có)
        let history = [];
        try {
            const rows = db.getTransactions('node_fees', 50);
            history = rows.map(row => ({
                ...row,
                type: row.from_username === 'system' ? 'incoming' : 'outgoing'
            }));
        } catch (e) {
            // Bỏ qua nếu không có bảng transactions
        }
        res.json({
            status: 'success',
            history: history
        });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// GET /mempool/status – Xem trạng thái mempool (công khai)
router.get('/mempool/status', (req, res) => {
    try {
        const count = getMempoolCount();
        const pending = getPendingMempool(20);
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

// GET /mempool/tx/:txid – Tra cứu transaction (công khai)
router.get('/mempool/tx/:txid', (req, res) => {
    try {
        const row = db.db.prepare(`
            SELECT * FROM mempool WHERE id = ?
        `).get(req.params.txid);
        
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

// POST /mempool/cleanup – Dọn dẹp mempool (admin)
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

// DELETE /mempool/tx/:txid – Xoá transaction khỏi mempool (admin)
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
    
    // Chạy cleanup mempool định kỳ mỗi 5 phút
    setInterval(() => {
        try {
            const result = cleanupExpiredMempool();
            if (result.refunded > 0) {
                console.log(`🧹 Cleaned up ${result.refunded} expired mempool transactions`);
            }
        } catch (e) {
            console.error('❌ Mempool cleanup error:', e.message);
        }
    }, 300000); // 5 phút
    
    // Phân phối phí định kỳ mỗi 10 phút (nếu có)
    setInterval(() => {
        try {
            const balance = getNodeFeesBalance();
            if (balance > 0.01) {
                distributeNodeFees();
            }
        } catch (e) {
            console.error('❌ Auto distribution error:', e.message);
        }
    }, 600000); // 10 phút
    
    console.log('🏦 Node fees module initialized');
}

// ─── Exports ─────────────────────────────────────────────────────────────
module.exports = {
    router,
    initNodeFees,
    // Hàm public để blockchain.js gọi
    addToMempool,
    getPendingMempool,
    getMempoolCount,
    confirmMempoolTransactions,
    cleanupExpiredMempool,
    refundMempoolTransaction,
    getNodeFeesBalance,
    getHoldingBalance,
    distributeNodeFees,
    addNodeFees,
    // Cấu hình
    NODE_FEES_ADMINS,
    NODE_FEES_RETENTION,
    MEMPOOL_EXPIRE_SECONDS
};
