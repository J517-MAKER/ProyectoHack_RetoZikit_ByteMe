/* ======================================================
   SecureGuard — Logica del tablero
   Reto Zikit "Antes de que suene el telefono" — ByteMe

   Intenta usar el backend real (server.py). Si no responde,
   corre la misma simulacion en el navegador, para que la
   demo funcione siempre, con o sin servidor.
   ====================================================== */

(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const RING_LEN = 2 * Math.PI * 52;
  const API = ""; // mismo origen cuando lo sirve server.py

  // ---- Tema ----
  $("themeBtn").addEventListener("click", () => {
    const r = document.documentElement;
    r.setAttribute("data-theme", r.getAttribute("data-theme") === "dark" ? "light" : "dark");
  });

  // ---- Escenarios (espejo del backend, para el modo sin servidor) ----
  const SCN = {
    memory: { driver: "mem", base: 12, fail: 100, senal: "la memoria de la caja",
      what: "La caja registradora está consumiendo cada vez más memoria. Si llega al límite, se reinicia y se pierde la venta en curso.",
      proj: "A este ritmo llegaría al límite en unos 45 segundos.",
      alertT: "Revisa la Caja 1",
      alertB: "La caja principal se está quedando sin memoria y podría reiniciarse pronto. Conviene actuar ahora, antes de que se caiga en plena venta.",
      act: "Liberar memoria y reiniciar el programa de la caja (sin perder la venta actual)." },
    disk: { driver: "mem", base: 20, fail: 100, senal: "el espacio del servidor",
      what: "El servidor donde se guardan las ventas y facturas se está llenando. Sin espacio, deja de registrar operaciones.",
      proj: "A este ritmo se llenaría en unos 40 segundos.",
      alertT: "El servidor casi sin espacio",
      alertB: "El disco del servidor está por llenarse. Si se llena, dejará de guardar ventas y facturas. Conviene liberar espacio ahora.",
      act: "Liberar espacio y archivar registros antiguos de forma automática." },
    latency: { driver: "lat", base: 40, fail: 600, senal: "el tiempo de respuesta",
      what: "El sistema está respondiendo cada vez más lento. Los cobros empiezan a tardar y los clientes esperan.",
      proj: "En menos de 50 segundos sería demasiado lento para cobrar.",
      alertT: "El sistema va lento",
      alertB: "Los tiempos de respuesta están subiendo rápido. Antes de que sea inusable para cobrar, conviene revisarlo.",
      act: "Liberar conexiones atascadas y ampliar el recurso del servidor." },
    errors: { driver: "err", base: 0, fail: 50, senal: "la cantidad de errores",
      what: "Están empezando a fallar operaciones sueltas. Un fallo puede arrastrar a otros hasta detener el servicio.",
      proj: "Podría caerse por completo en unos 45 segundos.",
      alertT: "Fallos en aumento",
      alertB: "Están apareciendo errores cada vez más seguido. Si no se corta, el servicio puede caerse del todo.",
      act: "Reiniciar el servicio afectado y aislar el fallo antes de que se extienda." },
  };
  const SPEED = { 1: { l: "Lenta", k: 0.55, api: "lenta" }, 2: { l: "Media", k: 1, api: "media" }, 3: { l: "Rápida", k: 1.7, api: "rapida" } };
  const SENS = { 1: { l: "Baja", v: 78, api: "baja" }, 2: { l: "Normal", v: 65, api: "normal" }, 3: { l: "Alta", v: 52, api: "alta" } };

  let S = null, timer = null, useBackend = false;

  // ---- Deteccion del backend ----
  async function detectBackend() {
    try {
      const r = await fetch(API + "/api/estado", { signal: AbortSignal.timeout(1500) });
      if (r.ok) { useBackend = true; note("Conectado al servidor de monitoreo."); return; }
    } catch (e) { /* sin backend */ }
    useBackend = false;
    note("Modo autónomo (sin servidor). La simulación corre en esta página.");
  }
  function note(txt) { $("backendNote").textContent = txt; }

  // ---- Controles ----
  $("speed").addEventListener("input", (e) => ($("speedVal").textContent = SPEED[e.target.value].l));
  $("thr").addEventListener("input", (e) => ($("thrVal").textContent = SENS[e.target.value].l));
  document.querySelectorAll("#srcSeg button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#srcSeg button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      $("hwRow").hidden = b.dataset.src !== "hw";
    })
  );
  $("espIp").addEventListener("change", checkEsp);
  $("runBtn").addEventListener("click", run);
  $("resetBtn").addEventListener("click", reset);
  $("actBtn").addEventListener("click", resolve);

  async function checkEsp() {
    const ip = $("espIp").value.trim();
    if (!ip) { $("hwState").textContent = "—"; return; }
    $("hwState").textContent = "buscando…";
    if (useBackend) {
      try {
        const r = await fetch(API + "/api/equipo/estado?ip=" + encodeURIComponent(ip), { signal: AbortSignal.timeout(3000) });
        const d = await r.json();
        $("hwState").textContent = d.reachable ? "conectado ✓" : "sin respuesta";
      } catch (e) { $("hwState").textContent = "sin respuesta"; }
    } else {
      $("hwState").textContent = "requiere servidor";
    }
  }

  // ---- Reset ----
  function reset() {
    clearInterval(timer); timer = null; S = null;
    paintHealth(92, "ok");
    setWhy("Todas las señales están en rango normal.");
    $("headline").textContent = "Todo funcionando con normalidad";
    $("subline").textContent = "No hay señales de problemas. Si algo empieza a fallar, lo verás aquí antes de que afecte a tus clientes.";
    setBadge("ok", "Saludable");
    $("whatText").textContent = "Sin novedades. Todos los equipos responden bien.";
    $("whatText").className = "whatline muted";
    $("projRow").hidden = true;
    $("actionText").textContent = "Nada por ahora. El sistema actúa solo cuando detecta un riesgo real.";
    $("actionText").className = "action-main action-wait";
    const done = document.querySelector(".act-done"); if (done) done.remove();
    $("actBtn").hidden = false; $("actBtn").disabled = true; $("actBtn").textContent = "Resolver ahora";
    $("actSub").hidden = false;
    $("notifBody").innerHTML = '<div class="notif-empty">Cuando haya un riesgo, aquí se muestra el mensaje que llega al celular del encargado.</div>';
    $("pdot").style.background = "var(--ok)"; $("pillTxt").textContent = "Vigilando";
    $("clock").textContent = "en reposo";
    $("ocDetect").textContent = "—"; $("ocFail").textContent = "—"; $("ocWin").textContent = "—";
    drawSpark([], 65);
  }

  // ---- Arranque de la simulacion ----
  async function run() {
    reset();
    const key = $("failType").value;
    const sp = SPEED[$("speed").value];
    const se = SENS[$("thr").value];
    $("runBtn").disabled = true;
    $("pillTxt").textContent = "Analizando…";

    if (useBackend) {
      try {
        await fetch(API + "/api/simular/iniciar", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ escenario: key, velocidad: sp.api, sensibilidad: se.api }),
        });
        S = { mode: "backend", key, thr: se.v, alerted: false, done: false, avisoShown: false };
        timer = setInterval(pollBackend, 350);
        return;
      } catch (e) { useBackend = false; note("Se perdió el servidor; sigo en modo autónomo."); }
    }
    // modo local
    const scn = SCN[key];
    S = { mode: "local", scn, key, k: sp.k, thr: se.v, t: 0, hist: [], prev: 8, ewma: scn.base,
          detectT: null, failT: null, alerted: false, done: false };
    timer = setInterval(tickLocal, 350);
  }

  // ---- Backend: solo pintar lo que dice el servidor ----
  async function pollBackend() {
    try {
      const r = await fetch(API + "/api/estado");
      const d = await r.json();
      applyState(d);
      if (!d.is_running) { clearInterval(timer); timer = null; $("runBtn").disabled = false; }
    } catch (e) {
      clearInterval(timer); timer = null; $("runBtn").disabled = false;
    }
  }

  function applyState(d) {
    const band = d.estado;
    paintHealth(d.salud, band);
    const scnW = SCN[S.key];
    setWhy(whyText(band, d.salud, scnW ? scnW.senal : null));
    S.hist = d.history || [];
    drawSpark(S.hist, d.umbral);
    $("clock").textContent = d.t + " s";
    if (band === "warn" && !S.warned) {
      S.warned = true;
      $("headline").textContent = "Hay una señal temprana";
      $("subline").textContent = "Algo empezó a comportarse distinto. Aún no afecta a nadie, pero conviene vigilarlo.";
      setBadge("warn", "Atención");
      $("whatText").textContent = d.descripcion; $("whatText").className = "whatline";
      const scn = SCN[S.key]; $("projText").textContent = scn ? scn.proj : ""; $("projRow").hidden = false;
    }
    if (d.alertado && !S.alerted) {
      S.alerted = true;
      const scn = SCN[S.key];
      fireAlert(scn.alertT, scn.alertB, d.accion_sugerida);
    }
    // Confirma en pantalla si el aviso real salio al celular
    if (d.alertado && d.aviso_configurado && !S.avisoShown) {
      S.avisoShown = true;
      const nota = document.createElement("div");
      nota.className = "bm";
      nota.style.marginTop = "6px";
      nota.textContent = d.aviso_enviado
        ? "✓ Enviado a tu celular por Telegram"
        : "No se pudo enviar al celular (" + (d.aviso_motivo || "revisa la configuración") + ")";
      const bubble = document.querySelector("#notifBody .bubble");
      if (bubble) bubble.appendChild(nota);
    }
    if (d.resultado) showResult(d.resultado);
  }

  // ---- Local: calcular y pintar ----
  function tickLocal() {
    S.t++;
    const scn = S.scn;
    const p = Math.min((S.t * S.k) / 42, 1.25);
    const val = Math.min(scn.base + (scn.fail - scn.base) * (p * p), scn.fail);
    const span = scn.fail - scn.base;
    const level = clamp(((val - scn.base) / span) * 100, 0, 100);
    S.ewma += 0.5 * (val - S.ewma);
    const trend = clamp(((val - S.ewma) / span) * 100 * 1.6, 0, 35);
    let risk = clamp(level * 0.8 + trend, 0, 100);
    risk = Math.max(risk, S.prev - 2); S.prev = risk;
    S.hist.push(risk);

    const band = risk < 40 ? "ok" : risk < S.thr ? "warn" : "crit";
    paintHealth(Math.round(100 - risk), band);
    setWhy(whyText(band, Math.round(100 - risk), scn.senal));
    drawSpark(S.hist, S.thr);
    $("clock").textContent = S.t + " s";

    if (band === "warn" && !S.warned) {
      S.warned = true;
      $("headline").textContent = "Hay una señal temprana";
      $("subline").textContent = "Algo empezó a comportarse distinto. Aún no afecta a nadie, pero conviene vigilarlo.";
      setBadge("warn", "Atención");
      $("whatText").textContent = scn.what; $("whatText").className = "whatline";
      $("projText").textContent = scn.proj; $("projRow").hidden = false;
    }
    if (!S.alerted && risk >= S.thr) { S.alerted = true; S.detectT = S.t; fireAlert(scn.alertT, scn.alertB, scn.act); }
    if (S.failT === null && val >= scn.fail) { S.failT = S.t; finishLocal(); }
    if (S.t > 80) finishLocal();
  }

  function finishLocal() {
    clearInterval(timer); timer = null;
    const failEst = S.failT !== null ? S.failT : (S.detectT !== null ? S.detectT + Math.round(12 / S.k) : null);
    showResult({ detect_t: S.detectT, fail_t: failEst, ventana_s: (S.detectT !== null && failEst !== null) ? failEst - S.detectT : null });
    $("runBtn").disabled = false;
  }

  // ---- Alerta + runbook ----
  function fireAlert(title, body, action) {
    setBadge("crit", "Riesgo");
    $("headline").textContent = "Conviene actuar ahora";
    $("subline").textContent = "El sistema avisó al responsable antes de que el problema llegara al cliente.";
    $("actionText").textContent = action; $("actionText").className = "action-main";
    $("actBtn").disabled = false;
    $("pdot").style.background = "var(--crit)"; $("pillTxt").textContent = "Aviso enviado";
    $("notifBody").innerHTML =
      '<div class="bubble"><div class="bt">⚠ ' + title + '</div><div class="bb">' + body +
      '</div><div class="bm">SecureGuard · hace un momento</div></div>';
  }

  async function resolve() {
    if (!S || S.done) return;
    S.done = true;
    $("actBtn").hidden = true; $("actSub").hidden = true;
    const d = document.createElement("div"); d.className = "act-done";
    d.innerHTML = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 6 9 17l-5-5"/></svg> Resuelto — el riesgo se controló a tiempo';
    $("actBtn").after(d);
    $("headline").textContent = "Resuelto a tiempo";
    $("subline").textContent = "Se aplicó la acción antes del punto de falla. El cliente nunca llegó a notarlo.";
    setWhy("La acción contuvo el riesgo; las señales vuelven a bajar.");
    $("pillTxt").textContent = "Vigilando"; $("pdot").style.background = "var(--ok)";

    if (S.mode === "backend") {
      try { await fetch(API + "/api/simular/resolver", { method: "POST" }); } catch (e) {}
      return; // el poll seguira pintando la recuperacion
    }
    // recuperacion local
    clearInterval(timer);
    let v = S.prev;
    const down = setInterval(() => {
      v -= 7; if (v <= 12) { v = 8; clearInterval(down); }
      S.hist.push(clamp(v, 0, 100));
      drawSpark(S.hist, S.thr);
      paintHealth(Math.round(100 - v), v < 40 ? "ok" : "warn");
      if (v <= 12) setBadge("ok", "Recuperado");
    }, 300);
  }

  function showResult(r) {
    if (!r) return;
    if (r.detect_t != null) $("ocDetect").textContent = r.detect_t + " s";
    if (r.fail_t != null) $("ocFail").textContent = r.fail_t + " s";
    if (r.ventana_s != null) $("ocWin").textContent = r.ventana_s + " s";
  }

  // ---- Explicacion viva del indice ----
  function setWhy(txt) { $("scoreWhy").textContent = txt; }
  function whyText(band, score, senal) {
    senal = senal || "las señales del equipo";
    if (band === "ok") return "Todas las señales están en rango normal.";
    if (band === "warn") return "El riesgo subió porque " + senal + " viene creciendo más rápido de lo normal.";
    return senal.charAt(0).toUpperCase() + senal.slice(1) + " se acerca al punto de falla y sigue subiendo.";
  }

  // ---- Pintado ----
  function paintHealth(score, band) {
    const col = band === "ok" ? "var(--ok)" : band === "warn" ? "var(--warn)" : "var(--crit)";
    $("score").textContent = score;
    $("score").style.color = col;
    $("ring").style.stroke = col;
    $("ring").style.strokeDashoffset = RING_LEN * (1 - score / 100);
    $("hero").style.borderColor = band === "ok" ? "var(--line)" : col;
  }
  function setBadge(band, txt) {
    const col = band === "ok" ? "var(--ok)" : band === "warn" ? "var(--warn)" : "var(--crit)";
    const bg = band === "ok" ? "var(--ok-bg)" : band === "warn" ? "var(--warn-bg)" : "var(--crit-bg)";
    const b = $("badge"); b.style.background = bg; b.style.color = col;
    b.innerHTML = '<span class="bd" style="background:' + col + '"></span>' + txt;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function drawSpark(data, thr) {
    const W = 400, H = 120, pad = 8;
    let el = "";
    el += '<line x1="0" y1="' + (H - pad) + '" x2="' + W + '" y2="' + (H - pad) + '" stroke="var(--line)" stroke-width="1"/>';
    if (thr != null) {
      const ty = H - pad - (thr / 100) * (H - 2 * pad);
      el += '<line x1="0" y1="' + ty + '" x2="' + W + '" y2="' + ty + '" stroke="var(--warn)" stroke-width="1.4" stroke-dasharray="5 4"/>';
    }
    if (data.length > 1) {
      const pts = data.map((v, i) => [Math.min((i / 80) * W, W), H - pad - (clamp(v, 0, 100) / 100) * (H - 2 * pad)]);
      let area = "M" + pts[0][0] + "," + (H - pad);
      pts.forEach((p) => (area += " L" + p[0].toFixed(1) + "," + p[1].toFixed(1)));
      area += " L" + pts[pts.length - 1][0].toFixed(1) + "," + (H - pad) + " Z";
      const last = data[data.length - 1];
      const col = last < 40 ? "var(--ok)" : last < (thr || 65) ? "var(--warn)" : "var(--crit)";
      el += '<path d="' + area + '" fill="' + col + '" opacity="0.1"/>';
      let line = "M" + pts[0][0] + "," + pts[0][1].toFixed(1);
      pts.forEach((p) => (line += " L" + p[0].toFixed(1) + "," + p[1].toFixed(1)));
      el += '<path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="2.4" stroke-linejoin="round"/>';
      const lp = pts[pts.length - 1];
      el += '<circle cx="' + lp[0].toFixed(1) + '" cy="' + lp[1].toFixed(1) + '" r="4" fill="' + col + '"/>';
    }
    $("spark").innerHTML = el;
  }

  // =====================================================
  //  DATOS REALES — reproducir una corrida del dataset
  // =====================================================
  let replayTimer = null;

  async function cargarCorridas() {
    try {
      const r = await fetch(API + "/api/dataset/corridas?cliente=gramo", { signal: AbortSignal.timeout(2000) });
      const d = await r.json();
      const sel = $("corridaSel");
      sel.innerHTML = "";
      (d.corridas || []).forEach((c) => {
        const o = document.createElement("option");
        o.value = c; o.textContent = c.replace("corrida_", "Semana ");
        sel.appendChild(o);
      });
      $("replayNote").textContent = d.fuente === "muestra"
        ? "Usando la muestra incluida (1 semana). Para las 10 semanas, define ZIKIT_DATASET."
        : "Kit de datos completo cargado (" + (d.corridas || []).length + " semanas).";
    } catch (e) {
      $("corridaSel").innerHTML = "<option>requiere servidor</option>";
      $("replayNote").textContent = "Necesitas el servidor corriendo (python server.py).";
    }
  }

  async function iniciarReplay() {
    const corrida = $("corridaSel").value;
    if (!corrida || corrida === "requiere servidor") return;
    reset();
    $("replayBtn").disabled = true;
    $("pillTxt").textContent = "Reproduciendo datos reales…";
    $("clock").textContent = "—";
    $("replayResult").hidden = true; $("replayDets").innerHTML = "";
    try {
      await fetch(API + "/api/dataset/reproducir", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ corrida, cliente: "gramo" }),
      });
      replayTimer = setInterval(pollReplay, 300);
    } catch (e) {
      $("replayNote").textContent = "No se pudo iniciar (¿servidor corriendo?).";
      $("replayBtn").disabled = false;
    }
  }

  async function detenerReplay() {
    clearInterval(replayTimer); replayTimer = null;
    try { await fetch(API + "/api/dataset/detener", { method: "POST" }); } catch (e) {}
    $("replayBtn").disabled = false;
    $("pillTxt").textContent = "Vigilando";
  }

  async function pollReplay() {
    try {
      const r = await fetch(API + "/api/dataset/estado");
      const d = await r.json();
      aplicarReplay(d);
      if (!d.is_running) {
        clearInterval(replayTimer); replayTimer = null;
        $("replayBtn").disabled = false;
        $("pillTxt").textContent = "Vigilando";
      }
    } catch (e) {
      clearInterval(replayTimer); replayTimer = null;
      $("replayBtn").disabled = false;
    }
  }

  function aplicarReplay(d) {
    paintHealth(d.salud, d.estado);
    if (d.ts) {
      const t = new Date(d.ts);
      const dias = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
      $("clock").textContent = dias[t.getDay()] + " " +
        String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0");
    }
    drawSpark(d.history || [], 65);

    if (d.estado === "ok") {
      setWhy("Telemetría real en rango normal.");
      $("headline").textContent = "Vigilando datos reales";
      $("subline").textContent = "Reproduciendo la semana de gramo. El detector ignora los picos normales del negocio.";
      setBadge("ok", "Saludable");
    } else if (d.estado === "warn") {
      setWhy("Una señal real empezó a subir de forma sostenida.");
      setBadge("warn", "Atención");
    }

    if (d.alertado) {
      setBadge("crit", "Riesgo");
      $("headline").textContent = "Falla real detectada a tiempo";
      $("subline").textContent = "El detector avisó antes de que la falla llegara al pico.";
      setWhy(d.descripcion || "Señal sostenida de falla real.");
      $("whatText").textContent = d.descripcion; $("whatText").className = "whatline";
      $("actionText").textContent = d.accion_sugerida; $("actionText").className = "action-main";
      $("pdot").style.background = "var(--crit)"; $("pillTxt").textContent = "Aviso enviado";
      // ultima deteccion en la burbuja
      const ult = d.detecciones[d.detecciones.length - 1];
      if (ult) {
        const antic = ult.anticipacion_min != null ? ("+" + ult.anticipacion_min + " min de anticipación") : "en vivo";
        $("notifBody").innerHTML =
          '<div class="bubble"><div class="bt">⚠ ' + (d.descripcion ? d.descripcion.split(".")[0] : "Falla detectada") +
          '</div><div class="bb">' + (d.accion_sugerida || "") +
          '</div><div class="bm">SecureGuard · ' + antic +
          (d.aviso_configurado ? (d.aviso_enviado ? " · ✓ enviado a tu celular" : " · aviso no enviado") : "") +
          '</div></div>';
      }
    }

    // resumen de detecciones
    if (d.detecciones && d.detecciones.length) {
      $("replayResult").hidden = false;
      $("replayDets").innerHTML = d.detecciones.map((x) => {
        const antic = x.anticipacion_min != null ? (x.anticipacion_min + " min antes") : "—";
        const hora = new Date(x.inicio);
        const dias = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
        return '<div class="rb-action"><span>' + dias[hora.getDay()] + " " +
          String(hora.getHours()).padStart(2, "0") + ":" + String(hora.getMinutes()).padStart(2, "0") +
          " · " + x.senal + '</span><span class="rb-done">' + antic + "</span></div>";
      }).join("");
      const prom = d.resultado && d.resultado.anticipacion_prom;
      if (prom != null) {
        $("ocDetect").textContent = d.detecciones.length;
        $("ocFail").textContent = "0";
        $("ocWin").textContent = prom + " min";
        document.querySelectorAll(".oc .l")[0].textContent = "Fallas reales detectadas";
        document.querySelectorAll(".oc .l")[1].textContent = "Falsas alarmas";
        document.querySelectorAll(".oc .l")[2].textContent = "Anticipación promedio";
      }
    }
  }

  $("replayBtn").addEventListener("click", iniciarReplay);
  $("replayStop").addEventListener("click", detenerReplay);
  $("datasetPanel").addEventListener("toggle", function () {
    if (this.open && $("corridaSel").children.length <= 1) cargarCorridas();
  });

  // ---- Init ----
  reset();
  detectBackend();
})();
