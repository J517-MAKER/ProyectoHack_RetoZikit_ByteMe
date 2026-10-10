/* ======================================================
   SecureGuard · gramo — Tablero NodeMCU
   Lee /api/estado cada segundo (la fuente activa: la NodeMCU
   si esta conectada; si no, la repeticion del kit) y lo cuenta
   en lenguaje de negocio, con el mismo diseno del tablero
   principal (dashboard/style.css y dashboard/charts.js).
   ====================================================== */

(function () {
  "use strict";
  // Este mismo archivo corre en dos lugares:
  //  - su pagina propia (/nodemcu/), con los IDs tal cual;
  //  - la vista "Tablero NodeMCU" del tablero principal, que lo carga con
  //    <script src="nodemcu/app.js" data-prefijo="nm-" data-api="/nodemcu">.
  const script = document.currentScript;
  const P = (script && script.dataset.prefijo) || "";
  const enHttp = location.protocol.startsWith("http");
  const API = script && script.dataset.api ? script.dataset.api   // p. ej. http://<host>:9091
    : enHttp ? new URL(".", location.href).pathname.replace(/\/$/, "") : "http://localhost:9091";
  // Elementos que la vista incrustada no tiene (reloj, tema, barra lateral...):
  // se usa un nodo suelto para que el resto del codigo no tenga que preguntar.
  const fantasmas = {};
  const fantasma = (id) => fantasmas[id] || (fantasmas[id] = Object.assign(document.createElement("div"), { innerHTML: "<svg><use/></svg>" }));
  const COMPARTIDOS = { tip: 1, toast: 1 };   // globo y aviso emergente: los del tablero principal
  const $ = (id) => document.getElementById(COMPARTIDOS[id] ? id : P + id) || fantasma(id);

  /* ---------- Utilidades ---------- */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const iso = (s) => new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");   // hora local de gramo, sin zona
  const hm = (d) => pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes());
  const fmtCorta = (d) => `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} · ${hm(d)}`;
  const fmtLarga = (d) => `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]} · ${hm(d)}`;
  const dec = (v, d) => (v == null ? "—" : Number(v).toLocaleString("es-MX", { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 }));
  const ico = (id) => `<svg><use href="#${id}"/></svg>`;
  const ACENTOS = { linea: "línea", mas: "más", trafico: "tráfico", Trafico: "Tráfico", ultimo: "último",
    empezaran: "empezarán", podran: "podrán", limite: "límite", promocion: "promoción", sabado: "sábado",
    reposicion: "reposición", Telemetria: "Telemetría" };
  const bonito = (s) => String(s == null ? "" : s).replace(/[A-Za-z]+/g, (w) => ACENTOS[w] || w);
  const ventana = (m) => (/promo/i.test(m) ? "Promoción 2x1" : /snapshot/i.test(m) ? "Snapshot de inventario"
    : /nocturn/i.test(m) ? "Tareas nocturnas" : bonito(m));

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

  $("btnTema").addEventListener("click", () => {
    const sistemaOscuro = matchMedia("(prefers-color-scheme: dark)").matches;
    const actual = document.documentElement.dataset.theme || (sistemaOscuro ? "dark" : "light");
    const nuevo = actual === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = nuevo;
    try { localStorage.setItem("sg-tema", nuevo); } catch (e) { /* almacenamiento bloqueado */ }
  });

  /* ---------- Sonido de alerta (semaforo en rojo) ---------- */
  // El navegador solo deja sonar audio despues de un clic: el boton de la
  // bocina activa el sonido y la preferencia se recuerda en este equipo.
  let audio = null;
  let sonidoOn = false;
  try { sonidoOn = localStorage.getItem("sg-sonido") === "1"; } catch (e) { /* almacenamiento bloqueado */ }
  let enRojo = false, ultimoPitido = 0;
  const REPETIR_MS = 8000;   // mientras siga en rojo, la alarma se repite

  function pintarBotonSonido() {
    const b = $("btnSonido");
    b.setAttribute("aria-pressed", String(sonidoOn));
    const txt = sonidoOn ? "Silenciar alerta sonora" : "Activar sonido de alerta";
    b.setAttribute("aria-label", txt);
    b.title = txt;
    b.querySelector("use").setAttribute("href", sonidoOn ? "#i-vol" : "#i-vol-off");
  }

  function alarma() {
    if (!sonidoOn) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
      const t0 = audio.currentTime + 0.02;
      // tres pitidos dobles, agudo-grave, como una sirena corta
      for (let k = 0; k < 3; k++) {
        [[988, 0], [740, 0.16]].forEach(([f, dt]) => {
          const o = audio.createOscillator(), g = audio.createGain();
          const t = t0 + k * 0.42 + dt;
          o.type = "square";
          o.frequency.value = f;
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
          o.connect(g).connect(audio.destination);
          o.start(t);
          o.stop(t + 0.15);
        });
      }
    } catch (e) { /* sin audio en este navegador */ }
  }

  function revisarAlarma(rojo) {
    const ahora = Date.now();
    if (rojo && (!enRojo || ahora - ultimoPitido >= REPETIR_MS)) {
      if (!enRojo) toast("¡Semáforo en rojo! Revisa el aviso y actúa.");
      alarma();
      ultimoPitido = ahora;
    }
    enRojo = rojo;
    $("btnSonido").toggleAttribute("data-sonando", rojo && sonidoOn);
  }

  $("btnSonido").addEventListener("click", () => {
    sonidoOn = !sonidoOn;
    try { localStorage.setItem("sg-sonido", sonidoOn ? "1" : "0"); } catch (e) { /* almacenamiento bloqueado */ }
    pintarBotonSonido();
    if (sonidoOn) { alarma(); toast("Sonido activado: sonará cuando el semáforo esté en rojo."); }
    else toast("Alerta sonora silenciada.");
    $("btnSonido").toggleAttribute("data-sonando", enRojo && sonidoOn);
  });
  pintarBotonSonido();
  // si quedo activado de antes, el primer clic en la pagina desbloquea el audio
  document.addEventListener("pointerdown", () => {
    if (sonidoOn && !audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* sin audio */ } }
  }, { once: true });

  /* ---------- Globo de las graficas ---------- */
  const tip = $("tip");
  function mostrarTip(ev, punto) {
    tip.replaceChildren();
    const t = document.createElement("div");
    t.className = "tip-time";
    t.textContent = fmtLarga(iso(punto.ts));
    tip.appendChild(t);
    [["riesgo", "índice de riesgo", ""], ["ram", "memoria RAM", " %"], ["latencia", "tiempo de respuesta", " ms"], ["errores", "errores", "/min"]]
      .forEach(([k, etiqueta, u]) => {
        const row = document.createElement("div");
        row.className = "tip-row";
        const key = document.createElement("span");
        key.className = "tip-key";
        const v = document.createElement("span");
        v.className = "tip-val";
        v.textContent = punto[k] == null ? "sin dato" : dec(punto[k], k === "ram" ? 1 : 0) + u;
        const l = document.createElement("span");
        l.className = "tip-lab";
        l.textContent = etiqueta;
        row.append(key, v, l);
        tip.appendChild(row);
      });
    tip.hidden = false;
    const r = tip.getBoundingClientRect(), m = 14;
    let x = ev.clientX + m, y = ev.clientY + m;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - m;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - m;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }

  /* ---------- Componentes ---------- */
  const gauge = SG.gauge($("gauge"));
  const GRAFICAS = [
    { k: "riesgo", nombre: "Índice de riesgo", unidad: "", max: 100, umbrales: [{ v: 65 }, { v: 40, suave: true }], cap: "Avisa con señal sostenida" },
    { k: "ram", nombre: "Memoria RAM", unidad: "%", max: 100, umbrales: [{ v: 82 }], cap: "≥ 82 % sostenido" },
    { k: "latencia", nombre: "Tiempo de respuesta", unidad: "ms", maxMin: 260, umbrales: [{ v: 180 }, { v: 125, suave: true }], cap: "≥ 180 ms sostenido" },
    { k: "errores", nombre: "Errores por minuto", unidad: "/min", maxMin: 10, umbrales: [{ v: 4 }, { v: 2, suave: true }], cap: "≥ 4/min sostenido" },
  ];
  let serie = [];
  let enVivo = false;
  const hora = (s) => { const d = iso(s); return enVivo ? `${hm(d)}:${pad(d.getUTCSeconds())}` : hm(d); };
  const graficas = GRAFICAS.map((g) => {
    const card = document.createElement("article");
    card.className = "chart-card";
    card.innerHTML = `<div class="chart-head"><div><div class="chart-name">${esc(g.nombre)}</div>
      <div class="chart-val"><span data-v>—</span><small>${esc(g.unidad)}</small></div></div>
      <div class="chart-cap">${esc(g.cap)}</div></div><div class="chart"></div>`;
    $("graficas").appendChild(card);
    const chart = SG.line(card.querySelector(".chart"), {
      titulo: g.nombre, max: g.max, maxMin: g.maxMin, umbrales: g.umbrales,
      // la placa manda cada 2 s y la repeticion cada minuto: marcas por posicion, rotuladas con la hora
      ticksX: (desde, hasta) => [0, 1, 2, 3, 4].map((k) => Math.round(desde + (k * (hasta - desde)) / 4))
        .filter((i, k, a) => a.indexOf(i) === k && serie[i]).map((i) => ({ i, label: hora(serie[i].ts) })),
      onHover: (i, ev) => {
        graficas.forEach((x) => x.chart.hover(i));
        if (i == null || !serie[i]) tip.hidden = true; else mostrarTip(ev, serie[i]);
      },
    });
    return { def: g, chart, val: card.querySelector("[data-v]") };
  });

  /* ---------- Temperatura de la placa (LM35) ---------- */
  // mismos umbrales que el firmware: 25 precaucion temprana, 27 activa (rele), 29 critico
  const TERMICO = {
    OK: { estado: "verde", icono: "i-ok", txt: "Normal" },
    PRECAUCION_TEMPRANA: { estado: "ambar", icono: "i-warn", txt: "Precaución temprana" },
    PRECAUCION_ACTIVA: { estado: "ambar", icono: "i-warn", txt: "Precaución activa" },
    CRITICO: { estado: "rojo", icono: "i-crit", txt: "Crítico" },
  };
  let serieTemp = [];
  const horaSeg = (s) => { const d = iso(s); return `${hm(d)}:${pad(d.getUTCSeconds())}`; };
  const graficaTemp = SG.line($("tempChart"), {
    titulo: "Temperatura", maxMin: 35, height: 150,
    umbrales: [{ v: 29 }, { v: 27, suave: true }, { v: 25, suave: true }],
    ticksX: (desde, hasta) => [0, 1, 2, 3, 4].map((k) => Math.round(desde + (k * (hasta - desde)) / 4))
      .filter((i, k, a) => a.indexOf(i) === k && serieTemp[i]).map((i) => ({ i, label: horaSeg(serieTemp[i].ts) })),
    onHover: (i, ev) => {
      graficaTemp.hover(i);
      const p = i == null ? null : serieTemp[i];
      if (!p) { tip.hidden = true; return; }
      tip.replaceChildren();
      const t = document.createElement("div");
      t.className = "tip-time";
      t.textContent = horaSeg(p.ts);
      const row = document.createElement("div");
      row.className = "tip-row";
      row.innerHTML = `<span class="tip-key"></span><span class="tip-val">${esc(dec(p.temperatura, 1))} °C</span><span class="tip-lab">${esc((TERMICO[p.estado] || TERMICO.OK).txt)}</span>`;
      tip.append(t, row);
      tip.hidden = false;
      tip.style.left = Math.min(ev.clientX + 14, innerWidth - tip.offsetWidth - 8) + "px";
      tip.style.top = Math.min(ev.clientY + 14, innerHeight - tip.offsetHeight - 8) + "px";
    },
  });

  function pintarTemperatura(t) {
    t = t || {};
    serieTemp = t.serie || [];
    const hay = t.temperatura != null;
    const s = TERMICO[t.estado] || TERMICO.OK;
    $("tempVal").textContent = hay ? dec(t.temperatura, 1) : "—";
    $("tempSub").textContent = t.conectada ? "Sensor LM35 de la NodeMCU · en tiempo real"
      : hay ? "Placa sin conexión: última lectura recibida" : "Esperando la primera lectura de la NodeMCU";
    const tarjeta = $("tempVal").closest(".temp-card");
    if (tarjeta) tarjeta.toggleAttribute("data-sin-datos", !t.conectada);
    const badge = $("tempBadge");
    badge.dataset.estado = hay ? s.estado : "verde";
    badge.innerHTML = ico(hay ? s.icono : "i-info") + `<span>${hay ? s.txt : "Sin lectura"}</span>`;
    const temps = serieTemp.map((p) => p.temperatura);
    const filas = [
      ["Ventilación (relé)", t.rele == null ? "—" : t.rele ? "ENCENDIDA" : "apagada"],
      ["Mín · máx", temps.length ? `${dec(Math.min(...temps), 1)} · ${dec(Math.max(...temps), 1)} °C` : "—"],
      ["Última lectura", t.ts ? horaSeg(t.ts) : "—"],
    ];
    $("tempDatos").innerHTML = filas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
    graficaTemp.draw({ serie: temps, desde: 0, hasta: Math.max(1, temps.length - 1),
      tiempo: (i) => iso(serieTemp[i] ? serieTemp[i].ts : "2026-01-01T00:00:00") });
  }

  /* ---------- Pintado ---------- */
  const ESTADOS = {
    verde: { icono: "i-ok", txt: "Saludable", luz: "Verde · todo bien", head: "Todo funcionando con normalidad",
      sub: "Los pedidos, el inventario y el portal responden bien." },
    ambar: { icono: "i-warn", txt: "En observación", luz: "Ámbar · vigilar", head: "Algo empieza a cambiar",
      sub: "Una señal se sostiene más de lo normal. Aún no hay falla." },
    rojo: { icono: "i-crit", txt: "Riesgo alto", luz: "Rojo · actuar ahora", head: "Falla en camino: conviene actuar",
      sub: "La señal ya se sostiene como en una falla real; hay tiempo antes de que los clientes lo noten." },
  };
  let firmaAvisos = "";

  function pintar(d) {
    const hayDatos = d.fuente === "nodemcu" || d.cargada;
    const e = ESTADOS[d.estado] || ESTADOS.verde;
    const f = d.falla_probable;

    // cabecera y barra lateral
    const pill = $("livePill");
    if (d.fuente === "nodemcu") { pill.dataset.modo = "vivo"; $("liveTxt").textContent = "NodeMCU en vivo"; }
    else if (d.cargada) {
      pill.dataset.modo = d.corriendo ? "vivo" : "pausa";
      $("liveTxt").textContent = d.corriendo ? `Repetición · ${d.corrida}` : "Repetición detenida";
    } else { pill.dataset.modo = "pausa"; $("liveTxt").textContent = "Sin datos"; }
    $("reloj").textContent = d.ts ? fmtLarga(iso(d.ts)) : "—";
    $("dotPlaca").dataset.s = d.nodemcu_conectada ? "ok" : "off";
    $("txtPlaca").textContent = d.nodemcu_conectada ? "NodeMCU conectada" : "NodeMCU sin conexión";
    $("dotTelegram").dataset.s = d.aviso_configurado ? "ok" : "off";
    $("txtTelegram").textContent = d.aviso_configurado ? "Telegram configurado" : "Telegram sin configurar";

    // estado
    gauge.set(d.riesgo || 0, d.estado || "verde");
    $("badge").dataset.estado = d.estado || "verde";
    $("badge").innerHTML = ico(e.icono) + `<span>${e.txt}</span>`;
    $("headline").textContent = hayDatos ? e.head : "Esperando telemetría";
    $("subline").textContent = !hayDatos ? "Conecta la NodeMCU o reproduce una semana del kit."
      : f ? `${bonito(f.titulo)}. ${bonito(f.que_pasa)}` : e.sub;
    $("nota").hidden = !d.ventana_esperada;
    if (d.ventana_esperada) $("nota").querySelector("span").textContent = `${ventana(d.ventana_esperada)}: pico anunciado, no se avisa`;
    const todo = $("queHacer");
    todo.dataset.estado = f ? d.estado : "verde";
    todo.querySelector("use").setAttribute("href", f ? (d.estado === "rojo" ? "#i-crit" : "#i-warn") : "#i-check");
    $("todoTitulo").textContent = f ? (d.estado === "rojo" ? "Qué hacer ahora" : "Vigilar: " + bonito(f.titulo)) : "Nada que hacer por ahora";
    $("todoTexto").textContent = f ? bonito(f.accion) : "El detector solo avisa cuando una señal se sostiene; un pico suelto es ruido normal.";

    // semaforo de la placa: el mismo LED que esta encendido en fisico. El
    // firmware deja que la temperatura mande sobre el servidor (CRITICO -> rojo,
    // PRECAUCION -> ambar), asi que aqui se aplica la misma regla.
    const sem = $("semaforo");
    const tm = d.fuente === "nodemcu" && d.termico && d.termico.conectada ? d.termico.estado : null;
    const luzFisica = tm === "CRITICO" ? "rojo" : tm && tm.startsWith("PRECAUCION") ? "ambar" : d.estado || "verde";
    const porTemp = luzFisica !== (d.estado || "verde");
    const eLuz = ESTADOS[luzFisica] || ESTADOS.verde;
    sem.dataset.estado = luzFisica;
    sem.toggleAttribute("data-apagado", !hayDatos);
    const txtLuz = eLuz.luz + (porTemp ? ` (por temperatura: ${dec(d.termico.temperatura, 1)} °C)` : "");
    sem.setAttribute("aria-label", "Semáforo: " + (hayDatos ? txtLuz : "apagado"));
    $("semEstado").textContent = hayDatos ? txtLuz : "Apagado · sin datos";
    const filas = [];
    if (d.fuente === "nodemcu") {
      const p = d.placa || {};
      filas.push(["Placa", p.id || "—"], ["IP", p.ip || "—"],
        ["Heap libre", p.heap_libre != null ? dec(p.heap_libre / 1024, 1) + " KB" : "—"],
        ["Envíos procesados", dec(d.minutos)], ["RAM reportada", d.ultima && d.ultima.ram != null ? dec(d.ultima.ram, 1) + " %" : "—"]);
      $("semSub").textContent = "La placa está conectada: estos son sus LED ahora mismo";
    } else {
      filas.push(["Fuente", d.cargada ? "Repetición del kit" : "—"], ["Semana", d.corrida || "—"],
        ["Avisos", String((d.avisos || []).length)], ["Placa", d.nodemcu_conectada ? "conectada" : "sin conexión"]);
      $("semSub").textContent = "Sin placa conectada: el semáforo sigue la repetición";
    }
    $("placa").innerHTML = filas.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");

    // progreso de la repeticion
    $("progBar").style.width = (d.progreso || 0) + "%";
    $("progTxt").textContent = d.cargada && d.fuente !== "nodemcu"
      ? `minuto ${dec(d.minutos)} de ${dec(d.total_minutos)}` : d.fuente === "nodemcu" ? "telemetría en vivo" : "—";

    // graficas
    serie = d.serie || [];
    enVivo = d.fuente === "nodemcu";
    $("senalesSub").textContent = d.fuente === "nodemcu" ? "Últimos envíos de la placa (cada envío cuenta como un minuto)"
      : `Últimas ${Math.max(1, Math.round(serie.length / 60))} h de la semana ${d.corrida || ""}`;
    graficas.forEach((g) => {
      const datos = serie.map((p) => p[g.def.k]);
      g.chart.draw({ serie: datos, desde: 0, hasta: Math.max(1, datos.length - 1), tiempo: (i) => iso(serie[i] ? serie[i].ts : d.ts || "2026-01-01T00:00:00") });
      const ult = datos.length ? datos[datos.length - 1] : null;
      g.val.textContent = ult == null ? "—" : dec(ult, g.def.k === "ram" ? 1 : 0);
    });

    pintarTemperatura(d.termico);
    // rojo del semaforo del servidor, o temperatura critica (LED rojo de la placa)
    const termicoCritico = !!(d.termico && d.termico.conectada && d.termico.estado === "CRITICO");
    revisarAlarma((hayDatos && d.estado === "rojo") || termicoCritico);
    pintarAvisos(d);
    const regs = d.registros || [];
    $("registros").innerHTML = regs.length ? regs.map((r) => `
      <div class="log"><span class="log-t">${esc(DIAS[iso(r.ts).getUTCDay()])} ${esc(hm(iso(r.ts)))}</span>
        <span class="lvl ${esc(r.nivel)}">${esc(r.nivel)}</span><span class="log-src">${esc(r.fuente)}</span>
        <span class="log-msg">${esc(r.mensaje)}</span></div>`).join("")
      : '<div class="empty">Sin advertencias recientes.</div>';
  }

  function pintarAvisos(d) {
    const av = d.avisos || [];
    $("tgTxt").textContent = d.aviso_configurado ? "Los avisos salen por Telegram al responsable"
      : "Telegram sin configurar (backend/.env): se ven aquí, no llegan al celular";
    const firma = JSON.stringify(av.map((a) => [a.disparo, a.telegram]));
    if (firma === firmaAvisos) return;
    firmaAvisos = firma;
    $("avisos").innerHTML = av.length ? av.slice().reverse().map((a) => {
      const v = a.verificacion, tags = [];
      if (v && v.es_real) tags.push(`<span class="tag ok">${ico("i-check")}Falla real · avisamos ${v.anticipacion_min} min antes del pico de las ${hm(iso(v.pico))}</span>`);
      else if (v) tags.push(`<span class="tag bad">${ico("i-x")}No coincide con una falla real</span>`);
      if (a.telegram && a.telegram.enviado) tags.push(`<span class="tag ok">${ico("i-send")}Enviado por Telegram</span>`);
      return `<div class="alert">
        <div class="alert-h">${ico("i-bell")}<span class="alert-t">${esc(bonito(a.titulo))}</span><span class="sys-chip">${esc(a.sistema)}</span></div>
        <div class="alert-meta"><span>${ico("i-clock")}Aviso ${esc(fmtCorta(iso(a.disparo)))}</span><span>${esc(a.detalle)}</span></div>
        <div class="alert-body">${esc(bonito(a.que_pasa))}<br><b>Qué hacer:</b> ${esc(bonito(a.accion))}</div>
        ${tags.length ? `<div class="alert-foot">${tags.join("")}</div>` : ""}
      </div>`;
    }).join("") : '<div class="empty">Todavía ningún aviso.</div>';
  }

  /* ---------- Datos ---------- */
  async function refrescar() {
    try {
      pintar(await api("/api/estado"));
      $("offline").hidden = true;
      $("dotServidor").dataset.s = "ok";
      $("txtServidor").textContent = "Servidor conectado";
    } catch (e) {
      $("offline").hidden = false;
      $("dotServidor").dataset.s = "off";
      $("txtServidor").textContent = "Sin conexión al servidor";
    }
  }

  async function cargarContexto() {
    try {
      const [c, k] = await Promise.all([api("/api/gramo/contexto"), api("/api/gramo/corridas")]);
      $("ctxSub").textContent = `${bonito(c.giro)} · ${bonito(c.horario)}`;
      const dias = { lunes: "lun", martes: "mar", miercoles: "mié", jueves: "jue", viernes: "vie", sabado: "sáb", domingo: "dom" };
      $("contexto").innerHTML = `<div class="ctx-sys">${c.sistemas.map((s) => `
          <div class="ctx-item"><b>${esc(bonito(s.nombre))}</b><p>${esc(bonito(s.que_es))}</p><span>Crítico: ${esc(s.critico)}</span></div>`).join("")}</div>
        <div class="ctx-picos">${c.ventanas_esperadas.map((w) => `<span class="chip">${ico("i-calendar")}${esc(ventana(w.motivo))} · ${esc(dias[w.dia] || "todos los días")} ${esc(w.ini)}–${esc(w.fin)}</span>`).join("")}
          ${(c.picos_normales || []).map((p) => `<span class="chip">${ico("i-clock")}Pico de pedidos ${esc(bonito(p))}</span>`).join("")}</div>`;
      $("selCorrida").innerHTML = k.corridas.map((id) => `<option value="${esc(id)}">${esc(id === "principal" ? "Semana principal" : id.replace("corrida_", "Corrida "))}</option>`).join("");
    } catch (e) {
      $("contexto").innerHTML = '<div class="empty">No se pudo leer el contexto (¿está corriendo el servidor?).</div>';
    }
  }

  function accion(p, ok) {
    p.then((r) => { if (ok) toast(typeof ok === "function" ? ok(r) : ok); refrescar(); }).catch((e) => toast(e.message));
  }
  $("btnIniciar").addEventListener("click", () => accion(post("/api/repeticion/iniciar", { corrida: $("selCorrida").value, velocidad: $("selVelocidad").value })));
  $("btnDetener").addEventListener("click", () => accion(post("/api/repeticion/detener")));
  $("btnNodeReset").addEventListener("click", () => accion(post("/api/nodemcu/reiniciar"), "Monitor de la placa reiniciado."));
  $("btnProbar").addEventListener("click", () => accion(post("/api/aviso/probar"),
    (r) => (r.enviado ? "Aviso de prueba enviado a Telegram." : "No se envió: " + (r.motivo || "error"))));

  cargarContexto();
  refrescar();
  setInterval(refrescar, 1000);
})();
