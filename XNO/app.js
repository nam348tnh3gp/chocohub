const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const { Wallet } = require('simple-nano-wallet-js');
const { wallet: walletLib, block, tools } = require('multi-nano-web');
const nanoJson = require('nano-json'); // <--- thêm để tính hash block

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
const NANSWAP_WS_URL = `wss://nodes.nanswap.com/ws/?ticker=XNO&api_key=${NANSWAP_API_KEY}`;
const NANO_TO_RPC_URL = 'https://rpc.nano.to';

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

// ========== CHUYỂN ĐỔI XNO → RAW ==========
function xnoToRaw(amount) {
    const amountStr = typeof amount === 'string' ? amount : amount.toString();
    const parts = amountStr.split('.');
    let intPart = parts[0] || '0';
    let fracPart = parts[1] || '';
    fracPart = fracPart.padEnd(30, '0').slice(0, 30);
    let rawStr = intPart + fracPart;
    rawStr = rawStr.replace(/^0+/, '') || '0';
    return BigInt(rawStr);
}

// ========== NANO WALLET MANAGER (CACHED) ==========
let nanoWalletInstance = null;
let accountCache = {};
let currentSeed = null;

function resetWalletCache() {
    accountCache = {};
    nanoWalletInstance = null;
    currentSeed = null;
    console.log('🔄 Wallet cache cleared');
}

async function initNanoWallet(seed) {
    if (!seed) throw new Error('Seed is required to initialize wallet');
    if (nanoWalletInstance && currentSeed === seed) {
        return nanoWalletInstance;
    }
    const headerAuth = {
        "nodes-api-key": process.env.NANSWAP_API_KEY
    };
    nanoWalletInstance = new Wallet({
        RPC_URL: NANSWAP_RPC_URL,
        WORK_URL: NANSWAP_RPC_URL,
        WS_URL: NANSWAP_WS_URL,
        seed: seed,
        defaultRep: "nano_1banexkcfuieufzxksfrxqf6xy8e57ry1zdtq9yn7jntzhpwu4pg4hajojmq",
        customHeaders: headerAuth,
        wsSubAll: false,
        prefix: "nano_",
        decimal: 30,
        autoReceive: false
    });
    currentSeed = seed;
    accountCache = {};
    const accounts = nanoWalletInstance.createAccounts(100);
    accounts.forEach((addr, idx) => {
        accountCache[addr] = { index: idx };
    });
    console.log(`✅ Nano wallet initialized with ${accounts.length} accounts`);
    return nanoWalletInstance;
}

async function getNanoWallet(seed) {
    if (!nanoWalletInstance || currentSeed !== seed) {
        await initNanoWallet(seed);
    }
    return nanoWalletInstance;
}

// ========== RPC CALLS - RETRY + TIMEOUT ==========
async function nanoRpcCallForTx(action, params = {}, retries = 3) {
    const tryEndpoints = [NANSWAP_RPC_URL, NANO_TO_RPC_URL];
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        for (const rpcUrl of tryEndpoints) {
            try {
                const response = await axios.post(rpcUrl, { action, ...params }, {
                    timeout: 15000,
                    headers: {
                        'Content-Type': 'application/json',
                        ...(rpcUrl.includes('nanswap') ? { 'nodes-api-key': process.env.NANSWAP_API_KEY } : {})
                    }
                });
                if (response.data && !response.data.error) {
                    return response.data;
                }
                throw new Error(response.data?.error || 'Unknown error');
            } catch (err) {
                lastError = err;
                const status = err.response?.status;
                console.warn(`RPC ${rpcUrl} failed for action ${action} (attempt ${attempt+1}):`, err.message);
                if (status === 429) {
                    const delay = 5000 * (attempt + 1);
                    console.log(`⏳ Rate limited, waiting ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
                continue;
            }
        }
        if (attempt < retries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }
    throw new Error(`All RPC endpoints failed for ${action}. Last error: ${lastError.message}`);
}

// ========== GENERATE WORK ==========
async function generateWork(hash) {
    try {
        const response = await axios.post(NANSWAP_RPC_URL, {
            action: 'work_generate',
            hash: hash
        }, {
            headers: {
                'Content-Type': 'application/json',
                'nodes-api-key': process.env.NANSWAP_API_KEY
            },
            timeout: 15000
        });
        if (response.data && !response.data.error) {
            return response.data.work;
        }
        throw new Error(response.data?.error || 'Unknown error');
    } catch (err) {
        console.error('Generate work error:', err.message);
        throw err;
    }
}

// ========== GET BALANCE (NANO.TO) ==========
async function getBalanceFromNanoTo(address) {
    try {
        const balanceResponse = await axios.post(NANO_TO_RPC_URL, {
            action: 'account_balance',
            account: address
        }, { timeout: 10000 });

        if (balanceResponse.data && balanceResponse.data.error) {
            throw new Error(balanceResponse.data.error);
        }

        const pendingResponse = await axios.post(NANO_TO_RPC_URL, {
            action: 'pending',
            account: address,
            count: 1
        }, { timeout: 10000 });

        let pending = '0';
        if (pendingResponse.data && pendingResponse.data.blocks) {
            const blockHash = Object.keys(pendingResponse.data.blocks)[0];
            if (blockHash) {
                pending = pendingResponse.data.blocks[blockHash].amount;
            }
        }

        return {
            success: true,
            balance: parseFloat(balanceResponse.data.balance) / 1e30,
            pending: parseFloat(pending) / 1e30,
            balanceRaw: balanceResponse.data.balance,
            pendingRaw: pending,
            address: address
        };
    } catch (err) {
        console.error('Get balance from Nano.to error:', err.message);
        return { success: false, error: err.message };
    }
}

// ========== GET HISTORY (NANO.TO) ==========
async function getHistoryFromNanoTo(address, count = 50) {
    try {
        const response = await axios.post(NANO_TO_RPC_URL, {
            action: 'account_history',
            account: address,
            count: count
        }, { timeout: 10000 });

        if (response.data && response.data.error) {
            throw new Error(response.data.error);
        }

        const history = response.data.history || [];
        const transactions = history.map(tx => ({
            hash: tx.hash,
            type: tx.type === 'send' ? 'send' : 'receive',
            amount: parseFloat(tx.amount) / 1e30,
            account: tx.account || '',
            memo: tx.memo || '',
            timestamp: tx.local_timestamp || 0,
            date: tx.local_timestamp ? new Date(tx.local_timestamp * 1000).toISOString() : null,
            balance: tx.balance ? parseFloat(tx.balance) / 1e30 : null
        }));

        return { success: true, transactions };
    } catch (err) {
        console.error('Get history from Nano.to error:', err.message);
        return { success: false, error: err.message };
    }
}

// ========== GET ACCOUNT INFO (NANO.TO) ==========
async function getAccountInfoFromNanoTo(address) {
    try {
        const response = await axios.post(NANO_TO_RPC_URL, {
            action: 'account_info',
            account: address
        }, { timeout: 10000 });
        if (response.data && response.data.error) {
            throw new Error(response.data.error);
        }
        return response.data;
    } catch (err) {
        console.error('Get account info from Nano.to error:', err.message);
        throw err;
    }
}

// ========== CORE NANO FUNCTIONS ==========

async function getBalance(walletData) {
    return await getBalanceFromNanoTo(walletData.address);
}

async function getHistory(walletData, count = 50) {
    return await getHistoryFromNanoTo(walletData.address, count);
}

async function sendXNO(walletData, toAddress, amountRaw) {
    try {
        const sourceAddress = walletData.address;
        await getNanoWallet(walletData.seed);
        // ensureAccount được dùng để đảm bảo account có trong cache (không thực sự cần thiết vì simple-wallet tự quản lý)
        // nhưng ta vẫn gọi để đảm bảo
        if (!accountCache[sourceAddress]) {
            // Nếu chưa có, tìm index của address trong wallet
            const accounts = nanoWalletInstance.createAccounts(100);
            const idx = accounts.indexOf(sourceAddress);
            if (idx === -1) throw new Error('Source address not found in wallet');
            accountCache[sourceAddress] = { index: idx };
        }

        const balanceResult = await getBalanceFromNanoTo(sourceAddress);
        if (!balanceResult.success) {
            throw new Error('Cannot fetch balance: ' + balanceResult.error);
        }
        const balanceRaw = BigInt(balanceResult.balanceRaw);
        if (balanceRaw < amountRaw) {
            throw new Error(`Insufficient balance: ${balanceRaw} < ${amountRaw}`);
        }

        const wallet = await getNanoWallet(walletData.seed);
        console.log(`📤 Sending ${amountRaw.toString()} raw from ${sourceAddress} to ${toAddress}`);
        
        const sendResult = await wallet.send({
            source: sourceAddress,
            destination: toAddress,
            amount: amountRaw.toString()
        });

        let hash = null;
        if (sendResult && typeof sendResult === 'object') {
            hash = sendResult.hash || sendResult.block || sendResult;
            if (typeof hash === 'object') {
                if (sendResult.block && sendResult.block.hash) {
                    hash = sendResult.block.hash;
                } else {
                    console.warn('⚠️ Unexpected send result format:', JSON.stringify(sendResult));
                    hash = sendResult.toString();
                }
            }
        } else {
            hash = sendResult;
        }

        console.log(`✅ Send successful: ${hash}`);
        return { success: true, hash };
    } catch (err) {
        console.error('Send XNO error:', err);
        return { success: false, error: err.message };
    }
}

async function receiveXNO(walletData, transactionHash) {
    try {
        const sourceAddress = walletData.address;
        await getNanoWallet(walletData.seed);
        if (!accountCache[sourceAddress]) {
            const accounts = nanoWalletInstance.createAccounts(100);
            const idx = accounts.indexOf(sourceAddress);
            if (idx === -1) throw new Error('Source address not found in wallet');
            accountCache[sourceAddress] = { index: idx };
        }

        const wallet = await getNanoWallet(walletData.seed);
        // Kiểm tra pending
        const pendingResult = await nanoRpcCallForTx('pending', { account: sourceAddress, source: true });
        if (!pendingResult.blocks || !pendingResult.blocks[transactionHash]) {
            throw new Error(`No pending block found for hash ${transactionHash}`);
        }

        console.log(`📥 Receiving ${pendingResult.blocks[transactionHash].amount} raw`);
        const receiveResult = await wallet.receive({
            account: sourceAddress,
            hash: transactionHash
        });
        let hash = receiveResult.hash || receiveResult.block || receiveResult;
        console.log(`✅ Receive successful: ${hash}`);
        return { success: true, hash };
    } catch (err) {
        console.error('Receive XNO error:', err);
        return { success: false, error: err.message };
    }
}

async function receiveAllXNO(walletData) {
    try {
        const sourceAddress = walletData.address;
        await getNanoWallet(walletData.seed);
        if (!accountCache[sourceAddress]) {
            const accounts = nanoWalletInstance.createAccounts(100);
            const idx = accounts.indexOf(sourceAddress);
            if (idx === -1) throw new Error('Source address not found in wallet');
            accountCache[sourceAddress] = { index: idx };
        }

        const wallet = await getNanoWallet(walletData.seed);
        const pendingResult = await nanoRpcCallForTx('pending', { account: sourceAddress, source: true });
        if (!pendingResult.blocks) {
            return { success: true, hashes: [] };
        }
        const hashes = Object.keys(pendingResult.blocks);
        const received = [];
        for (const hash of hashes) {
            const result = await wallet.receive({ account: sourceAddress, hash });
            received.push(result);
        }
        console.log(`✅ Received ${received.length} pending blocks`);
        return { success: true, hashes: received };
    } catch (err) {
        console.error('Receive all XNO error:', err);
        return { success: false, error: err.message };
    }
}

// ==================== SET REPRESENTATIVE (FIXED) ====================
async function setRepresentative(walletData, representativeAddress) {
    try {
        const sourceAddress = walletData.address;
        const privateKey = walletData.private_key;
        if (!privateKey) {
            throw new Error('Private key not found for wallet');
        }

        // 1. Lấy account info (frontier, balance)
        const accountInfo = await getAccountInfoFromNanoTo(sourceAddress);
        if (!accountInfo || accountInfo.error) {
            throw new Error('Cannot fetch account info: ' + (accountInfo?.error || 'unknown error'));
        }

        // 2. Tạo block change với work = null (chưa có work)
        const changeData = {
            walletBalanceRaw: accountInfo.balance,
            address: sourceAddress,
            representativeAddress: representativeAddress,
            frontier: accountInfo.frontier,
            work: null
        };

        // 3. Ký block (trả về object hoặc JSON string)
        let signedBlock = block.representative(changeData, privateKey);
        let blockObj = typeof signedBlock === 'string' ? JSON.parse(signedBlock) : signedBlock;

        // 4. Xoá work nếu có (đảm bảo không có work để tính hash)
        delete blockObj.work;

        // 5. Dùng nano-json để tính hash chính xác
        const nanoBlock = nanoJson.Block.fromObject(blockObj);
        const blockHash = nanoBlock.hash();
        console.log(`🔑 Block hash (không work): ${blockHash}`);

        // 6. Generate work từ Nanswap
        console.log(`⏳ Generating work for hash ${blockHash}...`);
        const work = await generateWork(blockHash);
        console.log(`✅ Work generated: ${work}`);

        // 7. Gán work vào block
        blockObj.work = work;

        // 8. Gửi block qua RPC process
        const blockJson = JSON.stringify(blockObj);
        const result = await nanoRpcCallForTx('process', {
            block: blockJson,
            json_block: 'true'
        });

        if (result && result.hash) {
            console.log(`✅ Representative changed: ${result.hash}`);
            return { success: true, hash: result.hash };
        } else {
            throw new Error('Failed to process change block: ' + JSON.stringify(result));
        }
    } catch (err) {
        console.error('Set representative error:', err);
        return { success: false, error: err.message };
    }
}
// ========================================================================

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
        if (!activeWallet) {
            console.log('⚠️ No active wallet found');
            return;
        }

        if (!nanoWalletInstance || currentSeed !== activeWallet.seed) {
            await initNanoWallet(activeWallet.seed);
            console.log('✅ Wallet initialized for auto swap');
        }

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
        const pending = await nanoRpcCallForTx('pending', { account: wallet.address, source: true });
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

        const sendResult = await sendXNO(wallet, toAddress, amountRawBigInt);
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
        const newWallet = walletLib.generateLegacy();
        const seedHex = newWallet.seed;
        const accounts = walletLib.legacyAccounts(seedHex, 0, 1);
        const account = accounts[0];
        const wallet = {
            id: Date.now().toString(),
            name: name || `Wallet ${new Date().toLocaleString()}`,
            address: account.address,
            public_key: account.publicKey,
            private_key: account.privateKey,
            seed: seedHex,
            index: 0,
            created_at: new Date().toISOString(),
            representative: null
        };
        const data = await getWallets();
        data.wallets.push(wallet);
        if (!data.active_wallet) data.active_wallet = wallet.id;
        await updateWallets(data);
        resetWalletCache();
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
        const walletIndex = parseInt(index) || 0;
        const accounts = walletLib.legacyAccounts(seedHex, walletIndex, walletIndex + 1);
        const account = accounts[0];

        let representative = null;
        try {
            const accountInfo = await getAccountInfoFromNanoTo(account.address);
            if (accountInfo && accountInfo.representative) {
                representative = accountInfo.representative;
            }
        } catch (e) {}

        const wallet = {
            id: Date.now().toString(),
            name: name || `Imported ${new Date().toLocaleString()}`,
            address: account.address,
            public_key: account.publicKey,
            private_key: account.privateKey,
            seed: seedHex,
            index: walletIndex,
            created_at: new Date().toISOString(),
            representative: representative
        };
        const data = await getWallets();
        if (data.wallets.find(w => w.address === account.address)) {
            return res.json({ success: false, error: 'Wallet already exists' });
        }
        data.wallets.push(wallet);
        if (!data.active_wallet) data.active_wallet = wallet.id;
        await updateWallets(data);
        resetWalletCache();
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
        const accounts = walletLib.legacyAccounts(seed, 0, 1);
        const account = accounts[0];
        let representative = null;
        try {
            const accountInfo = await getAccountInfoFromNanoTo(account.address);
            if (accountInfo && accountInfo.representative) {
                representative = accountInfo.representative;
            }
        } catch (e) {}
        const wallet = {
            id: Date.now().toString(),
            name: `File Import ${new Date().toLocaleString()}`,
            address: account.address,
            public_key: account.publicKey,
            private_key: account.privateKey,
            seed,
            index: 0,
            created_at: new Date().toISOString(),
            representative: representative
        };
        const data = await getWallets();
        data.wallets.push(wallet);
        if (!data.active_wallet) data.active_wallet = wallet.id;
        await updateWallets(data);
        resetWalletCache();
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
    resetWalletCache();
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
    resetWalletCache();
    res.json({ success: true });
});

// ========== BALANCE ==========
app.get('/api/wallet/:id/balance', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    try {
        const result = await getBalance(wallet);
        if (result.success) {
            const representative = wallet.representative || null;
            res.json({
                success: true,
                balance: result.balance,
                pending: result.pending,
                address: wallet.address,
                representative
            });
        } else {
            res.json({ success: false, error: result.error });
        }
    } catch (err) {
        res.json({ success: false, error: 'Cannot fetch balance' });
    }
});

// ========== SET REPRESENTATIVE ROUTE ==========
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

// ========== REPRESENTATIVE INFO ==========
app.get('/api/wallet/:id/representative', requireAuth, async (req, res) => {
    const data = await getWallets();
    const wallet = data.wallets.find(w => w.id === req.params.id);
    if (!wallet) return res.json({ success: false, error: 'Wallet not found' });
    try {
        const accountInfo = await getAccountInfoFromNanoTo(wallet.address);
        const representative = accountInfo.representative || null;
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
        const result = await getHistory(wallet, 50);
        if (result.success) {
            res.json({ success: true, transactions: result.transactions });
        } else {
            res.json({ success: false, error: result.error });
        }
    } catch (err) {
        res.json({ success: false, error: 'Cannot fetch history' });
    }
});

// ========== SEND XNO ==========
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
        const amountRaw = xnoToRaw(amount);
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

// ========== START APP ==========
async function startApp() {
    try {
        console.log('🔍 Testing Nanswap connection...');
        const testResult = await nanoRpcCallForTx('version');
        console.log(`✅ Nanswap connection successful: ${testResult.node_vendor || 'OK'}`);
    } catch (err) {
        console.error('⚠️ Nanswap connection warning:', err.message);
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
        console.log(`║  HTTP: http://localhost:${PORT}     ║`);
        console.log('║  Default login: admin / admin       ║');
        console.log(`║  RPC: Nano.to for balance/history   ║`);
        console.log(`║  TX RPC: Nanswap + Nano.to fallback ║`);
        console.log('║  Auto Swap: Enabled (30s interval)  ║');
        console.log('║  Wallet: simple-nano-wallet-js      ║');
        console.log('║  Wallet data: AES-256-GCM encrypted ║');
        console.log('║  Cookie Secure: ' + (process.env.NODE_ENV === 'production') + '        ║');
        console.log('╚══════════════════════════════════════╝');
        console.log('');
        console.log('💡 Nanswap API Key is loaded. Your node is ready.');
    });
}

startApp();
