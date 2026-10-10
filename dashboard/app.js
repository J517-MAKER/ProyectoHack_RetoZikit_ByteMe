/* ======================================================
   SecureGuard · gramo — Logica del tablero
   Reto Zikit "Antes de que suene el telefono" — ByteMe

   Monitor, resultados y contexto leen los datos reales de
   gramo del kit Zikit a traves de server.py (/api/gramo/*).
   El simulador usa el backend si responde y, si no, corre
   la misma simulacion en el navegador.
   ====================================================== */

(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const API = location.protocol.startsWith("http") ? "" : "http://localhost:9090";

  /* =====================================================
     UTILIDADES
     ===================================================== */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const DIAS_PY = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  // Las horas del kit son hora local de gramo: se manejan en UTC para que
  // ninguna zona horaria del navegador las mueva.
  const iso = (s) => new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
  const hm = (d) => pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  const fmtDia = (d) => `${DIAS[d.getUTCDay()]} ${d.getUTCDate()}`;
  const fmtCorta = (d) => `${fmtDia(d)} · ${hm(d)}`;
  const fmtLarga = (d) => `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]} · ${hm(d)}`;
  const fmtRango = (a, b) => `${DIAS[a.getUTCDay()]} ${a.getUTCDate()} – ${DIAS[b.getUTCDay()]} ${b.getUTCDate()} ${MESES[b.getUTCMonth()]}`;
  const miles = (n) => Number(n).toLocaleString("es-MX");
  const dec = (v, d) => (v == null ? "—" : Number(v).toLocaleString("es-MX", { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 }));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ico = (id) => `<svg><use href="#${id}"/></svg>`;

  // El kit viene sin acentos; se restituyen solo para mostrar el texto de negocio.
  const ACENTOS = {
    almacen: "almacén", sabado: "sábado", Sabado: "Sábado", sabados: "sábados", Sabados: "Sábados",
    linea: "línea", Publicacion: "Publicación", publicacion: "publicación", promocion: "promoción",
    Promocion: "Promoción", mas: "más", trafico: "tráfico", Trafico: "Tráfico", Telemetria: "Telemetría",
    telemetria: "telemetría", reposicion: "reposición", ultimo: "último", empezaran: "empezarán",
    podran: "podrán", limite: "límite", critica: "crítica", criticos: "críticos", miercoles: "miércoles",
    Descripcion: "Descripción", bitacoras: "bitácoras", fallaran: "fallarán",
  };
  const bonito = (s) => String(s == null ? "" : s).replace(/[A-Za-z]+/g, (w) => ACENTOS[w] || w);
  const conCodigo = (s) => esc(bonito(s)).replace(/`([^`]+)`/g, "<code>$1</code>");
  const nombreSemana = (c) => (c === "principal" ? "Semana principal" : c.replace("corrida_", "Corrida "));

  async function api(path, opts) {
    const r = await fetch(API + path, Object.assign({ cache: "no-store" }, opts || {}));
    if (!r.ok) {
      let msg = r.statusText;
      try { msg = (await r.json()).detail || msg; } catch (e) { /* sin cuerpo */ }
      throw new Error(msg);
    }
    return r.json();
  }
  const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  let toastT = null;
  function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.hidden = true), 4200);
  }

  /* ---------- Tooltip (un solo globo para todo el tablero) ---------- */
  const tip = $("tip");
  function tipNodo(tiempo, filas, nota) {
    const box = document.createElement("div");
    const t = document.createElement("div");
    t.className = "tip-time";
    t.textContent = tiempo;
    box.appendChild(t);
    filas.forEach(([valor, etiqueta, color]) => {
      const row = document.createElement("div");
      row.className = "tip-row";
      const k = document.createElement("span");
      k.className = "tip-key";
      if (color) k.style.background = color; else k.style.visibility = "hidden";
      const v = document.createElement("span");
      v.className = "tip-val";
      v.textContent = valor;
      const l = document.createElement("span");
      l.className = "tip-lab";
      l.textContent = etiqueta;
      row.append(k, v, l);
      box.appendChild(row);
    });
    if (nota) {
      const n = document.createElement("div");
      n.className = "tip-note";
      n.textContent = nota;
      box.appendChild(n);
    }
    return box;
  }
  function mostrarTip(ev, nodo, ancla) {
    tip.replaceChildren(nodo);
    tip.hidden = false;
    let cx = ev && ev.clientX, cy = ev && ev.clientY;
    if (cx == null && ancla) { const r = ancla.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top; }
    const r = tip.getBoundingClientRect(), m = 14;
    let x = cx + m, y = cy + m;
    if (x + r.width > innerWidth - 8) x = cx - r.width - m;
    if (y + r.height > innerHeight - 8) y = cy - r.height - m;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  const ocultarTip = () => (tip.hidden = true);

  /* =====================================================
     ESTADO GLOBAL
     ===================================================== */
  const DETECTOR = { ventana: 15, ram_alta: 82, lat_muy_alta: 180, lat_alta: 125, err_fuerte: 4, err_leve: 2,
    n_ram: 12, n_lat_muy_alta: 12, n_lat_alta: 10, n_err_junto: 8, n_err_fuerte: 10, rearme_min: 240,
    umbral_ambar: 40, umbral_rojo: 65 };
  const S = {
    conectado: null, corridas: [], fuente: "", contexto: null, evaluacion: null,
    semana: null, estado: null, vista: "monitor",
    ventanaH: 6, filtroLogs: "alertas", tabla: false,
    firma: "", firmaAvisos: "", firmaTel: "", firmaLogs: "", firmaSis: "",
  };
  const cfg = () => (S.contexto && S.contexto.detector) || DETECTOR;

  /* =====================================================
     NAVEGACION, TEMA Y ESTADO DE CONEXION
     ===================================================== */
  const SUBTITULOS = {
    monitor: () => {
      if (!S.semana) return "gramo · telemetría real del kit Zikit";
      return `gramo · ${nombreSemana(S.semana.corrida)} · ${fmtRango(S.semana.t0, S.semana.tiempo(S.semana.n - 1))}`;
    },
    resultados: () => "El detector sobre todas las semanas de gramo del kit Zikit",
    negocio: () => "Lo que el kit cuenta de gramo y cómo lo usa el detector",
    simulador: () => "Fallas sintéticas en los sistemas de gramo para la demo en vivo",
  };

  function mostrarVista(v) {
    if (!SUBTITULOS[v]) v = "monitor";
    S.vista = v;
    document.querySelectorAll(".view").forEach((n) => (n.hidden = n.id !== "vista-" + v));
    document.querySelectorAll(".nav-item").forEach((a) => {
      if (a.dataset.view === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    $("tituloVista").textContent = $("vista-" + v).dataset.titulo;
    $("subtituloVista").textContent = SUBTITULOS[v]();
    $("offline").hidden = S.conectado !== false || v === "simulador";
    if (v === "monitor") requestAnimationFrame(() => { S.timeline.render(); pintarMonitor(true); });
    if (v === "resultados") requestAnimationFrame(pintarResultados);
    if (v === "negocio") requestAnimationFrame(pintarNegocio);
    if (v === "simulador") { simRedibujar(); pollHistorial(); }
  }
  window.addEventListener("hashchange", () => mostrarVista(location.hash.slice(1)));

  $("btnTema").addEventListener("click", () => {
    const sistemaOscuro = matchMedia("(prefers-color-scheme: dark)").matches;
    const actual = document.documentElement.dataset.theme || (sistemaOscuro ? "dark" : "light");
    const nuevo = actual === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nuevo;
    try { localStorage.setItem("sg-tema", nuevo); } catch (e) { /* almacenamiento bloqueado */ }
  });

  function setConectado(ok) {
    if (S.conectado === ok) return;
    S.conectado = ok;
    $("dotServidor").dataset.s = ok ? "ok" : "off";
    $("txtServidor").textContent = ok ? "Servidor conectado" : "Sin conexión al servidor";
    $("offline").hidden = ok || S.vista === "simulador";
    if (!ok) {
      $("liveTxt").textContent = "Sin servidor";
      $("livePill").dataset.modo = "pausa";
    }
  }
  function setTelegram(configurado) {
    $("dotTelegram").dataset.s = configurado ? "ok" : "off";
    $("txtTelegram").textContent = configurado ? "Telegram configurado" : "Telegram sin configurar";
  }

  /* =====================================================
     MONITOR — CONSTRUCCION
     ===================================================== */
  S.gauge = SG.gauge($("gauge"));
  S.timeline = SG.timeline($("timeline"), {
    onSeek: (i) => saltar(i),
    onHover: (i, ev) => (i == null ? ocultarTip() : mostrarTip(ev, tipMinuto(i, true))),
  });

  const GRAFICAS = [
    { k: "riesgo", nombre: "Índice de riesgo", unidad: "", max: 100, dec: 0,
      umbrales: () => [{ v: cfg().umbral_rojo, etiqueta: "aviso " + cfg().umbral_rojo }, { v: cfg().umbral_ambar, etiqueta: String(cfg().umbral_ambar), suave: true }],
      cap: () => "Nivel 80 % + tendencia; avisa con señal sostenida" },
    { k: "ram", nombre: "Memoria RAM", unidad: "%", max: 100, dec: 1,
      umbrales: () => [{ v: cfg().ram_alta, etiqueta: cfg().ram_alta + " %" }],
      cap: () => `Falla si se sostiene ≥ ${cfg().ram_alta} % (${cfg().n_ram} de ${cfg().ventana} min)` },
    { k: "latencia", nombre: "Tiempo de respuesta", unidad: "ms", maxMin: 260, dec: 0,
      umbrales: () => [{ v: cfg().lat_muy_alta, etiqueta: cfg().lat_muy_alta + " ms" }, { v: cfg().lat_alta, etiqueta: cfg().lat_alta + " ms", suave: true }],
      cap: () => `≥ ${cfg().lat_muy_alta} ms sostenido, o ≥ ${cfg().lat_alta} ms junto con errores` },
    { k: "errores", nombre: "Errores por minuto", unidad: "/min", maxMin: 10, dec: 0,
      umbrales: () => [{ v: cfg().err_fuerte, etiqueta: String(cfg().err_fuerte) }, { v: cfg().err_leve, etiqueta: String(cfg().err_leve), suave: true }],
      cap: () => `≥ ${cfg().err_fuerte}/min sostenido, o ≥ ${cfg().err_leve} junto con lentitud` },
    { k: "cpu", nombre: "CPU", unidad: "%", max: 100, dec: 1, umbrales: () => [],
      cap: () => "Contexto: acompaña la carga del negocio" },
    { k: "disco", nombre: "Disco", unidad: "%", max: 100, dec: 1, umbrales: () => [],
      cap: () => "Estable durante la semana" },
  ];

  function crearGraficas() {
    const cont = $("graficas");
    cont.innerHTML = "";
    S.graficas = GRAFICAS.map((g) => {
      const card = document.createElement("article");
      card.className = "chart-card";
      card.innerHTML = `<div class="chart-head"><div><div class="chart-name">${esc(g.nombre)}</div>
        <div class="chart-val"><span data-v>—</span><small>${esc(g.unidad)}</small></div></div>
        <div class="chart-cap" data-cap></div></div><div class="chart"></div>`;
      cont.appendChild(card);
      const chart = SG.line(card.querySelector(".chart"), {
        titulo: g.nombre, max: g.max, maxMin: g.maxMin, umbrales: [], fmtDia,
        onHover: (i, ev) => {
          if (i != null && !esCompleta() && S.estado && i > S.estado.minuto) i = null;   // el futuro aun no se ve
          S.graficas.forEach((x) => x.chart.hover(i));
          if (i == null) ocultarTip(); else mostrarTip(ev, tipMinuto(i, false));
        },
      });
      return { def: g, card, chart, val: card.querySelector("[data-v]"), cap: card.querySelector("[data-cap]") };
    });
  }
  crearGraficas();

  /* ---------- Contenido del globo para un minuto ---------- */
  function serieDe(k) { return k === "riesgo" ? S.semana.riesgo : S.semana.metricas[k]; }
  function tipMinuto(i, conRiesgo) {
    const d = S.semana;
    if (!d) return tipNodo("—", []);
    if (!esCompleta() && S.estado && i > S.estado.minuto) {
      return tipNodo(fmtLarga(d.tiempo(i)), [], "La reproducción aún no llega a este minuto. Haz clic para saltar aquí.");
    }
    const v = (k) => serieDe(k)[i];
    const f = (x, u, dd) => (x == null ? "sin dato" : dec(x, dd) + (u ? " " + u : ""));
    const filas = [];
    if (conRiesgo) filas.push([dec(v("riesgo"), 0), "índice de riesgo", null]);
    filas.push([f(v("ram"), "%", 1), "memoria RAM", conRiesgo ? null : "var(--series-1)"],
      [f(v("latencia"), "ms"), "tiempo de respuesta", conRiesgo ? null : "var(--series-1)"],
      [f(v("errores"), "/min"), "errores", conRiesgo ? null : "var(--series-1)"],
      [f(v("cpu"), "%", 1), "CPU", conRiesgo ? null : "var(--series-1)"]);
    if (!conRiesgo) filas.unshift([dec(v("riesgo"), 0), "índice de riesgo", "var(--series-1)"]);
    let nota = "";
    const ven = d.ventanas.find((w) => i >= w.i0 && i <= w.i1);
    if (ven) nota = `Pico anunciado: ${ven.motivo}. No se avisa.`;
    const av = d.avisos.find((a) => Math.abs(a.i - i) <= 20 && (esCompleta() || a.i <= S.estado.minuto));
    if (av) nota = `Aviso ${hm(iso(av.disparo))}: ${bonito(av.titulo)}`;
    const s = d.senal[i];
    if (!nota && s != null) nota = `Señal dominante: ${d.senales[s]}`;
    return tipNodo(fmtLarga(d.tiempo(i)), filas, nota);
  }

  /* =====================================================
     MONITOR — DATOS
     ===================================================== */
  async function cargarSemana(corrida) {
    const d = await api("/api/gramo/semana?corrida=" + encodeURIComponent(corrida));
    d.t0 = iso(d.inicio);
    d.tiempo = (i) => new Date(d.t0.getTime() + (d.minutos ? d.minutos[i] : i) * 60000);
    d.fmtDia = fmtDia;
    d.fmtCorta = fmtCorta;
    const tsReg = d.registros.map((r) => r.ts + "|" + r.mensaje);
    d.pistas = new Set(d.avisos.filter((a) => a.pista).map((a) => a.pista.ts + "|" + a.pista.mensaje));
    d.esPista = d.registros.map((r, k) => d.pistas.has(tsReg[k]));
    d.perdidas = (d.resumen.perdidas || []).map((p) => d.etiquetas.find((e) => e.ts === p.ts)).filter(Boolean).map((e) => e.i);
    S.semana = d;
    S.firma = S.firmaAvisos = S.firmaTel = S.firmaLogs = S.firmaSis = "";
    S.timeline.setData(d);
    pintarResumenSemana();
    $("selCorrida").value = d.corrida;
    if (S.vista === "monitor") $("subtituloVista").textContent = SUBTITULOS.monitor();
  }

  let tickT = null;
  async function tick() {
    clearTimeout(tickT);
    try {
      const e = await api("/api/gramo/estado");
      setConectado(true);
      setTelegram(e.aviso_configurado);
      if (!S.semana || S.semana.corrida !== e.corrida) await cargarSemana(e.corrida);
      S.estado = e;
      pintarCabecera(e);
      if (S.vista === "monitor") pintarMonitor(false);
      if (!S.corridas.length) cargarListas();
    } catch (err) {
      setConectado(false);
    }
    tickT = setTimeout(tick, S.estado && S.estado.corriendo ? 250 : S.conectado ? 1200 : 3000);
  }

  async function cargarListas() {
    try {
      const [corr, ctx] = await Promise.all([api("/api/gramo/corridas"), api("/api/gramo/contexto")]);
      S.corridas = corr.corridas;
      S.fuente = corr.fuente;
      S.contexto = ctx;
      const etq = corr.corridas.filter((c) => c.etiquetada).length;
      $("txtFuente").textContent = corr.fuente === "completo"
        ? `Kit Zikit · ${corr.corridas.length} semanas`
        : `Muestra del repo · ${corr.corridas.length} semana`;
      $("txtFuente").parentElement.title = corr.fuente === "completo"
        ? `Kit completo: ${etq} semanas con solución y ${corr.corridas.length - etq} de prueba`
        : "Clona zikit-dataset junto al proyecto para ver todas las semanas";
      const sel = $("selCorrida");
      sel.innerHTML = "";
      const grupos = [["Con solución (verificables)", corr.corridas.filter((c) => c.etiquetada)],
                      ["Semanas de prueba (sin solución)", corr.corridas.filter((c) => !c.etiquetada)]];
      grupos.forEach(([titulo, lista]) => {
        if (!lista.length) return;
        const g = document.createElement("optgroup");
        g.label = titulo;
        lista.forEach((c) => {
          const o = document.createElement("option");
          o.value = c.id;
          o.textContent = c.nombre;
          g.appendChild(o);
        });
        sel.appendChild(g);
      });
      if (S.semana) sel.value = S.semana.corrida;
      S.graficas.forEach((g) => (g.cap.textContent = g.def.cap()));
      if (S.vista === "negocio") pintarNegocio();
    } catch (e) { /* se reintenta en el siguiente ciclo */ }
  }

  async function pollEvaluacion() {
    try {
      const ev = await api("/api/gramo/evaluacion");
      S.evaluacion = ev;
      pintarKpis();
      if (S.vista === "resultados") pintarResultados();
      if (ev.estado === "listo") return;
    } catch (e) { /* sin servidor */ }
    setTimeout(pollEvaluacion, S.conectado ? 900 : 3000);
  }

  /* ---------- Acciones de la repeticion ---------- */
  async function accion(promesa) {
    try {
      S.estado = await promesa;
      if (!S.semana || S.semana.corrida !== S.estado.corrida) await cargarSemana(S.estado.corrida);
      pintarCabecera(S.estado);
      pintarMonitor(true);
      tick();
    } catch (e) { toast("No se pudo: " + e.message); }
  }
  const saltar = (i) => accion(post("/api/gramo/repeticion/saltar", { minuto: i }));
  const velocidad = () => (S.estado && S.estado.velocidad) || "media";

  $("btnPlay").addEventListener("click", () => {
    const e = S.estado;
    if (!e) return;
    if (e.corriendo) accion(post("/api/gramo/repeticion/pausar"));
    else if (e.minuto >= e.total - 1) accion(post("/api/gramo/repeticion/iniciar", { corrida: e.corrida, velocidad: velocidad(), desde: 0 }));
    else accion(post("/api/gramo/repeticion/reanudar"));
  });
  $("btnInicio").addEventListener("click", () => S.estado &&
    accion(post("/api/gramo/repeticion/iniciar", { corrida: S.estado.corrida, velocidad: velocidad(), desde: 0 })));
  $("btnCompleta").addEventListener("click", async () => {
    if (!S.estado) return;
    await post("/api/gramo/repeticion/pausar").catch(() => null);
    accion(post("/api/gramo/repeticion/saltar", { minuto: S.estado.total - 1 }));
  });
  $("selCorrida").addEventListener("change", (ev) => accion(post("/api/gramo/repeticion/cargar", { corrida: ev.target.value })));
  $("segVelocidad").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (b) accion(post("/api/gramo/repeticion/velocidad", { velocidad: b.dataset.v }));
  });
  $("segVentana").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    S.ventanaH = Number(b.dataset.h);
    marcarSeg($("segVentana"), b);
    pintarMonitor(true);
  });
  $("btnTabla").addEventListener("click", () => {
    S.tabla = !S.tabla;
    $("btnTabla").setAttribute("aria-pressed", String(S.tabla));
    $("btnTabla").querySelector("span").textContent = S.tabla ? "Ver gráficas" : "Ver tabla";
    pintarMonitor(true);
  });
  $("segLogs").addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b) return;
    S.filtroLogs = b.dataset.f;
    marcarSeg($("segLogs"), b);
    S.firmaLogs = "";
    pintarMonitor(true);
  });
  $("avisos").addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-ver]");
    if (!b) return;
    await post("/api/gramo/repeticion/pausar").catch(() => null);
    saltar(Number(b.dataset.ver));
    document.querySelector(".telemetry").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  function marcarSeg(seg, activo) {
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === activo)));
  }

  /* =====================================================
     MONITOR — PINTADO
     ===================================================== */
  const esCompleta = () => S.estado && !S.estado.corriendo && S.estado.minuto >= S.estado.total - 1;

  function pintarMonitor(forzar) {
    const e = S.estado, d = S.semana;
    if (!e || !d) return;
    pintarControles(e);
    pintarEstado(e);
    pintarTelefono(e);
    const firma = [d.corrida, e.minuto, e.corriendo, S.ventanaH, S.tabla].join("|");
    if (!forzar && firma === S.firma) return;
    S.firma = firma;
    S.timeline.update(e.minuto, esCompleta());
    pintarGraficas(e.minuto);
    pintarAvisos(e);
    pintarRegistros(e.minuto);
  }

  function pintarControles(e) {
    const t = S.semana.tiempo(e.minuto);
    const completa = esCompleta();
    const b = $("btnPlay");
    b.innerHTML = e.corriendo ? ico("i-pause") + "<span>Pausar</span>"
      : ico("i-play") + `<span>${completa || e.minuto === 0 ? "Reproducir la semana" : "Reanudar"}</span>`;
    marcarSeg($("segVelocidad"), $("segVelocidad").querySelector(`[data-v="${e.velocidad}"]`));
    if (document.activeElement !== $("selCorrida")) $("selCorrida").value = e.corrida;
    $("progTxt").textContent = `minuto ${miles(e.minuto + 1)} de ${miles(e.total)}`;
    $("progTxt").parentElement.title = fmtLarga(t);
    $("progBar").style.width = ((e.minuto + 1) / e.total * 100).toFixed(2) + "%";
  }

  // Reloj y estado de la reproduccion en la barra superior (todas las vistas)
  function pintarCabecera(e) {
    const completa = esCompleta();
    $("reloj").textContent = fmtLarga(S.semana.tiempo(e.minuto));
    const etiquetaVel = { lenta: "10 min/s", media: "1 h/s", rapida: "4 h/s" }[e.velocidad] || "";
    $("livePill").dataset.modo = e.corriendo ? "vivo" : completa ? "semana" : "pausa";
    $("liveTxt").textContent = e.corriendo ? `Reproduciendo · ${etiquetaVel}` : completa ? "Semana completa" : "En pausa";
  }

  const ESTADOS = {
    verde: { icono: "i-ok", txt: "Saludable" },
    ambar: { icono: "i-warn", txt: "En observación" },
    rojo: { icono: "i-crit", txt: "Riesgo alto" },
  };

  function pintarEstado(e) {
    const f = e.falla_probable;
    S.gauge.set(e.riesgo, e.estado);
    const est = ESTADOS[e.estado] || ESTADOS.verde;
    const badge = $("badgeEstado");
    badge.dataset.estado = e.estado;
    badge.innerHTML = ico(est.icono) + `<span>${est.txt}</span>`;
    let head, sub;
    if (e.estado === "rojo" && f) {
      head = "Falla en camino: conviene actuar";
      sub = `${bonito(f.titulo)}. La señal ya se sostiene como en una falla real; hay tiempo antes de que los clientes lo noten.`;
    } else if (e.estado === "ambar" && f) {
      head = "Algo empieza a cambiar";
      sub = `${bonito(f.titulo)}: la señal se sostiene más de lo normal. Aún no hay falla; seguimos vigilando.`;
    } else if (e.ventana_esperada) {
      head = "Pico anunciado en curso";
      sub = "Es carga esperada del negocio según el contexto: se vigila, pero no se avisa.";
    } else {
      head = "Todo funcionando con normalidad";
      sub = "Los pedidos, el inventario y el portal responden bien.";
    }
    $("headline").textContent = head;
    $("subline").textContent = sub;
    const nota = $("notaVentana");
    nota.hidden = !e.ventana_esperada;
    if (e.ventana_esperada) nota.querySelector("span").textContent = `${e.ventana_esperada}: pico anunciado en contexto.md`;

    pintarSistemas(e);
    pintarReglas(e.cuentas || {});

    const todo = $("queHacer");
    const pista = $("todoPista");
    todo.dataset.estado = f ? e.estado : "verde";
    todo.querySelector(".todo-t use").setAttribute("href", f ? (e.estado === "rojo" ? "#i-crit" : "#i-warn") : "#i-check");
    if (f && e.estado === "rojo") {
      $("todoTitulo").textContent = "Qué hacer ahora";
      $("todoTexto").textContent = bonito(f.accion);
    } else if (f) {
      $("todoTitulo").textContent = "Vigilar: " + bonito(f.titulo);
      $("todoTexto").textContent = bonito(f.que_pasa);
    } else if (e.ventana_esperada) {
      const k = cfg(), c = e.cuentas || {};
      const pareceFalla = c.ram >= k.n_ram || c.lat_muy_alta >= k.n_lat_muy_alta || c.err_fuerte >= k.n_err_fuerte ||
        (c.lat_alta >= k.n_lat_alta && c.err_leve >= k.n_err_junto);
      $("todoTitulo").textContent = "Carga esperada: " + e.ventana_esperada;
      $("todoTexto").textContent = pareceFalla
        ? "Las señales se ven como una falla, pero el negocio anunció este pico en su contexto. El detector lo ve y no despierta a nadie."
        : "El negocio anunció este pico. El detector lo ve, pero no despierta a nadie por él.";
    } else {
      $("todoTitulo").textContent = "Nada que hacer por ahora";
      $("todoTexto").textContent = "El detector solo avisa cuando una señal se sostiene. Un pico suelto es ruido normal del negocio.";
    }
    pista.hidden = !(f && f.pista);
    if (f && f.pista) pista.querySelector("span").textContent = `Pista en registros · ${fmtCorta(iso(f.pista.ts))} ${f.pista.nivel} ${f.pista.mensaje}`;
  }

  const SISTEMAS = [
    { id: "app-01", nombre: "API de pedidos", icono: "i-server", desc: "app-01 · API de pedidos y pedidos-worker",
      lectura: (u) => (u.ram == null ? "RAM sin dato" : `RAM ${dec(u.ram, 0)} %`) },
    { id: "inventario", nombre: "Inventario", icono: "i-database", desc: "Servidor de inventario: existencias y lotes",
      lectura: (u) => (u.latencia == null ? "respuesta sin dato" : `respuesta ${dec(u.latencia)} ms`) },
    { id: "fw-01", nombre: "Firewall fw-01", icono: "i-shield", desc: "fw-01 · publica la API por HTTPS",
      lectura: (u) => (u.errores == null ? "errores sin dato" : `${dec(u.errores)} ${u.errores === 1 ? "error" : "errores"}/min`) },
    { id: "portal", nombre: "Portal de clientes", icono: "i-globe", desc: "Pedidos en línea 24/7; depende de app-01",
      lectura: () => "pedidos 24/7" },
  ];
  function pintarSistemas(e) {
    const f = e.falla_probable;
    const u = e.ultima || {};
    const afectado = f ? f.sistema : null;
    const estados = SISTEMAS.map((s) => {
      if (s.id === afectado) return [e.estado, e.estado === "rojo" ? "Falla en camino" : "En observación"];
      if (s.id === "portal" && afectado) return ["ambar", "Depende de " + afectado];
      return ["verde", "Normal"];
    });
    const firma = estados.map((x) => x.join()).join("|") + SISTEMAS.map((s) => s.lectura(u)).join("|");
    if (firma === S.firmaSis) return;
    S.firmaSis = firma;
    $("sistemas").innerHTML = SISTEMAS.map((s, k) => `
      <div class="sys" data-estado="${estados[k][0]}" title="${esc(s.desc)}">
        <span class="sys-ico">${ico(s.icono)}</span>
        <span class="sys-body"><span class="sys-name">${esc(s.nombre)}</span><span class="sys-read">${esc(s.lectura(u))}</span></span>
        <span class="sys-state"><i></i>${esc(estados[k][1])}</span>
      </div>`).join("");
  }

  function pintarReglas(c) {
    const k = cfg();
    const reglas = [
      { nombre: `Memoria ≥ ${k.ram_alta} %`, cap: "Fuga de memoria · app-01", partes: [[c.ram, k.n_ram]] },
      { nombre: `Respuesta ≥ ${k.lat_muy_alta} ms`, cap: "Inventario saturado", partes: [[c.lat_muy_alta, k.n_lat_muy_alta]] },
      { nombre: `Respuesta ≥ ${k.lat_alta} ms + errores ≥ ${k.err_leve}`, cap: "Tráfico hostil o pool de inventario", partes: [[c.lat_alta, k.n_lat_alta], [c.err_leve, k.n_err_junto]] },
      { nombre: `Errores ≥ ${k.err_fuerte} por minuto`, cap: "Errores en cascada", partes: [[c.err_fuerte, k.n_err_fuerte]] },
    ];
    const cont = $("reglas");
    if (!cont.children.length) {
      cont.innerHTML = reglas.map((r) => `
        <div class="rule">
          <div class="rule-top"><span class="rule-name">${esc(r.nombre)}</span><span class="rule-val"></span></div>
          <div class="meters">${r.partes.map(() => '<div class="meter"><i></i></div>').join("")}</div>
          <div class="rule-cap">${esc(r.cap)}</div>
        </div>`).join("");
    }
    reglas.forEach((r, i) => {
      const nodo = cont.children[i];
      nodo.querySelector(".rule-val").textContent = r.partes.map(([v, n]) => `${v || 0} de ${n}`).join(" · ") + " min";
      nodo.querySelectorAll(".meter").forEach((m, j) => {
        const [v, n] = r.partes[j];
        const ratio = clamp((v || 0) / n, 0, 1);
        m.dataset.nivel = ratio >= 1 ? "lleno" : ratio >= 0.5 ? "medio" : "bajo";
        m.firstElementChild.style.width = (ratio * 100).toFixed(1) + "%";
      });
    });
  }

  function avisosVisibles(e) {
    const completa = esCompleta();
    return S.semana.avisos.map((a, k) => ({ a, k })).filter(({ a }) => completa || a.i <= e.minuto);
  }

  function pintarTelefono(e) {
    const vis = avisosVisibles(e);
    const firma = vis.map(({ k }) => k + ":" + JSON.stringify(e.telegram[String(k)] || {})).join("|") + e.aviso_configurado;
    if (firma === S.firmaTel) return;
    S.firmaTel = firma;
    const cuerpo = $("telefonoCuerpo");
    if (!vis.length) {
      cuerpo.innerHTML = '<div class="phone-empty">Sin avisos todavía. Cuando una falla real empiece a formarse, aquí aparece el mensaje que recibe el encargado, antes de que los clientes lo noten.</div>';
    } else {
      const { a, k } = vis[vis.length - 1];
      const tg = e.telegram[String(k)];
      const marca = tg && tg.enviado ? " ✓✓" : tg && tg.enviando ? " · enviando" : "";
      const previos = vis.length - 1;
      cuerpo.innerHTML = (previos ? `<div class="phone-prev">${previos} ${previos === 1 ? "aviso anterior" : "avisos anteriores"} esta semana</div>` : "") + `
        <div class="bubble">
          <div class="bubble-t">${ico("i-warn")}<span>${esc(bonito(a.titulo))}</span></div>
          <p>${esc(bonito(a.que_pasa))}</p>
          <p class="b-do"><b>Qué hacer:</b> ${esc(bonito(a.accion))}</p>
          <div class="bubble-meta"><span>gramo · ${esc(a.sistema)}</span><span>${esc(fmtCorta(iso(a.disparo)))}${esc(marca)}</span></div>
        </div>`;
    }
    const ultimo = vis.length ? e.telegram[String(vis[vis.length - 1].k)] : null;
    let txt;
    if (!e.aviso_configurado) txt = "Telegram sin configurar (backend/.env): el aviso se ve aquí, pero no llega al celular.";
    else if (ultimo && ultimo.enviado) txt = "Enviado al celular del responsable por Telegram.";
    else if (ultimo && ultimo.motivo) txt = "Telegram no pudo enviarlo: " + ultimo.motivo;
    else txt = "Telegram listo: los avisos salen al celular cuando la reproducción llega a ellos.";
    $("tgEstado").innerHTML = ico(e.aviso_configurado ? "i-send" : "i-info") + `<span>${esc(txt)}</span>`;
  }

  function pintarResumenSemana() {
    const r = S.semana.resumen;
    const chips = [];
    if (r.etiquetada) {
      chips.push(`<span class="chip"><b>${r.reales}</b> fallas reales</span>`);
      chips.push(`<span class="chip ${r.anticipadas === r.reales ? "ok" : "bad"}">${ico("i-check")}<b>${r.anticipadas}</b> avisadas antes del pico</span>`);
      chips.push(`<span class="chip ${r.falsas ? "bad" : "ok"}">${ico(r.falsas ? "i-x" : "i-check")}<b>${r.falsas}</b> falsas alarmas</span>`);
      if (r.anticipacion) chips.push(`<span class="chip">${ico("i-clock")}${r.anticipacion.min}–${r.anticipacion.max} min de anticipación</span>`);
    } else {
      chips.push('<span class="chip">Semana de prueba · sin solución publicada</span>');
      chips.push(`<span class="chip"><b>${r.avisos}</b> avisos del detector</span>`);
    }
    $("resumenSemana").innerHTML = chips.join("");
  }

  function pintarGraficas(cursor) {
    const d = S.semana;
    const H = S.ventanaH * 60;
    const desde = Math.max(0, Math.min(cursor - H + 1, d.n - H));
    const hasta = Math.min(d.n - 1, desde + H - 1);
    const completa = esCompleta();
    const marcas = [];
    d.avisos.forEach((a) => {
      if (completa || a.i <= cursor) marcas.push({ i: a.i, tipo: "aviso" });
      const v = a.verificacion;
      if (v && v.es_real && (completa || v.i_pico <= cursor)) marcas.push({ i: v.i_pico, tipo: "pico" });
    });
    $("telemetriaSub").textContent = `${S.ventanaH === 24 ? "Últimas 24 horas" : "Últimas 6 horas"} hasta ${fmtCorta(d.tiempo(cursor))} · un punto por minuto`;
    $("graficas").hidden = S.tabla;
    $("tablaTelemetria").hidden = !S.tabla;
    if (S.tabla) return pintarTablaTelemetria(desde, Math.min(hasta, cursor));
    S.graficas.forEach((g) => {
      const serie = serieDe(g.def.k);
      g.chart.draw({ serie, desde, hasta, limite: cursor, tiempo: d.tiempo, bandas: d.ventanas,
        marcas, umbrales: g.def.umbrales() });
      let v = null;
      for (let i = cursor; i >= desde && v == null; i--) v = serie[i];
      g.val.textContent = v == null ? "—" : dec(v, g.def.k === "riesgo" ? 0 : g.def.dec);
      if (!g.cap.textContent) g.cap.textContent = g.def.cap();
    });
  }

  function pintarTablaTelemetria(desde, hasta) {
    const d = S.semana, filas = [];
    for (let i = hasta; i >= desde; i -= 10) filas.push(i);
    const celda = (k, i, dd) => { const v = serieDe(k)[i]; return v == null ? "—" : dec(v, dd); };
    $("tablaTelemetria").innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Hora</th><th class="num">Riesgo</th><th class="num">RAM %</th><th class="num">Respuesta ms</th><th class="num">Errores/min</th><th class="num">CPU %</th><th class="num">Disco %</th><th>Contexto</th></tr></thead>
      <tbody>${filas.map((i) => {
        const ven = d.ventanas.find((w) => i >= w.i0 && i <= w.i1);
        return `<tr><td class="mono">${esc(fmtCorta(d.tiempo(i)))}</td><td class="num">${celda("riesgo", i, 0)}</td>
          <td class="num">${celda("ram", i, 1)}</td><td class="num">${celda("latencia", i)}</td><td class="num">${celda("errores", i)}</td>
          <td class="num">${celda("cpu", i, 1)}</td><td class="num">${celda("disco", i, 1)}</td><td>${ven ? esc(ven.motivo) : ""}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  function pintarAvisos(e) {
    const vis = avisosVisibles(e);
    const firma = vis.map(({ k }) => k + ":" + JSON.stringify(e.telegram[String(k)] || {})).join("|") + "|" + esCompleta() + e.aviso_configurado;
    const total = S.semana.avisos.length;
    $("avisosSub").textContent = S.semana.etiquetada
      ? `${vis.length} de ${total} avisos hasta ahora · verificados contra la solución del kit`
      : `${vis.length} de ${total} avisos · semana de prueba, sin solución para verificar`;
    if (firma === S.firmaAvisos) return;
    S.firmaAvisos = firma;
    if (!vis.length) {
      $("avisos").innerHTML = `<div class="empty">Sin avisos hasta ${esc(fmtCorta(S.semana.tiempo(e.minuto)))}. El detector solo avisa cuando una señal se sostiene; los picos anunciados no generan alarma.</div>`;
      return;
    }
    const ultimo = vis[vis.length - 1].k;
    $("avisos").innerHTML = vis.slice().reverse().map(({ a, k }) => {
      const v = a.verificacion;
      const tags = [];
      if (v && v.es_real) {
        tags.push(`<span class="tag ok">${ico("i-check")}Falla real · pico ${hm(iso(v.pico))} · ${v.anticipacion_min} min antes</span>`);
        tags.push(v.diagnostico_ok ? `<span class="tag ok">${ico("i-check")}Sistema correcto</span>` : '<span class="tag warn">Otro sistema</span>');
      } else if (v) tags.push(`<span class="tag bad">${ico("i-x")}No coincide con una falla real</span>`);
      else tags.push('<span class="tag">Sin solución para verificar</span>');
      const tg = e.telegram[String(k)];
      if (tg && tg.enviado) tags.push(`<span class="tag ok">${ico("i-send")}Enviado por Telegram</span>`);
      else if (tg && tg.enviando) tags.push('<span class="tag">Enviando…</span>');
      else if (tg) tags.push(`<span class="tag">No llegó al celular: ${esc(tg.motivo === "sin_configurar" ? "Telegram sin configurar" : tg.motivo)}</span>`);
      const destino = v && v.es_real ? Math.min(S.semana.n - 1, v.i_pico + 30) : Math.min(S.semana.n - 1, a.i + 60);
      return `<div class="alert${k === ultimo && !esCompleta() && e.estado !== "verde" ? " activo" : ""}">
        <div class="alert-h">${ico("i-bell")}<span class="alert-t">${esc(bonito(a.titulo))}</span><span class="sys-chip">${esc(a.sistema)}</span></div>
        <div class="alert-meta">
          <span>${ico("i-clock")}Aviso ${esc(fmtCorta(iso(a.disparo)))}</span>
          <span>Señal desde ${esc(hm(iso(a.inicio)))} · ${esc(a.detalle)}</span>
        </div>
        <div class="alert-body">${esc(bonito(a.que_pasa))}<br><b>Qué hacer:</b> ${esc(bonito(a.accion))}</div>
        ${a.pista ? `<div class="alert-body"><div class="pista">${ico("i-search")}<span>Pista en registros · ${esc(fmtCorta(iso(a.pista.ts)))} ${esc(a.pista.nivel)} ${esc(a.pista.mensaje)}</span></div></div>` : ""}
        <div class="alert-foot">${tags.join("")}<button class="link-btn" data-ver="${destino}">Ver en detalle ${ico("i-arrow")}</button></div>
      </div>`;
    }).join("");
  }

  function pintarRegistros(cursor) {
    const regs = S.semana.registros;
    let hi = 0, lo = 0, top = regs.length;
    while (lo < top) { const m = (lo + top) >> 1; if (regs[m].i <= cursor) lo = m + 1; else top = m; }
    hi = lo;
    const soloAlertas = S.filtroLogs === "alertas";
    const firma = hi + "|" + S.filtroLogs + "|" + S.semana.corrida;
    if (firma === S.firmaLogs) return;
    const nuevos = S.firmaLogs.split("|")[1] === S.filtroLogs && S.firmaLogs.split("|")[2] === S.semana.corrida ? Number(S.firmaLogs.split("|")[0]) : hi;
    S.firmaLogs = firma;
    let warn = 0, err = 0;
    for (let k = 0; k < hi; k++) { if (regs[k].nivel === "WARN") warn++; else if (regs[k].nivel === "ERROR") err++; }
    $("registrosSub").textContent = `${err} errores y ${warn} advertencias hasta ahora · servidor, firewall y app`;
    const lista = [];
    for (let k = hi - 1; k >= 0 && lista.length < 160; k--) {
      const r = regs[k];
      if (!soloAlertas || r.nivel === "WARN" || r.nivel === "ERROR" || S.semana.esPista[k]) lista.push([r, k]);
    }
    if (!lista.length) {
      $("registros").innerHTML = '<div class="empty">Sin advertencias ni errores hasta este momento.</div>';
      return;
    }
    $("registros").innerHTML = lista.map(([r, k]) => `
      <div class="log${k >= nuevos ? " nuevo" : ""}">
        <span class="log-t">${esc(DIAS[iso(r.ts).getUTCDay()])} ${esc(hm(iso(r.ts)))}</span>
        <span class="lvl ${esc(r.nivel)}">${esc(r.nivel)}</span>
        <span class="log-src">${esc(r.fuente)}</span>
        <span class="log-msg">${esc(r.mensaje)}${S.semana.esPista[k] ? ' <span class="tag warn">pista del aviso</span>' : ""}</span>
      </div>`).join("");
  }

  /* =====================================================
     KPIs Y RESULTADOS DEL KIT
     ===================================================== */
  function pintarKpis() {
    const ev = S.evaluacion;
    const listo = ev && ev.estado === "listo";
    document.querySelectorAll(".kpi").forEach((k) => k.classList.toggle("loading", !listo));
    if (!listo) {
      const txt = ev && ev.total ? `Calculando… ${ev.hechas} de ${ev.total} semanas` : "Calculando sobre el kit…";
      ["kpiAnticipadasSub", "rAnticipadasSub"].forEach((id) => ($(id).textContent = txt));
      return;
    }
    const ant = ev.anticipacion || {};
    const ignorados = ev.senuelos.reduce((s, x) => s + x.ignorados, 0);
    const pct = ev.reales ? Math.round(100 * ev.anticipadas / ev.reales) : 0;
    const set = (id, html, sub) => { $(id).innerHTML = html; $(id + "Sub").textContent = sub; };
    set("kpiAnticipadas", `${ev.anticipadas}<small>de ${ev.reales}</small>`,
      `${pct} % en ${ev.etiquetadas} ${ev.etiquetadas === 1 ? "semana" : "semanas"} con solución`);
    set("kpiFalsas", String(ev.falsas), `${ignorados} picos normales ignorados`);
    set("kpiAnticipacion", `${dec(ant.prom, 0)}<small>min</small>`, `antes del pico · mínimo ${ant.min} min`);
    set("kpiDiagnostico", `${ev.diagnostico_ok}<small>de ${ev.anticipadas}</small>`, "el aviso dice qué sistema revisar");
    set("rAnticipadas", `${ev.anticipadas}<small>de ${ev.reales}</small>`, `${pct} % de las fallas reales`);
    set("rFalsas", String(ev.falsas), `${ignorados} picos normales ignorados`);
    set("rAnticipacion", `${dec(ant.prom, 1)}<small>min</small>`, `mínimo ${ant.min} · máximo ${ant.max} min`);
    set("rDiagnostico", `${ev.diagnostico_ok}<small>de ${ev.anticipadas}</small>`, "pista correcta en los registros");
    set("rSemanas", String(ev.series), `${ev.etiquetadas} con solución · ${ev.prueba} de prueba`);
  }

  function pintarResultados() {
    const ev = S.evaluacion;
    pintarKpis();
    if (!ev || ev.estado !== "listo") {
      $("resLead").textContent = S.conectado === false
        ? "Sin conexión con el servidor: los resultados se calculan en server.py."
        : "Calculando: el monitor recorre minuto a minuto todas las semanas de gramo del kit…";
      return;
    }
    $("resLead").textContent = ev.fuente === "completo"
      ? `Corrimos el mismo monitor minuto a minuto sobre las ${ev.series} semanas de gramo del kit (la principal y sus corridas). En las ${ev.etiquetadas} que traen solución comparamos cada aviso con el pico real de la falla; en las ${ev.prueba} de prueba solo vemos qué avisos da.`
      : `Corrimos el monitor minuto a minuto sobre la muestra incluida en el repo (${ev.series} ${ev.series === 1 ? "semana" : "semanas"}) y comparamos cada aviso con el pico real de la falla. Clona zikit-dataset junto al proyecto para ver las 55 semanas.`;

    SG.strip($("stripPlot"), ev.por_tipo.map((t) => ({
      nombre: bonito(t.nombre),
      sub: `${t.sistema} · ${t.anticipadas} de ${t.reales} avisadas antes del pico`,
      sub2: `promedio ${dec(t.prom, 1)} min · sistema correcto ${t.diagnostico_ok}/${t.anticipadas}`,
      prom: t.prom,
      valores: t.anticipaciones.map((a) => ({ v: a.min, etiqueta: nombreSemana(a.corrida) })),
    })), {
      titulo: "Anticipación por tipo de falla",
      onHover: (p, ev2, ancla) => (p ? mostrarTip(ev2, tipNodo(p.etiqueta, [[p.v + " min", "antes del pico", "var(--series-1)"]],
        p.n > 1 ? `${p.n} semanas avisaron con ${p.v} min de anticipación` : ""), ancla) : ocultarTip()),
    });

    $("senuelos").innerHTML = ev.senuelos.map((s) => {
      // que tan fuerte fue el pico y por que no desperto a nadie (datos reales del kit)
      const p = s.pico || {}, partes = [];
      if (p.latencia != null) partes.push(`${dec(p.latencia)} ms de respuesta`);
      if (p.errores != null && p.errores > 0) partes.push(`${dec(p.errores)} errores/min`);
      if (p.cpu != null) partes.push(`${dec(p.cpu, 0)} % de CPU`);
      if (p.ram != null) partes.push(`${dec(p.ram, 0)} % de RAM`);
      return `<div class="decoy">
        <div class="decoy-top"><b>${esc(bonito(s.nombre))}</b><span>${s.ignorados} de ${s.total} sin alarma</span></div>
        <div class="meter"><i style="width:${(100 * s.ignorados / Math.max(1, s.total)).toFixed(1)}%"></i></div>
        <div class="decoy-cap">Llegó hasta ${esc(partes.join(", "))}; el índice de riesgo no pasó de ${dec(s.riesgo_max, 0)}.</div>
      </div>`;
    }).join("") || '<div class="empty">Sin eventos normales en la solución.</div>';

    const dist = Object.entries(ev.prueba_avisos || {}).map(([n, c]) => `${c} con ${n} avisos`).join(", ");
    $("pruebaSub").textContent = ev.prueba
      ? `${ev.prueba} semanas sin solución publicada · ${dist}. Mismo día, misma falla y casi la misma hora en todas.`
      : "El kit cargado no incluye semanas de prueba.";
    $("patrones").innerHTML = ev.prueba_patrones && ev.prueba_patrones.length
      ? `<div class="patterns">${ev.prueba_patrones.map((p) => `
        <div class="pattern">
          <div class="pattern-day">Cada ${esc(DIAS_PY[p.dia])}</div>
          <div class="pattern-t">${esc(bonito(p.titulo))}</div>
          <div class="pattern-v"><span><b>${p.semanas}</b> de ${ev.prueba} semanas</span><span>aviso entre <b>${esc(p.desde)}</b> y <b>${esc(p.hasta)}</b></span></div>
        </div>`).join("")}</div>`
      : '<div class="empty">Sin semanas de prueba en los datos cargados.</div>';
    pintarTablaSemanas();
  }

  function pintarTablaSemanas() {
    const ev = S.evaluacion;
    if (!ev || ev.estado !== "listo") return;
    const tipos = ev.por_tipo.map((t) => t.tipo);
    const nombres = { trafico_hostil_lento: "Tráfico hostil", fuga_memoria_worker: "Fuga de memoria", agotamiento_pool_inventario: "Pool inventario" };
    const conPrueba = $("chkPrueba").checked;
    const filas = ev.semanas.filter((s) => s.etiquetada || conPrueba);
    $("tablaSemanas").innerHTML = `<table>
      <thead><tr><th>Semana</th><th>Solución</th><th class="num">Avisos</th><th class="num">Fallas reales</th><th class="num">Anticipadas</th><th class="num">Falsas alarmas</th>
        ${tipos.map((t) => `<th class="num">${esc(nombres[t] || t)} · min</th>`).join("")}<th></th></tr></thead>
      <tbody>${filas.map((s) => {
        const porTipo = {};
        s.detalle.forEach((a) => { if (a.verificacion && a.verificacion.es_real) porTipo[a.verificacion.tipo] = a.verificacion.anticipacion_min; });
        return `<tr class="clickable" data-corrida="${esc(s.corrida)}" tabindex="0">
          <td><b>${esc(nombreSemana(s.corrida))}</b></td>
          <td>${s.etiquetada ? '<span class="tag ok">Con solución</span>' : '<span class="tag">Prueba</span>'}</td>
          <td class="num">${s.avisos}</td>
          <td class="num">${s.etiquetada ? s.reales : "—"}</td>
          <td class="num">${s.etiquetada ? s.anticipadas : "—"}</td>
          <td class="num">${s.etiquetada ? s.falsas : "—"}</td>
          ${tipos.map((t) => `<td class="num">${porTipo[t] != null ? porTipo[t] : "—"}</td>`).join("")}
          <td><span class="link-btn">Abrir ${ico("i-arrow")}</span></td>
        </tr>`;
      }).join("")}</tbody></table>`;
  }
  $("chkPrueba").addEventListener("change", pintarTablaSemanas);
  function abrirSemanaDesdeTabla(ev) {
    const tr = ev.target.closest("tr[data-corrida]");
    if (!tr) return;
    if (ev.type === "keydown" && ev.key !== "Enter") return;
    location.hash = "#monitor";
    accion(post("/api/gramo/repeticion/cargar", { corrida: tr.dataset.corrida }));
  }
  $("tablaSemanas").addEventListener("click", abrirSemanaDesdeTabla);
  $("tablaSemanas").addEventListener("keydown", abrirSemanaDesdeTabla);

  /* =====================================================
     NEGOCIO Y CONTEXTO
     ===================================================== */
  function pintarNegocio() {
    const c = S.contexto;
    if (!c) return;
    const cab = c.cabecera || {};
    $("bizGiro").textContent = bonito(cab.giro || "Distribuidora de alimentos").replace(/^./, (m) => m.toUpperCase());
    const horario = String(cab.horario || "").split(";").map((s) => s.trim().replace(/\.$/, "")).filter(Boolean);
    const datos = [];
    if (cab.empleados) datos.push(["i-users", `<b>${esc(bonito(cab.empleados).split(" ")[0])}</b> empleados ${esc(bonito(cab.empleados).replace(/^\S+\s*/, ""))}`]);
    if (horario[0]) datos.push(["i-clock", `<b>${esc(bonito(horario[0]).replace(/^./, (m) => m.toUpperCase()))}</b>`]);
    if (horario[1]) datos.push(["i-globe", esc(bonito(horario[1]).replace(/^./, (m) => m.toUpperCase()))]);
    const nota = (c.notas || []).find((n) => /telemetr/i.test(n));
    if (nota) datos.push(["i-activity", esc(bonito(nota).replace(/\.$/, ""))]);
    $("bizDatos").innerHTML = datos.map(([i, h]) => `<span class="fact">${ico(i)}<span>${h}</span></span>`).join("");

    const k = cfg();
    const VIGILA = {
      "app-01": [c.fallas.RAM.titulo, `RAM ≥ ${k.ram_alta} % sostenida ${k.n_ram} de ${k.ventana} min`],
      inventario: [c.fallas.latencia.titulo, `Respuesta ≥ ${k.lat_muy_alta} ms sostenida, o lentitud con errores y la pista «pool de conexiones» en los registros`],
      "fw-01": [c.fallas["latencia+errores"].titulo, `Respuesta ≥ ${k.lat_alta} ms y errores ≥ ${k.err_leve} juntos (${k.n_lat_alta} y ${k.n_err_junto} de ${k.ventana} min)`],
      portal: ["Sin servicio si cae la API", "Se vigila a través de app-01 y fw-01, de los que depende"],
    };
    const ICONOS = { "app-01": "i-server", inventario: "i-database", "fw-01": "i-shield", portal: "i-globe" };
    $("bizSistemas").innerHTML = (c.sistemas_monitoreados || []).map((s, i) => {
      const md = (c.sistemas || [])[i] || {};
      const [titulo, firma] = VIGILA[s.id] || ["", ""];
      return `<article class="card sys-card">
        <div class="sys-card-h"><span class="sys-ico">${ico(ICONOS[s.id] || "i-server")}</span><span class="sys-card-t">${conCodigo(md.nombre || s.nombre)}</span></div>
        <p>${conCodigo(md.descripcion || s.que_es)}</p>
        <div class="crit">${ico("i-clock")}Ventana crítica: ${esc(bonito(md.ventana_critica || s.critico))}</div>
        <div class="watch"><b>${esc(bonito(titulo))}</b>${esc(firma)}</div>
      </article>`;
    }).join("");

    const diaIdx = { lunes: 0, martes: 1, miercoles: 2, jueves: 3, viernes: 4, sabado: 5, domingo: 6 };
    const picos = [];
    (c.notas || []).forEach((n) => { if (/pico/i.test(n)) (n.match(/\d{1,2}:\d{2}/g) || []).forEach((h) => picos.push(h)); });
    S.agendaDatos = {
      horario: c.horario,
      ventanas: (c.ventanas_esperadas || []).map((w) => ({ ...w, dia: w.dia == null ? null : diaIdx[w.dia] })),
      picos,
    };
    SG.agenda($("agenda"), S.agendaDatos);
    if (!$("agenda").nextElementSibling) {
      $("agenda").insertAdjacentHTML("afterend", `<div class="agenda-legend">
        <span><i class="lk lk-hours"></i>Horario de atención</span>
        <span><i class="lk lk-band"></i>Pico anunciado o tarea nocturna (no se avisa)</span>
        <span><i class="lk" style="width:8px;height:8px;border-radius:50%;background:var(--ink)"></i>Pico de pedidos (${esc(picos.join(" y "))})</span></div>`);
    }

    // "promocion 2x1 para restaurantes (se espera ...)" -> titulo + detalle
    const mayus = (s) => s.replace(/^./, (m) => m.toUpperCase());
    const evento = (cuando, que) => {
      const t = bonito(que).trim().replace(/\.$/, "");
      const corte = t.search(/[(,]/);
      const titulo = mayus((corte > 0 ? t.slice(0, corte) : t).trim());
      const detalle = corte > 0 ? mayus(t.slice(corte).replace(/^[,\s]+/, "").replace(/^\((.*)\)$/, "$1")) : "";
      return `<div class="event"><span class="event-when">${esc(cuando)}</span>
        <span class="event-what"><b>${esc(titulo)}</b>${esc(detalle)}</span></div>`;
    };
    const eventos = (c.eventos || []).map((e) => evento(bonito(e.cuando), e.que));
    (c.ventanas_esperadas || []).filter((w) => w.dia == null).forEach((w) => eventos.push(
      evento(`Todos los días ${w.ini}–${w.fin}`, `${w.nombre} (respaldos y reportes de madrugada; ventana genérica del detector)`)));
    $("bizEventos").innerHTML = eventos.join("");

    $("bizReglas").innerHTML = `
      ${[
        ["Fuga de memoria", "RAM alta sostenida", `RAM ≥ ${k.ram_alta} % · ${k.n_ram}/${k.ventana} min`, "Crece de noche y revienta al abrir el pico de pedidos."],
        ["Inventario saturado", "Respuesta muy lenta sostenida", `≥ ${k.lat_muy_alta} ms · ${k.n_lat_muy_alta}/${k.ventana} min`, "El pool de conexiones se agota en escalones."],
        ["Tráfico hostil", "Lentitud y errores juntos", `≥ ${k.lat_alta} ms y ≥ ${k.err_leve} err · ${k.n_lat_alta} y ${k.n_err_junto}/${k.ventana}`, "La pista de los registros separa tráfico hostil (fw-01) de inventario."],
        ["Errores en cascada", "Errores fuertes sostenidos", `≥ ${k.err_fuerte} err/min · ${k.n_err_fuerte}/${k.ventana} min`, "Un fallo arrastra a otros hasta tirar el servicio."],
      ].map(([t, k1, c1, p1]) => `<div class="how-card"><div class="how-k">${esc(k1)}</div><div class="how-t">${esc(t)}</div><div class="how-c">${esc(c1)}</div><div class="how-p">${esc(p1)}</div></div>`).join("")}
      <div class="how-notes">
        <div class="how-note"><b>Señales sostenidas, no picos</b>En la telemetría normal de gramo hay minutos sueltos con más de 230 ms, 94 % de RAM o 14 errores. Por eso cuenta minutos «malos» en una ventana de ${k.ventana} min.</div>
        <div class="how-note"><b>Índice de riesgo 0–100</b>Nivel (qué tan cerca está la regla más cargada de dispararse) × 0,8 + tendencia (media móvil, hasta +35). Ámbar desde ${k.umbral_ambar}, rojo desde ${k.umbral_rojo}.</div>
        <div class="how-note"><b>Contexto y anti-duplicado</b>Dentro de un pico anunciado no avisa (±20 min). Tras un aviso guarda silencio ${k.rearme_min / 60} h para no repetir la misma falla.</div>
      </div>`;
  }

  /* =====================================================
     SIMULADOR (backend si responde; si no, en el navegador)
     ===================================================== */
  const SCN = {
    memory: { base: 12, fail: 100, senal: "la memoria de app-01",
      titulo: "Fuga de memoria en pedidos-worker", sistema: "app-01",
      que: "La memoria de app-01 sube sin bajar. Si se agota, pedidos-worker se cae y se pierden los pedidos en curso de los restaurantes.",
      proj: "A este ritmo se agotaría en unos 45 segundos.",
      accion: "Reiniciar pedidos-worker de forma controlada (drenar la cola primero) y revisar el último despliegue." },
    disk: { base: 20, fail: 100, senal: "el disco de app-01",
      titulo: "Disco de app-01 casi lleno", sistema: "app-01",
      que: "El disco donde app-01 guarda pedidos y bitácoras se está llenando. Sin espacio, la API deja de registrar pedidos.",
      proj: "A este ritmo se llenaría en unos 40 segundos.",
      accion: "Archivar bitácoras antiguas y liberar espacio antes del pico de pedidos." },
    latency: { base: 40, fail: 600, senal: "el tiempo de respuesta",
      titulo: "Inventario saturado", sistema: "inventario",
      que: "La API de pedidos tarda cada vez más porque espera al inventario. Pronto los pedidos fallarán por tiempo de espera.",
      proj: "En menos de 50 segundos sería inusable para tomar pedidos.",
      accion: "Liberar conexiones atascadas al inventario y ampliar el pool." },
    errors: { base: 0, fail: 50, senal: "la cantidad de errores",
      titulo: "Errores en cascada en la API", sistema: "app-01",
      que: "Fallan operaciones de la API de pedidos; un fallo arrastra a otros hasta dejar sin servicio al portal.",
      proj: "Podría caerse por completo en unos 45 segundos.",
      accion: "Reiniciar el servicio afectado y aislar la dependencia que falla." },
  };
  const SIM_VEL = { lenta: 0.55, media: 1, rapida: 1.7 };
  const SIM_SENS = { baja: 78, normal: 65, alta: 52 };
  const SIM = { backend: false, run: null, timer: null, vel: "media", sens: "normal", origen: "sim", espT: null };
  S.simGauge = SG.gauge($("simGauge"));
  S.simChart = SG.line($("simGrafica"), {
    titulo: "Índice de riesgo simulado", max: 100, height: 150, umbrales: [],
    ticksX: (desde, hasta) => { const out = []; for (let s = 0; s <= hasta; s += 10) out.push({ i: s, label: s + " s" }); return out; },
    onHover: (i, ev) => {
      S.simChart.hover(i);
      if (i == null || !SIM.run || SIM.run.hist[i] == null) return ocultarTip();
      mostrarTip(ev, tipNodo(`segundo ${i}`, [[dec(SIM.run.hist[i], 0), "índice de riesgo", "var(--series-1)"]]));
    },
  });

  function segmento(id, campo) {
    $(id).addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      SIM[campo] = b.dataset.v;
      marcarSeg($(id), b);
      if (campo === "origen") { $("simHw").hidden = SIM.origen !== "hw"; espLeer(); }
      if (campo === "sens") simRedibujar();
    });
  }
  segmento("simVelocidad", "vel");
  segmento("simSensibilidad", "sens");
  segmento("simOrigen", "origen");
  $("simIp").addEventListener("change", espLeer);
  $("simRun").addEventListener("click", simIniciar);
  $("simReset").addEventListener("click", () => simReiniciar(true));
  $("simResolver").addEventListener("click", simResolver);

  async function simDetectar() {
    try {
      await api("/api/estado");
      SIM.backend = true;
      $("simNota").textContent = "Conectado al servidor de monitoreo (server.py).";
    } catch (e) {
      SIM.backend = false;
      $("simNota").textContent = "Modo autónomo: la simulación corre en esta página.";
    }
  }

  function simReiniciar(avisarServidor) {
    clearInterval(SIM.timer);
    SIM.timer = null;
    if (avisarServidor && SIM.backend && SIM.run && SIM.run.modo === "backend") post("/api/simular/detener").catch(() => null);
    SIM.run = null;
    $("simRun").disabled = false;
    $("simResolver").disabled = true;
    $("simResolver").hidden = false;
    const hecho = document.querySelector(".sim-box .done");
    if (hecho) hecho.remove();
    S.simGauge.set(0, "verde");
    simBadge("verde", "Saludable");
    $("simHeadline").textContent = "Listo para simular";
    $("simSubline").textContent = "Elige una falla y presiona «Simular la falla».";
    $("simQue").textContent = "Sin novedades.";
    $("simQue").className = "muted";
    $("simAccion").textContent = "Nada por ahora.";
    $("simAccion").className = "muted";
    $("simReloj").textContent = "0 s";
    ["simDetect", "simFail", "simWin"].forEach((id) => ($(id).textContent = "—"));
    simRedibujar();
  }

  function simBadge(estado, txt) {
    const b = $("simBadge");
    b.dataset.estado = estado;
    b.innerHTML = ico(ESTADOS[estado].icono) + `<span>${txt}</span>`;
  }

  function simRedibujar() {
    const hist = SIM.run ? SIM.run.hist : [];
    const umbral = SIM.run ? SIM.run.umbral : SIM_SENS[SIM.sens];
    S.simChart.draw({
      serie: hist, desde: 0, hasta: Math.max(80, hist.length - 1), tiempo: () => new Date(0),
      bandas: [], horario: [], marcas: SIM.run && SIM.run.detectT != null ? [{ i: SIM.run.detectT, tipo: "aviso" }] : [],
      umbrales: [{ v: umbral, etiqueta: "aviso " + umbral }],
    });
  }

  async function simIniciar() {
    simReiniciar(false);
    const key = $("simEscenario").value;
    const scn = SCN[key];
    SIM.run = { modo: "local", key, scn, k: SIM_VEL[SIM.vel], umbral: SIM_SENS[SIM.sens], t: 0, hist: [],
      prev: 8, ewma: scn.base, detectT: null, failT: null, alertado: false, avisado: false, resuelto: false };
    $("simRun").disabled = true;
    $("simHeadline").textContent = "Vigilando la señal…";
    $("simSubline").textContent = `Se está degradando ${scn.senal}.`;
    if (SIM.backend) {
      try {
        await post("/api/simular/iniciar", { escenario: key, velocidad: SIM.vel, sensibilidad: SIM.sens });
        SIM.run.modo = "backend";
        SIM.timer = setInterval(simPollBackend, 350);
        return;
      } catch (e) {
        SIM.backend = false;
        $("simNota").textContent = "Se perdió el servidor; sigo en modo autónomo.";
      }
    }
    SIM.timer = setInterval(simTickLocal, 350);
  }

  async function simPollBackend() {
    try {
      const d = await api("/api/estado");
      const r = SIM.run;
      if (!r) return;
      r.t = d.t;
      r.hist = d.history || [];
      r.umbral = d.umbral;
      if (d.resultado) { r.detectT = d.resultado.detect_t; r.failT = d.resultado.fail_t; r.ventana = d.resultado.ventana_s; }
      r.aviso = d.aviso_configurado ? (d.aviso_enviado ? "Enviado a tu celular por Telegram" : d.alertado ? "No se pudo enviar al celular: " + (d.aviso_motivo || "revisa la configuración") : "") : "";
      simPintar(d.riesgo, d.estado === "ok" ? "verde" : d.estado === "warn" ? "ambar" : "rojo", d.alertado);
      if (!d.is_running) { clearInterval(SIM.timer); SIM.timer = null; $("simRun").disabled = false; simResultado(); }
    } catch (e) {
      clearInterval(SIM.timer);
      SIM.timer = null;
      $("simRun").disabled = false;
    }
  }

  function simTickLocal() {
    const r = SIM.run;
    r.t++;
    let riesgo;
    if (r.resuelto) {
      riesgo = Math.max(8, r.prev - 7);
      if (riesgo <= 10) { clearInterval(SIM.timer); SIM.timer = null; $("simRun").disabled = false; }
    } else {
      const s = r.scn, span = s.fail - s.base;
      const p = Math.min((r.t * r.k) / 42, 1.25);
      const val = Math.min(s.base + span * p * p, s.fail);
      const nivel = clamp(((val - s.base) / span) * 100, 0, 100);
      r.ewma += 0.5 * (val - r.ewma);
      const tendencia = clamp(((val - r.ewma) / span) * 100 * 1.6, 0, 35);
      riesgo = Math.max(clamp(nivel * 0.8 + tendencia, 0, 100), r.prev - 2);
      if (!r.alertado && riesgo >= r.umbral) { r.alertado = true; r.detectT = r.t; }
      if (r.failT == null && val >= s.fail) r.failT = r.t;
      if (r.failT != null || r.t > 80) { clearInterval(SIM.timer); SIM.timer = null; $("simRun").disabled = false; simResultado(); }
    }
    r.prev = riesgo;
    r.hist.push(Math.round(riesgo * 10) / 10);
    simPintar(riesgo, riesgo < 40 ? "verde" : riesgo < r.umbral ? "ambar" : "rojo", r.alertado);
  }

  function simPintar(riesgo, estado, alertado) {
    const r = SIM.run;
    S.simGauge.set(riesgo, estado);
    $("simReloj").textContent = r.t + " s";
    simRedibujar();
    if (r.resuelto) return;
    if (estado === "ambar" && !r.avisoAmbar) {
      r.avisoAmbar = true;
      simBadge("ambar", "En observación");
      $("simHeadline").textContent = "Hay una señal temprana";
      $("simSubline").textContent = "Algo empezó a comportarse distinto. Aún no afecta a nadie, pero conviene vigilarlo.";
      $("simQue").textContent = r.scn.que + " " + r.scn.proj;
      $("simQue").className = "";
    }
    if (alertado && !r.avisado) {
      r.avisado = true;
      simBadge("rojo", "Riesgo alto");
      $("simHeadline").textContent = "Conviene actuar ahora";
      $("simSubline").textContent = `${r.scn.titulo}: el aviso salió al responsable antes del punto de falla.`;
      $("simAccion").textContent = r.scn.accion;
      $("simAccion").className = "";
      $("simResolver").disabled = false;
      $("simDetect").textContent = `segundo ${r.detectT != null ? r.detectT : r.t}`;
      toast(`Aviso enviado: ${r.scn.titulo}`);
    }
    if (r.aviso && !r.avisoMostrado) { r.avisoMostrado = true; toast(r.aviso); }
  }

  function simResultado() {
    const r = SIM.run;
    if (!r) return;
    const fallo = r.failT != null ? r.failT : r.detectT != null ? r.detectT + Math.round(12 / r.k) : null;
    $("simDetect").textContent = r.detectT != null ? `segundo ${r.detectT}` : "sin aviso";
    $("simFail").textContent = fallo != null ? `segundo ${fallo}` : "—";
    $("simWin").textContent = r.detectT != null && fallo != null ? `${fallo - r.detectT} s` : "—";
  }

  async function simResolver() {
    const r = SIM.run;
    if (!r || r.resuelto) return;
    r.resuelto = true;
    $("simResolver").hidden = true;
    $("simResolver").insertAdjacentHTML("afterend", `<div class="done">${ico("i-check")}Resuelto: el riesgo se controló a tiempo</div>`);
    simBadge("verde", "Recuperando");
    $("simHeadline").textContent = "Resuelto a tiempo";
    $("simSubline").textContent = "Se aplicó el runbook antes del punto de falla. Los clientes nunca lo notaron.";
    simResultado();
    if (r.modo === "backend") { try { await post("/api/simular/resolver"); } catch (e) { /* sigue el sondeo */ } }
  }

  async function espLeer() {
    clearTimeout(SIM.espT);
    const ip = $("simIp").value.trim();
    if (SIM.origen !== "hw" || !ip) {
      $("simHwEstado").textContent = "—";
      $("espDatos").innerHTML = '<p class="muted">Elige «Equipo real (ESP32)» y escribe su IP para leer su salud en vivo.</p>';
      return;
    }
    if (!SIM.backend) { $("simHwEstado").textContent = "requiere servidor"; return; }
    $("simHwEstado").textContent = "buscando…";
    try {
      const d = await api("/api/equipo/salud?ip=" + encodeURIComponent(ip));
      if (!d.reachable || !d.salud) throw new Error("sin respuesta");
      $("simHwEstado").textContent = "conectado";
      const h = d.salud;
      const up = h.uptime_s != null ? `${Math.floor(h.uptime_s / 3600)} h ${Math.floor((h.uptime_s % 3600) / 60)} min` : "—";
      const k = [["Memoria usada", h.memoria_uso_pct != null ? dec(h.memoria_uso_pct, 1) + " %" : "—"],
        ["Heap libre", h.free_heap != null ? miles(Math.round(h.free_heap / 1024)) + " KB" : "—"],
        ["Latencia", h.latencia_ms != null ? dec(h.latencia_ms, 1) + " ms" : "—"],
        ["Encendido", up], ["WiFi", h.wifi_rssi != null ? h.wifi_rssi + " dBm" : "—"],
        ["Modo demo", h.modo_demo_activo ? "fuga activa" : "apagado"]];
      $("espDatos").innerHTML = k.map(([a, b]) => `<div class="esp-k"><span>${esc(a)}</span><b>${esc(b)}</b></div>`).join("");
    } catch (e) {
      $("simHwEstado").textContent = "sin respuesta";
      $("espDatos").innerHTML = `<p class="muted">El ESP32 en ${esc(ip)} no responde. Revisa que esté en la misma red y que el firmware muestre su IP en el monitor serie.</p>`;
    }
    if (S.vista === "simulador") SIM.espT = setTimeout(espLeer, 3000);
  }

  let histFirma = "";
  async function pollHistorial() {
    try {
      const d = await api("/api/notificaciones?limite=30");
      $("histSync").textContent = d.configurado ? "Sincronizado con Telegram" : "Telegram sin configurar: se registran, no se envían";
      setTelegram(d.configurado);
      const firma = d.avisos.map((a) => a.id + ":" + a.enviado).join(",");
      if (firma !== histFirma) {
        histFirma = firma;
        $("historial").innerHTML = d.avisos.length ? d.avisos.map((a) => `
          <div class="h-item"><span class="h-time">${esc(a.hora)}</span>
            <div><div class="h-t">${esc(bonito(a.titulo))}</div><div class="h-d">${esc(bonito(a.cuerpo))} · ${esc(a.origen)}</div></div>
            <span class="tag ${a.enviado ? "ok" : ""}">${a.enviado ? "Enviado" : "No enviado"}</span></div>`).join("")
          : '<div class="empty">Aún no se ha enviado ningún aviso.</div>';
      }
    } catch (e) {
      $("histSync").textContent = "Sin conexión al servidor";
      if (!histFirma) $("historial").innerHTML = '<div class="empty">El historial vive en el servidor.</div>';
    }
    if (S.vista === "simulador") setTimeout(pollHistorial, 2500);
  }
  $("btnProbarAviso").addEventListener("click", async () => {
    try {
      const r = await post("/api/aviso/probar");
      toast(r.enviado ? "Aviso de prueba enviado a Telegram." : "No se envió: " + (r.motivo || "error"));
      pollHistorial();
    } catch (e) { toast(e.message); }
  });

  /* =====================================================
     ARRANQUE
     ===================================================== */
  let rz = null;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(rz);
    rz = requestAnimationFrame(() => {
      if (S.vista === "monitor" && S.semana) { S.timeline.render(); S.timeline.update(S.estado.minuto, esCompleta()); pintarGraficas(S.estado.minuto); }
      if (S.vista === "resultados") pintarResultados();
      if (S.vista === "negocio" && S.agendaDatos) SG.agenda($("agenda"), S.agendaDatos);
      if (S.vista === "simulador") simRedibujar();
    });
  });
  ro.observe(document.querySelector(".main"));

  simReiniciar(false);
  mostrarVista(location.hash.slice(1) || "monitor");
  cargarListas();
  tick();
  pollEvaluacion();
  simDetectar();
})();
