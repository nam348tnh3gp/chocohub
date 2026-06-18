// separate module from server, so editing will be easier :3
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const http = require('http');
const https = require('https');
const db = require('../db');

const router = express.Router();

// ========== CONFIGURAÇÃO DO DUCO ==========
const DUCO_CONFIG = {
    API_URL: 'https://server.duinocoin.com',
    USERNAME: process.env.DUCO_USERNAME || '',
    PASSWORD: process.env.DUCO_PASSWORD || '',
    CC_TO_DUCO_RATE: 0.1,  // 1 CC = 0.1 DUCO
    DUCO_TO_CC_RATE: 10,   // 1 DUCO = 10 CC
};

// ========== CONFIGURAÇÃO DO XNO ==========
const XNO_CONFIG = {
    CC_TO_XNO_RATE: 0.000002,    // 1 CC = 0.000002 XNO
    XNO_TO_CC_RATE: 500000,      // 1 XNO = 500,000 CC
    XNO_RECEIVE_ADDRESS: "nano_3k41y61xxgmre13exyk3q69k78bxxwhmrmncezt49jg1sok18xo64jeff5hk",
};

// ========== LOGGING SIMPLES (arquivo + console) ==========
const LOG_FILE = path.join(__dirname, 'swap_api.log');
function log(message) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${message}`;
    console.log(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
}

function logError(message) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ERROR: ${message}`;
    console.error(line);
    fs.appendFileSync(LOG_FILE, line + '\n');
}

// ========== AVISOS DE INICIALIZAÇÃO ==========
if (!DUCO_CONFIG.USERNAME || !DUCO_CONFIG.PASSWORD) {
    logError('DUCO_USERNAME ou DUCO_PASSWORD não definidos. Transferências automáticas DUCO falharão.');
} else {
    log(`DUCO_CONFIG carregado para usuário: ${DUCO_CONFIG.USERNAME}`);
}

// ========== AJUDANTES DA API DUCO ==========
function ducoApiRequest(endpoint, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(DUCO_CONFIG.API_URL + endpoint);
        const isHttps = url.protocol === 'https:';
        const client = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            path: url.pathname + url.search,
            method: method,
            timeout: 15000,
            headers: { 'User-Agent': 'ChocoHub-Swap/1.0' }
        };

        const req = client.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ status: res.statusCode, data: parsed });
                } catch (e) {
                    reject(new Error(`JSON inválido da API: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout na API DUCO (15s)'));
        });

        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function getDucoBalance(username) {
    try {
        log(`Consultando saldo DUCO de: ${username}`);
        const res = await ducoApiRequest(`/balances/${username}`);
        log(`   Status: ${res.status}, Sucesso: ${res.data.success}`);
        if (res.status === 200 && res.data.success) {
            const balance = res.data.result.balance;
            log(`   Saldo: ${balance} DUCO`);
            return balance;
        }
        logError(`   Falha na consulta de saldo: ${JSON.stringify(res.data)}`);
        return null;
    } catch (e) {
        logError(`   Erro ao consultar saldo DUCO: ${e.message}`);
        return null;
    }
}

async function transferDuco(from, password, to, amount, memo = 'ChocoHub swap') {
    try {
        log(`💸 Transferência DUCO: ${from} → ${to}, valor: ${amount}, memo: ${memo}`);
        log(`   Remetente: ${from}, Senha: ${password ? '***' : 'FALTANDO'}`);
        
        const endpoint = `/transaction?username=${encodeURIComponent(from)}&password=${encodeURIComponent(password)}&recipient=${encodeURIComponent(to)}&amount=${amount}&memo=${encodeURIComponent(memo)}`;
        log(`   Endpoint: ${endpoint.substring(0, 80)}...`);
        
        const res = await ducoApiRequest(endpoint, 'GET');
        log(`   Status: ${res.status}, Sucesso: ${res.data.success}`);
        log(`   Resposta: ${JSON.stringify(res.data).substring(0, 300)}`);
        
        if (res.status === 200 && res.data.success) {
            log(`   ✅ Transferência bem-sucedida: ${res.data.result}`);
            return res.data.result;
        }
        logError(`   ❌ Falha na transferência: ${JSON.stringify(res.data)}`);
        return null;
    } catch (e) {
        logError(`   ❌ Erro na transferência DUCO: ${e.message}`);
        return null;
    }
}

// Autenticação
const ADMIN_USERS = ['chocoetom', 'Nam2010'];

function isAdmin(username) {
    return ADMIN_USERS.includes(username);
}

function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ status: 'error', message: 'Token ausente ou inválido' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ status: 'error', message: 'Token inválido ou expirado' });
    }
}

function verifyAdmin(req, res, next) {
    if (!req.user) {
        return res.status(401).json({ status: 'error', message: 'Não autenticado' });
    }
    if (!isAdmin(req.user.username)) {
        return res.status(403).json({ status: 'error', message: 'Apenas administradores' });
    }
    next();
}

// Rate Limiter
const swapLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { status: 'error', message: 'Muitas requisições, aguarde.' },
    standardHeaders: true,
    legacyHeaders: false,
});

// Persistência dos pedidos de swap
let swapRequests = [];
const SWAP_FILE = path.join(__dirname, 'swap_requests.json');

function loadSwapRequests() {
    try {
        if (fs.existsSync(SWAP_FILE)) {
            const data = JSON.parse(fs.readFileSync(SWAP_FILE, 'utf8'));
            if (Array.isArray(data)) swapRequests = data;
            log(`📦 Carregados ${swapRequests.length} pedidos de swap`);
        }
    } catch (e) {
        logError(`Não foi possível carregar pedidos: ${e.message}`);
    }
}

function saveSwapRequests() {
    try {
        fs.writeFileSync(SWAP_FILE, JSON.stringify(swapRequests, null, 2));
    } catch (e) {
        logError(`Falha ao salvar pedidos: ${e.message}`);
    }
}

loadSwapRequests();

// ────────────────────────── CONTA HOLDING ──────────────────────────
function ensureHoldingAccount() {
    const holding = db.getUser('swap_holding');
    if (!holding) {
        const randomPin = crypto.randomBytes(16).toString('hex');
        db.authenticate('swap_holding', randomPin);
        log('🏦 Conta swap_holding criada com pin aleatório');
    }
}
ensureHoldingAccount();

// Auxiliar: reembolsar CC da holding para o usuário (quando swap pendente é cancelado)
function refundUser(request) {
    if (request.status === 'pending') {
        const amount = request.amount_cc;
        db.updateBalance('swap_holding', -amount);
        db.updateBalance(request.from_user, amount);
        if (db.addTransaction.length >= 4) {
            db.addTransaction('swap_holding', request.from_user, amount, `Reembolso swap cancelado ${request.id}`);
        } else {
            db.addTransaction('swap_holding', request.from_user, amount);
        }
        log(`💰 Reembolsado ${amount} CC para ${request.from_user} (swap ${request.id})`);
    }
}

// Auxiliar: cunhar CC do sistema (DUCO→CC, XNO→CC, CCPoC→CC)
function mintCCForUser(username, amount, swapId, swapType) {
    db.updateBalance(username, amount);
    if (db.addTransaction.length >= 4) {
        db.addTransaction('swap_system', username, amount, `${swapType.toUpperCase()} → CC (${swapId})`);
    } else {
        db.addTransaction('swap_system', username, amount);
    }
    log(`✨ Cunhados ${amount} CC para ${username} (swap ${swapId} tipo ${swapType})`);
    return true;
}

// ========== ROTAS DE SWAP ==========

// 1. CC → DUCO / CC → CCPoC / CC → XNO
router.post('/create', verifyToken, swapLimiter, (req, res) => {
    try {
        const { from_user, amount_cc, swap_type, receiver } = req.body;

        if (req.user.username !== from_user) {
            return res.status(403).json({ status: 'error', message: 'Não autorizado: nome de usuário diferente' });
        }

        if (!amount_cc || !swap_type || !receiver) {
            return res.status(400).json({ status: 'error', message: 'Campos obrigatórios faltando' });
        }

        const amount = parseFloat(amount_cc);
        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ status: 'error', message: 'Valor inválido' });
        }

        if (swap_type !== 'duco' && swap_type !== 'ccpoc' && swap_type !== 'cc_to_xno') {
            return res.status(400).json({ status: 'error', message: 'Tipo de swap inválido. Use "duco", "ccpoc" ou "cc_to_xno"' });
        }

        const user = db.getUser(from_user);
        if (!user) {
            return res.status(404).json({ status: 'error', message: 'Usuário não encontrado' });
        }

        if (user.balance < amount) {
            return res.status(400).json({ status: 'error', message: 'Saldo CC insuficiente' });
        }

        // Transfere CC do usuário para holding
        db.updateBalance(from_user, -amount);
        db.updateBalance('swap_holding', amount);
        if (db.addTransaction.length >= 4) {
            db.addTransaction(from_user, 'swap_holding', amount, `Escrow para ${swap_type.toUpperCase()} de ${receiver}`);
        } else {
            db.addTransaction(from_user, 'swap_holding', amount);
        }

        let rateInfo = {};
        if (swap_type === 'cc_to_xno') {
            const xno_amount = amount * XNO_CONFIG.CC_TO_XNO_RATE;
            rateInfo = {
                exchange_rate: XNO_CONFIG.CC_TO_XNO_RATE,
                xno_amount: xno_amount,
                note: `${amount} CC = ${xno_amount.toFixed(8)} XNO`
            };
        } else if (swap_type === 'duco') {
            rateInfo = { rate: 10, note: '1 DUCO = 10 CC' };
        } else if (swap_type === 'ccpoc') {
            rateInfo = { rate: 0.75, note: '1 CC PoC = 0.75 CC' };
        }

        const newRequest = {
            id: Date.now() + '-' + crypto.randomBytes(8).toString('hex'),
            from_user,
            amount_cc: amount,
            swap_type,
            receiver: receiver.trim(),
            rate: swap_type === 'duco' ? 10 : (swap_type === 'ccpoc' ? 0.75 : XNO_CONFIG.CC_TO_XNO_RATE),
            status: 'pending',
            created_at: new Date().toISOString(),
            ...rateInfo
        };

        swapRequests.push(newRequest);
        saveSwapRequests();

        https.request('https://ntfy.sh/chocohub-pending-swaps', {method: 'POST'}).end(`Novo swap: ${newRequest.id} | ${from_user} → ${amount} CC (${swap_type}) para ${receiver}`);
        
        log(`🔄 Pedido de swap criado: ${newRequest.id} | ${from_user} -> ${amount} CC para ${swap_type} (${receiver})`);

        res.json({
            status: 'success',
            message: `Pedido criado. ${amount} CC movidos para holding.`,
            request_id: newRequest.id,
            new_balance: user.balance - amount,
            swap_details: rateInfo
        });
    } catch (e) {
        logError(`Erro ao criar swap: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 2. DUCO → CC (cria pedido, NÃO desconta CC do usuário)
router.post('/create_duco_to_cc', verifyToken, swapLimiter, (req, res) => {
    try {
        const { from_user, amount_duco, target_username } = req.body;

        if (req.user.username !== from_user) {
            return res.status(403).json({ status: 'error', message: 'Não autorizado: nome de usuário diferente' });
        }

        if (!amount_duco || !target_username) {
            return res.status(400).json({ status: 'error', message: 'Campos obrigatórios faltando' });
        }

        const amount = parseFloat(amount_duco);
        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ status: 'error', message: 'Valor inválido' });
        }

        const user = db.getUser(from_user);
        if (!user) {
            return res.status(404).json({ status: 'error', message: 'Usuário não encontrado' });
        }

        const newRequest = {
            id: Date.now() + '-' + crypto.randomBytes(8).toString('hex'),
            from_user,
            amount_cc: amount * 10,
            amount_duco: amount,
            swap_type: 'duco_to_cc',
            receiver: target_username.trim(),
            status: 'pending',
            created_at: new Date().toISOString()
        };

        swapRequests.push(newRequest);
        saveSwapRequests();

        https.request('https://ntfy.sh/chocohub-pending-swaps', {method: 'POST'}).end(`Novo DUCO→CC: ${newRequest.id} | ${from_user} envia ${amount} DUCO para ${target_username} (recebe ${newRequest.amount_cc} CC)`);

        log(`🔄 DUCO→CC pedido criado: ${newRequest.id} | ${from_user} -> ${amount} DUCO para CC (${target_username})`);

        res.json({
            status: 'success',
            message: `Pedido criado. Envie ${amount} DUCO para ${DUCO_CONFIG.USERNAME || 'ADMIN'} com memo: "SWAP CC for ${target_username}"`,
            request_id: newRequest.id
        });
    } catch (e) {
        logError(`Erro ao criar DUCO→CC: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 3. XNO → CC (cria pedido, NÃO desconta CC)
router.post('/create_xno_to_cc', verifyToken, swapLimiter, (req, res) => {
    try {
        const { from_user, amount_cc, target_username } = req.body;

        if (req.user.username !== from_user) {
            return res.status(403).json({ status: 'error', message: 'Não autorizado: nome de usuário diferente' });
        }

        if (!amount_cc || !target_username) {
            return res.status(400).json({ status: 'error', message: 'Campos obrigatórios faltando' });
        }

        const amount = parseFloat(amount_cc);
        if (isNaN(amount) || amount <= 0) {
            return res.status(400).json({ status: 'error', message: 'Valor inválido' });
        }

        const user = db.getUser(from_user);
        if (!user) {
            return res.status(404).json({ status: 'error', message: 'Usuário não encontrado' });
        }

        const xno_amount = amount / XNO_CONFIG.XNO_TO_CC_RATE;

        const newRequest = {
            id: Date.now() + '-' + crypto.randomBytes(8).toString('hex'),
            from_user,
            amount_cc: amount,
            amount_xno: xno_amount,
            swap_type: 'xno_to_cc',
            receiver: target_username.trim(),
            xno_receive_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS,
            status: 'pending',
            created_at: new Date().toISOString(),
            exchange_rate: XNO_CONFIG.XNO_TO_CC_RATE
        };

        swapRequests.push(newRequest);
        saveSwapRequests();

        const ntfyMsg = `XNO→CC: ${newRequest.id} | ${from_user} quer ${amount} CC, envie ${xno_amount.toFixed(8)} XNO para ${XNO_CONFIG.XNO_RECEIVE_ADDRESS} para ${target_username}`;
        https.request('https://ntfy.sh/chocohub-pending-swaps', {method: 'POST'}).end(ntfyMsg);

        log(`🪙 XNO→CC pedido criado: ${newRequest.id} | ${from_user} -> ${xno_amount.toFixed(8)} XNO por ${amount} CC para ${target_username}`);

        res.json({
            status: 'success',
            message: `Pedido criado. Envie ${xno_amount.toFixed(8)} XNO para: ${XNO_CONFIG.XNO_RECEIVE_ADDRESS}`,
            request_id: newRequest.id,
            xno_amount: xno_amount,
            xno_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS,
            will_receive_cc: amount
        });
    } catch (e) {
        logError(`Erro ao criar XNO→CC: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ========== SWAPS AUTOMÁTICOS (USANDO API DUCO) ==========

// 4. DUCO → CC (automático, cunha CC diretamente)
router.post('/duco-to-cc', verifyToken, swapLimiter, async (req, res) => {
    try {
        log(`🔄 Requisição DUCO→CC de ${req.user.username}: ${JSON.stringify(req.body)}`);
        
        const { duco_username, duco_password, amount_duco, receiver } = req.body;

        if (!duco_username || !duco_password || !amount_duco || !receiver) {
            logError(`Campos obrigatórios faltando`);
            return res.status(400).json({ status: 'error', message: 'Faltam: duco_username, duco_password, amount_duco, receiver' });
        }

        const amount = parseFloat(amount_duco);
        if (isNaN(amount) || amount <= 0) {
            logError(`Valor inválido: ${amount_duco}`);
            return res.status(400).json({ status: 'error', message: 'Valor DUCO inválido' });
        }

        // Verifica saldo DUCO
        const balance = await getDucoBalance(duco_username);
        if (balance === null) {
            return res.status(400).json({ status: 'error', message: 'Não foi possível verificar o saldo DUCO' });
        }

        if (balance < amount) {
            return res.status(400).json({ status: 'error', message: `Saldo DUCO insuficiente. Saldo: ${balance} DUCO` });
        }

        // Verifica credenciais da holding
        if (!DUCO_CONFIG.USERNAME || !DUCO_CONFIG.PASSWORD) {
            logError('DUCO_USERNAME/DUCO_PASSWORD não configurados no servidor');
            return res.status(500).json({ status: 'error', message: 'Transferências DUCO automáticas não configuradas (admin)' });
        }

        // Transfere DUCO do usuário para a holding
        log(`Tentando transferir ${amount} DUCO de ${duco_username} para ${DUCO_CONFIG.USERNAME}`);
        const txid = await transferDuco(duco_username, duco_password, DUCO_CONFIG.USERNAME, amount, 'ChocoHub→CC');
        if (!txid) {
            return res.status(400).json({ status: 'error', message: 'Falha na transferência DUCO. Verifique credenciais e saldo.' });
        }

        const amount_cc = amount * DUCO_CONFIG.DUCO_TO_CC_RATE;
        const swapId = Date.now() + '-' + crypto.randomBytes(8).toString('hex');

        const newRequest = {
            id: swapId,
            duco_username,
            amount_duco: amount,
            amount_cc,
            swap_type: 'duco_to_cc',
            receiver: receiver.trim(),
            rate: DUCO_CONFIG.DUCO_TO_CC_RATE,
            status: 'completed',
            created_at: new Date().toISOString(),
            completed_at: new Date().toISOString(),
            duco_txid: txid,
            auto_transfer: true
        };

        swapRequests.push(newRequest);
        saveSwapRequests();

        // Cunha CC para o receiver
        mintCCForUser(receiver.trim(), amount_cc, swapId, 'DUCO');

        https.request('https://ntfy.sh/chocohub-swaps', {method: 'POST'}).end(`✅ AUTO DUCO→CC: ${duco_username} +${amount} DUCO → ${receiver} +${amount_cc} CC [${txid}]`);

        log(`✅ Swap automático concluído: ${swapId}`);

        res.json({
            status: 'success',
            message: 'Swap DUCO→CC concluído',
            swap_id: swapId,
            duco_txid: txid,
            details: { duco_sent: amount, cc_received: amount_cc, receiver, rate: DUCO_CONFIG.DUCO_TO_CC_RATE }
        });
    } catch (e) {
        logError(`Erro em DUCO→CC: ${e.message}\n${e.stack}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// 5. CC → DUCO (automático, desconta CC, transfere DUCO via API)
router.post('/cc-to-duco', verifyToken, swapLimiter, async (req, res) => {
    try {
        log(`🔄 Requisição CC→DUCO de ${req.user.username}: ${JSON.stringify(req.body)}`);
        
        const { amount_cc, duco_receiver } = req.body;
        const from_user = req.user.username;

        if (!amount_cc || !duco_receiver) {
            logError(`Campos obrigatórios faltando`);
            return res.status(400).json({ status: 'error', message: 'Faltam: amount_cc, duco_receiver' });
        }

        const amount = parseFloat(amount_cc);
        if (isNaN(amount) || amount <= 0) {
            logError(`Valor CC inválido: ${amount_cc}`);
            return res.status(400).json({ status: 'error', message: 'Valor CC inválido' });
        }

        const user = db.getUser(from_user);
        if (!user) {
            logError(`Usuário não encontrado: ${from_user}`);
            return res.status(400).json({ status: 'error', message: 'Usuário não encontrado' });
        }
        
        log(`Saldo de ${from_user}: ${user.balance}, necessário: ${amount}`);
        
        if (user.balance < amount) {
            logError(`Saldo insuficiente`);
            return res.status(400).json({ status: 'error', message: 'Saldo CC insuficiente' });
        }

        // Verifica credenciais da holding
        if (!DUCO_CONFIG.USERNAME || !DUCO_CONFIG.PASSWORD) {
            logError('DUCO_USERNAME/DUCO_PASSWORD não configurados no servidor');
            return res.status(500).json({ status: 'error', message: 'Transferências DUCO automáticas não configuradas (admin)' });
        }

        // Desconta CC do usuário → holding
        db.updateBalance(from_user, -amount);
        db.updateBalance('swap_holding', amount);
        if (db.addTransaction.length >= 4) {
            db.addTransaction(from_user, 'swap_holding', amount, `CC→DUCO para ${duco_receiver}`);
        } else {
            db.addTransaction(from_user, 'swap_holding', amount);
        }

        const amount_duco = amount * DUCO_CONFIG.CC_TO_DUCO_RATE;
        const swapId = Date.now() + '-' + crypto.randomBytes(8).toString('hex');

        log(`Tentando transferir ${amount_duco} DUCO de ${DUCO_CONFIG.USERNAME} para ${duco_receiver}`);
        // Tenta transferir DUCO
        const txid = await transferDuco(DUCO_CONFIG.USERNAME, DUCO_CONFIG.PASSWORD, duco_receiver, amount_duco, 'ChocoHub swap');
        
        let status = 'pending';
        let message = '';
        if (txid) {
            status = 'completed';
            log(`Transferência bem-sucedida, removendo da holding`);
            db.updateBalance('swap_holding', -amount);
            message = 'Swap CC→DUCO concluído';
        } else {
            logError(`Falha na transferência DUCO, swap fica como pendente`);
            message = 'Falha na transferência DUCO. O administrador deverá completar manualmente.';
        }

        const newRequest = {
            id: swapId,
            from_user,
            amount_cc: amount,
            amount_duco,
            swap_type: 'cc_to_duco',
            duco_receiver: duco_receiver.trim(),
            rate: DUCO_CONFIG.CC_TO_DUCO_RATE,
            status,
            created_at: new Date().toISOString(),
            ...(txid && { completed_at: new Date().toISOString(), duco_txid: txid, auto_transfer: true })
        };

        swapRequests.push(newRequest);
        saveSwapRequests();

        https.request('https://ntfy.sh/chocohub-swaps', {method: 'POST'}).end(`CC→DUCO: ${from_user} -${amount} CC → ${duco_receiver} +${amount_duco} DUCO [${status}]`);

        log(`Swap registrado: ${swapId} [${status}]`);

        res.json({
            status: 'success',
            message,
            swap_id: swapId,
            ...(txid && { duco_txid: txid }),
            details: { cc_sent: amount, duco_received: amount_duco, receiver: duco_receiver, rate: DUCO_CONFIG.CC_TO_DUCO_RATE }
        });
    } catch (e) {
        logError(`Erro em CC→DUCO: ${e.message}\n${e.stack}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Listar swaps pendentes (filtrado por usuário se não for admin)
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
        logError(`Erro ao listar pendentes: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ========== CUMPRIR SWAP (admin) – suporte a xno_txid ==========
router.post('/fulfill', verifyToken, verifyAdmin, (req, res) => {
    try {
        const { request_id, xno_txid } = req.body;
        if (!request_id) {
            return res.status(400).json({ status: 'error', message: 'Falta request_id' });
        }

        const reqIndex = swapRequests.findIndex(r => r.id === request_id);
        if (reqIndex === -1) {
            return res.status(404).json({ status: 'error', message: 'Pedido não encontrado' });
        }

        if (swapRequests[reqIndex].status !== 'pending') {
            return res.status(400).json({ status: 'error', message: 'Swap já processado' });
        }

        const request = swapRequests[reqIndex];
        const adminName = req.user.username;

        if (request.swap_type === 'duco' || request.swap_type === 'ccpoc') {
            db.updateBalance('swap_holding', -request.amount_cc);
            db.updateBalance(adminName, request.amount_cc);
            if (db.addTransaction.length >= 4) {
                db.addTransaction('swap_holding', adminName, request.amount_cc, `Taxa de swap de ${request.from_user} (${request.id})`);
            } else {
                db.addTransaction('swap_holding', adminName, request.amount_cc);
            }
            log(`✅ Taxa de swap: ${request.amount_cc} CC holding → ${adminName} (${request.swap_type})`);
        } else if (request.swap_type === 'duco_to_cc') {
            mintCCForUser(request.receiver, request.amount_cc, request.id, 'DUCO');
        } else if (request.swap_type === 'xno_to_cc') {
            mintCCForUser(request.receiver, request.amount_cc, request.id, 'XNO');
        } else if (request.swap_type === 'cc_to_xno') {
            db.updateBalance('swap_holding', -request.amount_cc);
            db.updateBalance(adminName, request.amount_cc);
            if (db.addTransaction.length >= 4) {
                db.addTransaction('swap_holding', adminName, request.amount_cc, `Taxa CC→XNO de ${request.from_user} (${request.id})`);
            } else {
                db.addTransaction('swap_holding', adminName, request.amount_cc);
            }
            log(`✅ Taxa CC→XNO: ${request.amount_cc} CC holding → ${adminName}`);
            if (xno_txid) {
                log(`   Hash XNO: ${xno_txid}`);
            } else {
                log(`   ⚠️ Nenhum xno_txid fornecido (admin deve enviar manualmente)`);
            }
        } else {
            return res.status(400).json({ status: 'error', message: 'Tipo de swap desconhecido' });
        }

        swapRequests[reqIndex].status = 'completed';
        swapRequests[reqIndex].completed_at = new Date().toISOString();
        swapRequests[reqIndex].fulfilled_by = adminName;
        if (xno_txid) {
            swapRequests[reqIndex].xno_txid = xno_txid;
        }
        saveSwapRequests();

        res.json({ status: 'success', message: 'Swap concluído' });
    } catch (e) {
        logError(`Erro ao cumprir swap: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Endpoint extra: listar pendentes CC→XNO para admin
router.get('/admin/pending_xno', verifyToken, verifyAdmin, (req, res) => {
    try {
        const pendingXno = swapRequests.filter(r => r.status === 'pending' && r.swap_type === 'cc_to_xno');
        res.json({
            status: 'success',
            swaps: pendingXno,
            count: pendingXno.length
        });
    } catch (e) {
        logError(`Erro ao listar pendentes XNO: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Taxas (público)
router.get('/rates', (req, res) => {
    res.json({
        status: 'success',
        rates: {
            cc_to_duco: DUCO_CONFIG.CC_TO_DUCO_RATE,
            duco_to_cc: DUCO_CONFIG.DUCO_TO_CC_RATE,
            cc_to_ccpoc: 0.75,
            xno_to_cc: XNO_CONFIG.XNO_TO_CC_RATE,
            cc_to_xno: XNO_CONFIG.CC_TO_XNO_RATE,
            note: {
                duco: `1 DUCO = ${DUCO_CONFIG.DUCO_TO_CC_RATE} CC | 1 CC = ${DUCO_CONFIG.CC_TO_DUCO_RATE} DUCO`,
                ccpoc: '1 CC PoC = 0.75 CC',
                xno: `1 XNO = ${XNO_CONFIG.XNO_TO_CC_RATE.toLocaleString()} CC | 1 CC = ${XNO_CONFIG.CC_TO_XNO_RATE} XNO`,
                xno_receive_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS
            }
        }
    });
});

// Histórico do usuário
router.get('/history', verifyToken, (req, res) => {
    try {
        const userHistory = swapRequests.filter(r => r.from_user === req.user.username);
        res.json({
            status: 'success',
            history: userHistory,
            total: userHistory.length
        });
    } catch (e) {
        logError(`Erro ao obter histórico: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ──────────────── Rotas de Administrador ────────────────

// Ver todos os swaps (admin)
router.get('/admin/swaps', verifyToken, verifyAdmin, (req, res) => {
    try {
        res.json({
            status: 'success',
            swaps: swapRequests,
            total: swapRequests.length
        });
    } catch (e) {
        logError(`Erro em admin/swaps: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Deletar swap por ID (admin) – reembolsa se pendente
router.delete('/admin/swaps/:id', verifyToken, verifyAdmin, (req, res) => {
    try {
        const id = req.params.id;
        const index = swapRequests.findIndex(r => r.id === id);
        if (index === -1) {
            return res.status(404).json({ status: 'error', message: 'Swap não encontrado' });
        }

        const request = swapRequests[index];
        
        // Reembolsa se for CC → algo e pendente
        if (request.status === 'pending' && (request.swap_type === 'duco' || request.swap_type === 'ccpoc' || request.swap_type === 'cc_to_xno')) {
            refundUser(request);
        } else if (request.status === 'pending' && (request.swap_type === 'duco_to_cc' || request.swap_type === 'xno_to_cc')) {
            log(`🗑️ Deletado pedido ${id} (não requer reembolso)`);
        }
        
        swapRequests.splice(index, 1);
        saveSwapRequests();

        res.json({ status: 'success', message: 'Swap deletado' });
    } catch (e) {
        logError(`Erro ao deletar swap: ${e.message}`);
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Informações de configuração XNO (público)
router.get('/xno/config', (req, res) => {
    res.json({
        status: 'success',
        xno_receive_address: XNO_CONFIG.XNO_RECEIVE_ADDRESS,
        rates: {
            xno_to_cc: XNO_CONFIG.XNO_TO_CC_RATE,
            cc_to_xno: XNO_CONFIG.CC_TO_XNO_RATE
        }
    });
});

// Endpoint de debug: verificar saldo DUCO de um usuário (público)
router.get('/duco/balance/:username', async (req, res) => {
    const { username } = req.params;
    if (!username) return res.status(400).json({ status: 'error', message: 'Username necessário' });
    const balance = await getDucoBalance(username);
    if (balance === null) {
        return res.status(404).json({ status: 'error', message: 'Não foi possível obter o saldo' });
    }
    res.json({ status: 'success', username, balance });
});

module.exports = router;
