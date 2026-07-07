// ══════════════════════════════════════════════════════
// SNAKE ENGINE - CHOCO HUB (SYNCED v2)
// ══════════════════════════════════════════════════════

// ── CONFIG ──
const BOX = 15;
const COLS = 20;
const CC_NORMAL_APPLE = 0.05;   // ✅ nerf: 0.05 CC/apple
const CC_HC_APPLE = 0.1;        // ✅ nerf: 0.1 CC/apple
const CC_NORMAL_MAX = 50;       // ✅ max 50 CC cho cả hai chế độ
const CC_HC_MAX = 50;           // ✅ max 50 CC
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // ✅ 24 giờ

// ── STATE ──
let canvas, ctx;
let gameLoop = null;
let score = 0;
let snake = [];
let food = { x: 0, y: 0 };
let goldFood = null;
let direction = "";
let nextDir = "";
let hardcoreMode = false;
let paused = false;
let dead = false;
let lastEatTime = 0;
let comboCount = 0;
let comboTimer = null;
let curSpeed = 115;

const SPD_BASE_N  = 115;
const SPD_BASE_HC = 105;
const SPD_MIN     = 65;

window.currentUser = "";
window.currentPin  = "";
window.currentGameSessionId = null;
window._isLagGhost = false;
let cooldownInterval = null;

// ── INIT ──
document.addEventListener('DOMContentLoaded', () => {
    canvas = document.getElementById("snakeCanvas");
    if (!canvas) { console.error("snakeCanvas element not found!"); return; }
    ctx = canvas.getContext("2d");

    const savedUser = localStorage.getItem('choco_user');
    if (savedUser) {
        const inp = document.getElementById("player-user");
        if (inp) inp.value = savedUser;
    }

    window.addEventListener("keydown", (e) => {
        if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"," "].includes(e.key)) {
            e.preventDefault();
        }
        handleInput(e.key);
    }, false);

    setupTouchControls();

    loadBestScore();
    loadLb();
    console.log("Snake Engine Loaded (Synced v2)");
});

// ── D-PAD ──
function dpadHit(dir, event) {
    if (event) { event.preventDefault(); event.stopPropagation(); }
    setDir(dir);
}

// ── TOUCH CONTROLS (finger-following) ──
let touchStartX = 0, touchStartY = 0;
let touchActive = false;

function setupTouchControls() {
    const cvs = document.getElementById('snakeCanvas');
    if (!cvs) return;

    // Detect touch device
    const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    if (isTouchDevice) {
        document.body.classList.add('touch-active');
        touchActive = true;
    }

    cvs.addEventListener('touchstart', (e) => {
        e.preventDefault();
        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
    }, { passive: false });

    cvs.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (dead || paused || !window.currentUser) return;

        const touch = e.touches[0];
        const dx = touch.clientX - touchStartX;
        const dy = touch.clientY - touchStartY;

        // Minimum movement threshold to avoid jitter
        const threshold = 10;
        if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;

        // Determine direction based on dominant axis
        if (Math.abs(dx) > Math.abs(dy)) {
            setDir(dx > 0 ? 'RIGHT' : 'LEFT');
        } else {
            setDir(dy > 0 ? 'DOWN' : 'UP');
        }
    }, { passive: false });

    cvs.addEventListener('touchend', (e) => {
        e.preventDefault();
    }, { passive: false });
}

// ── DRAW ──
function safeRoundRect(ctx, x, y, width, height, radius) {
    if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, radius);
        ctx.fill();
    } else {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.fill();
    }
}

function draw() {
    if (!ctx) return;
    ctx.fillStyle = "#020208";
    ctx.fillRect(0, 0, 300, 300);

    ctx.strokeStyle = "rgba(255,149,0,0.06)";
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 300; i += BOX) {
        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 300); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(300, i); ctx.stroke();
    }

    const pulse = 0.85 + 0.15 * Math.sin(Date.now() / 200);
    ctx.save();
    ctx.fillStyle = "#ff2d78";
    ctx.shadowColor = "#ff2d78";
    ctx.shadowBlur = 12 * pulse;
    ctx.beginPath();
    ctx.arc(food.x + BOX/2, food.y + BOX/2, 6 * pulse, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();

    if (goldFood) {
        const gp = 0.8 + 0.2 * Math.sin(Date.now() / 100);
        ctx.save();
        ctx.fillStyle = "#ffd700";
        ctx.shadowColor = "#ffd700";
        ctx.shadowBlur = 20 * gp;
        ctx.beginPath();
        ctx.arc(goldFood.x + BOX/2, goldFood.y + BOX/2, 7 * gp, 0, Math.PI*2);
        ctx.fill();
        ctx.restore();
    }

    snake.forEach((seg, idx) => {
        const isHead = (idx === 0);
        const t = idx / snake.length;
        ctx.save();

        if (window._isLagGhost) {
            ctx.fillStyle = idx % 2 === 0 ? "rgba(0,225,255,0.8)" : "rgba(255,255,255,0.5)";
            ctx.shadowColor = "#00e1ff";
            ctx.shadowBlur = 15;
        } else if (isHead) {
            const g = ctx.createRadialGradient(seg.x+BOX/2, seg.y+BOX/2, 0, seg.x+BOX/2, seg.y+BOX/2, BOX);
            g.addColorStop(0, "#ffcc44");
            g.addColorStop(1, "#f58a00");
            ctx.fillStyle = g;
            ctx.shadowColor = "#f58a00";
            ctx.shadowBlur = 15;
        } else {
            ctx.fillStyle = `rgb(${Math.floor(210*(1-t*.7))}, ${Math.floor(72*(1-t*.7))}, 0)`;
        }

        const pad = isHead ? 1 : 2 + (t * 2);
        safeRoundRect(ctx, seg.x + pad, seg.y + pad, BOX - (pad*2), BOX - (pad*2), isHead ? 5 : 3);
        ctx.restore();
    });
}

// ── INPUT ──
function handleInput(key) {
    if (dead || !window.currentUser) return;
    const k = key.toLowerCase();
    if (k === "arrowup"    || k === "w") setDir("UP");
    if (k === "arrowdown"  || k === "s") setDir("DOWN");
    if (k === "arrowleft"  || k === "a") setDir("LEFT");
    if (k === "arrowright" || k === "d") setDir("RIGHT");
    if (k === " ") togglePause();
}

function setDir(d) {
    if (dead || paused) return;
    const opp = { "UP":"DOWN", "DOWN":"UP", "LEFT":"RIGHT", "RIGHT":"LEFT" };
    if (d !== opp[direction]) nextDir = d;
}

// ── GAME TICK ──
function tick() {
    if (paused || dead) return;
    if (nextDir) direction = nextDir;
    if (!direction) { draw(); return; }

    let hx = snake[0].x, hy = snake[0].y;
    if (direction === "LEFT")  hx -= BOX;
    if (direction === "UP")    hy -= BOX;
    if (direction === "RIGHT") hx += BOX;
    if (direction === "DOWN")  hy += BOX;

    if (!window._isLagGhost) {
        if (hx < 0 || hx >= 300 || hy < 0 || hy >= 300) return triggerGameOver();
        if (snake.some(s => s.x === hx && s.y === hy)) return triggerGameOver();
    } else {
        if (hx < 0) hx = 300 - BOX; else if (hx >= 300) hx = 0;
        if (hy < 0) hy = 300 - BOX; else if (hy >= 300) hy = 0;
    }

    snake.unshift({x: hx, y: hy});

    let eaten = false;
    if (hx === food.x && hy === food.y) {
        score++;
        eaten = true;
        food = spawnFood();
        handleCombo();
        spawnParticles(hx, hy, ["#ff2d78","#ffffff"]);
    } else if (goldFood && hx === goldFood.x && hy === goldFood.y) {
        score += 3;
        eaten = true;
        goldFood = null;
        hidePU();
        handleCombo();
        spawnParticles(hx, hy, ["#ffd700","#ffffff","#f58a00"], 15);
        toast("⭐ GOLDEN APPLE! +3", "success");
    }

    if (eaten) {
        updateHUD();
        syncSpeed();
        if (score % 5 === 0) spawnGoldMark();
        const el = document.getElementById("score-val");
        el.classList.remove("pop");
        void el.offsetWidth;
        el.classList.add("pop");
    } else {
        snake.pop();
    }
    draw();
}

function spawnFood() {
    let p, attempts = 0;
    while (attempts < 100) {
        p = { x: Math.floor(Math.random() * COLS) * BOX, y: Math.floor(Math.random() * COLS) * BOX };
        if (!snake.some(s => s.x === p.x && s.y === p.y)) return p;
        attempts++;
    }
    return p;
}

function spawnGoldMark() {
    if (goldFood) return;
    if (Math.random() > 0.65) {
        goldFood = spawnFood();
        showPU("⭐ GOLDEN APPLE SPAWNED!");
        setTimeout(() => { if (goldFood) { goldFood = null; hidePU(); } }, 7000);
    }
}

// ── AUTH & START ── (Bỏ kiểm tra cooldown để luôn cho chơi)
async function checkUser() {
    const userInp = document.getElementById("player-user").value.trim();
    const pinInp  = document.getElementById("player-pin").value.trim();

    if (!userInp || userInp.length < 2) return toast("❌ Enter a valid username!", "error");
    if (!pinInp) return toast("❌ Enter your PIN!", "error");

    localStorage.setItem('choco_user', userInp);

    try {
        // ✅ Chỉ xác thực, không kiểm tra cooldown nữa
        const authRes = await fetch('/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: userInp, pin: pinInp })
        });
        const authData = await authRes.json();

        if (authData.status !== 'success') {
            return toast("❌ " + (authData.message || "Auth failed"), "error");
        }

        // ✅ Request game session (proof-of-play)
        try {
            const sessionRes = await fetch('/snake/start-game', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: userInp, pin: pinInp })
            });
            const sessionData = await sessionRes.json();
            if (sessionData.status !== 'success') {
                return toast("❌ " + (sessionData.message || "Session failed"), "error");
            }
            window.currentGameSessionId = sessionData.game_session_id;
        } catch (e) {
            return toast("⚠️ Could not start game session", "error");
        }

        window.currentUser = userInp;
        window.currentPin  = pinInp;

        document.getElementById("setup-screen").style.display = "none";
        document.getElementById("game-screen").style.display  = "block";
        loadBestScore();
        startGame();

    } catch (e) {
        toast("⚠️ Server offline hoặc lỗi mạng", "error");
        console.error(e);
    }
}

// ── GAME CONTROL ──
function startGame() {
    if (!ctx) {
        canvas = document.getElementById("snakeCanvas");
        if (canvas) ctx = canvas.getContext("2d");
    }
    if (typeof _cleanHC === "function") _cleanHC();

    dead       = false;
    paused     = false;
    score      = 0;
    comboCount = 0;
    direction  = "";
    nextDir    = "";
    goldFood   = null;
    snake      = [{x: 10 * BOX, y: 10 * BOX}];
    food       = spawnFood();
    curSpeed   = hardcoreMode ? SPD_BASE_HC : SPD_BASE_N;

    updateHUD();
    if (gameLoop) clearInterval(gameLoop);
    draw();
    gameLoop = setInterval(tick, curSpeed);

    // Audio
    const nm = document.getElementById("normalMusic");
    const hm = document.getElementById("hardcoreMusic");
    if (nm && hm) {
        if (!nm.src || !nm.src.endsWith("High_Score_Chase.mp3"))
            nm.src = "OSTS/High_Score_Chase.mp3";
        if (!hm.src || !hm.src.endsWith("High_Score_Overdrive_Hardcore.mp3"))
            hm.src = "OSTS/High_Score_Overdrive_Hardcore.mp3";
        nm.pause(); nm.currentTime = 0;
        hm.pause(); hm.currentTime = 0;
        const active = hardcoreMode ? hm : nm;
        active.play().catch(() => {});
        if (hardcoreMode) active.onended = () => { if (!dead) triggerGameOver(); };
    }

    if (hardcoreMode && typeof startHardcoreSystems === "function") {
        startHardcoreSystems();
    }
}

function triggerGameOver() {
    if (dead) return;
    dead = true;
    clearInterval(gameLoop);

    document.getElementById("normalMusic").pause();
    document.getElementById("hardcoreMusic").pause();

    // ✅ Tính reward với max = 50 cho cả hai chế độ
    const r = hardcoreMode
        ? Math.min(score * CC_HC_APPLE, CC_HC_MAX)
        : Math.min(score * CC_NORMAL_APPLE, CC_NORMAL_MAX);

    document.getElementById("m-score").textContent  = score;
    document.getElementById("m-reward").textContent = r + " CC";
    document.getElementById("m-user").textContent   = window.currentUser;

    const modal = document.getElementById("modal");
    modal.classList.add("show");

    const btn = document.getElementById("btn-claim");
    btn.disabled    = false;
    btn.textContent = "💰 CLAIM CC";

    saveBestScore();
    if (typeof _cleanHC === "function") _cleanHC();
}

function toggleHardcoreMode() {
    hardcoreMode = !hardcoreMode;

    const wrap   = document.getElementById("hc-wrap");
    const sw     = document.getElementById("hardcore-switch");
    const badges = document.getElementById("hc-badges");
    const warn   = document.getElementById("epilepsy-warning");
    const vApple = document.getElementById("val-apple");
    const vMax   = document.getElementById("val-max");

    if (hardcoreMode) {
        wrap.classList.add("hc-on"); sw.classList.add("on");
        badges.style.display = "flex"; warn.style.display = "block";
        vApple.textContent = "0.1 CC";   // ✅ hiển thị đúng
        vMax.textContent = "50 CC";      // ✅ max 50
    } else {
        wrap.classList.remove("hc-on"); sw.classList.remove("on");
        badges.style.display = "none"; warn.style.display = "none";
        vApple.textContent = "0.05 CC";
        vMax.textContent = "50 CC";
    }
}

function restartGame() {
    document.getElementById("modal").classList.remove("show");
    clearCooldownUI();
    startGame();
}

// 🏠 Thoát về Dashboard
function exitToDashboard() {
    document.getElementById("modal").classList.remove("show");
    if (typeof _cleanHC === "function") _cleanHC();
    document.getElementById("normalMusic").pause();
    document.getElementById("hardcoreMusic").pause();
    window.location.href = "/";
}

// ── API CLAIM ── (Backend sẽ kiểm tra cooldown và max)
async function claimReward() {
    const btn = document.getElementById("btn-claim");
    btn.disabled    = true;
    btn.textContent = "CLAIMING…";

    try {
        const mode = hardcoreMode ? 'hardcore' : 'normal';
        const res = await fetch("/snake/claim", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username: window.currentUser,
                pin:      window.currentPin,
                apples:   score,
                mode:     mode,
                game_session_id: window.currentGameSessionId
            })
        });
        const data = await res.json();

        if (data.status === "success") {
            toast("✅ Claimed " + data.reward + " CC! Balance: " + data.new_balance + " CC", "success");
            btn.textContent = "✅ CLAIMED!";
            startCooldownUI();

            if ('Notification' in window && Notification.permission === 'granted') {
                new Notification('🍫 CC Received!', {
                    body: `+${data.reward} CC credited to your account!`
                });
            }
        } else {
            toast("❌ " + (data.message || "Claim failed"), "error");
            btn.disabled    = false;
            btn.textContent = "💰 CLAIM CC";
        }
    } catch (e) {
        toast("⚠️ API Offline", "error");
        btn.disabled    = false;
        btn.textContent = "💰 CLAIM CC";
    }
}

// ── COOLDOWN UI ── (24h)
function startCooldownUI() {
    clearCooldownUI();
    const cdWrap  = document.getElementById("cooldown-wrap");
    const cdLabel = document.getElementById("cooldown-label");
    const cdFill  = document.getElementById("cooldown-fill");

    if (!cdWrap || !cdLabel || !cdFill) return;

    cdWrap.style.display = "block";
    let remaining = COOLDOWN_MS;

    const tick = () => {
        remaining -= 1000;
        if (remaining <= 0) {
            cdLabel.textContent = "⏳ Ready to claim again!";
            cdFill.style.width  = "100%";
            cdWrap.style.display = "none";
            clearInterval(cooldownInterval);
            cooldownInterval = null;
            return;
        }
        const h = Math.floor(remaining / 3600000);
        const m = Math.floor((remaining % 3600000) / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        cdLabel.textContent = `⏳ Cooldown: ${h}h ${m}m ${s.toString().padStart(2, '0')}s`;
        cdFill.style.width  = ((COOLDOWN_MS - remaining) / COOLDOWN_MS * 100) + "%";
    };

    tick();
    cooldownInterval = setInterval(tick, 1000);
}

function clearCooldownUI() {
    if (cooldownInterval) {
        clearInterval(cooldownInterval);
        cooldownInterval = null;
    }
    const cdWrap = document.getElementById("cooldown-wrap");
    if (cdWrap) cdWrap.style.display = "none";
}

// ── COMBO, PARTICLES, SPEED ──
function handleCombo() {
    const now = Date.now();
    comboCount = (now - lastEatTime < 2500) ? comboCount + 1 : 1;
    lastEatTime = now;

    if (comboCount >= 3) {
        const disp = document.getElementById("combo-disp");
        let txt = `COMBO x${comboCount}`;
        if (comboCount >= 8)      txt = "🔥 INSANE!!";
        else if (comboCount >= 5) txt = "⚡ AMAZING!";
        disp.textContent = txt;
        disp.classList.add("visible");
        clearTimeout(comboTimer);
        comboTimer = setTimeout(() => disp.classList.remove("visible"), 1500);
    }
}

function spawnParticles(x, y, colors, count = 10) {
    const wrap = document.getElementById("canvas-wrap");
    for (let i = 0; i < count; i++) {
        const p = document.createElement("div");
        p.className = "particle";
        const angle = Math.random() * Math.PI * 2;
        const dist  = 20 + Math.random() * 40;
        p.style.left       = (x + BOX/2) + "px";
        p.style.top        = (y + BOX/2) + "px";
        p.style.background = colors[Math.floor(Math.random() * colors.length)];
        p.style.setProperty('--tx', (Math.cos(angle) * dist) + "px");
        p.style.setProperty('--ty', (Math.sin(angle) * dist) + "px");
        wrap.appendChild(p);
        setTimeout(() => p.remove(), 600);
    }
}

function syncSpeed() {
    if (window._hcFlags && window._hcFlags.turbo) return;
    const base   = hardcoreMode ? SPD_BASE_HC : SPD_BASE_N;
    const newSpd = Math.max(SPD_MIN, base - (score * 1.6));
    if (Math.abs(newSpd - curSpeed) > 1) {
        curSpeed = newSpd;
        clearInterval(gameLoop);
        gameLoop = setInterval(tick, curSpeed);
    }
    const pct = ((base - curSpeed) / (base - SPD_MIN)) * 100;
    document.getElementById("spd-bar").style.width = Math.max(4, pct) + "%";
}

function togglePause() {
    if (dead) return;
    paused = !paused;
    document.getElementById("pause-btn").textContent = paused ? "▶ RESUME" : "⏸ PAUSE";
}

// ── UI HELPERS ──
function toast(msg, type) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.className   = `show ${type}`;
    setTimeout(() => t.className = "", 3000);
}

function showPU(msg) {
    document.getElementById("pu-banner").textContent = msg;
    document.getElementById("pu-banner").classList.add("show");
}
function hidePU() {
    document.getElementById("pu-banner").classList.remove("show");
}

function updateHUD() {
    document.getElementById("score-val").textContent = score;
    const r = hardcoreMode ? Math.min(score * CC_HC_APPLE, CC_HC_MAX) : Math.min(score * CC_NORMAL_APPLE, CC_NORMAL_MAX);
    document.getElementById("reward-val").textContent = r + " CC";
}

// ── BEST SCORE ──
function saveBestScore() {
    const b = localStorage.getItem(`snake_best_${window.currentUser}`) || 0;
    if (score > b) {
        localStorage.setItem(`snake_best_${window.currentUser}`, score);
        document.getElementById("best-val").textContent = score;
    }
}

function loadBestScore() {
    if (window.currentUser) {
        const b = localStorage.getItem(`snake_best_${window.currentUser}`) || 0;
        document.getElementById("best-val").textContent = b;
    }
}

// ── LEADERBOARD ──
async function loadLb() {
    try {
        const res = await fetch("/leaderboard");
        const data = await res.json();
        window.lbData = data;
        showLb('normal');
    } catch (e) { console.log("LB Offline"); }
}

function showLb(mode) {
    const body = document.getElementById("lb-body");
    const tabN = document.getElementById("lb-tab-normal");
    const tabH = document.getElementById("lb-tab-hardcore");

    tabN.className = "lb-tab" + (mode === 'normal'   ? " active-n" : "");
    tabH.className = "lb-tab" + (mode === 'hardcore' ? " active-h" : "");

    if (!window.lbData || !window.lbData[mode] || window.lbData[mode].length === 0) {
        body.innerHTML = '<div class="lb-empty">No scores yet — be the first!</div>';
        return;
    }

    body.innerHTML = window.lbData[mode].map((e, i) => `
        <div style="display:grid;grid-template-columns:30px 1fr auto auto;gap:10px;padding:12px;border-bottom:1px solid rgba(255,255,255,0.05);align-items:center;">
            <div style="font-family:'Space Mono';color:var(--dim);font-size:0.7rem;">#${i+1}</div>
            <div style="font-weight:600;font-size:0.85rem;">${e.username}</div>
            <div style="font-family:'Space Mono';color:var(--amber);font-weight:700;">${e.score}</div>
            <div style="font-size:0.7rem;color:var(--mid);">${e.reward} CC</div>
        </div>
    `).join("");
}
