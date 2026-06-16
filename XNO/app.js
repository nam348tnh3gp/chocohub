const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const blake = require('blakejs');
const nacl = require('tweetnacl');
const nanoBase32 = require('nano-base32');
const nanocurrency = require('nanocurrency');

const app = express();
const PORT = process.env.PORT || 3000;

// Nano RPC URL (cho các tác vụ thông thường)
const NANO_RPC_URL = 'https://rpc.nano.to';

// Nano.to PoW Service
const NANOTO_POW_URL = 'https://pow.nano.to';
const NANOTO_API_KEY = process.env.NANOTO_API_KEY || null;

// Swap check interval (ms)
const SWAP_CHECK_INTERVAL = 30000;

// Rate limiting cho PoW khi không có API key
let lastPowRequestTime = 0;
const POW_RATE_LIMIT_MS = 200; // 5 requests/giây = 1 request mỗi 200ms

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

// Chuyển địa chỉ nano_... thành public key (hex)
function addressToPublicKey(address) {
    if (!address.startsWith('nano_')) throw new Error('Invalid Nano address');
    const encoded = address.substring(5);
    const decoded = nanoBase32.decode(encoded);
    const publicKeyBytes = decoded.slice(0, 32);
    return publicKeyBytes.toString('hex');
}

// Chuyển public key hex thành địa chỉ nano
function publicKeyToAddress(publicKeyHex) {
    const publicKeyBytes = Buffer.from(publicKeyHex, 'hex');
    const encoded = nanoBase32.encode(publicKeyBytes);
    return 'nano_' + encoded;
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

// ========== PROOF OF WORK GENERATION ==========

// Hàm chờ rate limit (chỉ áp dụng khi không có API key)
async function waitForRateLimit() {
    if (NANOTO_API_KEY) return; // Có API key thì không giới hạn
    
    const now = Date.now();
    const timeSinceLastRequest = now - lastPowRequestTime;
    if (timeSinceLastRequest < POW_RATE_LIMIT_MS) {
        const waitTime = POW_RATE_LIMIT_MS - timeSinceLastRequest;
        console.log(`⏳ Rate limit: waiting ${waitTime}ms before next PoW request...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    lastPowRequestTime = Date.now();
}

// Gọi PoW từ nano.to service
async function generateWorkViaNanoTo(hash, difficulty = 'ffffffc000000000') {
    try {
        await waitForRateLimit();
        
        const headers = {
            'Content-Type': 'application/json'
        };
        
        // Nếu có API key thì thêm vào header
        if (NANOTO_API_KEY) {
            headers['api-key'] = NANOTO_API_KEY;
            console.log(`🔑 Using Nano.to PoW with API key`);
        } else {
            console.log(`🌐 Using Nano.to PoW without API key (rate limited to 5 req/s)`);
        }
        
        const response = await axios.post(NANOTO_POW_URL, {
            action: 'work_generate',
            hash: hash,
            difficulty: difficulty
        }, { 
            timeout: 15000,
            headers: headers
        });
        
        if (response.data && response.data.work) {
            console.log(`✅ PoW via Nano.to: ${response.data.work}`);
            return response.data.work;
        }
        throw new Error('No work returned from Nano.to');
    } catch (err) {
        if (err.response && err.response.status === 429) {
            console.warn(`⚠️ Rate limit exceeded on Nano.to! ${err.response.data?.message || 'Too many requests'}`);
        } else if (err.response && err.response.data && typeof err.response.data === 'string' && err.response.data.startsWith('<')) {
            console.warn(`⚠️ Nano.to returned HTML (may be blocked/rate limited)`);
        } else {
            console.warn(`⚠️ Nano.to PoW failed: ${err.message}`);
        }
        return null;
    }
}

// Fallback: Gọi RPC cũ (thường bị disable trên node công cộng)
async function generateWorkViaRPC(hash, difficulty = 'ffffffc000000000') {
    try {
        const response = await axios.post(NANO_RPC_URL, {
            action: 'work_generate',
            hash: hash,
            difficulty: difficulty
        }, { timeout: 10000 });
        
        if (response.data && response.data.work) {
            console.log(`✅ PoW via RPC: ${response.data.work}`);
            return response.data.work;
        }
        throw new Error('No work returned from RPC');
    } catch (err) {
        console.warn('RPC work generation failed (likely disabled on public node):', err.message);
        return null;
    }
}

// Fallback cuối cùng: tính PoW bằng CPU
async function generateWorkViaCPU(hash, difficulty = 'ffffffc000000000') {
    try {
        console.log(`🖥️ CPU PoW for ${hash.substring(0, 16)}... (may take 10-20s)`);
        const work = await nanocurrency.computeWork(hash, { workThreshold: difficulty });
        if (work && work !== '0000000000000000') {
            console.log(`✅ PoW via CPU: ${work}`);
            return work;
        }
        throw new Error('CPU work generation returned invalid result');
    } catch (err) {
        console.error('CPU work generation failed:', err);
        return null;
    }
}

// Hàm chính để sinh PoW với các fallback
async function generateRealWork(blockHashHex, difficultyHex = 'ffffffc000000000') {
    // 1. Ưu tiên dùng Nano.to service
    let work = await generateWorkViaNanoTo(blockHashHex, difficultyHex);
    if (work) return work;
    
    // 2. Fallback sang RPC (thường sẽ fail vì bị disable)
    work = await generateWorkViaRPC(blockHashHex, difficultyHex);
    if (work) return work;
    
    // 3. Fallback cuối cùng là CPU
    work = await generateWorkViaCPU(blockHashHex, difficultyHex);
    if (work) return work;
    
    throw new Error('All PoW generation methods failed');
}

// ========== NANO BLOCK BUILDING ==========
// Tính hash của block theo đúng chuẩn Nano
function computeBlockHash(block) {
    const blockData = {
        type: block.type,
        previous: block.previous,
        representative: block.representative,
        balance: block.balance,
        link: block.link,
        work: block.work
    };
    const blockString = JSON.stringify(blockData);
    return blake.blake2bHex(blockString, null, 32);
}

// Ký block bằng private key
function signBlock(block, privateKeyHex) {
    const blockHash = computeBlockHash(block);
    const blockHashBuffer = Buffer.from(blockHash, 'hex');
    const privateKeyBuffer = Buffer.from(privateKeyHex, 'hex');
    const keyPair = nacl.sign.keyPair.fromSeed(privateKeyBuffer.slice(0, 32));
    const signature = nacl.sign.detached(blockHashBuffer, keyPair.secretKey);
    return Buffer.from(signature).toString('hex');
}

// Gửi XNO
async function sendXNO(wallet, toAddress, amountRaw) {
    try {
        // Lấy thông tin tài khoản
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        
        if (!accountInfo || !accountInfo.frontier) {
            throw new Error('Account not initialized. Need to receive at least 1 raw first.');
        }
        
        const previous = accountInfo.frontier;
        const currentBalanceRaw = accountInfo.balance;
        const amountRawBigInt = BigInt(amountRaw);
        const currentBalanceBigInt = BigInt(currentBalanceRaw);
        
        if (currentBalanceBigInt < amountRawBigInt) {
            throw new Error(`Insufficient balance: ${currentBalanceBigInt} < ${amountRawBigInt}`);
        }
        
        const newBalanceRaw = (currentBalanceBigInt - amountRawBigInt).toString();
        
        // Lấy representative - nếu không có thì dùng chính địa chỉ ví
        let representative = accountInfo.representative;
        if (!representative || representative === '0000000000000000000000000000000000000000000000000000000000000000') {
            // Nếu chưa có representative, dùng chính public key của ví
            representative = wallet.public_key;
            console.log(`⚠️ No representative set, using self: ${representative.substring(0, 20)}...`);
        }
        
        // Link là public key của người nhận
        const linkPublicKey = addressToPublicKey(toAddress);
        
        // Log chi tiết (an toàn với substring)
        console.log(`📤 Sending ${amountRaw} raw`);
        console.log(`   From: ${wallet.address.substring(0, 25)}...`);
        console.log(`   To: ${toAddress.substring(0, 25)}...`);
        console.log(`   Previous: ${previous.substring(0, 16)}...`);
        console.log(`   Balance: ${currentBalanceRaw} -> ${newBalanceRaw}`);
        console.log(`   Representative: ${representative.substring(0, 20)}...`);
        console.log(`   Link (dest pubkey): ${linkPublicKey.substring(0, 16)}...`);
        
        // Tạo block
        const block = {
            type: 'state',
            previous: previous,
            representative: representative,
            balance: newBalanceRaw,
            link: linkPublicKey,
            work: '0000000000000000'
        };
        
        // Sinh work
        const tempHash = computeBlockHash(block);
        const realWork = await generateRealWork(tempHash);
        block.work = realWork;
        
        // Ký block
        const signature = signBlock(block, wallet.private_key);
        block.signature = signature;
        
        // Log block trước khi gửi (debug)
        console.log('   Block preview:', JSON.stringify({
            type: block.type,
            previous: block.previous.substring(0, 16) + '...',
            representative: block.representative.substring(0, 16) + '...',
            balance: block.balance,
            link: block.link.substring(0, 16) + '...',
            work: block.work,
            signature: block.signature.substring(0, 16) + '...'
        }));
        
        // Gửi block
        const result = await nanoRpcCall('process', { block: JSON.stringify(block) });
        console.log(`✅ Send successful: ${result.hash}`);
        return { success: true, hash: result.hash };
        
    } catch (err) {
        console.error('Send XNO error:', err);
        return { success: false, error: err.message };
    }
}

// Receive XNO
async function receiveXNO(wallet, transactionHash) {
    try {
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        if (!accountInfo || !accountInfo.frontier) {
            throw new Error('Account not initialized');
        }
        
        const previous = accountInfo.frontier;
        const currentBalanceRaw = accountInfo.balance;
        
        const pending = await nanoRpcCall('pending', { 
            account: wallet.address, 
            hash: transactionHash,
            source: true 
        });
        
        if (!pending.blocks || !pending.blocks[transactionHash]) {
            throw new Error(`No pending block found for hash ${transactionHash}`);
        }
        
        const amountRaw = pending.blocks[transactionHash].amount;
        const newBalanceRaw = (BigInt(currentBalanceRaw) + BigInt(amountRaw)).toString();
        
        let representative = accountInfo.representative;
        if (!representative || representative === '0000000000000000000000000000000000000000000000000000000000000000') {
            representative = wallet.public_key;
        }
        
        console.log(`📥 Receiving ${amountRaw} raw`);
        console.log(`   Balance: ${currentBalanceRaw} -> ${newBalanceRaw}`);
        
        const block = {
            type: 'state',
            previous: previous,
            representative: representative,
            balance: newBalanceRaw,
            link: transactionHash,
            work: '0000000000000000'
        };
        
        const tempHash = computeBlockHash(block);
        const realWork = await generateRealWork(tempHash);
        block.work = realWork;
        
        const signature = signBlock(block, wallet.private_key);
        block.signature = signature;
        
        const result = await nanoRpcCall('process', { block: JSON.stringify(block) });
        console.log(`✅ Receive successful: ${result.hash}`);
        return { success: true, hash: result.hash };
        
    } catch (err) {
        console.error('Receive XNO error:', err);
        return { success: false, error: err.message };
    }
}

// Set representative
async function setRepresentative(wallet, representativeAddress) {
    try {
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        if (!accountInfo || !accountInfo.frontier) {
            throw new Error('Account not initialized');
        }
        
        const previous = accountInfo.frontier;
        const balance = accountInfo.balance;
        const representativePubKey = addressToPublicKey(representativeAddress);
        const linkZeros = '0000000000000000000000000000000000000000000000000000000000000000';
        
        const block = {
            type: 'state',
            previous: previous,
            representative: representativePubKey,
            balance: balance,
            link: linkZeros,
            work: '0000000000000000'
        };
        
        const tempHash = computeBlockHash(block);
        const realWork = await generateRealWork(tempHash);
        block.work = realWork;
        
        const signature = signBlock(block, wallet.private_key);
        block.signature = signature;
        
        const result = await nanoRpcCall('process', { block: JSON.stringify(block) });
        console.log(`✅ Representative changed: ${result.hash}`);
        return { success: true, hash: result.hash };
        
    } catch (err) {
        console.error('Set representative error:', err);
        return { success: false, error: err.message };
    }
}

// Nano RPC wrapper
async function nanoRpcCall(action, params = {}) {
    try {
        const response = await axios.post(NANO_RPC_URL, { action, ...params }, { 
            timeout: 30000, 
            headers: { 'Content-Type': 'application/json' } 
        });
        if (response.data && !response.data.error) return response.data;
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
        if (!activeWallet) return;
        
        for (const swap of swaps) {
            if (swap.status !== 'pending') continue;
            if (swap.swap_type === 'xno_to_cc') {
                await processXNOtoCC(swap, activeWallet, admin);
            } else if (swap.swap_type === 'cc_to_xno') {
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
        const expectedAmountRaw = Math.floor(parseFloat(expectedAmount) * 1e30);
        
        for (const [txHash, txInfo] of Object.entries(pending.blocks)) {
            const amountRaw = parseInt(txInfo.amount);
            if (Math.abs(amountRaw - expectedAmountRaw) <= 1000) {
                const receiveResult = await receiveXNO(wallet, txHash);
                if (receiveResult.success) {
                    await axios.post(`${CHOCOHUB_URL}/swap/fulfill`, 
                        { request_id: swap.id, xno_txid: txHash }, 
                        { headers: { Authorization: `Bearer ${admin.chocohub_token}` } }
                    );
                    console.log(`✅ Auto-fulfilled XNO->CC swap: ${swap.id}`);
                }
                break;
            }
        }
    } catch (err) { 
        console.error('Process XNO->CC error:', err); 
    }
}

async function processCCtoXNO(swap, wallet, admin) {
    try {
        const xnoAmount = swap.amount_cc * 0.000002;
        const toAddress = swap.receiver;
        
        if (!isValidNanoAddress(toAddress)) {
            console.error(`Invalid XNO address for swap ${swap.id}: ${toAddress}`);
            return;
        }
        
        const amountRaw = Math.floor(xnoAmount * 1e30);
        console.log(`💱 Processing CC->XNO: ${swap.amount_cc} CC = ${xnoAmount} XNO (${amountRaw} raw)`);
        
        const sendResult = await sendXNO(wallet, toAddress, amountRaw);
        if (sendResult.success) {
            await axios.post(`${CHOCOHUB_URL}/swap/fulfill`, 
                { request_id: swap.id, xno_txid: sendResult.hash }, 
                { headers: { Authorization: `Bearer ${admin.chocohub_token}` } }
            );
            console.log(`✅ Auto-fulfilled CC->XNO swap: ${swap.id}, tx: ${sendResult.hash}`);
        } else {
            console.error(`Failed to send XNO for swap ${swap.id}: ${sendResult.error}`);
        }
    } catch (err) { 
        console.error('Process CC->XNO error:', err); 
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
            const authRes = await axios.post(`${CHOCOHUB_URL}/auth`, 
                { username: chocohub_username, pin: chocohub_pin }
            );
            if (authRes.data.status !== 'success') {
                return res.json({ success: false, error: 'Invalid ChocoHub credentials' });
            }
            admin.chocohub_token = authRes.data.token;
            if (swapProcessorInterval) clearInterval(swapProcessorInterval);
            swapProcessorInterval = setInterval(processPendingSwaps, SWAP_CHECK_INTERVAL);
            console.log('🔄 Auto swap processor started');
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
        id: w.id, name: w.name, address: w.address, public_key: w.public_key,
        index: w.index, created_at: w.created_at, representative: w.representative
    }));
    res.json({ wallets: safeWallets, active: data.active_wallet });
});

app.post('/api/wallet/create', requireAuth, async (req, res) => {
    const { name } = req.body;
    try {
        const seedHex = await generateRandomSeed();
        const { address, publicKey, privateKey } = await generateNanoAddressFromSeed(seedHex, 0);
        const wallet = {
            id: Date.now().toString(), 
            name: name || `Wallet ${new Date().toLocaleString()}`,
            address, 
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
        res.json({ success: true, wallet: { id: wallet.id, name: wallet.name, address: wallet.address } });
    } catch (err) {
        console.error('Create wallet error:', err);
        res.json({ success: false, error: err.message });
    }
});

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
        let representative = null;
        try { 
            const accountInfo = await nanoRpcCall('account_info', { account: address }); 
            if (accountInfo && accountInfo.representative) {
                representative = publicKeyToAddress(accountInfo.representative);
            }
        } catch (e) {}
        
        const wallet = {
            id: Date.now().toString(), 
            name: name || `Imported ${new Date().toLocaleString()}`,
            address, 
            public_key: publicKey, 
            private_key: privateKey, 
            seed: seedHex, 
            index: walletIndex,
            created_at: new Date().toISOString(), 
            representative
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
            if (accountInfo && accountInfo.representative) {
                representative = publicKeyToAddress(accountInfo.representative);
            }
        } catch (e) {}
        
        const wallet = {
            id: Date.now().toString(), 
            name: `File Import ${new Date().toLocaleString()}`,
            address, 
            public_key: publicKey, 
            private_key: privateKey, 
            seed, 
            index: 0,
            created_at: new Date().toISOString(), 
            representative
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

app.get('/api/wallet/:id/export', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    res.setHeader('Content-Disposition', `attachment; filename="wallet_seed_${wallet.id}.txt"`);
    res.setHeader('Content-Type', 'text/plain');
    res.send(wallet.seed);
});

app.post('/api/wallet/:id/activate', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    data.active_wallet = wallet.id;
    await updateWallets(data);
    res.json({ success: true });
});

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
            if (accountInfo && accountInfo.representative) {
                representative = publicKeyToAddress(accountInfo.representative);
            }
        } catch(e) {}
        res.json({ success: true, balance, pending, address: wallet.address, representative });
    } catch (err) {
        res.json({ success: false, error: 'Cannot fetch balance' });
    }
});

app.post('/api/wallet/:id/set-representative', requireAuth, async (req, res) => {
    const { representative } = req.body;
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    if (!isValidNanoAddress(representative)) {
        return res.json({ success: false, error: 'Invalid representative address' });
    }
    try {
        const result = await setRepresentative(wallet, representative);
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

app.get('/api/wallet/:id/representative', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    try {
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        const representative = accountInfo.representative ? publicKeyToAddress(accountInfo.representative) : null;
        res.json({ success: true, representative, 
                   weight: accountInfo.weight || '0', 
                   voting_weight: parseFloat(accountInfo.weight || '0') / 1e30 });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/wallet/:id/history', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    try {
        const history = await nanoRpcCall('account_history', { account: wallet.address, count: 50 });
        const transactions = (history.history || []).map(tx => ({
            hash: tx.hash, type: tx.type, amount: parseFloat(tx.amount || '0') / 1e30,
            account: tx.account, memo: tx.memo || '', timestamp: tx.local_timestamp,
            date: tx.local_timestamp ? new Date(tx.local_timestamp * 1000).toISOString() : null
        }));
        res.json({ success: true, transactions });
    } catch (err) {
        res.json({ success: false, error: 'Cannot fetch history' });
    }
});

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
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    try {
        const balanceRes = await nanoRpcCall('account_balance', { account: wallet.address });
        const balance = parseFloat(balanceRes.balance || '0') / 1e30;
        if (balance < sendAmount) {
            return res.json({ success: false, error: `Insufficient balance. You have ${balance.toFixed(6)} XNO` });
        }
        const amountRaw = Math.floor(sendAmount * 1e30);
        const result = await sendXNO(wallet, to_address, amountRaw);
        if (result.success) {
            res.json({ success: true, hash: result.hash });
        } else {
            res.json({ success: false, error: result.error });
        }
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.get('/api/chocohub/swaps', requireAuth, async (req, res) => {
    const admin = await getAdmin();
    if (!admin.chocohub_token) return res.json({ success: false, error: 'Not connected to ChocoHub' });
    try {
        const response = await axios.get(`${CHOCOHUB_URL}/swap/pending`, 
            { headers: { Authorization: `Bearer ${admin.chocohub_token}` } }
        );
        res.json({ success: true, swaps: response.data.pending || [] });
    } catch (err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/chocohub/process', requireAuth, async (req, res) => {
    await processPendingSwaps();
    res.json({ success: true, message: 'Swap processing triggered' });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Khởi tạo và start
setTimeout(async () => {
    try {
        const testHash = '0000000000000000000000000000000000000000000000000000000000000000';
        console.log('🔍 Testing PoW generation...');
        const testWork = await generateRealWork(testHash);
        console.log(`✅ PoW test successful: ${testWork}`);
    } catch (err) {
        console.error('⚠️ PoW initialization warning:', err.message);
    }
    
    const admin = await getAdmin();
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
    console.log(`║  PoW Service: ${NANOTO_POW_URL}     ║`);
    console.log(`║  API Key: ${NANOTO_API_KEY ? '✅ Configured' : '❌ Not set (5 req/s limit)'}`);
    console.log('║  Auto Swap: Enabled (30s interval)  ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');
});
