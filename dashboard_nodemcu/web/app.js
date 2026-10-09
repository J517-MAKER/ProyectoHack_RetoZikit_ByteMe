/* ======================================================
   SecureGuard · gramo — Tablero NodeMCU
   Lee /api/estado cada segundo y lo cuenta en lenguaje
   de negocio: semaforo, que pasa, que hacer y avisos.
   ====================================================== */

const API = location.protocol.startsWith("http") ? "" : "http://localhost:9091";
const $ = (id) => document.getElementById(id);

const ESTADOS = {
  verde: { color: "var(--ok)", bg: "var(--ok-bg)", txt: "Saludable",
           head: "Todo funcionando con normalidad",
           sub: "Los pedidos, el inventario y el portal responden bien." },
  ambar: { color: "var(--warn)", bg: "var(--warn-bg)", txt: "En observación",
           head: "Algo empieza a cambiar",
           sub: "Una señal se está sosteniendo más de lo normal. Aún no hay falla." },
  rojo:  { color: "var(--crit)", bg: "var(--crit-bg)", txt: "Riesgo alto",
           head: "Falla en camino: actúa ahora",
           sub: "La señal ya se sostiene como en una falla real. Hay tiempo para evitar que el cliente lo note." },
};

const fmtHora = (iso) => {
  const d = new Date(iso);
  return d.toLocaleString("es-MX", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ---------- Tema ---------- */
try { const t = localStorage.getItem("tema"); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
$("themeBtn").onclick = () => {
  const dark = getComputedStyle(document.documentElement).colorScheme === "dark";
  const t = dark ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem("tema", t); } catch (e) {}
};

/* ---------- Mini graficas (una por medida, un solo eje) ---------- */
const sparks = [...document.querySelectorAll(".spark")].map((el) => {
  el.innerHTML = `<div class="lbl">${el.dataset.titulo}</div><canvas></canvas><div class="val">–</div>`;
  return { el, canvas: el.querySelector("canvas"), val: el.querySelector(".val"), serie: [] };
});
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function dibujar(s) {
  const { canvas, el, serie } = s;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const campo = el.dataset.campo;
  const datos = serie.map((p) => p[campo]);
  const max = Math.max(+el.dataset.max, ...datos.filter((v) => v != null));
  const y = (v) => h - 3 - (v / max) * (h - 6);
  const n = Math.max(datos.length, 2);
  const x = (i) => (i / (n - 1)) * w;

  // umbral
  ctx.strokeStyle = css("--warn"); ctx.setLineDash([3, 3]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y(+el.dataset.umbral)); ctx.lineTo(w, y(+el.dataset.umbral)); ctx.stroke();
  ctx.setLineDash([]);
  // linea
  ctx.strokeStyle = css("--accent"); ctx.lineWidth = 2; ctx.lineJoin = "round";
  ctx.beginPath();
  let pen = false;
  datos.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    pen ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v));
    pen = true;
  });
  ctx.stroke();
  // crosshair
  if (s.hover != null && datos[s.hover] != null) {
    ctx.strokeStyle = css("--ink-faint"); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(s.hover), 0); ctx.lineTo(x(s.hover), h); ctx.stroke();
    ctx.fillStyle = css("--accent"); ctx.strokeStyle = css("--card"); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x(s.hover), y(datos[s.hover]), 4, 0, 7); ctx.fill(); ctx.stroke();
  }
}

sparks.forEach((s) => {
  const tip = $("tip");
  s.canvas.addEventListener("mousemove", (e) => {
    if (!s.serie.length) return;
    const r = s.canvas.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / r.width) * (s.serie.length - 1));
    s.hover = Math.max(0, Math.min(s.serie.length - 1, i));
    const p = s.serie[s.hover], v = p[s.el.dataset.campo];
    tip.hidden = false;
    tip.textContent = `${fmtHora(p.ts)} · ${v == null ? "sin dato" : v + s.el.dataset.unidad}`;
    tip.style.left = e.clientX + 12 + "px"; tip.style.top = e.clientY - 30 + "px";
    dibujar(s);
  });
  s.canvas.addEventListener("mouseleave", () => { s.hover = null; tip.hidden = true; dibujar(s); });
});

/* ---------- Pintar estado ---------- */
function pintar(d) {
  const e = ESTADOS[d.estado] || ESTADOS.verde;
  const salud = d.salud ?? 100;
  $("score").textContent = salud;
  $("score").style.color = e.color;
  $("ring").style.stroke = e.color;
  $("ring").style.strokeDashoffset = 326.7 * (1 - salud / 100);
  $("headline").textContent = e.head;
  $("subline").textContent = e.sub;
  $("badge").style.background = e.bg;
  $("badge").style.color = e.color;
  $("badgeTxt").textContent = e.txt;

  const fuente = d.fuente === "nodemcu" ? "NodeMCU en vivo" : d.cargada ? `Repetición · ${d.corrida}` : "Sin datos";
  $("fuente").textContent = fuente;
  $("pdot").style.background = (d.corriendo || d.conectada) ? e.color : "var(--ink-faint)";
  $("reloj").textContent = d.ts ? (d.fuente === "nodemcu" ? "Ahora · " : "Hora en gramo · ") + fmtHora(d.ts) : "Esperando telemetría";

  const f = d.falla_probable;
  $("whatText").innerHTML = f ? `<b>${esc(f.titulo)}</b><br>${esc(f.que_pasa)}` : "Sin novedades en los sistemas de gramo.";
  $("whatText").className = f ? "" : "muted";
  $("doText").innerHTML = f ? esc(f.accion) : "Nada por ahora. Seguimos vigilando.";
  $("doText").className = f ? "" : "muted";
  $("ventana").hidden = !d.ventana_esperada;
  if (d.ventana_esperada) $("ventana").textContent = `Pico anunciado: ${d.ventana_esperada}. Es carga esperada, no se avisa.`;

  sparks.forEach((s) => {
    s.serie = d.serie || [];
    const ult = s.serie.length ? s.serie[s.serie.length - 1][s.el.dataset.campo] : null;
    s.val.textContent = ult == null ? "–" : `${Math.round(ult)}${s.el.dataset.unidad}`;
    dibujar(s);
  });

  const av = d.avisos || [];
  $("avisos").className = av.length ? "" : "muted";
  $("avisos").innerHTML = av.length ? av.slice().reverse().map((a) => {
    const v = a.verificacion;
    let tag = "";
    if (v && v.es_real) tag = `<span class="ok-tag">✓ Falla real (${esc(v.tipo)}): avisamos ${v.anticipacion_min} min antes del pico de ${fmtHora(v.pico)}</span>`;
    else if (v) tag = `<span class="bad-tag">✗ No coincide con una falla real</span>`;
    const tg = a.telegram && a.telegram.enviado ? " · enviado por Telegram" : "";
    return `<div class="aviso"><div class="t">${esc(a.titulo)}</div>
      <div class="m">${fmtHora(a.disparo)} · ${esc(a.sistema)} · ${esc(a.detalle)}${tg}</div>
      <div class="m">Qué hacer: ${esc(a.accion)}</div>${tag}</div>`;
  }).join("") : "Todavía ningún aviso.";
  $("telegram").textContent = d.aviso_configurado ? "Los avisos salen por Telegram al responsable." :
    "Telegram sin configurar (backend/.env): los avisos se ven aquí, pero no llegan al celular.";

  const regs = d.registros || [];
  $("registros").className = regs.length ? "" : "muted";
  $("registros").innerHTML = regs.length ? regs.map((r) =>
    `<div class="log"><span class="n ${r.nivel}">${r.nivel}</span>${fmtHora(r.ts)} · <b>${esc(r.fuente)}</b> · ${esc(r.mensaje)}</div>`).join("")
    : "Sin advertencias recientes.";

  $("progreso").style.width = (d.progreso || 0) + "%";
  $("nodemcu").textContent = d.nodemcu_conectada ? "NodeMCU: conectada y enviando telemetría." : "NodeMCU: sin conexión.";
}

async function api(path, opts) {
  const r = await fetch(API + path, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
  return r.json();
}

async function refrescar() {
  try { pintar(await api("/api/estado")); } catch (e) { $("fuente").textContent = "Servidor sin respuesta"; }
}

async function cargarContexto() {
  try {
    const [c, k] = await Promise.all([api("/api/gramo/contexto"), api("/api/gramo/corridas")]);
    $("contexto").className = "";
    $("contexto").innerHTML = `<div class="small muted">${esc(c.giro)} · ${esc(c.horario)}</div>
      <ul class="ctx-list">${c.sistemas.map((s) => `<li><b>${esc(s.nombre)}</b>: ${esc(s.que_es)} <span class="muted">(crítico ${esc(s.critico)})</span></li>`).join("")}</ul>
      <div class="small"><b>Picos que NO son falla</b> (no se avisa):</div>
      <ul class="ctx-list">${c.ventanas_esperadas.map((w) => `<li>${esc(w.motivo)} · ${esc(w.dia)} ${w.ini}–${w.fin}</li>`).join("")}</ul>`;
    $("corrida").innerHTML = k.corridas.map((c) => `<option>${esc(c)}</option>`).join("");
  } catch (e) {
    $("contexto").textContent = "No se pudo leer el contexto (¿está corriendo el servidor?).";
  }
}

$("btnIniciar").onclick = () => api("/api/repeticion/iniciar", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ corrida: $("corrida").value, velocidad: $("velocidad").value }),
}).then(refrescar).catch((e) => alert(e.message));
$("btnDetener").onclick = () => api("/api/repeticion/detener", { method: "POST" }).then(refrescar);
$("btnNodeReset").onclick = () => api("/api/nodemcu/reiniciar", { method: "POST" }).then(refrescar);
$("btnProbar").onclick = () => api("/api/aviso/probar", { method: "POST" })
  .then((r) => alert(r.enviado ? "Aviso de prueba enviado." : "No se envió: " + r.motivo))
  .catch((e) => alert(e.message));

cargarContexto();
refrescar();
setInterval(refrescar, 1000);
