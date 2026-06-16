const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const nanocurrency = require('nanocurrency');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// ========== HTTPS REDIRECT (production only) ==========
if (IS_PROD) {
    app.set('trust proxy', 1);
    app.use((req, res, next) => {
        if (req.headers['x-forwarded-proto'] !== 'https') {
            return res.redirect(`https://${req.headers.host}${req.url}`);
        }
        next();
    });
}

// Nano RPC URLs (cho cả PoW và các gọi RPC thông thường)
const NANO_RPC_URLS = [
    'https://rpc.nano.to',
    'https://nanorpc.nano.com.co',
    'https://node.nanode.co',
    'https://rpc.nano.community',
    'https://proxy.powerful.nano.community'
];
let currentRpcIndex = 0; // sẽ được thay đổi khi có RPC hoạt động

// Swap check interval (ms)
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

// Session secret bắt buộc từ env
if (!process.env.SESSION_SECRET) {
    console.error('FATAL: SESSION_SECRET environment variable is not set. Exiting.');
    process.exit(1);
}
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: IS_PROD,          // chỉ gửi qua HTTPS ở production
        httpOnly: true,
        maxAge: 86400000,
        sameSite: 'lax'
    }
}));

const upload = multer({ dest: path.join(DATA_DIR, 'uploads') });

// ========== MÃ HÓA / GIẢI MÃ ==========
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
    return nanocurrency.addressToPublicKey(address);
}

function publicKeyToAddress(publicKeyHex) {
    return nanocurrency.publicKeyToAddress(publicKeyHex);
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

// ========== ENHANCED PROOF OF WORK WITH MULTI-RPC FALLBACK ==========
// Cache RPC hoạt động tốt
let workingRpcUrl = null;
let lastRpcTestTime = 0;
const RPC_TEST_INTERVAL = 10 * 60 * 1000; // 10 phút

async function testRpcEndpoint(url) {
    try {
        const start = Date.now();
        const response = await axios.post(url, {
            action: 'work_generate',
            hash: '0000000000000000000000000000000000000000000000000000000000000000',
            difficulty: 'ffffffc000000000'
        }, { timeout: 5000 });
        if (response.data && response.data.work) {
            const latency = Date.now() - start;
            console.log(`✅ RPC ${url} works (latency ${latency}ms)`);
            return true;
        }
        return false;
    } catch (err) {
        console.warn(`RPC ${url} failed: ${err.message}`);
        return false;
    }
}

async function getWorkingRpcUrl() {
    const now = Date.now();
    if (workingRpcUrl && (now - lastRpcTestTime) < RPC_TEST_INTERVAL) {
        return workingRpcUrl;
    }
    // shuffle RPC list để tránh luôn dùng endpoint đầu
    const shuffled = [...NANO_RPC_URLS];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    for (const url of shuffled) {
        if (await testRpcEndpoint(url)) {
            workingRpcUrl = url;
            lastRpcTestTime = now;
            return url;
        }
    }
    workingRpcUrl = null;
    return null;
}

async function generateWorkViaRPC(hash, difficulty = 'ffffffc000000000') {
    const rpcUrl = await getWorkingRpcUrl();
    if (!rpcUrl) throw new Error('No working RPC endpoint for PoW');
    try {
        const response = await axios.post(rpcUrl, {
            action: 'work_generate',
            hash: hash,
            difficulty: difficulty
        }, { timeout: 10000 });
        if (response.data && response.data.work) {
            console.log(`✅ PoW via RPC (${rpcUrl}): ${response.data.work}`);
            return response.data.work;
        }
        throw new Error('No work returned from RPC');
    } catch (err) {
        console.warn(`RPC PoW failed on ${rpcUrl}: ${err.message}`);
        // Đánh dấu endpoint này có thể lỗi, buộc refresh working cache
        workingRpcUrl = null;
        throw err;
    }
}

async function generateWorkViaCPU(hash, difficulty = 'ffffffc000000000') {
    console.log(`🖥️ CPU PoW for ${hash.substring(0, 16)}... (may take 10-20s)`);
    const work = await nanocurrency.computeWork(hash, { workThreshold: difficulty });
    if (work && work !== '0000000000000000') {
        console.log(`✅ PoW via CPU: ${work}`);
        return work;
    }
    throw new Error('CPU work generation returned invalid result');
}

async function generateRealWork(blockHashHex, difficultyHex = 'ffffffc000000000') {
    // Try all RPC endpoints (via the rotating mechanism) up to 2 times
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await generateWorkViaRPC(blockHashHex, difficultyHex);
        } catch (err) {
            console.warn(`RPC PoW attempt ${attempt + 1} failed: ${err.message}`);
            if (attempt === 1) break;
            // wait a bit before next attempt
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    // Fallback to CPU
    console.log('⚠️ All RPC PoW failed, falling back to CPU...');
    return await generateWorkViaCPU(blockHashHex, difficultyHex);
}

// ========== NANO TRANSACTION QUEUE ==========
const walletQueues = new Map();

function getWalletQueue(walletId) {
    if (!walletQueues.has(walletId)) {
        walletQueues.set(walletId, { currentPromise: Promise.resolve() });
    }
    return walletQueues.get(walletId);
}

async function enqueueTransaction(walletId, transactionFunc) {
    const queue = getWalletQueue(walletId);
    await queue.currentPromise;
    const taskPromise = (async () => {
        try {
            return await transactionFunc();
        } catch (err) {
            throw err;
        }
    })();
    queue.currentPromise = taskPromise;
    return taskPromise;
}

// ========== NANO BLOCK BUILDING & SENDING ==========
async function buildSendBlock(wallet, toAddress, amountRawBigInt, previous, representativePubKey, currentBalanceRaw) {
    const newBalanceBigInt = BigInt(currentBalanceRaw) - amountRawBigInt;
    const linkPublicKey = addressToPublicKey(toAddress);
    
    const blockPayload = {
        account: wallet.address,
        previous: previous,
        representative: representativePubKey,
        balance: newBalanceBigInt.toString(),
        link: linkPublicKey
    };
    
    const signedBlock = nanocurrency.block.sign(blockPayload, wallet.private_key);
    if (!signedBlock) throw new Error('Failed to sign block');
    
    const blockHash = nanocurrency.block.hash(blockPayload);
    const work = await generateRealWork(blockHash);
    signedBlock.work = work;
    
    const finalBlock = { ...signedBlock, work };
    const result = await nanoRpcCall('process', { block: JSON.stringify(finalBlock) });
    return { success: true, hash: result.hash };
}

async function buildReceiveBlock(wallet, transactionHash, previous, representativePubKey, currentBalanceRaw, amountRawBigInt) {
    const newBalanceBigInt = BigInt(currentBalanceRaw) + amountRawBigInt;
    const blockPayload = {
        account: wallet.address,
        previous: previous,
        representative: representativePubKey,
        balance: newBalanceBigInt.toString(),
        link: transactionHash
    };
    const signedBlock = nanocurrency.block.sign(blockPayload, wallet.private_key);
    const blockHash = nanocurrency.block.hash(blockPayload);
    const work = await generateRealWork(blockHash);
    signedBlock.work = work;
    const finalBlock = { ...signedBlock, work };
    const result = await nanoRpcCall('process', { block: JSON.stringify(finalBlock) });
    return { success: true, hash: result.hash };
}

async function sendXNO(wallet, toAddress, amountRaw) {
    return enqueueTransaction(wallet.id, async () => {
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
                console.log(`⚠️ No representative set, using self`);
            }
            
            console.log(`📤 Sending ${amountRaw} raw from ${wallet.address.substring(0,20)}... to ${toAddress.substring(0,20)}...`);
            const result = await buildSendBlock(wallet, toAddress, amountRawBigInt, previous, representative, currentBalanceRaw);
            console.log(`✅ Send successful: ${result.hash}`);
            return { success: true, hash: result.hash };
        } catch (err) {
            console.error('Send XNO error:', err);
            return { success: false, error: err.message };
        }
    });
}

async function receiveXNO(wallet, transactionHash) {
    return enqueueTransaction(wallet.id, async () => {
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
            
            const result = await buildReceiveBlock(wallet, transactionHash, previous, representative, currentBalanceRaw, amountRawBigInt);
            console.log(`✅ Receive successful: ${result.hash}`);
            return { success: true, hash: result.hash };
        } catch (err) {
            console.error('Receive XNO error:', err);
            return { success: false, error: err.message };
        }
    });
}

async function setRepresentative(wallet, representativeAddress) {
    return enqueueTransaction(wallet.id, async () => {
        try {
            const accountInfo = await nanoRpcCall('account_info', { account: wallet.address });
            if (!accountInfo || !accountInfo.frontier) {
                throw new Error('Account not initialized');
            }
            const previous = accountInfo.frontier;
            const balance = accountInfo.balance;
            const representativePubKey = addressToPublicKey(representativeAddress);
            const linkZeros = '0000000000000000000000000000000000000000000000000000000000000000';
            
            const blockPayload = {
                account: wallet.address,
                previous: previous,
                representative: representativePubKey,
                balance: balance,
                link: linkZeros
            };
            const signedBlock = nanocurrency.block.sign(blockPayload, wallet.private_key);
            const blockHash = nanocurrency.block.hash(blockPayload);
            const work = await generateRealWork(blockHash);
            signedBlock.work = work;
            const finalBlock = { ...signedBlock, work };
            const result = await nanoRpcCall('process', { block: JSON.stringify(finalBlock) });
            console.log(`✅ Representative changed: ${result.hash}`);
            return { success: true, hash: result.hash };
        } catch (err) {
            console.error('Set representative error:', err);
            return { success: false, error: err.message };
        }
    });
}

// Nano RPC wrapper (cho các action khác như account_info, pending, process...)
// Dùng round-robin qua các RPC endpoints để tăng độ tin cậy
let rpcRoundRobinIndex = 0;
async function nanoRpcCall(action, params = {}) {
    const startIdx = rpcRoundRobinIndex;
    for (let i = 0; i < NANO_RPC_URLS.length; i++) {
        const idx = (startIdx + i) % NANO_RPC_URLS.length;
        const url = NANO_RPC_URLS[idx];
        try {
            const response = await axios.post(url, { action, ...params }, { 
                timeout: 15000,
                headers: { 'Content-Type': 'application/json' }
            });
            if (response.data && !response.data.error) {
                rpcRoundRobinIndex = (idx + 1) % NANO_RPC_URLS.length;
                return response.data;
            }
            throw new Error(response.data?.error || 'Unknown error');
        } catch (err) {
            console.warn(`RPC call ${action} to ${url} failed: ${err.message}`);
            if (i === NANO_RPC_URLS.length - 1) throw err;
        }
    }
    throw new Error('All RPC endpoints failed');
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

// ========== ROUTES (giữ nguyên như code gốc, không thay đổi) ==========
// ... (toàn bộ routes từ app.get('/login') đến app.get('/logout') giữ nguyên)
// Để tránh dài quá, tôi sẽ chỉ giữ lại phần routes cần thiết, bạn có thể copy từ code đã cho

// (Tôi sẽ viết lại tóm gọn các routes, nhưng thực tế bạn dùng code cũ)
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
    res.json({ username: admin.username, chocohub_username: admin.chocohub_username, firstLogin: admin.first_login });
});

// Các route còn lại (wallet management, send, history, v.v...) giữ nguyên từ code gốc
// (Do giới hạn độ dài, tôi không paste lại toàn bộ, nhưng bạn có thể lấy từ code bạn đã cung cấp)

// Khởi tạo và start
async function startApp() {
    // Kiểm tra PoW lúc khởi động (thử tìm RPC hoạt động)
    try {
        console.log('🔍 Testing PoW via RPC...');
        const testHash = '0000000000000000000000000000000000000000000000000000000000000000';
        const work = await generateWorkViaRPC(testHash);
        console.log(`✅ PoW test successful: ${work}`);
    } catch (err) {
        console.error('⚠️ All RPC PoW failed, will use CPU fallback:', err.message);
    }
    
    const admin = await getAdmin();
    if (admin.chocohub_token) {
        swapProcessorInterval = setInterval(processPendingSwaps, SWAP_CHECK_INTERVAL);
        console.log('🔄 Auto swap processor started');
    }
    
    app.listen(PORT, () => {
        console.log('');
        console.log('╔══════════════════════════════════════╗');
        console.log('║   NANO XNO DASHBOARD (SECURE + PoW) ║');
        console.log('╠══════════════════════════════════════╣');
        console.log(`║  HTTP: http://localhost:${PORT}     ║`);
        console.log(`║  HTTPS: ${IS_PROD ? 'ENABLED' : 'DISABLED (set NODE_ENV=production)'}`);
        console.log('║  Default login: admin / admin       ║');
        console.log(`║  PoW: Multi-RPC (${NANO_RPC_URLS.length} endpoints) + CPU fallback`);
        console.log('║  Wallet data: AES-256-GCM encrypted ║');
        console.log('║  Transaction queue: per wallet      ║');
        console.log('╚══════════════════════════════════════╝');
        console.log('');
    });
}

startApp();
