// ══════════════════════════════════════════════════════
// HARDCORE CHAOS ENGINE - CHOCO HUB (THE "NO LIMITS" VERSION)
// PARTE 1: SISTEMAS DE PARTICULAS E COBERTURA DE TELA
// ══════════════════════════════════════════════════════

window._hcTimeouts = [];
window._hcIntervals = [];
window._hcFlags = { 
    turbo: false, blackout: false, rotating: false, zooming: false, 
    shaking: false, strobe: false, ghostSnake: false, drunk: false,
    spotlight: false, invert: false, mouseHunt: false 
};

// Adicione no topo do hardcore.js

// Verifica se a tela já está sendo entortada por outro efeito
function hcTransformBusy() {
    return window._hcFlags.zooming || window._hcFlags.shaking;
}

// Emite os avisos na tela (como "🌌 ENTERING 4D DIMENSION")
function showHCWarning(msg) {
    // Reutiliza o sistema de banner (PU) que você já criou no game.js
    if (typeof showPU === "function") {
        showPU(msg);
        setTimeout(() => hidePU(), 3500);
    } else {
        console.warn("HARDCORE WARNING:", msg);
    }
}

// ── SISTEMA DE GERENCIAMENTO DE TIMERS (PARA NÃO QUEBRAR O JOGO) ──
function hcSetTimeout(fn, delay) { 
    const id = setTimeout(fn, delay); 
    window._hcTimeouts.push(id); 
    return id; 
}

function hcSetInterval(fn, delay) { 
    const id = setInterval(fn, delay); 
    window._hcIntervals.push(id); 
    return id; 
}

// ── LIMPEZA TOTAL DE CAOS (ESSENCIAL PARA O RETRY FUNCIONAR) ──
function _cleanHC() {
    const cvsWrap = document.getElementById("canvas-wrap");
    const canvas = document.getElementById("snakeCanvas");
    const hud = document.querySelector(".hud");

    console.log("🔥 [DEBUG] Purging all hardcore chaos elements...");

    if(cvsWrap) { 
        cvsWrap.style.filter = ""; 
        cvsWrap.style.transform = ""; 
        cvsWrap.style.boxShadow = "";
    }
    if(canvas) {
        canvas.style.transform = "";
        canvas.style.opacity = "1";
        canvas.style.clipPath = "none";
        canvas.style.filter = "";
    }
    if(hud) {
        hud.style.transform = "";
        hud.style.opacity = "1";
    }

    // Remove cada elemento de caos da tela um por um
    const elements = document.querySelectorAll(".hc-element");
    elements.forEach(el => {
        el.parentElement.removeChild(el);
    });
    
    // Mata todos os processos e loops ativos
    window._hcTimeouts.forEach(id => clearTimeout(id)); 
    window._hcTimeouts = [];
    
    window._hcIntervals.forEach(id => clearInterval(id)); 
    window._hcIntervals = [];
    
    // Reseta flags de comportamento
    for(let k in window._hcFlags) {
        window._hcFlags[k] = false;
    }
    
    // Cancela animações de frame (RequestAnimationFrame)
    if(window._hcMatrixRAF) cancelAnimationFrame(window._hcMatrixRAF);
    if(window._hcSnowRAF) cancelAnimationFrame(window._hcSnowRAF);
    
    window._isLagGhost = false;
}

// ── EFEITO 1: MATRIX SUPREMA (COBERTURA 300x300 GARANTIDA) ──
function startMatrixApocalypse() {
    const wrap = document.getElementById("canvas-wrap");
    const mCvs = document.createElement("canvas");
    mCvs.className = "hc-element";
    mCvs.id = "matrix-layer";
    
    // Força o tamanho exato do quadrado do jogo
    mCvs.width = 300; 
    mCvs.height = 300;
    
    mCvs.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 9998;
        pointer-events: none;
        opacity: 0.5;
    `;
    wrap.appendChild(mCvs);
    
    const mctx = mCvs.getContext("2d");
    const fontSize = 10;
    const columns = mCvs.width / fontSize; // Calcula quantas colunas cabem em 300px
    
    // Array de gotas: um para cada coluna da tela toda
    const drops = [];
    for (let x = 0; x < columns; x++) {
        drops[x] = 1;
    }

    const chars = "01ABCDEFGHIJKLMNOPQRSTUVWXYZ$#@%&*あいうえおかきくけこ".split("");

    function drawMatrix() {
        if(!hardcoreMode || dead) return;
        
        // Fundo preto semi-transparente para o rastro
        mctx.fillStyle = "rgba(0, 0, 0, 0.05)";
        mctx.fillRect(0, 0, mCvs.width, mCvs.height);

        mctx.fillStyle = "#00ff88"; // Cor clássica Matrix
        mctx.font = fontSize + "px monospace";

        for (let i = 0; i < drops.length; i++) {
            const text = chars[Math.floor(Math.random() * chars.length)];
            // x = i * fontSize (Garante que cobre da esquerda 0 até direita 300)
            mctx.fillText(text, i * fontSize, drops[i] * fontSize);

            // Reseta a gota aleatoriamente depois que ela passa do fundo (300px)
            if (drops[i] * fontSize > mCvs.height && Math.random() > 0.975) {
                drops[i] = 0;
            }
            drops[i]++;
        }
        window._hcMatrixRAF = requestAnimationFrame(drawMatrix);
    }
    drawMatrix();
}

// ── EFEITO 2: EMOJI STORM (COBERTURA TOTAL COM FÍSICA) ──
function startEmojiStorm() {
    hcSetTimeout(() => {
        if (dead || !hardcoreMode) return;
        
        const wrap = document.getElementById("canvas-wrap");
        const emojis = ['💀','🔥','😱','🤪','💥','🌀','⚡','🎃','👾','🤯','💩','🐍','🍎','💸','🍫'];
        
        // Criamos um lote de 20 emojis que caem de uma vez
        for(let i = 0; i < 20; i++) {
            hcSetTimeout(() => {
                if(dead) return;
                const e = document.createElement("div");
                e.className = "hc-element";
                
                // Geração de X de 0 a 300px para cobrir todo o quadrado
                const posX = Math.floor(Math.random() * 270); // 270 para não vazar da borda
                
                e.style.cssText = `
                    position: absolute;
                    left: ${posX}px;
                    top: -50px;
                    font-size: ${25 + Math.random() * 25}px;
                    z-index: 10002;
                    user-select: none;
                    pointer-events: none;
                    transition: top 2.5s cubic-bezier(0.1, 0.5, 0.1, 1);
                `;
                
                e.textContent = emojis[Math.floor(Math.random() * emojis.length)];
                wrap.appendChild(e);

                // Força o navegador a renderizar antes de animar
                void e.offsetWidth;
                
                // Move o emoji para o fundo do quadrado (350px para sumir)
                e.style.top = "350px";

                // Remove o elemento após a queda para não pesar o PC
                hcSetTimeout(() => {
                    if(e.parentElement) e.parentElement.removeChild(e);
                }, 3000);
                
            }, i * 150); // Delay entre cada emoji do lote
        }
        
        // Repete a tempestade a cada 15-25 segundos
        startEmojiStorm();
        
    }, 15000 + Math.random() * 10000);
}

// ══════════════════════════════════════════════════════
// HARDCORE CHAOS ENGINE - CHOCO HUB (SUPREME APOCALYPSE)
// PARTE 2: ESPAÇO, TEMPO E DISTORÇÃO DE CORES
// ══════════════════════════════════════════════════════

// ── EFEITO 3: RAINBOW OVERDRIVE (CICLO PSICODÉLICO) ──
function startRainbowOverdrive() {
    let hue = 0;
    // Intervalo rápido de 40ms para uma transição de cores fluida e estressante
    hcSetInterval(() => {
        const wrap = document.getElementById("canvas-wrap");
        if (!wrap || dead || window._hcFlags.blackout || window._hcFlags.strobe) return;

        hue = (hue + 8) % 360; // Salto de 8 graus por frame
        
        // Oscilação de saturação para dar um efeito de "pulsação de cor"
        const saturation = 200 + (Math.sin(Date.now() / 500) * 150); 
        const contrast = 1.2 + (Math.cos(Date.now() / 300) * 0.2);
        
        wrap.style.filter = `hue-rotate(${hue}deg) saturate(${saturation}%) contrast(${contrast}) brightness(1.1)`;
    }, 40);
}

// ── EFEITO 4: DIMENSÃO 4D (INCLINAÇÃO ESPACIAL AGRESSIVA) ──
function startDimensionShift4D() {
    hcSetTimeout(() => {
        if (dead || !hardcoreMode || hcTransformBusy()) {
            startDimensionShift4D(); // Tenta novamente se o sistema estiver ocupado
            return;
        }

        const wrap = document.getElementById("canvas-wrap");
        window._hcFlags.zooming = true;
        showHCWarning("🌌 ENTERING 4D DIMENSION");

        // Transição suave para entrar no modo 3D
        wrap.style.transition = "transform 2.5s cubic-bezier(0.68, -0.6, 0.32, 1.6)";
        
        // Inclinação agressiva: Perspective cria a profundidade, RotateX deita a tela, 
        // RotateZ gira lateralmente e Scale diminui para caber o fundo
        const rotX = 55 + (Math.random() * 10);
        const rotZ = 15 + (Math.random() * 10);
        
        wrap.style.transform = `perspective(600px) rotateX(${rotX}deg) rotateZ(${rotZ}deg) scale(0.65) translateY(60px)`;
        wrap.style.boxShadow = "0 80px 150px rgba(255, 45, 120, 0.6), 0 0 40px rgba(0, 225, 255, 0.3)";

        // Mantém o jogador na quarta dimensão por 10 segundos
        hcSetTimeout(() => {
            if (!dead) {
                wrap.style.transform = "";
                wrap.style.boxShadow = "";
                window._hcFlags.zooming = false;
                startDimensionShift4D(); // Reagenda o próximo salto dimensional
            }
        }, 10000);

    }, 30000 + Math.random() * 20000);
}

// ── EFEITO 5: SIMULADOR DE LAG (PING SPIKE 999ms) ──
// Este é o efeito mais "roubado", por isso adicionamos o Ghost Shield (Invencibilidade)
function startLagSimulator() {
    hcSetTimeout(() => {
        if (dead || !hardcoreMode) return;

        showHCWarning("📶 PING 999ms! (SHIELD ACTIVE)");

        // 1. O JOGO PARA TOTALMENTE (CONGELA)
        clearInterval(gameLoop); 
        window._isLagGhost = true; // Torna o jogador invencível no motor do game.js

        // 2. APÓS 1.5 SEGUNDOS DE TRAVAMENTO...
        hcSetTimeout(() => {
            if (dead) return;

            // 3. O JOGO TENTA "RECOMPENSAR" O TEMPO PERDIDO (ACELERAÇÃO INSANA)
            // A cobra se move a cada 15ms por um curto período (0.6s)
            gameLoop = setInterval(tick, 15);

            hcSetTimeout(() => {
                if (dead) return;

                // 4. VOLTA PARA A VELOCIDADE NORMAL
                clearInterval(gameLoop);
                gameLoop = setInterval(tick, curSpeed);

                // 5. O ESCUDO FICA ATIVO POR MAIS 2 SEGUNDOS PARA SEGURANÇA
                // Durante este tempo a cobra brilha em azul (definido no game.js)
                hcSetTimeout(() => {
                    window._isLagGhost = false;
                    console.log("🛡️ Lag Shield Deactivated.");
                    startLagSimulator(); // Agenda o próximo lag
                }, 2000);

            }, 600); // Duração do teleporte de compensação

        }, 1500); // Tempo do congelamento inicial

    }, 25000 + Math.random() * 20000);
}

// ── EFEITO 6: DIGITAL NOISE (ESTÁTICA DE TV ANTIGA) ──
function startDigitalStatic() {
    hcSetTimeout(() => {
        if (dead || !hardcoreMode) return;

        const wrap = document.getElementById("canvas-wrap");
        const noise = document.createElement("div");
        noise.className = "hc-element";
        
        // Usamos um GIF de estática real para poluir a visão
        noise.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: url('https://media.giphy.com/media/oEI9uWUqnW3Ze/giphy.gif');
            background-size: cover;
            opacity: 0.22;
            z-index: 9999;
            mix-blend-mode: color-dodge;
            pointer-events: none;
        `;
        wrap.appendChild(noise);

        // A estática dura 5 segundos e some
        hcSetTimeout(() => {
            if(noise.parentElement) noise.parentElement.removeChild(noise);
            startDigitalStatic();
        }, 5000);

    }, 15000 + Math.random() * 15000);
}

// ══════════════════════════════════════════════════════
// HARDCORE CHAOS ENGINE - CHOCO HUB (SUPREME APOCALYPSE)
// PARTE 3: POP-UPS, CENSURA, TERREMOTO E JUMP SCARES
// ══════════════════════════════════════════════════════

// ── EFEITO 7: VÍRUS POP-UPS (ESTILO WINDOWS ANTIGO) ──
function startVirusPopups() {
    hcSetTimeout(() => {
        if (dead || !hardcoreMode) return;

        const wrap = document.getElementById("canvas-wrap");
        const titles = ["FATAL ERROR", "VIRUS DETECTED", "DOWNLOAD MORE RAM", "YOU WON 1,000,000 CC", "HOT CHOCO NEAR YOU"];
        const contents = [
            "A critical error has occurred in SnakeMain.exe.",
            "Your GPU is melting. Please insert chocolate to cool down.",
            "Warning: Skill issue detected in sector 0xCC.",
            "Someone is watching your snake. Look behind you."
        ];

        const p = document.createElement("div");
        p.className = "hc-element";
        
        // Posicionamento aleatório cobrindo o quadrado de 300px
        const top = Math.floor(Math.random() * 150);
        const left = Math.floor(Math.random() * 100);

        p.style.cssText = `
            position: absolute; top: ${top}px; left: ${left}px;
            width: 190px; background: #c0c0c0; border: 2px solid #fff;
            border-right-color: #000; border-bottom-color: #000;
            z-index: 10001; box-shadow: 6px 6px 0 rgba(0,0,0,0.8);
            font-family: sans-serif; user-select: none;
        `;

        p.innerHTML = `
            <div style="background:#000080; color:#fff; padding:3px 6px; font-size:10px; font-weight:bold; display:flex; justify-content:space-between; align-items:center;">
                <span>${titles[Math.floor(Math.random()*titles.length)]}</span>
                <span onclick="this.parentElement.parentElement.remove()" style="background:#c0c0c0; color:#000; padding:0 3px; border:1px solid #fff; border-right-color:#000; border-bottom-color:#000; cursor:pointer;">X</span>
            </div>
            <div style="padding:12px; color:#000; font-size:11px; text-align:center; line-height:1.3;">
                ${contents[Math.floor(Math.random()*contents.length)]}
                <br><br>
                <button onclick="this.parentElement.parentElement.remove()" style="padding:4px 15px; background:#c0c0c0; border:2px solid #fff; border-right-color:#000; border-bottom-color:#000; font-weight:bold; cursor:pointer;">OK</button>
            </div>
        `;
        wrap.appendChild(p);

        // O popup some sozinho após 5 segundos se o jogador não fechar
        hcSetTimeout(() => { if(p.parentElement) p.parentElement.removeChild(p); }, 5000);
        
        // Repete o ciclo de popups
        startVirusPopups();
    }, 12000 + Math.random() * 10000);
}

// ── EFEITO 8: TARJA DE CENSURA MÓVEL (CENSORED) ──
function startCensoredBars() {
    hcSetTimeout(() => {
        if (dead || !hardcoreMode) return;

        const wrap = document.getElementById("canvas-wrap");
        const bar = document.createElement("div");
        bar.className = "hc-element";
        
        const top = 30 + Math.floor(Math.random() * 220); // Entre 30 e 250px
        
        bar.style.cssText = `
            position: absolute; top: ${top}px; left: 0;
            width: 100%; height: 50px; background: #000;
            display: flex; align-items: center; justify-content: center;
            color: #fff; font-family: 'Press Start 2P'; font-size: 10px;
            z-index: 10000; border-top: 2px solid #333; border-bottom: 2px solid #333;
            letter-spacing: 2px;
        `;
        bar.textContent = Math.random() > 0.5 ? "CENSORED CONTENT" : "ADVERTISEMENT";
        wrap.appendChild(bar);

        hcSetTimeout(() => {
            if(bar.parentElement) bar.parentElement.removeChild(bar);
            startCensoredBars();
        }, 4000);
    }, 10000 + Math.random() * 10000);
}

// ── EFEITO 9: TERREMOTO MAGNITUDE 10 (SHAKE CANVAS & HUD) ──
function startEarthquake() {
    hcSetTimeout(() => {
        if (dead || !hardcoreMode || hcTransformBusy()) {
            startEarthquake(); return;
        }

        window._hcFlags.shaking = true;
        showHCWarning("💥 MAGNITUDE 10 EARTHQUAKE!");

        const canvas = document.getElementById("snakeCanvas");
        const hud = document.querySelector(".hud");
        let count = 0;

        const shakeInterval = hcSetInterval(() => {
            const intensity = 28;
            const x = (Math.random() - 0.5) * intensity;
            const y = (Math.random() - 0.5) * intensity;
            const rot = (Math.random() - 0.5) * 12;

            canvas.style.transform = `translate(${x}px, ${y}px) rotate(${rot}deg)`;
            if(hud) hud.style.transform = `translate(${-x}px, ${-y}px)`;

            if (++count > 60) { // Dura aprox 2.4 segundos
                clearInterval(shakeInterval);
                canvas.style.transform = "";
                if(hud) hud.style.transform = "";
                window._hcFlags.shaking = false;
                startEarthquake();
            }
        }, 40);
    }, 15000 + Math.random() * 10000);
}

// ── EFEITO 10: PSYCHOLOGICAL TAUNTS (PROVOCAÇÕES) ──
function startTaunts() {
    hcSetTimeout(() => {
        if (dead || !hardcoreMode) return;

        const wrap = document.getElementById("canvas-wrap");
        const msgs = ["YOU'RE GONNA LOSE 😈", "SKILL ISSUE detected", "GIVE UP NOW", "DON'T TRUST THE FRUIT", "IT'S A TRAP", "ARE YOU CRYING?", "HAHAHAHAHAHA"];
        
        const el = document.createElement("div");
        el.className = "hc-element";
        const t = 40 + Math.random() * 180;
        const l = 10 + Math.random() * 130;

        el.style.cssText = `
            position: absolute; top: ${t}px; left: ${l}px;
            font-family: 'Press Start 2P'; font-size: 8px; color: #ff3366;
            background: rgba(0,0,0,0.85); padding: 10px; border-radius: 4px;
            z-index: 10003; border: 1px solid #ff3366; white-space: nowrap;
            box-shadow: 0 0 15px #ff2d78; pointer-events: none;
        `;
        el.textContent = msgs[Math.floor(Math.random() * msgs.length)];
        wrap.appendChild(el);

        hcSetTimeout(() => {
            if(el.parentElement) el.parentElement.removeChild(el);
            startTaunts();
        }, 3000);
    }, 6000 + Math.random() * 6000);
}

// ── EFEITO 11: SUSTO DO FALSO GAME OVER (JUMP SCARE) ──
function scheduleFakeGameOver() {
    hcSetTimeout(() => {
        if (dead || !hardcoreMode) return;

        const wrap = document.getElementById("canvas-wrap");
        const scare = document.createElement("div");
        scare.className = "hc-element";
        scare.style.cssText = `
            position: absolute; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.98); z-index: 10005;
            display: flex; align-items: center; justify-content: center;
            flex-direction: column; gap: 20px; font-family: 'Press Start 2P';
        `;
        scare.innerHTML = `
            <div style="font-size:60px; animation: hudPop 0.3s infinite;">💀</div>
            <div style="color:red; font-size:18px; letter-spacing:3px;">SYSTEM ERROR</div>
            <div style="color:#444; font-size:8px;">REBOOTING ATTEMPT...</div>
        `;
        wrap.appendChild(scare);

        // O susto dura apenas 1.6 segundos para não causar raiva real
        hcSetTimeout(() => {
            if(scare.parentElement) scare.parentElement.removeChild(scare);
        }, 1600);

    }, 50000 + Math.random() * 30000);
}

// ── FUNÇÃO MESTRE: INICIALIZA TODO O CAOS ──
function startHardcoreSystems() {
    console.log("😈 [SYSTEM] Apocalypse Supreme Initialized.");
    
    // Inicia Partículas (Parte 1)
    startMatrixApocalypse();
    startEmojiStorm();
    
    // Inicia Distorções (Parte 2)
    startRainbowOverdrive();
    startDimensionShift4D();
    startLagSimulator();
    startDigitalStatic();
    
    // Inicia Atrocidades (Parte 3)
    startVirusPopups();
    startCensoredBars();
    startEarthquake();
    startTaunts();
    scheduleFakeGameOver();
}