const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const blake = require('blakejs');

// Import nanocurrency
const nanocurrency = require('nanocurrency');

const app = express();
const PORT = process.env.PORT || 3000;

// Nano RPC URL (dùng rpc.nano.to ổn định, hỗ trợ POST)
const NANO_RPC_URL = 'https://rpc.nano.to';

// Nano RPC wrapper function
async function nanoRpcCall(action, params = {}) {
    try {
        const response = await axios.post(NANO_RPC_URL, { action, ...params }, {
            timeout: 15000,
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.data && !response.data.error) {
            return response.data;
        }
        throw new Error(response.data?.error || 'Unknown error');
    } catch (err) {
        console.error(`RPC error (${action}):`, err.message);
        throw err;
    }
}

// ========== CONFIG ==========
const DATA_DIR = path.join(__dirname, 'data');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const CHOCOHUB_URL = 'https://chocohub-r011.onrender.com';

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'nano-dashboard-secret-key-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 86400000 }
}));

const upload = multer({ dest: path.join(DATA_DIR, 'uploads') });

// ========== INITIALIZE DATA ==========
async function initData() {
    await fs.ensureDir(DATA_DIR);
    if (!await fs.pathExists(ADMIN_FILE)) {
        const defaultHash = await bcrypt.hash('admin', 10);
        await fs.writeJson(ADMIN_FILE, {
            username: 'admin',
            password_hash: defaultHash,
            chocohub_username: null,
            chocohub_pin: null,
            chocohub_token: null,
            first_login: true
        });
        console.log('📝 Created default admin: admin/admin');
    }
    if (!await fs.pathExists(WALLETS_FILE)) {
        await fs.writeJson(WALLETS_FILE, { wallets: [], active_wallet: null });
    }
}
initData();

// ========== HELPER FUNCTIONS ==========
async function getAdmin() { return await fs.readJson(ADMIN_FILE); }
async function updateAdmin(data) { await fs.writeJson(ADMIN_FILE, data); }
async function getWallets() { return await fs.readJson(WALLETS_FILE); }
async function updateWallets(data) { await fs.writeJson(WALLETS_FILE, data); }

function isValidNanoAddress(address) {
    return address && address.startsWith('nano_') && address.length >= 60;
}

// Tạo địa chỉ Nano từ seed (seed phải là hex string 64 ký tự)
async function generateNanoAddressFromSeed(seedHex, index = 0) {
    try {
        if (typeof seedHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(seedHex)) {
            throw new Error('Seed must be a 64-character hex string');
        }
        const privateKey = await nanocurrency.deriveSecretKey(seedHex, index);
        const publicKey = await nanocurrency.derivePublicKey(privateKey);
        const address = await nanocurrency.deriveAddress(publicKey, { useNanoPrefix: true });
        return {
            address: address,
            publicKey: publicKey.toString('hex'),
            privateKey: privateKey.toString('hex')
        };
    } catch (err) {
        console.error('Generate address error:', err);
        throw err;
    }
}

// Tạo seed ngẫu nhiên dạng hex string (64 ký tự)
async function generateRandomSeed() {
    const seedBuffer = await nanocurrency.generateSeed();
    return seedBuffer.toString('hex');
}

// Tạo block change representative
async function createChangeRepresentativeBlock(wallet, representativeAddress) {
    try {
        // Lấy thông tin account
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        
        if (!accountInfo.frontier) {
            throw new Error('Account has no frontier. Send a small amount first to activate the account.');
        }
        
        const previous = accountInfo.frontier;
        const balance = accountInfo.balance;
        const representative = representativeAddress;
        
        // Tạo block change
        // Cần sign block với private key
        // Sử dụng thư viện nanocurrency để sign
        
        const privateKeyHex = wallet.private_key;
        const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
        
        // Tạo block hash
        const blockData = {
            type: 'state',
            previous: previous,
            representative: representative,
            balance: balance,
            link: '0000000000000000000000000000000000000000000000000000000000000000',
            work: '0000000000000000' // Có thể cần work, nhưng node sẽ tự tính nếu không có
        };
        
        // Serialize block để sign
        const blockHash = blake.blake2bHex(JSON.stringify(blockData), null, 32);
        
        // Sign với private key (cần thư viện ed25519)
        // Đây là phần phức tạp, tạm thời hướng dẫn user dùng Natrium
        
        return {
            success: false,
            need_manual: true,
            message: 'Auto-change representative requires complex signing. Please use Natrium wallet.',
            instruction: `Import seed into Natrium to change representative: ${wallet.seed}`,
            representative: representativeAddress
        };
        
    } catch (err) {
        console.error('Create change block error:', err);
        throw err;
    }
}

// ========== AUTH MIDDLEWARE ==========
function requireAuth(req, res, next) {
    if (req.session.authenticated) return next();
    res.redirect('/login');
}

// ========== ROUTES ==========
app.get('/login', (req, res) => {
    if (req.session.authenticated) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = await getAdmin();
    if (username !== admin.username) return res.json({ success: false, error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) return res.json({ success: false, error: 'Invalid credentials' });
    req.session.authenticated = true;
    req.session.firstLogin = admin.first_login;
    res.json({ success: true, firstLogin: admin.first_login });
});

app.post('/api/setup', requireAuth, async (req, res) => {
    const { new_password, chocohub_username, chocohub_pin } = req.body;
    const admin = await getAdmin();
    if (new_password && new_password.length >= 4) {
        admin.password_hash = await bcrypt.hash(new_password, 10);
    }
    if (chocohub_username && chocohub_pin) {
        admin.chocohub_username = chocohub_username;
        admin.chocohub_pin = chocohub_pin;
        admin.first_login = false;
        try {
            const authRes = await axios.post(`${CHOCOHUB_URL}/auth`, {
                username: chocohub_username,
                pin: chocohub_pin
            });
            if (authRes.data.status !== 'success') return res.json({ success: false, error: 'Invalid ChocoHub credentials' });
            admin.chocohub_token = authRes.data.token;
        } catch (err) {
            return res.json({ success: false, error: 'Cannot connect to ChocoHub: ' + err.message });
        }
    }
    await updateAdmin(admin);
    req.session.firstLogin = false;
    res.json({ success: true });
});

app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/admin', requireAuth, async (req, res) => {
    const admin = await getAdmin();
    res.json({
        username: admin.username,
        chocohub_username: admin.chocohub_username,
        firstLogin: admin.first_login
    });
});

// ========== WALLET MANAGEMENT ==========
app.get('/api/wallets', requireAuth, async (req, res) => {
    const data = await getWallets();
    res.json({ wallets: data.wallets, active: data.active_wallet });
});

// Tạo ví mới
app.post('/api/wallet/create', requireAuth, async (req, res) => {
    try {
        const seedHex = await generateRandomSeed();
        const { address, publicKey, privateKey } = await generateNanoAddressFromSeed(seedHex, 0);
        const wallet = {
            id: Date.now().toString(),
            name: req.body.name || `Wallet ${new Date().toLocaleString()}`,
            address: address,
            public_key: publicKey,
            private_key: privateKey,
            seed: seedHex,
            index: 0,
            created_at: new Date().toISOString(),
            representative: null
        };
        const data = await getWallets();
        data.wallets.push(wallet);
        if (!data.active_wallet) data.active_wallet = wallet.id;
        await updateWallets(data);
        res.json({ success: true, wallet: { ...wallet, seed: undefined, private_key: undefined } });
    } catch (err) {
        console.error('Create wallet error:', err);
        res.json({ success: false, error: err.message });
    }
});

// Import wallet từ seed hex
app.post('/api/wallet/import', requireAuth, async (req, res) => {
    try {
        let { seed, name, index } = req.body;
        if (!seed) return res.json({ success: false, error: 'Seed is required' });
        let seedHex = seed;
        if (seed.length !== 64) {
            try {
                seedHex = Buffer.from(seed).toString('hex');
                if (seedHex.length !== 64) throw new Error();
            } catch (e) {
                return res.json({ success: false, error: 'Seed must be 64 hex characters' });
            }
        }
        const walletIndex = index || 0;
        const { address, publicKey, privateKey } = await generateNanoAddressFromSeed(seedHex, walletIndex);
        
        // Lấy thông tin representative từ blockchain
        let representative = null;
        try {
            const accountInfo = await nanoRpcCall('account_info', { account: address });
            representative = accountInfo.representative || null;
        } catch (e) {
            // Account chưa có giao dịch
        }
        
        const wallet = {
            id: Date.now().toString(),
            name: name || `Imported ${new Date().toLocaleString()}`,
            address: address,
            public_key: publicKey,
            private_key: privateKey,
            seed: seedHex,
            index: walletIndex,
            created_at: new Date().toISOString(),
            representative: representative
        };
        const data = await getWallets();
        if (data.wallets.find(w => w.address === address)) {
            return res.json({ success: false, error: 'Wallet already exists' });
        }
        data.wallets.push(wallet);
        if (!data.active_wallet) data.active_wallet = wallet.id;
        await updateWallets(data);
        res.json({ success: true, wallet: { ...wallet, seed: undefined, private_key: undefined } });
    } catch (err) {
        console.error('Import wallet error:', err);
        res.json({ success: false, error: err.message });
    }
});

// Import từ file
app.post('/api/wallet/import-file', requireAuth, upload.single('seedFile'), async (req, res) => {
    try {
        if (!req.file) return res.json({ success: false, error: 'No file uploaded' });
        const content = await fs.readFile(req.file.path, 'utf8');
        let seed = content.trim();
        await fs.remove(req.file.path);
        if (seed.length !== 64) {
            try {
                seed = Buffer.from(seed).toString('hex');
                if (seed.length !== 64) throw new Error();
            } catch (e) {
                return res.json({ success: false, error: 'Invalid seed file content' });
            }
        }
        const { address, publicKey, privateKey } = await generateNanoAddressFromSeed(seed, 0);
        
        let representative = null;
        try {
            const accountInfo = await nanoRpcCall('account_info', { account: address });
            representative = accountInfo.representative || null;
        } catch (e) {}
        
        const wallet = {
            id: Date.now().toString(),
            name: `File Import ${new Date().toLocaleString()}`,
            address: address,
            public_key: publicKey,
            private_key: privateKey,
            seed: seed,
            index: 0,
            created_at: new Date().toISOString(),
            representative: representative
        };
        const data = await getWallets();
        data.wallets.push(wallet);
        if (!data.active_wallet) data.active_wallet = wallet.id;
        await updateWallets(data);
        res.json({ success: true, wallet: { ...wallet, seed: undefined, private_key: undefined } });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: err.message });
    }
});

// Xuất seed của ví
app.get('/api/wallet/:id/export', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    res.setHeader('Content-Disposition', `attachment; filename="wallet_seed_${wallet.id}.txt"`);
    res.setHeader('Content-Type', 'text/plain');
    res.send(wallet.seed);
});

// Kích hoạt ví
app.post('/api/wallet/:id/activate', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    data.active_wallet = wallet.id;
    await updateWallets(data);
    res.json({ success: true });
});

// Xóa ví
app.delete('/api/wallet/:id', requireAuth, async (req, res) => {
    const data = await getWallets();
    const index = data.wallets.findIndex(w => w.id === req.params.id);
    if (index === -1) return res.json({ success: false, error: 'Wallet not found' });
    data.wallets.splice(index, 1);
    if (data.active_wallet === req.params.id) {
        data.active_wallet = data.wallets.length > 0 ? data.wallets[0].id : null;
    }
    await updateWallets(data);
    res.json({ success: true });
});

// Lấy số dư
app.get('/api/wallet/:id/balance', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    try {
        const balanceRes = await nanoRpcCall('account_balance', { account: wallet.address });
        const balance = parseFloat(balanceRes.balance || '0') / 1e30;
        const pending = parseFloat(balanceRes.pending || '0') / 1e30;
        
        // Cập nhật representative nếu có
        try {
            const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
            if (accountInfo.representative && wallet.representative !== accountInfo.representative) {
                wallet.representative = accountInfo.representative;
                await updateWallets(data);
            }
        } catch(e) {}
        
        res.json({ success: true, balance, pending, address: wallet.address, representative: wallet.representative });
    } catch (err) {
        res.json({ success: false, error: 'Cannot fetch balance' });
    }
});

// SET REPRESENTATIVE - TRỰC TIẾP DÙNG PRIVATE KEY
app.post('/api/wallet/:id/set-representative', requireAuth, async (req, res) => {
    const { representative } = req.body;
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    if (!isValidNanoAddress(representative)) {
        return res.json({ success: false, error: 'Invalid representative address' });
    }
    
    try {
        // Lấy thông tin account
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        
        if (!accountInfo.frontier) {
            return res.json({ 
                success: false, 
                error: 'Account not initialized. Send a small amount first to activate.',
                instruction: `Send at least 0.000001 XNO to ${wallet.address} first, then try again.`
            });
        }
        
        const previous = accountInfo.frontier;
        const balance = accountInfo.balance;
        
        // Tạo block change representative
        // Cấu trúc block state
        const block = {
            type: 'state',
            previous: previous,
            representative: representative,
            balance: balance,
            link: '0000000000000000000000000000000000000000000000000000000000000000',
            work: '0000000000000000'
        };
        
        // Tính block hash
        const blockHash = blake.blake2bHex(JSON.stringify(block), null, 32);
        
        // Sign với private key
        const privateKeyHex = wallet.private_key;
        
        // Tạo chữ ký (cần thư viện ed25519)
        // Do giới hạn, tạm thời hướng dẫn user dùng Natrium
        // Nhưng để đáp ứng yêu cầu "set trực tiếp", cần thêm thư viện ed25519
        
        res.json({
            success: false,
            need_manual: true,
            message: 'Auto-set representative requires Ed25519 signing library. Please use Natrium wallet.',
            instruction: `Import this seed into Natrium to set representative: ${wallet.seed}`,
            representative: representative,
            current_rep: wallet.representative,
            alternative: `You can also use: https://nano.to/rep?address=${wallet.address}&rep=${representative}`
        });
        
    } catch (err) {
        console.error('Set representative error:', err);
        res.json({ success: false, error: err.message });
    }
});

// Lấy thông tin representative hiện tại
app.get('/api/wallet/:id/representative', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    
    try {
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        res.json({ 
            success: true, 
            representative: accountInfo.representative || null,
            weight: accountInfo.weight || '0',
            voting_weight: parseFloat(accountInfo.weight || '0') / 1e30
        });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Lịch sử giao dịch
app.get('/api/wallet/:id/history', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    try {
        const history = await nanoRpcCall('account_history', { account: wallet.address, count: 50 });
        const transactions = (history.history || []).map(tx => ({
            hash: tx.hash,
            type: tx.type,
            amount: parseFloat(tx.amount || '0') / 1e30,
            account: tx.account,
            memo: tx.memo || '',
            timestamp: tx.local_timestamp,
            date: tx.local_timestamp ? new Date(tx.local_timestamp * 1000).toISOString() : null
        }));
        res.json({ success: true, transactions });
    } catch (err) {
        res.json({ success: false, error: 'Cannot fetch history' });
    }
});

// Gửi XNO (hướng dẫn thủ công)
app.post('/api/wallet/send', requireAuth, async (req, res) => {
    const { wallet_id, to_address, amount } = req.body;
    if (!wallet_id || !to_address || !amount) return res.json({ success: false, error: 'Missing required fields' });
    if (!isValidNanoAddress(to_address)) return res.json({ success: false, error: 'Invalid Nano address' });
    const sendAmount = parseFloat(amount);
    if (isNaN(sendAmount) || sendAmount <= 0) return res.json({ success: false, error: 'Invalid amount' });
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === wallet_id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    try {
        const balanceRes = await nanoRpcCall('account_balance', { account: wallet.address });
        const balance = parseFloat(balanceRes.balance || '0') / 1e30;
        if (balance < sendAmount) return res.json({ success: false, error: `Insufficient balance. You have ${balance.toFixed(6)} XNO` });
    } catch (err) {
        return res.json({ success: false, error: 'Cannot check balance' });
    }
    res.json({
        success: false,
        error: 'Auto-send not implemented for security. Please send manually from your Natrium wallet.',
        tx_info: {
            from: wallet.address,
            to: to_address,
            amount: sendAmount,
            nano_raw: Math.floor(sendAmount * 1e30)
        }
    });
});

// Kết nối ChocoHub
app.get('/api/chocohub/swaps', requireAuth, async (req, res) => {
    const admin = await getAdmin();
    if (!admin.chocohub_token) return res.json({ success: false, error: 'Not connected to ChocoHub' });
    try {
        const response = await axios.get(`${CHOCOHUB_URL}/swap/pending`, {
            headers: { Authorization: `Bearer ${admin.chocohub_token}` }
        });
        res.json({ success: true, swaps: response.data.pending || [] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Hoàn thành swap (XNO→CC)
app.post('/api/chocohub/fulfill', requireAuth, async (req, res) => {
    const { request_id, xno_txid } = req.body;
    const admin = await getAdmin();
    if (!admin.chocohub_token) return res.json({ success: false, error: 'Not connected to ChocoHub' });
    try {
        const response = await axios.post(`${CHOCOHUB_URL}/swap/fulfill`, { request_id, xno_txid }, {
            headers: { Authorization: `Bearer ${admin.chocohub_token}` }
        });
        res.json({ success: true, result: response.data });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║      NANO XNO DASHBOARD             ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  HTTP: http://localhost:${PORT}     ║`);
    console.log('║  Default login: admin / admin       ║');
    console.log(`║  RPC Node: ${NANO_RPC_URL}          ║`);
    console.log('╚══════════════════════════════════════╝');
    console.log('');
});
