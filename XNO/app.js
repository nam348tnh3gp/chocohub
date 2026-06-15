const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const blake = require('blakejs');
const nacl = require('tweetnacl');

// Import nanocurrency
const nanocurrency = require('nanocurrency');

const app = express();
const PORT = process.env.PORT || 3000;

// Nano RPC URL
const NANO_RPC_URL = 'https://rpc.nano.to';

// Swap check interval (ms)
const SWAP_CHECK_INTERVAL = 30000; // 30 seconds

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

// Sign with tweetnacl
function signWithPrivateKey(messageHex, privateKeyHex) {
    const message = Buffer.from(messageHex, 'hex');
    const privateKey = Buffer.from(privateKeyHex, 'hex');
    const publicKey = Buffer.from(privateKey).slice(32);
    const secretKey = Buffer.concat([privateKey, publicKey]);
    const signature = nacl.sign.detached(message, secretKey);
    return Buffer.from(signature).toString('hex');
}

// Tạo địa chỉ Nano từ seed
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

// Tạo seed ngẫu nhiên
async function generateRandomSeed() {
    const seedBuffer = await nanocurrency.generateSeed();
    return seedBuffer.toString('hex');
}

// Gửi XNO (auto)
async function sendXNO(wallet, toAddress, amountRaw, work = '0000000000000000') {
    try {
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        
        if (!accountInfo.frontier) {
            throw new Error('Account not initialized');
        }
        
        const previous = accountInfo.frontier;
        const balance = BigInt(accountInfo.balance);
        const amount = BigInt(amountRaw);
        const newBalance = (balance - amount).toString();
        
        const block = {
            type: 'state',
            previous: previous,
            representative: accountInfo.representative,
            balance: newBalance,
            link: toAddress,
            work: work
        };
        
        const blockHash = blake.blake2bHex(JSON.stringify(block), null, 32);
        const signature = signWithPrivateKey(blockHash, wallet.private_key);
        
        block.signature = signature;
        
        const result = await nanoRpcCall('process', { block: JSON.stringify(block) });
        
        return { success: true, hash: result.hash };
    } catch (err) {
        console.error('Send XNO error:', err);
        return { success: false, error: err.message };
    }
}

// Tạo block change representative
async function setRepresentative(wallet, representativeAddress, work = '0000000000000000') {
    try {
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        
        if (!accountInfo.frontier) {
            throw new Error('Account not initialized. Send a small amount first.');
        }
        
        const previous = accountInfo.frontier;
        const balance = accountInfo.balance;
        
        const block = {
            type: 'state',
            previous: previous,
            representative: representativeAddress,
            balance: balance,
            link: '0000000000000000000000000000000000000000000000000000000000000000',
            work: work
        };
        
        const blockHash = blake.blake2bHex(JSON.stringify(block), null, 32);
        const signature = signWithPrivateKey(blockHash, wallet.private_key);
        
        block.signature = signature;
        
        const result = await nanoRpcCall('process', { block: JSON.stringify(block) });
        
        return { success: true, hash: result.hash };
    } catch (err) {
        console.error('Set representative error:', err);
        return { success: false, error: err.message };
    }
}

// Receive XNO
async function receiveXNO(wallet, transactionHash) {
    try {
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        const previous = accountInfo.frontier;
        const balance = BigInt(accountInfo.balance);
        
        const pending = await nanoRpcCall('pending', { account: wallet.address, hash: transactionHash });
        const amount = BigInt(pending.blocks[transactionHash].amount);
        const newBalance = (balance + amount).toString();
        
        const block = {
            type: 'state',
            previous: previous,
            representative: accountInfo.representative,
            balance: newBalance,
            link: transactionHash,
            work: '0000000000000000'
        };
        
        const blockHash = blake.blake2bHex(JSON.stringify(block), null, 32);
        const signature = signWithPrivateKey(blockHash, wallet.private_key);
        
        block.signature = signature;
        
        const result = await nanoRpcCall('process', { block: JSON.stringify(block) });
        
        return { success: true, hash: result.hash };
    } catch (err) {
        console.error('Receive XNO error:', err);
        return { success: false, error: err.message };
    }
}

// Nano RPC wrapper
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

// ========== AUTO SWAP PROCESSOR ==========
let swapProcessorInterval = null;

async function processPendingSwaps() {
    const admin = await getAdmin();
    if (!admin.chocohub_token) return;
    
    try {
        const response = await axios.get(`${CHOCOHUB_URL}/swap/pending`, {
            headers: { Authorization: `Bearer ${admin.chocohub_token}` }
        });
        
        const swaps = response.data.pending || [];
        const data = await getWallets();
        const activeWallet = data.wallets.find(w => w.id === data.active_wallet);
        
        if (!activeWallet || !activeWallet.private_key) {
            // Need to decrypt wallet first (store decrypted private key in memory for auto ops)
            console.log('Active wallet has no private key loaded');
            return;
        }
        
        for (const swap of swaps) {
            if (swap.status !== 'pending') continue;
            
            if (swap.swap_type === 'xno_to_cc') {
                await processXNOtoCC(swap, activeWallet, admin);
            }
            else if (swap.swap_type === 'cc_to_xno') {
                await processCCtoXNO(swap, activeWallet, admin);
            }
        }
    } catch (err) {
        console.error('Process pending swaps error:', err);
    }
}

async function processXNOtoCC(swap, wallet, admin) {
    try {
        const pending = await nanoRpcCall('pending', { account: wallet.address, source: true });
        
        if (!pending.blocks) return;
        
        const expectedAmount = (swap.amount_cc / 500000).toFixed(8);
        
        for (const [txHash, txInfo] of Object.entries(pending.blocks)) {
            const amount = parseFloat(txInfo.amount) / 1e30;
            
            if (Math.abs(amount - expectedAmount) <= 0.0001) {
                const receiveResult = await receiveXNO(wallet, txHash);
                
                if (receiveResult.success) {
                    await axios.post(`${CHOCOHUB_URL}/swap/fulfill`, {
                        request_id: swap.id,
                        xno_txid: txHash
                    }, {
                        headers: { Authorization: `Bearer ${admin.chocohub_token}` }
                    });
                    console.log(`✅ Auto-fulfilled XNO→CC swap: ${swap.id}`);
                }
                break;
            }
        }
    } catch (err) {
        console.error('Process XNO→CC error:', err);
    }
}

async function processCCtoXNO(swap, wallet, admin) {
    try {
        const xnoAmount = (swap.amount_cc * 0.000002).toFixed(8);
        const toAddress = swap.receiver;
        
        if (!isValidNanoAddress(toAddress)) {
            console.error(`Invalid XNO address for swap ${swap.id}: ${toAddress}`);
            return;
        }
        
        const amountRaw = Math.floor(parseFloat(xnoAmount) * 1e30);
        const sendResult = await sendXNO(wallet, toAddress, amountRaw);
        
        if (sendResult.success) {
            await axios.post(`${CHOCOHUB_URL}/swap/fulfill`, {
                request_id: swap.id,
                xno_txid: sendResult.hash
            }, {
                headers: { Authorization: `Bearer ${admin.chocohub_token}` }
            });
            console.log(`✅ Auto-fulfilled CC→XNO swap: ${swap.id}, tx: ${sendResult.hash}`);
        } else {
            console.error(`Failed to send XNO for swap ${swap.id}: ${sendResult.error}`);
        }
    } catch (err) {
        console.error('Process CC→XNO error:', err);
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
            
            if (swapProcessorInterval) clearInterval(swapProcessorInterval);
            swapProcessorInterval = setInterval(processPendingSwaps, SWAP_CHECK_INTERVAL);
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
    const safeWallets = data.wallets.map(w => ({
        id: w.id,
        name: w.name,
        address: w.address,
        public_key: w.public_key,
        index: w.index,
        created_at: w.created_at,
        representative: w.representative,
        has_encrypted_seed: !!w.encrypted_seed,
        has_private_key: !!w.private_key
    }));
    res.json({ wallets: safeWallets, active: data.active_wallet });
});

// Set active wallet and load private key for auto ops
app.post('/api/wallet/:id/activate', requireAuth, async (req, res) => {
    const { password } = req.body;
    const data = await getWallets();
    const walletIndex = data.wallets.findIndex(w => w.id === req.params.id);
    
    if (walletIndex === -1) return res.json({ success: false, error: 'Wallet not found' });
    
    // Decrypt and store private key for auto operations
    if (password && data.wallets[walletIndex].encrypted_private_key) {
        try {
            const privateKey = await decryptPrivateKey(data.wallets[walletIndex].encrypted_private_key, password);
            data.wallets[walletIndex].private_key = privateKey;
        } catch (err) {
            return res.json({ success: false, error: 'Invalid password' });
        }
    }
    
    data.active_wallet = data.wallets[walletIndex].id;
    await updateWallets(data);
    res.json({ success: true });
});

// Tạo ví mới
app.post('/api/wallet/create', requireAuth, async (req, res) => {
    const { password, name } = req.body;
    
    if (!password) {
        return res.json({ success: false, error: 'Password required to encrypt wallet' });
    }
    
    try {
        const seedHex = await generateRandomSeed();
        const { address, publicKey, privateKey } = await generateNanoAddressFromSeed(seedHex, 0);
        
        const encryptedPrivateKey = await encryptPrivateKey(privateKey, password);
        const encryptedSeed = await encryptPrivateKey(seedHex, password);
        
        const wallet = {
            id: Date.now().toString(),
            name: name || `Wallet ${new Date().toLocaleString()}`,
            address: address,
            public_key: publicKey,
            encrypted_private_key: encryptedPrivateKey,
            encrypted_seed: encryptedSeed,
            private_key: privateKey, // Keep in memory for auto ops
            index: 0,
            created_at: new Date().toISOString(),
            representative: null
        };
        const data = await getWallets();
        data.wallets.push(wallet);
        if (!data.active_wallet) data.active_wallet = wallet.id;
        await updateWallets(data);
        
        res.json({ success: true, wallet: { id: wallet.id, name: wallet.name, address: wallet.address } });
    } catch (err) {
        console.error('Create wallet error:', err);
        res.json({ success: false, error: err.message });
    }
});

// Import wallet
app.post('/api/wallet/import', requireAuth, async (req, res) => {
    try {
        let { seed, name, index, password } = req.body;
        
        if (!seed) return res.json({ success: false, error: 'Seed is required' });
        if (!password) return res.json({ success: false, error: 'Password required to encrypt wallet' });
        
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
        
        const encryptedPrivateKey = await encryptPrivateKey(privateKey, password);
        const encryptedSeed = await encryptPrivateKey(seedHex, password);
        
        let representative = null;
        try {
            const accountInfo = await nanoRpcCall('account_info', { account: address });
            representative = accountInfo.representative || null;
        } catch (e) {}
        
        const wallet = {
            id: Date.now().toString(),
            name: name || `Imported ${new Date().toLocaleString()}`,
            address: address,
            public_key: publicKey,
            encrypted_private_key: encryptedPrivateKey,
            encrypted_seed: encryptedSeed,
            private_key: privateKey,
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
        
        res.json({ success: true, wallet: { id: wallet.id, name: wallet.name, address: wallet.address } });
    } catch (err) {
        console.error('Import wallet error:', err);
        res.json({ success: false, error: err.message });
    }
});

// Import from file
app.post('/api/wallet/import-file', requireAuth, upload.single('seedFile'), async (req, res) => {
    try {
        if (!req.file) return res.json({ success: false, error: 'No file uploaded' });
        if (!req.body.password) return res.json({ success: false, error: 'Password required' });
        
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
        
        const encryptedPrivateKey = await encryptPrivateKey(privateKey, req.body.password);
        const encryptedSeed = await encryptPrivateKey(seed, req.body.password);
        
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
            encrypted_private_key: encryptedPrivateKey,
            encrypted_seed: encryptedSeed,
            private_key: privateKey,
            index: 0,
            created_at: new Date().toISOString(),
            representative: representative
        };
        const data = await getWallets();
        data.wallets.push(wallet);
        if (!data.active_wallet) data.active_wallet = wallet.id;
        await updateWallets(data);
        
        res.json({ success: true, wallet: { id: wallet.id, name: wallet.name, address: wallet.address } });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: err.message });
    }
});

// Export seed (yêu cầu mật khẩu)
app.post('/api/wallet/:id/export', requireAuth, async (req, res) => {
    const { password } = req.body;
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    if (!wallet.encrypted_seed) return res.status(404).json({ error: 'Seed not available' });
    
    try {
        const seed = await decryptPrivateKey(wallet.encrypted_seed, password);
        res.json({ success: true, seed: seed });
    } catch (err) {
        res.json({ success: false, error: 'Invalid password' });
    }
});

// Delete wallet
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
        
        let representative = wallet.representative;
        try {
            const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
            representative = accountInfo.representative || null;
        } catch(e) {}
        
        res.json({ success: true, balance, pending, address: wallet.address, representative });
    } catch (err) {
        res.json({ success: false, error: 'Cannot fetch balance' });
    }
});

// SET REPRESENTATIVE
app.post('/api/wallet/:id/set-representative', requireAuth, async (req, res) => {
    const { representative, password } = req.body;
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    if (!isValidNanoAddress(representative)) {
        return res.json({ success: false, error: 'Invalid representative address' });
    }
    
    let privateKey = wallet.private_key;
    
    // If private key not in memory, decrypt it
    if (!privateKey && password && wallet.encrypted_private_key) {
        try {
            privateKey = await decryptPrivateKey(wallet.encrypted_private_key, password);
        } catch (err) {
            return res.json({ success: false, error: 'Invalid password' });
        }
    }
    
    if (!privateKey) {
        return res.json({ success: false, error: 'Private key not available. Activate wallet first or provide password.' });
    }
    
    try {
        const tempWallet = { ...wallet, private_key: privateKey };
        const result = await setRepresentative(tempWallet, representative);
        
        if (result.success) {
            wallet.representative = representative;
            await updateWallets(data);
            res.json({ success: true, hash: result.hash });
        } else {
            res.json({ success: false, error: result.error });
        }
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

// Lấy thông tin representative
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

// Gửi XNO (yêu cầu mật khẩu cho manual send)
app.post('/api/wallet/send', requireAuth, async (req, res) => {
    const { wallet_id, to_address, amount, password } = req.body;
    
    if (!wallet_id || !to_address || !amount) return res.json({ success: false, error: 'Missing required fields' });
    if (!isValidNanoAddress(to_address)) return res.json({ success: false, error: 'Invalid Nano address' });
    
    const sendAmount = parseFloat(amount);
    if (isNaN(sendAmount) || sendAmount <= 0) return res.json({ success: false, error: 'Invalid amount' });
    
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === wallet_id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    
    let privateKey = wallet.private_key;
    
    if (!privateKey && password && wallet.encrypted_private_key) {
        try {
            privateKey = await decryptPrivateKey(wallet.encrypted_private_key, password);
        } catch (err) {
            return res.json({ success: false, error: 'Invalid password' });
        }
    }
    
    if (!privateKey) {
        return res.json({ success: false, error: 'Private key not available. Activate wallet first or provide password.' });
    }
    
    try {
        const balanceRes = await nanoRpcCall('account_balance', { account: wallet.address });
        const balance = parseFloat(balanceRes.balance || '0') / 1e30;
        if (balance < sendAmount) return res.json({ success: false, error: `Insufficient balance. You have ${balance.toFixed(6)} XNO` });
        
        const tempWallet = { ...wallet, private_key: privateKey };
        const amountRaw = Math.floor(sendAmount * 1e30);
        const result = await sendXNO(tempWallet, to_address, amountRaw);
        
        if (result.success) {
            res.json({ success: true, hash: result.hash });
        } else {
            res.json({ success: false, error: result.error });
        }
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
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

// Manually trigger swap processing
app.post('/api/chocohub/process', requireAuth, async (req, res) => {
    await processPendingSwaps();
    res.json({ success: true, message: 'Swap processing triggered' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Start auto swap processor on server start
setTimeout(async () => {
    const admin = await getAdmin();
    const data = await getWallets();
    // Auto-activate first wallet for auto ops
    if (data.active_wallet && data.wallets.length > 0) {
        const activeWallet = data.wallets.find(w => w.id === data.active_wallet);
        if (activeWallet && activeWallet.private_key) {
            console.log('✅ Active wallet ready for auto swap');
        } else if (activeWallet && activeWallet.encrypted_private_key) {
            console.log('⚠️ Active wallet encrypted. Auto swap will use stored key from activation.');
        }
    }
    
    if (admin.chocohub_token) {
        swapProcessorInterval = setInterval(processPendingSwaps, SWAP_CHECK_INTERVAL);
        console.log('🔄 Auto swap processor started');
    }
}, 5000);

app.listen(PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║      NANO XNO DASHBOARD             ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  HTTP: http://localhost:${PORT}     ║`);
    console.log('║  Default login: admin / admin       ║');
    console.log(`║  RPC Node: ${NANO_RPC_URL}          ║`);
    console.log('║  Auto Swap: Enabled (30s interval)  ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');
});
