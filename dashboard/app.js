/**
 * ======================================================
 *  🛡️ DDoS Simulation Lab — Dashboard Logic
 * ======================================================
 *  Control de ataque, visualización de métricas en tiempo
 *  real, y gestión de defensas del ESP32.
 *
 *  Dependencia: Chart.js v4+ (cargado desde CDN en HTML)
 * ======================================================
 */

// ===== CONFIGURACIÓN =====
const BACKEND_URL = window.location.origin;   // Auto-detect cuando se sirve desde FastAPI
const POLL_INTERVAL_MS = 1000;                // Polling cada 1 segundo
const MAX_DATA_POINTS = 60;                   // 60 segundos de historia en las gráficas

// ===== ESTADO GLOBAL =====
let isAttacking = false;
let defenseEnabled = false;
let isConnected = false;
let pollTimer = null;

// ===== SELECTORES DOM =====
const $ = (id) => document.getElementById(id);

const el = {
    // Header
    header:           $('header'),
    attackIndicator:  $('attack-indicator'),
    statusDot:        $('status-dot'),
    espIp:            $('esp-ip'),

    // Attack Panel
    attackPanel:      $('attack-panel'),
    targetIp:         $('target-ip'),
    attackType:       $('attack-type'),
    intensity:        $('intensity'),
    intensityVal:     $('intensity-val'),
    concurrent:       $('concurrent'),
    concurrentVal:    $('concurrent-val'),
    attackBtn:        $('attack-btn'),

    // Attack Stats
    statSent:         $('stat-sent'),
    statSuccess:      $('stat-success'),
    statFailed:       $('stat-failed'),
    statRate:         $('stat-rate'),
    statLatency:      $('stat-latency'),
    statDuration:     $('stat-duration'),

    // KPIs
    kpiLatency:       $('kpi-latency'),
    kpiRps:           $('kpi-rps'),
    kpiMemory:        $('kpi-memory'),
    kpiBlocked:       $('kpi-blocked'),
    kpiLatencyBar:    $('kpi-latency-bar'),
    kpiRpsBar:        $('kpi-rps-bar'),
    kpiMemoryBar:     $('kpi-memory-bar'),
    kpiBlockedBar:    $('kpi-blocked-bar'),

    // Defense
    defenseSection:   $('defense-section'),
    defenseBtn:       $('defense-btn'),
    rateLimit:        $('rate-limit'),
    rateLimitVal:     $('rate-limit-val'),
    defenseBl:        $('defense-bl'),
    defenseBlockedT:  $('defense-blocked-total'),
    defenseRssi:      $('defense-rssi'),
    defenseUptime:    $('defense-uptime'),

    // Log
    logTerminal:      $('log-terminal'),
};

// ===== DATOS PARA GRÁFICAS =====
const chartStore = {
    labels:   Array(MAX_DATA_POINTS).fill(''),
    latency:  [],
    rps:      [],
    memory:   [],
    allowed:  [],
    blocked:  [],
};

// Para calcular deltas (peticiones nuevas por segundo)
let prevTotalReq = 0;
let prevBlockedReq = 0;

// ===== GRÁFICAS (Chart.js) =====
let charts = {};

/**
 * Crea una gráfica de línea con área rellena.
 */
function createLineChart(canvasId, rgbColor, yMin = 0, yMax = undefined) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    // Gradiente de relleno
    const gradient = ctx.createLinearGradient(0, 0, 0, 160);
    gradient.addColorStop(0, `rgba(${rgbColor}, 0.25)`);
    gradient.addColorStop(1, `rgba(${rgbColor}, 0.0)`);

    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: chartStore.labels,
            datasets: [{
                data: [],
                borderColor: `rgb(${rgbColor})`,
                backgroundColor: gradient,
                borderWidth: 2,
                fill: true,
                tension: 0.4,
                pointRadius: 0,
                pointHitRadius: 8,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 180 },
            interaction: { intersect: false, mode: 'index' },
            scales: {
                x: { display: false },
                y: {
                    min: yMin,
                    max: yMax,
                    grid: { color: 'rgba(255,255,255,0.03)', drawBorder: false },
                    border: { display: false },
                    ticks: {
                        color: '#4a5568',
                        font: { size: 10, family: 'JetBrains Mono' },
                        maxTicksLimit: 5,
                        padding: 8,
                    },
                },
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10,16,28,0.92)',
                    titleFont: { family: 'JetBrains Mono', size: 11 },
                    bodyFont: { family: 'JetBrains Mono', size: 11 },
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    cornerRadius: 8,
                    padding: 10,
                },
            },
        },
    });
}

/**
 * Crea una gráfica de barras apiladas (permitidas vs bloqueadas).
 */
function createStackedBarChart(canvasId) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    return new Chart(ctx, {
        type: 'bar',
        data: {
            labels: chartStore.labels,
            datasets: [
                {
                    label: 'Permitidas',
                    data: [],
                    backgroundColor: `rgba(0, 230, 118, 0.55)`,
                    borderRadius: 2,
                    barPercentage: 0.85,
                },
                {
                    label: 'Bloqueadas',
                    data: [],
                    backgroundColor: `rgba(255, 45, 85, 0.55)`,
                    borderRadius: 2,
                    barPercentage: 0.85,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 180 },
            scales: {
                x: { display: false, stacked: true },
                y: {
                    stacked: true,
                    grid: { color: 'rgba(255,255,255,0.03)', drawBorder: false },
                    border: { display: false },
                    ticks: {
                        color: '#4a5568',
                        font: { size: 10, family: 'JetBrains Mono' },
                        maxTicksLimit: 5,
                        padding: 8,
                    },
                },
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    align: 'end',
                    labels: {
                        color: '#64748b',
                        font: { size: 10, family: 'Inter' },
                        boxWidth: 8,
                        boxHeight: 8,
                        usePointStyle: true,
                        pointStyle: 'circle',
                        padding: 12,
                    },
                },
                tooltip: {
                    backgroundColor: 'rgba(10,16,28,0.92)',
                    titleFont: { family: 'JetBrains Mono', size: 11 },
                    bodyFont: { family: 'JetBrains Mono', size: 11 },
                    borderColor: 'rgba(255,255,255,0.08)',
                    borderWidth: 1,
                    cornerRadius: 8,
                },
            },
        },
    });
}

/**
 * Inicializa las 4 gráficas del dashboard.
 */
function initCharts() {
    charts.latency = createLineChart('chart-latency', '0, 240, 255');
    charts.rps     = createLineChart('chart-rps', '255, 171, 0');
    charts.memory  = createLineChart('chart-memory', '168, 85, 247', 0, 100);
    charts.blocked = createStackedBarChart('chart-blocked');
}

/**
 * Agrega un dato al array circular del chart.
 */
function pushChartData(arr, value) {
    arr.push(value);
    if (arr.length > MAX_DATA_POINTS) arr.shift();
}

/**
 * Actualiza las gráficas con los datos actuales.
 */
function refreshCharts() {
    charts.latency.data.datasets[0].data = [...chartStore.latency];
    charts.latency.update('none');

    charts.rps.data.datasets[0].data = [...chartStore.rps];
    charts.rps.update('none');

    charts.memory.data.datasets[0].data = [...chartStore.memory];
    charts.memory.update('none');

    charts.blocked.data.datasets[0].data = [...chartStore.allowed];
    charts.blocked.data.datasets[1].data = [...chartStore.blocked];
    charts.blocked.update('none');
}

// ===== LOG DE ACTIVIDAD =====

/**
 * Agrega una entrada al terminal de log.
 */
function addLog(message, type = 'info') {
    const now = new Date();
    const ts = now.toLocaleTimeString('es-MX', { hour12: false });

    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.innerHTML = `<span class="log-ts">[${ts}]</span> ${message}`;

    el.logTerminal.appendChild(entry);
    el.logTerminal.scrollTop = el.logTerminal.scrollHeight;

    // Mantener máximo 60 entradas
    while (el.logTerminal.children.length > 60) {
        el.logTerminal.removeChild(el.logTerminal.firstChild);
    }
}

// ===== API CALLS =====

/**
 * Wrapper para llamadas al backend.
 */
async function api(endpoint, method = 'GET', body = null) {
    try {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (body) opts.body = JSON.stringify(body);

        const res = await fetch(`${BACKEND_URL}${endpoint}`, opts);
        if (!res.ok) {
            const err = await res.text();
            throw new Error(`HTTP ${res.status}: ${err}`);
        }
        return await res.json();
    } catch (err) {
        console.error(`[API] ${method} ${endpoint}:`, err.message);
        return null;
    }
}

// ===== CONTROL DE ATAQUE =====

/**
 * Inicia el ataque con la configuración actual del panel.
 */
async function startAttack() {
    const ip = el.targetIp.value.trim();
    if (!ip) {
        addLog('❌ Ingresa la dirección IP del ESP32', 'error');
        el.targetIp.focus();
        el.targetIp.style.borderColor = 'var(--red)';
        setTimeout(() => el.targetIp.style.borderColor = '', 2000);
        return;
    }

    const config = {
        target_ip: ip,
        intensity: parseInt(el.intensity.value, 10),
        concurrent: parseInt(el.concurrent.value, 10),
        attack_type: el.attackType.value,
    };

    addLog(`🚀 Iniciando <strong>${config.attack_type}</strong> → ${ip}`, 'warn');
    addLog(`   ⚙️ Intensidad: ${config.intensity} req/s | Concurrentes: ${config.concurrent}`, 'info');

    const result = await api('/api/attack/start', 'POST', config);

    if (result) {
        isAttacking = true;
        syncAttackUI();
        addLog('⚡ ¡Ataque en curso! El ESP32 está recibiendo tráfico.', 'error');
    } else {
        addLog('❌ Error al iniciar el ataque. ¿El backend está corriendo?', 'error');
    }
}

/**
 * Detiene el ataque en curso.
 */
async function stopAttack() {
    addLog('🛑 Deteniendo ataque...', 'warn');

    const result = await api('/api/attack/stop', 'POST');

    if (result) {
        isAttacking = false;
        syncAttackUI();
        addLog(
            `✅ Ataque detenido. Enviadas: ${fmt(result.total_sent)} | ` +
            `Éxito: ${result.success_rate}%`,
            'success'
        );
    } else {
        addLog('⚠️ No se pudo confirmar la detención del ataque', 'warn');
    }
}

/**
 * Sincroniza la UI del panel de ataque con el estado actual.
 */
function syncAttackUI() {
    // Botón
    const btnIcon = el.attackBtn.querySelector('.btn-icon');
    const btnLabel = el.attackBtn.querySelector('.btn-label');

    el.attackBtn.classList.toggle('active', isAttacking);
    btnIcon.textContent = isAttacking ? '⏹' : '▶';
    btnLabel.textContent = isAttacking ? 'DETENER ATAQUE' : 'LANZAR ATAQUE';

    // Panel
    el.attackPanel.classList.toggle('active', isAttacking);

    // Header
    el.header.classList.toggle('attacking', isAttacking);
    el.attackIndicator.classList.toggle('visible', isAttacking);

    // Deshabilitar controles durante ataque
    el.targetIp.disabled = isAttacking;
    el.attackType.disabled = isAttacking;
    el.intensity.disabled = isAttacking;
    el.concurrent.disabled = isAttacking;
}

// ===== CONTROL DE DEFENSAS =====

/**
 * Activa o desactiva las defensas en el ESP32.
 */
async function toggleDefense() {
    const ip = el.targetIp.value.trim();
    if (!ip) {
        addLog('❌ Ingresa la IP del ESP32 primero', 'error');
        return;
    }

    const result = await api(`/api/defense/toggle?target_ip=${encodeURIComponent(ip)}`, 'POST');

    if (result) {
        defenseEnabled = result.enabled;
        syncDefenseUI();
        addLog(
            defenseEnabled
                ? '🛡️ Defensas <strong>ACTIVADAS</strong> — Rate Limit + Blacklist + Conn Limit'
                : '⚠️ Defensas <strong>DESACTIVADAS</strong> — Servidor vulnerable',
            defenseEnabled ? 'success' : 'warn'
        );
    } else {
        addLog('❌ No se pudo comunicar con el ESP32. ¿Está conectado?', 'error');
    }
}

/**
 * Envía un nuevo valor de rate limit al ESP32.
 */
async function applyRateLimit() {
    const ip = el.targetIp.value.trim();
    if (!ip) return;

    const value = parseInt(el.rateLimit.value, 10);
    const result = await api(
        `/api/defense/ratelimit?target_ip=${encodeURIComponent(ip)}&value=${value}`,
        'POST'
    );

    if (result) {
        addLog(`⚙️ Rate limit ajustado a <strong>${result.rate_limit}</strong> req/s por IP`, 'info');
    }
}

/**
 * Sincroniza la UI de defensa.
 */
function syncDefenseUI() {
    const btnLabel = el.defenseBtn.querySelector('.btn-label');
    el.defenseBtn.classList.toggle('active', defenseEnabled);
    btnLabel.textContent = defenseEnabled ? 'Defensas ACTIVAS' : 'Activar Defensas';
    el.defenseSection.classList.toggle('active', defenseEnabled);
}

// ===== POLLING DE MÉTRICAS =====

/**
 * Consulta métricas del backend + ESP32 y actualiza toda la UI.
 */
async function pollMetrics() {
    const ip = el.targetIp.value.trim();
    const data = await api(`/api/metrics?target_ip=${encodeURIComponent(ip || '')}`);

    if (!data) return;

    // ---- Estado de conexión ----
    const wasConnected = isConnected;
    isConnected = data.connected;
    el.statusDot.classList.toggle('connected', isConnected);
    el.espIp.textContent = isConnected ? ip : 'Desconectado';

    if (isConnected && !wasConnected) {
        addLog(`✅ Conectado al ESP32 en <strong>${ip}</strong>`, 'success');
    } else if (!isConnected && wasConnected) {
        addLog('⚠️ Conexión con el ESP32 perdida', 'error');
    }

    // ---- Stats del motor de ataque ----
    const atk = data.attack;
    if (atk) {
        el.statSent.textContent = fmt(atk.total_sent);
        el.statSuccess.textContent = fmt(atk.total_success);
        el.statFailed.textContent = fmt(atk.total_failed);
        el.statRate.textContent = `${atk.success_rate}%`;
        el.statRate.className = `stat-value ${atk.success_rate > 80 ? 'success' : atk.success_rate > 40 ? 'warning' : 'danger'}`;
        el.statLatency.textContent = `${atk.avg_response_ms} ms`;
        el.statDuration.textContent = fmtDuration(atk.duration_s);

        // Sincronizar estado
        if (atk.is_running !== isAttacking) {
            isAttacking = atk.is_running;
            syncAttackUI();
        }
    }

    // ---- Telemetría del ESP32 ----
    const esp = data.esp32;
    if (esp) {
        updateESP32Metrics(esp);
    } else {
        updateESP32Offline();
    }
}

/**
 * Actualiza KPIs, gráficas y defensas con datos del ESP32.
 */
function updateESP32Metrics(esp) {
    // KPI values
    const latency = Math.round(esp.avg_response_ms);
    const rps = esp.requests_per_second;
    const memPct = Math.round(esp.heap_usage_pct);
    const blocked = esp.blocked_requests + esp.dropped_requests;

    setKPI(el.kpiLatency, `${latency}`, el.kpiLatencyBar, Math.min(latency / 500 * 100, 100));
    setKPI(el.kpiRps, `${rps}`, el.kpiRpsBar, Math.min(rps / 200 * 100, 100));
    setKPI(el.kpiMemory, `${memPct}%`, el.kpiMemoryBar, memPct);
    setKPI(el.kpiBlocked, fmt(blocked), el.kpiBlockedBar, Math.min(blocked / 1000 * 100, 100));

    // Chart data
    pushChartData(chartStore.latency, esp.avg_response_ms);
    pushChartData(chartStore.rps, rps);
    pushChartData(chartStore.memory, esp.heap_usage_pct);

    // Calcular deltas para barras de bloqueadas
    const totalNow = esp.total_requests;
    const blockedNow = esp.blocked_requests;
    const allowedDelta = Math.max(0, (totalNow - blockedNow) - (prevTotalReq - prevBlockedReq));
    const blockedDelta = Math.max(0, blockedNow - prevBlockedReq);
    pushChartData(chartStore.allowed, allowedDelta);
    pushChartData(chartStore.blocked, blockedDelta);
    prevTotalReq = totalNow;
    prevBlockedReq = blockedNow;

    refreshCharts();

    // Defense info
    defenseEnabled = esp.defense_enabled;
    syncDefenseUI();
    el.defenseBl.textContent = esp.blacklisted_ips;
    el.defenseBlockedT.textContent = fmt(esp.blocked_requests + esp.dropped_requests);
    el.defenseRssi.textContent = esp.wifi_rssi;
    el.defenseUptime.textContent = fmtDuration(esp.uptime_s);

    if (esp.rate_limit !== undefined) {
        el.rateLimitVal.textContent = esp.rate_limit;
    }
}

/**
 * Actualiza UI cuando el ESP32 no responde.
 */
function updateESP32Offline() {
    pushChartData(chartStore.latency, null);
    pushChartData(chartStore.rps, null);
    pushChartData(chartStore.memory, null);
    pushChartData(chartStore.allowed, 0);
    pushChartData(chartStore.blocked, 0);

    el.kpiLatency.textContent = '—';
    el.kpiRps.textContent = '—';
    el.kpiMemory.textContent = '—';
    el.kpiBlocked.textContent = '—';

    refreshCharts();
}

/**
 * Actualiza un KPI card con animación flash.
 */
function setKPI(valueEl, text, barEl, barPct) {
    if (valueEl.textContent !== text) {
        valueEl.textContent = text;
        valueEl.classList.remove('value-flash');
        void valueEl.offsetWidth; // Trigger reflow
        valueEl.classList.add('value-flash');
    }
    if (barEl) {
        barEl.style.width = `${Math.min(100, Math.max(0, barPct))}%`;
    }
}

// ===== UTILIDADES DE FORMATO =====

/**
 * Formatea números grandes (1K, 1.2M, etc).
 */
function fmt(n) {
    if (n == null) return '—';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 10_000) return (n / 1_000).toFixed(1) + 'K';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(Math.round(n));
}

/**
 * Formatea una duración en segundos a formato legible.
 */
function fmtDuration(seconds) {
    if (!seconds || seconds < 0) return '0s';
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

// ===== EVENT LISTENERS =====

function initEventListeners() {
    // — Range sliders en tiempo real —
    el.intensity.addEventListener('input', () => {
        el.intensityVal.textContent = el.intensity.value;
    });

    el.concurrent.addEventListener('input', () => {
        el.concurrentVal.textContent = el.concurrent.value;
    });

    el.rateLimit.addEventListener('input', () => {
        el.rateLimitVal.textContent = el.rateLimit.value;
    });

    // Enviar rate limit al ESP32 cuando el slider se suelta
    el.rateLimit.addEventListener('change', applyRateLimit);

    // — Botón de ataque —
    el.attackBtn.addEventListener('click', () => {
        if (isAttacking) {
            stopAttack();
        } else {
            startAttack();
        }
    });

    // — Botón de defensa —
    el.defenseBtn.addEventListener('click', toggleDefense);

    // — Persistir IP del target —
    el.targetIp.addEventListener('change', () => {
        localStorage.setItem('ddos_lab_target_ip', el.targetIp.value.trim());
    });

    // — Restaurar IP guardada —
    const savedIp = localStorage.getItem('ddos_lab_target_ip');
    if (savedIp) {
        el.targetIp.value = savedIp;
    }

    // — Atajos de teclado —
    document.addEventListener('keydown', (e) => {
        // Ctrl+Enter = toggle ataque
        if (e.ctrlKey && e.key === 'Enter') {
            e.preventDefault();
            el.attackBtn.click();
        }
        // Ctrl+D = toggle defensa
        if (e.ctrlKey && e.key === 'd') {
            e.preventDefault();
            el.defenseBtn.click();
        }
    });
}

// ===== INICIALIZACIÓN =====

function init() {
    // Inicializar gráficas
    initCharts();

    // Registrar eventos
    initEventListeners();

    // Log de bienvenida
    addLog('🛡️ <strong>DDoS Simulation Lab v1.0</strong>', 'info');
    addLog('📡 Conectando con el backend...', 'info');

    // Primer poll inmediato
    pollMetrics().then(() => {
        addLog('✅ Dashboard listo. Ingresa la IP del ESP32 para comenzar.', 'success');
        addLog('💡 Atajos: <strong>Ctrl+Enter</strong> = Ataque | <strong>Ctrl+D</strong> = Defensa', 'info');
    });

    // Polling periódico
    pollTimer = setInterval(pollMetrics, POLL_INTERVAL_MS);
}

// Arrancar cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', init);
