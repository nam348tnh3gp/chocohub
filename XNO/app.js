const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const axios = require('axios');

// Import nanocurrency (phiên bản 2.5.0)
const nanocurrency = require('nanocurrency');

const app = express();
const PORT = process.env.PORT || 3000;

// Nano RPC URL (public node ổn định)
const NANO_RPC_URL = 'https://www.nanode.co/api';

// Nano RPC wrapper function
async function nanoRpcCall(action, params = {}) {
    try {
        const response = await axios.post(NANO_RPC_URL, { action, ...params });
        return response.data;
    } catch (err) {
        console.error(`RPC error (${action}):`, err.message);
        throw err;
    }
}

// ========== CONFIG ==========
const DATA_DIR = path.join(__dirname, 'data');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');

// ChocoHub API URL
const CHOCOHUB_URL = 'https://chocohub-r011.onrender.com';

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Session
app.use(session({
    secret: process.env.SESSION_SECRET || 'nano-dashboard-secret-key-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 86400000 }
}));

// Multer for file upload
const upload = multer({ dest: path.join(DATA_DIR, 'uploads') });

// ========== INITIALIZE DATA ==========
async function initData() {
    await fs.ensureDir(DATA_DIR);
    
    // Khởi tạo admin mặc định
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
    
    // Khởi tạo wallets file
    if (!await fs.pathExists(WALLETS_FILE)) {
        await fs.writeJson(WALLETS_FILE, {
            wallets: [],
            active_wallet: null
        });
    }
}
initData();

// ========== HELPER FUNCTIONS ==========
async function getAdmin() {
    return await fs.readJson(ADMIN_FILE);
}

async function updateAdmin(data) {
    await fs.writeJson(ADMIN_FILE, data);
}

async function getWallets() {
    return await fs.readJson(WALLETS_FILE);
}

async function updateWallets(data) {
    await fs.writeJson(WALLETS_FILE, data);
}

// Validate Nano address
function isValidNanoAddress(address) {
    return address && address.startsWith('nano_') && address.length >= 60;
}

// Hàm tạo địa chỉ Nano từ seed (dùng nanocurrency@2.5.0)
async function generateNanoAddressFromSeed(seedHex, index = 0) {
    try {
        // Đảm bảo seed là Buffer 32 bytes
        let seedBuffer;
        if (Buffer.isBuffer(seedHex)) {
            seedBuffer = seedHex;
        } else if (typeof seedHex === 'string') {
            seedBuffer = Buffer.from(seedHex, 'hex');
        } else {
            seedBuffer = seedHex;
        }
        
        // deriveKeyPairFromSeed là API đúng của nanocurrency 2.x
        const keyPair = await nanocurrency.deriveKeyPairFromSeed(seedBuffer, index);
        
        // Tạo địa chỉ từ public key
        const address = await nanocurrency.deriveAddress(keyPair.publicKey, { useNanoPrefix: true });
        
        return {
            address: address,
            publicKey: keyPair.publicKey.toString('hex'),
            privateKey: keyPair.privateKey.toString('hex')
        };
    } catch (err) {
        console.error('Generate address error:', err);
        throw err;
    }
}

// ========== AUTH MIDDLEWARE ==========
function requireAuth(req, res, next) {
    if (req.session.authenticated) {
        return next();
    }
    res.redirect('/login');
}

// ========== ROUTES ==========

// Login page
app.get('/login', (req, res) => {
    if (req.session.authenticated) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login API
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const admin = await getAdmin();
    
    if (username !== admin.username) {
        return res.json({ success: false, error: 'Invalid credentials' });
    }
    
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
        return res.json({ success: false, error: 'Invalid credentials' });
    }
    
    req.session.authenticated = true;
    req.session.firstLogin = admin.first_login;
    
    res.json({ success: true, firstLogin: admin.first_login });
});

// Change password & set ChocoHub credentials
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
        
        // Test ChocoHub authentication
        try {
            const authRes = await axios.post(`${CHOCOHUB_URL}/auth`, {
                username: chocohub_username,
                pin: chocohub_pin
            });
            if (authRes.data.status !== 'success') {
                return res.json({ success: false, error: 'Invalid ChocoHub credentials' });
            }
            admin.chocohub_token = authRes.data.token;
        } catch (err) {
            return res.json({ success: false, error: 'Cannot connect to ChocoHub: ' + err.message });
        }
    }
    
    await updateAdmin(admin);
    req.session.firstLogin = false;
    res.json({ success: true });
});

// Dashboard
app.get('/', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get admin info
app.get('/api/admin', requireAuth, async (req, res) => {
    const admin = await getAdmin();
    res.json({
        username: admin.username,
        chocohub_username: admin.chocohub_username,
        firstLogin: admin.first_login
    });
});

// ========== WALLET MANAGEMENT ==========

// Get all wallets
app.get('/api/wallets', requireAuth, async (req, res) => {
    const data = await getWallets();
    res.json({
        wallets: data.wallets,
        active: data.active_wallet
    });
});

// Create new wallet
app.post('/api/wallet/create', requireAuth, async (req, res) => {
    try {
        // Generate random seed (32 bytes)
        const seed = nanocurrency.generateSeed();
        const seedHex = seed.toString('hex');
        
        // Generate address từ seed
        const { address, publicKey, privateKey } = await generateNanoAddressFromSeed(seed, 0);
        
        const wallet = {
            id: Date.now().toString(),
            name: req.body.name || `Wallet ${new Date().toLocaleString()}`,
            address: address,
            public_key: publicKey,
            private_key: privateKey,
            seed: seedHex,
            index: 0,
            created_at: new Date().toISOString()
        };
        
        const data = await getWallets();
        data.wallets.push(wallet);
        if (!data.active_wallet) {
            data.active_wallet = wallet.id;
        }
        await updateWallets(data);
        
        res.json({ success: true, wallet: { ...wallet, seed: undefined, private_key: undefined } });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: err.message });
    }
});

// Import wallet from seed (64 hex chars)
app.post('/api/wallet/import', requireAuth, async (req, res) => {
    try {
        const { seed, name, index } = req.body;
        
        if (!seed || seed.length < 64) {
            return res.json({ success: false, error: 'Invalid seed (must be 64 hex chars)' });
        }
        
        const seedHex = seed.length === 64 ? seed : Buffer.from(seed).toString('hex');
        const walletIndex = index || 0;
        const seedBuffer = Buffer.from(seedHex, 'hex');
        
        // Generate address
        const { address, publicKey, privateKey } = await generateNanoAddressFromSeed(seedBuffer, walletIndex);
        
        const wallet = {
            id: Date.now().toString(),
            name: name || `Imported ${new Date().toLocaleString()}`,
            address: address,
            public_key: publicKey,
            private_key: privateKey,
            seed: seedHex,
            index: walletIndex,
            created_at: new Date().toISOString()
        };
        
        const data = await getWallets();
        
        // Check duplicate
        const existing = data.wallets.find(w => w.address === address);
        if (existing) {
            return res.json({ success: false, error: 'Wallet already exists' });
        }
        
        data.wallets.push(wallet);
        if (!data.active_wallet) {
            data.active_wallet = wallet.id;
        }
        await updateWallets(data);
        
        res.json({ success: true, wallet: { ...wallet, seed: undefined, private_key: undefined } });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: err.message });
    }
});

// Import from file
app.post('/api/wallet/import-file', requireAuth, upload.single('seedFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.json({ success: false, error: 'No file uploaded' });
        }
        
        const content = await fs.readFile(req.file.path, 'utf8');
        const seed = content.trim();
        
        await fs.remove(req.file.path);
        
        if (!seed || seed.length < 64) {
            return res.json({ success: false, error: 'Invalid seed file content' });
        }
        
        const seedBuffer = Buffer.from(seed, 'hex');
        const { address, publicKey, privateKey } = await generateNanoAddressFromSeed(seedBuffer, 0);
        
        const wallet = {
            id: Date.now().toString(),
            name: `File Import ${new Date().toLocaleString()}`,
            address: address,
            public_key: publicKey,
            private_key: privateKey,
            seed: seed,
            index: 0,
            created_at: new Date().toISOString()
        };
        
        const data = await getWallets();
        data.wallets.push(wallet);
        if (!data.active_wallet) {
            data.active_wallet = wallet.id;
        }
        await updateWallets(data);
        
        res.json({ success: true, wallet: { ...wallet, seed: undefined, private_key: undefined } });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: err.message });
    }
});

// Export wallet seed
app.get('/api/wallet/:id/export', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    
    if (!wallet) {
        return res.status(404).json({ error: 'Wallet not found' });
    }
    
    res.setHeader('Content-Disposition', `attachment; filename="wallet_seed_${wallet.id}.txt"`);
    res.setHeader('Content-Type', 'text/plain');
    res.send(wallet.seed);
});

// Set active wallet
app.post('/api/wallet/:id/activate', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    
    if (!wallet) {
        return res.json({ success: false, error: 'Wallet not found' });
    }
    
    data.active_wallet = wallet.id;
    await updateWallets(data);
    res.json({ success: true });
});

// Delete wallet
app.delete('/api/wallet/:id', requireAuth, async (req, res) => {
    const data = await getWallets();
    const index = data.wallets.findIndex(w => w.id === req.params.id);
    
    if (index === -1) {
        return res.json({ success: false, error: 'Wallet not found' });
    }
    
    data.wallets.splice(index, 1);
    
    if (data.active_wallet === req.params.id) {
        data.active_wallet = data.wallets.length > 0 ? data.wallets[0].id : null;
    }
    
    await updateWallets(data);
    res.json({ success: true });
});

// Get wallet balance
app.get('/api/wallet/:id/balance', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    
    if (!wallet) {
        return res.json({ success: false, error: 'Wallet not found' });
    }
    
    try {
        const balanceRes = await nanoRpcCall('account_balance', { account: wallet.address });
        const balance = parseFloat(balanceRes.balance || '0') / 1e30;
        const pending = parseFloat(balanceRes.pending || '0') / 1e30;
        
        res.json({
            success: true,
            balance: balance,
            pending: pending,
            address: wallet.address
        });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: 'Cannot fetch balance' });
    }
});

// Get transaction history
app.get('/api/wallet/:id/history', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    
    if (!wallet) {
        return res.json({ success: false, error: 'Wallet not found' });
    }
    
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
        console.error(err);
        res.json({ success: false, error: 'Cannot fetch history' });
    }
});

// Send XNO
app.post('/api/wallet/send', requireAuth, async (req, res) => {
    const { wallet_id, to_address, amount } = req.body;
    
    if (!wallet_id || !to_address || !amount) {
        return res.json({ success: false, error: 'Missing required fields' });
    }
    
    if (!isValidNanoAddress(to_address)) {
        return res.json({ success: false, error: 'Invalid Nano address' });
    }
    
    const sendAmount = parseFloat(amount);
    if (isNaN(sendAmount) || sendAmount <= 0) {
        return res.json({ success: false, error: 'Invalid amount' });
    }
    
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === wallet_id);
    
    if (!wallet) {
        return res.json({ success: false, error: 'Wallet not found' });
    }
    
    // Check balance
    try {
        const balanceRes = await nanoRpcCall('account_balance', { account: wallet.address });
        const balance = parseFloat(balanceRes.balance || '0') / 1e30;
        
        if (balance < sendAmount) {
            return res.json({ success: false, error: `Insufficient balance. You have ${balance.toFixed(6)} XNO` });
        }
    } catch (err) {
        return res.json({ success: false, error: 'Cannot check balance' });
    }
    
    // For security, return transaction info for manual sending
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

// Get pending swaps from ChocoHub
app.get('/api/chocohub/swaps', requireAuth, async (req, res) => {
    const admin = await getAdmin();
    
    if (!admin.chocohub_token) {
        return res.json({ success: false, error: 'Not connected to ChocoHub' });
    }
    
    try {
        const response = await axios.get(`${CHOCOHUB_URL}/swap/pending`, {
            headers: { Authorization: `Bearer ${admin.chocohub_token}` }
        });
        res.json({ success: true, swaps: response.data.pending || [] });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: err.message });
    }
});

// Fulfill swap on ChocoHub
app.post('/api/chocohub/fulfill', requireAuth, async (req, res) => {
    const { request_id, xno_txid } = req.body;
    const admin = await getAdmin();
    
    if (!admin.chocohub_token) {
        return res.json({ success: false, error: 'Not connected to ChocoHub' });
    }
    
    try {
        const response = await axios.post(`${CHOCOHUB_URL}/swap/fulfill`, {
            request_id,
            xno_txid
        }, {
            headers: { Authorization: `Bearer ${admin.chocohub_token}` }
        });
        res.json({ success: true, result: response.data });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: err.message });
    }
});

// Logout
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Start server
app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║      NANO XNO DASHBOARD             ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  HTTP: http://localhost:${PORT}     ║`);
    console.log('║  Default login: admin / admin       ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');
});
