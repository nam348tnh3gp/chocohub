const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const nanocurrency = require('nanocurrency');
const nanoBase32 = require('nano-base32');
const NanoWallet = require('simple-nanowallet');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CẤU HÌNH HTTPS & PROXY ==========
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// ========== NANO RPC ENDPOINTS ==========
if (!process.env.NANSWAP_API_KEY) {
    console.error('FATAL: NANSWAP_API_KEY environment variable is not set. Exiting.');
    process.exit(1);
}
const NANSWAP_API_KEY = process.env.NANSWAP_API_KEY;
const NANSWAP_RPC_URL = `https://nodes.nanswap.com/XNO?api_key=${NANSWAP_API_KEY}`;
const NANO_TO_RPC_URL = 'https://rpc.nano.to';

const workCache = new Map();
const SWAP_CHECK_INTERVAL = 30000;

// ========== CONFIG ==========
const DATA_DIR = path.join(__dirname, 'data');
const WALLETS_FILE = path.join(DATA_DIR, 'wallets.enc');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const CHOCOHUB_URL = 'https://chocohub-r011.onrender.com';

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

if (!process.env.SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET environment variable is not set. Exiting.');
    process.exit(1);
}
const sessionConfig = {
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 86400000
    }
};
app.use(session(sessionConfig));

const upload = multer({ dest: path.join(DATA_DIR, 'uploads') });

// ========== MÃ HÓA DỮ LIỆU (AES-256-GCM) ==========
let MASTER_KEY = null;
function initMasterKey() {
    const masterPassword = process.env.MASTER_PASSWORD;
    if (!masterPassword) {
        console.error('FATAL: MASTER_PASSWORD environment variable is not set. Exiting.');
        process.exit(1);
    }
    MASTER_KEY = crypto.pbkdf2Sync(masterPassword, 'nano-dashboard-salt', 100000, 32, 'sha256');
}
initMasterKey();

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return JSON.stringify({ iv: iv.toString('hex'), encryptedData: encrypted, authTag });
}

function decrypt(encryptedJson) {
    try {
        const { iv, encryptedData, authTag } = JSON.parse(encryptedJson);
        const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, Buffer.from(iv, 'hex'));
        decipher.setAuthTag(Buffer.from(authTag, 'hex'));
        let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (err) {
        console.error('Decryption failed:', err);
        return null;
    }
}

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
        const emptyData = encrypt(JSON.stringify({ wallets: [], active_wallet: null }));
        await fs.writeFile(WALLETS_FILE, emptyData);
    }
}
initData();

// ========== HELPER FUNCTIONS ==========
async function getAdmin() { return await fs.readJson(ADMIN_FILE); }
async function updateAdmin(data) { await fs.writeJson(ADMIN_FILE, data); }

async function getWallets() {
    const encrypted = await fs.readFile(WALLETS_FILE, 'utf8');
    const decrypted = decrypt(encrypted);
    if (!decrypted) throw new Error('Failed to decrypt wallet data');
    return JSON.parse(decrypted);
}
async function updateWallets(data) {
    const encrypted = encrypt(JSON.stringify(data));
    await fs.writeFile(WALLETS_FILE, encrypted);
}

function isValidNanoAddress(address) {
    return address && address.startsWith('nano_') && address.length >= 60;
}

function addressToPublicKey(address) {
    if (!address.startsWith('nano_')) throw new Error('Invalid Nano address');
    const encoded = address.substring(5);
    const decoded = nanoBase32.decode(encoded);
    const publicKeyBytes = decoded.slice(0, 32);
    return publicKeyBytes.toString('hex');
}

function publicKeyToAddress(publicKeyHex) {
    const publicKeyBytes = Buffer.from(publicKeyHex, 'hex');
    const encoded = nanoBase32.encode(publicKeyBytes);
    return 'nano_' + encoded;
}

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

async function generateRandomSeed() {
    const seedBuffer = await nanocurrency.generateSeed();
    return seedBuffer.toString('hex');
}

// ========== PROOF OF WORK (PoW) GENERATION ==========
async function generateWorkViaRPC(rpcUrl, hash, difficulty) {
    try {
        const response = await axios.post(rpcUrl, {
            action: 'work_generate',
            hash: hash,
            difficulty: difficulty
        }, { timeout: 8000 });
        if (response.data && response.data.work) {
            const source = rpcUrl.includes('nanswap') ? 'Nanswap' : 'Nano.to';
            console.log(`✅ PoW via ${source}: ${response.data.work}`);
            return response.data.work;
        }
        throw new Error('No work returned');
    } catch (err) {
        const source = rpcUrl.includes('nanswap') ? 'Nanswap' : 'Nano.to';
        console.warn(`RPC ${source} failed for work_generate:`, err.message);
        return null;
    }
}

async function generateWorkViaCPU(hash, difficulty) {
    try {
        console.log(`🖥️ CPU PoW for ${hash.substring(0, 16)}... (may take 15-30s on weak CPU)`);
        const work = await nanocurrency.computeWork(hash, { workThreshold: difficulty });
        if (work && work !== '0000000000000000') {
            console.log(`✅ PoW via CPU: ${work}`);
            return work;
        }
        throw new Error('CPU work invalid');
    } catch (err) {
        console.error('CPU work generation failed:', err);
        return null;
    }
}

async function generateRealWork(blockHashHex, difficultyHex = 'ffffffc000000000') {
    const cacheKey = `${blockHashHex}|${difficultyHex}`;
    if (workCache.has(cacheKey)) {
        console.log(`♻️ Using cached PoW for ${blockHashHex.substring(0, 16)}...`);
        return workCache.get(cacheKey);
    }

    let work = await generateWorkViaRPC(NANSWAP_RPC_URL, blockHashHex, difficultyHex);
    if (work) {
        workCache.set(cacheKey, work);
        if (workCache.size > 100) {
            const firstKey = workCache.keys().next().value;
            workCache.delete(firstKey);
        }
        return work;
    }

    work = await generateWorkViaRPC(NANO_TO_RPC_URL, blockHashHex, difficultyHex);
    if (work) {
        workCache.set(cacheKey, work);
        if (workCache.size > 100) {
            const firstKey = workCache.keys().next().value;
            workCache.delete(firstKey);
        }
        return work;
    }

    work = await generateWorkViaCPU(blockHashHex, difficultyHex);
    if (work) {
        workCache.set(cacheKey, work);
        return work;
    }

    throw new Error('All PoW generation methods failed (Nanswap + Nano.to + CPU)');
}

// ========== NANO RPC CALL VỚI FALLBACK ==========
async function nanoRpcCall(action, params = {}) {
    if (!global._activeRpcEndpoint) {
        global._activeRpcEndpoint = NANSWAP_RPC_URL;
    }

    const tryEndpoints = [global._activeRpcEndpoint, NANSWAP_RPC_URL, NANO_TO_RPC_URL];
    const uniqueEndpoints = [...new Set(tryEndpoints)];
    let lastError = null;

    for (const rpcUrl of uniqueEndpoints) {
        try {
            const response = await axios.post(rpcUrl, { action, ...params }, {
                timeout: 15000,
                headers: { 'Content-Type': 'application/json' }
            });
            if (response.data && !response.data.error) {
                global._activeRpcEndpoint = rpcUrl;
                return response.data;
            }
            throw new Error(response.data?.error || 'Unknown error');
        } catch (err) {
            lastError = err;
            const source = rpcUrl.includes('nanswap') ? 'Nanswap' : 'Nano.to';
            console.warn(`RPC ${source} failed for action ${action}:`, err.message);
            continue;
        }
    }
    throw new Error(`All RPC endpoints failed for ${action}. Last error: ${lastError.message}`);
}

// ========== NANO BLOCK BUILDING & SENDING (DÙNG simple-nanowallet) ==========
async function sendXNO(wallet, toAddress, amountRaw) {
    try {
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

        let representative = accountInfo.representative;
        if (!representative || representative === '0000000000000000000000000000000000000000000000000000000000000000') {
            representative = wallet.public_key;
            console.log(`⚠️ No representative set, using self: ${representative.substring(0, 20)}...`);
        }

        const nanoWallet = new NanoWallet(wallet.seed);
        // Tạo block tạm để lấy hash
        const tempBlock = await nanoWallet.createSendBlock({
            index: wallet.index,
            toAddress: toAddress,
            amount: amountRawBigInt.toString(),
            representative: representative,
            work: null
        });
        const blockHash = tempBlock.hash;
        const work = await generateRealWork(blockHash);

        // Tạo block chính thức với work
        const finalBlock = await nanoWallet.createSendBlock({
            index: wallet.index,
            toAddress: toAddress,
            amount: amountRawBigInt.toString(),
            representative: representative,
            work: work
        });

        const result = await nanoRpcCall('process', {
            json_block: JSON.stringify(finalBlock),
            subtype: 'send'
        });

        console.log(`✅ Send successful: ${result.hash}`);
        return { success: true, hash: result.hash };
    } catch (err) {
        console.error('Send XNO error:', err);
        return { success: false, error: err.message };
    }
}

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
        const amountRawBigInt = BigInt(amountRaw);

        let representative = accountInfo.representative;
        if (!representative || representative === '0000000000000000000000000000000000000000000000000000000000000000') {
            representative = wallet.public_key;
        }

        const nanoWallet = new NanoWallet(wallet.seed);
        const tempBlock = await nanoWallet.createReceiveBlock({
            index: wallet.index,
            transactionHash: transactionHash,
            representative: representative,
            work: null
        });
        const blockHash = tempBlock.hash;
        const work = await generateRealWork(blockHash);

        const finalBlock = await nanoWallet.createReceiveBlock({
            index: wallet.index,
            transactionHash: transactionHash,
            representative: representative,
            work: work
        });

        const result = await nanoRpcCall('process', {
            json_block: JSON.stringify(finalBlock),
            subtype: 'receive'
        });

        console.log(`✅ Receive successful: ${result.hash}`);
        return { success: true, hash: result.hash };
    } catch (err) {
        console.error('Receive XNO error:', err);
        return { success: false, error: err.message };
    }
}

async function setRepresentative(wallet, representativeAddress) {
    try {
        const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
        if (!accountInfo || !accountInfo.frontier) {
            throw new Error('Account not initialized');
        }
        const previous = accountInfo.frontier;
        const balance = accountInfo.balance;
        const representativePubKey = addressToPublicKey(representativeAddress);

        const nanoWallet = new NanoWallet(wallet.seed);
        const tempBlock = await nanoWallet.createChangeBlock({
            index: wallet.index,
            representative: representativePubKey,
            work: null
        });
        const blockHash = tempBlock.hash;
        const work = await generateRealWork(blockHash);

        const finalBlock = await nanoWallet.createChangeBlock({
            index: wallet.index,
            representative: representativePubKey,
            work: work
        });

        const result = await nanoRpcCall('process', {
            json_block: JSON.stringify(finalBlock),
            subtype: 'change'
        });

        console.log(`✅ Representative changed: ${result.hash}`);
        return { success: true, hash: result.hash };
    } catch (err) {
        console.error('Set representative error:', err);
        return { success: false, error: err.message };
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
        
        const expectedXNO = swap.amount_cc / 500000;
        const expectedAmountRaw = BigInt(Math.floor(expectedXNO * 1e30));
        
        for (const [txHash, txInfo] of Object.entries(pending.blocks)) {
            const amountRaw = BigInt(txInfo.amount);
            const diff = amountRaw > expectedAmountRaw ? amountRaw - expectedAmountRaw : expectedAmountRaw - amountRaw;
            if (diff <= 1000) {
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
        const amountRawBigInt = BigInt(Math.round(swap.amount_cc * 2e24));
        const toAddress = swap.receiver;
        
        if (!isValidNanoAddress(toAddress)) {
            console.error(`Invalid XNO address for swap ${swap.id}: ${toAddress}`);
            return;
        }
        
        console.log(`💱 Processing CC->XNO: ${swap.amount_cc} CC = ${Number(amountRawBigInt) / 1e30} XNO (${amountRawBigInt} raw)`);
        
        const sendResult = await sendXNO(wallet, toAddress, amountRawBigInt.toString());
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
async function startApp() {
    try {
        const testHash = '0000000000000000000000000000000000000000000000000000000000000000';
        console.log('🔍 Testing PoW generation (Nanswap -> Nano.to -> CPU)...');
        const testWork = await generateRealWork(testHash);
        console.log(`✅ PoW test successful: ${testWork}`);
    } catch (err) {
        console.error('⚠️ PoW initialization warning:', err.message);
        console.error('   You may still use the dashboard, but sending transactions might fail.');
    }
    
    const admin = await getAdmin();
    if (admin.chocohub_token) {
        swapProcessorInterval = setInterval(processPendingSwaps, SWAP_CHECK_INTERVAL);
        console.log('🔄 Auto swap processor started');
    }
    
    app.listen(PORT, () => {
        console.log('');
        console.log('╔══════════════════════════════════════╗');
        console.log('║   NANO XNO DASHBOARD (SECURE)       ║');
        console.log('╠══════════════════════════════════════╣');
        console.log(`║  HTTP: http://localhost:${PORT}     ║');
        console.log('║  Default login: admin / admin       ║');
        console.log(`║  RPC Endpoints: Nanswap + Nano.to   ║');
        console.log('║  Auto Swap: Enabled (30s interval)  ║');
        console.log('║  PoW: Nanswap -> Nano.to -> CPU     ║');
        console.log('║  Wallet data: AES-256-GCM encrypted ║');
        console.log('║  Cookie Secure: ' + (process.env.NODE_ENV === 'production') + '        ║');
        console.log('╚══════════════════════════════════════╝');
        console.log('');
        console.log('💡 Nanswap API Key is loaded. Your node is ready.');
    });
}

startApp();
