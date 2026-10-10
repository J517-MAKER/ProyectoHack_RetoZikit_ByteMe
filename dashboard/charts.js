/* ======================================================
   SecureGuard — Graficas SVG del tablero
   Reto Zikit "Antes de que suene el telefono" — ByteMe

   Sin dependencias (el tablero tambien abre sin internet).
   Los colores salen de variables CSS por rol, asi el tema
   claro / oscuro cambia sin volver a dibujar. Marcas finas
   (lineas de 2 px, puntos de 8 px con anillo de superficie),
   rejilla tenue y una sola escala por grafica.
   ====================================================== */

(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const SG = (window.SG = window.SG || {});

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function text(parent, x, y, s, cls, anchor) {
    const t = el("text", { x, y, class: cls, "text-anchor": anchor || "start" }, parent);
    t.textContent = s;
    return t;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function lin(d0, d1, r0, r1) {
    const k = (r1 - r0) / ((d1 - d0) || 1);
    const f = (v) => r0 + (v - d0) * k;
    f.invert = (p) => d0 + (p - r0) / k;
    return f;
  }
  // Maximo "redondo" para un eje (1, 2, 2.5, 5 x 10^n)
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  SG.util = { el, text, clear, clamp, lin, niceMax };

  /* ---------------------------------------------------------
     Medidor semicircular del indice de riesgo (0-100)
     --------------------------------------------------------- */
  SG.gauge = function (box) {
    const W = 200, H = 128, cx = 100, cy = 104, r = 80;
    const svg = el("svg", { class: "viz", viewBox: `0 0 ${W} ${H}` }, box);
    const ang = (v) => Math.PI * (1 - v / 100);
    const pt = (v, rr) => [cx + rr * Math.cos(ang(v)), cy - rr * Math.sin(ang(v))];
    const arc = (v0, v1, rr) => {
      const [x0, y0] = pt(v0, rr), [x1, y1] = pt(v1, rr);
      return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${rr} ${rr} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    };
    // Zonas: verde < 40 <= ambar < 65 <= rojo (pista tenue del mismo color)
    [[0, 39.3, "var(--good)"], [40.7, 64.3, "var(--warning)"], [65.7, 100, "var(--critical)"]].forEach(([a, b, c]) =>
      el("path", { d: arc(a, b, r), fill: "none", stroke: c, "stroke-width": 12, opacity: 0.2 }, svg));
    const valor = el("path", {
      d: arc(0, 100, r), fill: "none", "stroke-width": 12, "stroke-linecap": "round", pathLength: 100,
      "stroke-dasharray": "100 200", stroke: "var(--good)",
      style: "stroke-dashoffset:100;transition:stroke-dashoffset .5s ease, stroke .4s",
    }, svg);
    [40, 65].forEach((v) => {
      const [x0, y0] = pt(v, r + 9), [x1, y1] = pt(v, r + 14), [tx, ty] = pt(v, r + 23);
      el("line", { x1: x0, y1: y0, x2: x1, y2: y1, stroke: "var(--axis)", "stroke-width": 1.5 }, svg);
      text(svg, tx, ty + 4, String(v), "tick", "middle");
    });
    text(svg, cx - r, cy + 17, "0", "tick", "middle");
    text(svg, cx + r, cy + 17, "100", "tick", "middle");
    const num = text(svg, cx, cy - 12, "0", "", "middle");
    num.setAttribute("style", "font-size:46px;font-weight:650;letter-spacing:-.03em;fill:var(--ink)");
    const lab = text(svg, cx, cy + 12, "índice de riesgo", "tick", "middle");
    lab.setAttribute("style", "font-size:11.5px");
    const COL = { verde: "var(--good)", ambar: "var(--warning)", rojo: "var(--critical)" };
    return {
      set(v, estado) {
        v = clamp(v || 0, 0, 100);
        valor.style.strokeDashoffset = String(100 - v);
        valor.style.opacity = v < 0.5 ? "0" : "1";
        valor.setAttribute("stroke", COL[estado] || COL.verde);
        num.textContent = String(Math.round(v));
        box.setAttribute("aria-label", `Índice de riesgo ${Math.round(v)} de 100`);
      },
    };
  };

  /* ---------------------------------------------------------
     Grafica de linea de una medida (ventana de minutos)
     --------------------------------------------------------- */
  SG.line = function (box, opts) {
    const o = Object.assign({ height: 122, pad: { t: 10, r: 10, b: 20, l: 32 }, umbrales: [] }, opts);
    const svg = el("svg", { class: "viz", role: "img" }, box);
    if (o.titulo) svg.setAttribute("aria-label", o.titulo);
    const L = {
      hours: el("g", null, svg), bands: el("g", null, svg), grid: el("g", null, svg), thr: el("g", null, svg),
      area: el("path", { class: "area" }, svg), line: el("path", { class: "line" }, svg),
      marks: el("g", null, svg), end: el("circle", { class: "dot", r: 4, fill: "var(--series-1)" }, svg),
      hover: el("g", { visibility: "hidden" }, svg), hit: null,
    };
    const hLine = el("line", { class: "hover-line" }, L.hover);
    const hDot = el("circle", { class: "dot", r: 4, fill: "var(--series-1)" }, L.hover);
    L.hit = el("rect", { class: "hit" }, svg);
    let st = null;

    function draw(d) {
      // d: { serie, desde, hasta, limite?, tiempo(i) -> Date, bandas[], horario[], marcas[], umbrales? }
      const W = Math.max(160, Math.round(box.clientWidth || 300)), H = o.height, p = o.pad;
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("height", H);
      const y0 = H - p.b;
      const umbrales = d.umbrales || o.umbrales;
      // despues del cursor no hay datos todavia: la linea se corta ahi
      const lim = d.limite == null ? d.hasta : Math.min(d.hasta, d.limite);
      const valor = (i) => (i > lim ? null : d.serie[i]);
      let maxV = o.max;
      if (maxV == null) {
        let m = 0;
        for (let i = d.desde; i <= lim; i++) { const v = d.serie[i]; if (v != null && v > m) m = v; }
        umbrales.forEach((u) => { if (u.v > m) m = u.v; });
        maxV = niceMax(Math.max(m * 1.12, o.maxMin || 1));
      }
      const x = lin(d.desde, Math.max(d.hasta, d.desde + 1), p.l, W - p.r);
      const y = lin(0, maxV, y0, p.t);
      st = { W, H, x, y, d, maxV, valor };

      // horario de atencion y picos anunciados
      clear(L.hours); clear(L.bands);
      (d.horario || []).forEach((b) => {
        const a = Math.max(b.i0, d.desde), z = Math.min(b.i1, d.hasta);
        if (z > a) el("rect", { class: "hours", x: x(a), y: p.t, width: x(z) - x(a), height: y0 - p.t }, L.hours);
      });
      (d.bandas || []).forEach((b) => {
        const a = Math.max(b.i0, d.desde), z = Math.min(b.i1, d.hasta);
        if (z <= a) return;
        el("rect", { class: "band", x: x(a), y: p.t, width: x(z) - x(a), height: y0 - p.t }, L.bands);
        if (x(z) - x(a) > 74) text(L.bands, x(a) + 5, p.t + 11, b.motivo, "band-label");
      });

      // rejilla y eje: 0, maximo y los umbrales del detector (en el eje, no sobre los datos)
      clear(L.grid);
      const marcasY = [{ v: 0 }, { v: maxV }];
      umbrales.forEach((u) => { if (u.v > 0 && u.v < maxV) marcasY.unshift({ v: u.v, thr: true }); });
      if (!umbrales.length) marcasY.push({ v: maxV / 2 });
      const ocupadas = [];
      marcasY.forEach((m) => {
        const yy = y(m.v);
        if (!m.thr) el("line", { class: m.v === 0 ? "base" : "grid", x1: p.l, x2: W - p.r, y1: Math.round(yy) + 0.5, y2: Math.round(yy) + 0.5 }, L.grid);
        if (ocupadas.some((o2) => Math.abs(o2 - yy) < 11)) return;
        ocupadas.push(yy);
        text(L.grid, p.l - 6, yy + 3.5, String(Math.round(m.v)), m.thr ? "tick thr-tick" : "tick", "end");
      });
      let ultimo = -Infinity;
      if (o.ticksX) {
        o.ticksX(d.desde, d.hasta).forEach((t) => {
          const xx = x(t.i);
          if (xx - ultimo < 30 || xx > W - p.r + 1) return;
          ultimo = xx;
          // en los bordes la etiqueta se alinea hacia adentro para no cortarse
          const ancla = xx > W - p.r - 20 ? "end" : xx < p.l + 20 ? "start" : "middle";
          text(L.grid, ancla === "end" ? Math.min(xx, W - 2) : xx, H - 5, t.label, "tick", ancla);
        });
      } else {
        const span = d.hasta - d.desde;
        const paso = span <= 8 * 60 ? 60 : span <= 26 * 60 ? 240 : 720;
        const t0 = d.tiempo(d.desde);
        const off = (paso - ((t0.getUTCHours() * 60 + t0.getUTCMinutes()) % paso)) % paso;
        for (let i = d.desde + off; i <= d.hasta; i += paso) {
          const xx = x(i);
          if (xx - ultimo < 34 || xx > W - p.r - 6) continue;
          ultimo = xx;
          const t = d.tiempo(i);
          const hh = String(t.getUTCHours()).padStart(2, "0") + ":00";
          text(L.grid, xx, H - 5, t.getUTCHours() === 0 && o.fmtDia ? o.fmtDia(t) : hh, "tick", "middle");
        }
      }

      // umbrales (linea punteada = regla del detector; su valor va en el eje)
      clear(L.thr);
      umbrales.forEach((u) => {
        if (u.v > maxV) return;
        const yy = Math.round(y(u.v)) + 0.5;
        el("line", { class: "thr" + (u.suave ? " soft" : ""), x1: p.l, x2: W - p.r, y1: yy, y2: yy }, L.thr);
      });

      // la serie (los huecos de telemetria cortan la linea)
      let line = "", area = "", seg = [], ultimoPt = null;
      const flush = () => {
        if (!seg.length) return;
        line += "M" + seg.map((q) => q[0] + "," + q[1]).join("L");
        if (seg.length > 1) area += `M${seg[0][0]},${y0}L` + seg.map((q) => q[0] + "," + q[1]).join("L") + `L${seg[seg.length - 1][0]},${y0}Z`;
        seg = [];
      };
      for (let i = d.desde; i <= lim; i++) {
        const v = d.serie[i];
        if (v == null) { flush(); continue; }
        const q = [x(i).toFixed(1), y(clamp(v, 0, maxV)).toFixed(1)];
        seg.push(q);
        ultimoPt = q;
      }
      flush();
      L.line.setAttribute("d", line || "M0,0");
      L.area.setAttribute("d", area || "M0,0");
      if (ultimoPt && d.mostrarFin !== false) {
        L.end.setAttribute("cx", ultimoPt[0]); L.end.setAttribute("cy", ultimoPt[1]); L.end.setAttribute("visibility", "visible");
      } else L.end.setAttribute("visibility", "hidden");

      // avisos y picos reales dentro de la ventana
      clear(L.marks);
      (d.marcas || []).forEach((m) => {
        if (m.i < d.desde || m.i > d.hasta) return;
        const xx = Math.round(x(m.i)) + 0.5;
        if (m.tipo === "aviso") {
          el("line", { class: "alert-line", x1: xx, x2: xx, y1: p.t, y2: y0 }, L.marks);
          el("path", { class: "alert-mark", d: `M${xx - 5},${p.t - 1}L${xx + 5},${p.t - 1}L${xx},${p.t + 7}Z` }, L.marks);
        } else {
          el("line", { class: "peak-line", x1: xx, x2: xx, y1: p.t, y2: y0 }, L.marks);
          el("rect", { class: "peak-mark", x: xx - 4, y: p.t - 1, width: 8, height: 8, transform: `rotate(45 ${xx} ${p.t + 3})` }, L.marks);
        }
      });

      L.hit.setAttribute("x", p.l); L.hit.setAttribute("y", 0);
      L.hit.setAttribute("width", Math.max(0, W - p.l - p.r)); L.hit.setAttribute("height", H);
    }

    function hover(i) {
      if (i == null || !st || i < st.d.desde || i > st.d.hasta) { L.hover.setAttribute("visibility", "hidden"); return; }
      const xx = Math.round(st.x(i)) + 0.5, v = st.valor(i);
      hLine.setAttribute("x1", xx); hLine.setAttribute("x2", xx);
      hLine.setAttribute("y1", st.d.padTop || o.pad.t); hLine.setAttribute("y2", st.H - o.pad.b);
      if (v == null) hDot.setAttribute("visibility", "hidden");
      else {
        hDot.setAttribute("visibility", "visible");
        hDot.setAttribute("cx", st.x(i)); hDot.setAttribute("cy", st.y(clamp(v, 0, st.maxV)));
      }
      L.hover.setAttribute("visibility", "visible");
    }

    function indiceDesde(ev) {
      if (!st) return null;
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (st.W / r.width);
      return Math.round(clamp(st.x.invert(px), st.d.desde, st.d.hasta));
    }
    L.hit.addEventListener("pointermove", (ev) => o.onHover && o.onHover(indiceDesde(ev), ev));
    L.hit.addEventListener("pointerleave", () => o.onHover && o.onHover(null));
    L.hit.addEventListener("click", (ev) => o.onClick && o.onClick(indiceDesde(ev)));

    return { draw, hover, svg };
  };

  /* ---------------------------------------------------------
     Linea de tiempo de la semana: riesgo, avisos y picos
     --------------------------------------------------------- */
  SG.timeline = function (box, o) {
    const H = 232, TOP = 64, BOT = 196, PL = 30, PR = 12;
    const svg = el("svg", { class: "viz", role: "img", "aria-label": "Índice de riesgo de la semana" }, box);
    const defs = el("defs", null, svg);
    const gid = "tl" + Math.random().toString(36).slice(2, 8);
    const grad = el("linearGradient", { id: gid, gradientUnits: "userSpaceOnUse", x1: 0, x2: 0, y1: BOT, y2: TOP }, defs);
    [[0, "--good"], [0.4, "--good"], [0.4, "--warning"], [0.65, "--warning"], [0.65, "--critical"], [1, "--critical"]]
      .forEach(([off, c]) => el("stop", { offset: off, style: `stop-color:var(${c})` }, grad));
    const L = {};
    ["fondo", "ejes", "area", "linea", "thr", "futuro", "marcas", "cursor", "hover"].forEach((k) => (L[k] = el("g", null, svg)));
    const hit = el("rect", { class: "hit" }, svg);
    let D = null, geo = null, cursor = 0, completa = true;

    function render() {
      if (!D) return;
      const W = Math.max(320, Math.round(box.clientWidth || 800));
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("height", H);
      const n = D.n;
      const x = lin(0, n - 1, PL, W - PR), y = lin(0, 100, BOT, TOP);
      geo = { W, x, y };
      Object.values(L).forEach(clear);

      // horario de atencion y picos anunciados (fondo)
      D.horario.forEach((b) => el("rect", { class: "hours", x: x(b.i0), y: TOP, width: Math.max(1, x(b.i1) - x(b.i0)), height: BOT - TOP }, L.fondo));
      D.ventanas.forEach((b) => {
        el("rect", { class: "band", x: x(b.i0), y: TOP, width: Math.max(1, x(b.i1) - x(b.i0)), height: BOT - TOP }, L.fondo);
        // la etiqueta termina donde empieza el pico, para no tapar avisos cercanos
        if (!/nocturn/i.test(b.motivo)) text(L.fondo, x(b.i0) - 4, 57, b.motivo, "band-label", "end");
      });

      // dias y horas
      const t0 = D.tiempo(0);
      const min0 = t0.getUTCHours() * 60 + t0.getUTCMinutes();
      const dias = [];
      for (let i = (1440 - min0) % 1440; i < n; i += 1440) dias.push(i);
      const bordes = [0, ...dias.filter((i) => i > 0), n - 1];
      dias.forEach((i) => el("line", { class: "day-sep", x1: Math.round(x(i)) + 0.5, x2: Math.round(x(i)) + 0.5, y1: 4, y2: BOT }, L.ejes));
      for (let k = 0; k < bordes.length - 1; k++) {
        const a = x(bordes[k]), b = x(bordes[k + 1]);
        if (b - a < 44) continue;
        text(L.ejes, (a + b) / 2, 14, D.fmtDia(D.tiempo(bordes[k] + 1)), "tick-day", "middle");
      }
      const anchoDia = (x(1440) - x(0));
      const pasoH = anchoDia > 150 ? 360 : anchoDia > 70 ? 720 : 0;
      geo.ticks = [];
      if (pasoH) {
        for (let i = (pasoH - (min0 % pasoH)) % pasoH; i < n; i += pasoH) {
          const h = D.tiempo(i).getUTCHours();
          if (h === 0) continue;
          geo.ticks.push({ x: x(i), el: text(L.ejes, x(i), H - 18, String(h).padStart(2, "0"), "tick", "middle") });
        }
      }
      [0, 40, 65, 100].forEach((v) => text(L.ejes, PL - 6, y(v) + 3.5, String(v), "tick", "end"));
      el("line", { class: "base", x1: PL, x2: W - PR, y1: BOT + 0.5, y2: BOT + 0.5 }, L.ejes);

      // riesgo: maximo por columna de pixeles (no se pierde ningun pico)
      const cols = Math.max(2, Math.round(W - PL - PR));
      const porCol = n / cols;
      let lin2 = "", area = `M${PL},${BOT}`;
      for (let c = 0; c < cols; c++) {
        const a = Math.floor(c * porCol), b = Math.min(n, Math.floor((c + 1) * porCol) + 1);
        let m = 0;
        for (let i = a; i < b; i++) { const v = D.riesgo[i]; if (v > m) m = v; }
        const px = (PL + c * (W - PL - PR) / (cols - 1)).toFixed(1), py = y(m).toFixed(1);
        lin2 += (c ? "L" : "M") + px + "," + py;
        area += "L" + px + "," + py;
      }
      area += `L${W - PR},${BOT}Z`;
      el("path", { class: "risk-area", d: area, fill: `url(#${gid})` }, L.area);
      el("path", { class: "risk-line", d: lin2, stroke: `url(#${gid})` }, L.linea);
      [[65, ""], [40, " soft"]].forEach(([v, s]) => el("line", { class: "thr" + s, x1: PL, x2: W - PR, y1: Math.round(y(v)) + 0.5, y2: Math.round(y(v)) + 0.5 }, L.thr));

      hit.setAttribute("x", PL); hit.setAttribute("y", 0);
      hit.setAttribute("width", W - PL - PR); hit.setAttribute("height", H);
      dibujarCursor();
    }

    function dibujarCursor() {
      if (!D || !geo) return;
      const { W, x } = geo;
      clear(L.marcas); clear(L.futuro); clear(L.cursor);
      const visible = (i) => completa || i <= cursor;

      // avisos (triangulo) con su anticipacion, y picos reales (rombo)
      let ultimoFin = -Infinity;
      D.avisos.forEach((a) => {
        if (!visible(a.i)) return;
        const xa = Math.round(x(a.i)) + 0.5;
        const v = a.verificacion;
        const pico = v && v.es_real && visible(v.i_pico) ? Math.round(x(v.i_pico)) + 0.5 : null;
        el("line", { class: "alert-line", x1: xa, x2: xa, y1: TOP, y2: BOT }, L.marcas);
        if (pico != null) {
          el("line", { class: "peak-line", x1: pico, x2: pico, y1: TOP, y2: BOT }, L.marcas);
          el("line", { class: "lead-line", x1: xa, x2: pico, y1: TOP - 4.5, y2: TOP - 4.5 }, L.marcas);
          el("rect", { class: "peak-mark", x: pico - 4, y: TOP - 8.5, width: 8, height: 8, transform: `rotate(45 ${pico} ${TOP - 4.5})` }, L.marcas);
        }
        el("path", { class: "alert-mark", d: `M${xa - 6},${TOP - 11}L${xa + 6},${TOP - 11}L${xa},${TOP - 1}Z` }, L.marcas);
        // etiqueta: cuanto antes del pico avisamos (solo cuando el pico ya ocurrio)
        const etiqueta = pico != null ? `${v.anticipacion_min} min antes del pico` : `Aviso · ${D.fmtCorta(D.tiempo(a.i))}`;
        const ancho = etiqueta.length * 6.1 + 18;
        let cx = clamp(xa, PL + ancho / 2, W - PR - ancho / 2);
        if (cx - ancho / 2 < ultimoFin + 4) return;     // no se enciman: queda el marcador
        ultimoFin = cx + ancho / 2;
        const g = el("g", { class: "callout" }, L.marcas);
        el("rect", { x: cx - ancho / 2, y: 22, width: ancho, height: 19, rx: 9.5 }, g);
        text(g, cx, 35, etiqueta, "", "middle");
      });
      // fallas reales sin aviso (si las hubiera) tambien se muestran
      (D.perdidas || []).forEach((pi) => {
        if (!visible(pi)) return;
        const xp = Math.round(x(pi)) + 0.5;
        el("line", { class: "peak-line", x1: xp, x2: xp, y1: TOP, y2: BOT }, L.marcas);
        el("rect", { class: "peak-mark", x: xp - 4, y: TOP - 8.5, width: 8, height: 8, transform: `rotate(45 ${xp} ${TOP - 4.5})` }, L.marcas);
      });

      (geo.ticks || []).forEach((t) => (t.el.style.visibility = ""));
      if (!completa) {
        const xc = x(cursor);
        if (cursor < D.n - 1) el("rect", { class: "future", x: xc, y: 0, width: Math.max(0, W - PR - xc + 2), height: BOT + 1 }, L.futuro);
        const xr = Math.round(xc) + 0.5;
        el("line", { class: "cursor", x1: xr, x2: xr, y1: TOP - 14, y2: BOT }, L.cursor);
        const lab = D.fmtCorta(D.tiempo(cursor));
        const ancho = lab.length * 6.6 + 16;
        const cx = clamp(xc, PL + ancho / 2, W - PR - ancho / 2);
        const g = el("g", { class: "cursor-label" }, L.cursor);
        el("rect", { x: cx - ancho / 2, y: BOT + 4, width: ancho, height: 19, rx: 5 }, g);
        text(g, cx, BOT + 17, lab, "", "middle");
        // las horas que quedan debajo de la etiqueta del cursor se ocultan
        (geo.ticks || []).forEach((t) => { if (Math.abs(t.x - cx) < ancho / 2 + 10) t.el.style.visibility = "hidden"; });
      }
    }

    function hoverEn(i) {
      clear(L.hover);
      if (i == null || !geo) return;
      const xx = Math.round(geo.x(i)) + 0.5;
      el("line", { class: "hover-line", x1: xx, x2: xx, y1: TOP, y2: BOT }, L.hover);
      el("circle", { class: "dot", cx: geo.x(i), cy: geo.y(D.riesgo[i] || 0), r: 4, fill: "var(--ink)" }, L.hover);
    }
    function indiceDesde(ev) {
      if (!geo) return null;
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (geo.W / r.width);
      return Math.round(clamp(geo.x.invert(px), 0, D.n - 1));
    }
    hit.addEventListener("pointermove", (ev) => { const i = indiceDesde(ev); hoverEn(i); o.onHover && o.onHover(i, ev); });
    hit.addEventListener("pointerleave", () => { hoverEn(null); o.onHover && o.onHover(null); });
    hit.addEventListener("click", (ev) => { const i = indiceDesde(ev); if (i != null && o.onSeek) o.onSeek(i); });

    return {
      setData(d) { D = d; render(); },
      update(i, esCompleta) { cursor = i; completa = esCompleta; dibujarCursor(); },
      render,
    };
  };

  /* ---------------------------------------------------------
     Grafica de puntos: anticipacion por tipo de falla
     --------------------------------------------------------- */
  SG.strip = function (box, filas, o) {
    clear(box);
    const W = Math.max(320, Math.round(box.clientWidth || 600));
    const PASO = 9.5;      // separacion vertical de puntos del mismo minuto (punto de 9 px + aire)
    // Varias semanas caen en el mismo minuto: se apilan en vertical, centradas en su fila
    const grupos = filas.map((f) => {
      const m = new Map();
      f.valores.forEach((p) => { if (!m.has(p.v)) m.set(p.v, []); m.get(p.v).push(p); });
      return m;
    });
    const maxPila = Math.max(1, ...grupos.flatMap((m) => [...m.values()].map((l) => l.length)));
    const rowH = Math.max(76, Math.ceil(maxPila * PASO + 24));
    const top = 6, axisH = 44;
    const padL = Math.min(260, Math.round(W * 0.44)), padR = 16;
    const H = top + filas.length * rowH + axisH;
    const todos = filas.flatMap((f) => f.valores.map((v) => v.v));
    const xMax = niceMax(Math.max(60, ...todos) + 4);
    const x = lin(0, xMax, padL, W - padR);
    const svg = el("svg", { class: "viz", viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": o.titulo || "" }, box);
    const yEje = top + filas.length * rowH;
    const paso = xMax <= 60 ? 10 : xMax <= 120 ? 20 : 30;
    for (let v = 0; v <= xMax; v += paso) {
      el("line", { class: v === 0 ? "base" : "grid", x1: Math.round(x(v)) + 0.5, x2: Math.round(x(v)) + 0.5, y1: top, y2: yEje }, svg);
      text(svg, x(v), yEje + 15, String(v), "tick", "middle");
    }
    text(svg, padL, yEje + 34, "minutos entre el aviso y el pico real →", "tick");
    filas.forEach((f, k) => {
      const cy = top + k * rowH + rowH / 2;
      if (k) el("line", { class: "grid", x1: 0, x2: W - padR, y1: top + k * rowH + 0.5, y2: top + k * rowH + 0.5 }, svg);
      text(svg, 0, cy - 10, f.nombre, "strip-row-label");
      text(svg, 0, cy + 7, f.sub, "strip-row-sub");
      if (f.sub2) text(svg, 0, cy + 22, f.sub2, "strip-row-sub");
      if (f.prom != null) {
        const xp = Math.round(x(f.prom)) + 0.5;
        el("line", { x1: xp, x2: xp, y1: cy - rowH / 2 + 8, y2: cy + rowH / 2 - 8, stroke: "var(--ink)", "stroke-width": 2, "stroke-linecap": "round" }, svg);
      }
      grupos[k].forEach((lista, v) => {
        const px = x(v);
        lista.forEach((p, j) => {
          const cyp = cy + (j - (lista.length - 1) / 2) * PASO;
          const g = el("g", { tabindex: 0, role: "img", "aria-label": `${p.etiqueta}: ${v} min antes del pico` }, svg);
          el("circle", { class: "hit", cx: px, cy: cyp, r: 11 }, g);
          el("circle", { class: "dot", cx: px, cy: cyp, r: 4.5, fill: "var(--series-1)" }, g);
          const mostrar = (ev) => o.onHover && o.onHover({ ...p, v, n: lista.length }, ev, g);
          g.addEventListener("pointermove", mostrar);
          g.addEventListener("focus", (ev) => mostrar(ev));
          g.addEventListener("pointerleave", () => o.onHover && o.onHover(null));
          g.addEventListener("blur", () => o.onHover && o.onHover(null));
        });
      });
    });
  };

  /* ---------------------------------------------------------
     Agenda de una semana tipo (7 dias x 24 h)
     --------------------------------------------------------- */
  SG.agenda = function (box, o) {
    clear(box);
    const W = Math.max(320, Math.round(box.clientWidth || 600));
    const labelW = 40, top = 20, rowH = 22, gap = 5;
    const H = top + 7 * (rowH + gap);
    const x = lin(0, 1440, labelW, W - 6);
    const svg = el("svg", { class: "viz", viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Semana tipo de gramo" }, box);
    const aMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
    for (let h = 0; h <= 24; h += 3) {
      text(svg, x(h * 60), 12, String(h).padStart(2, "0"), "tick", h === 0 ? "start" : h === 24 ? "end" : "middle");
    }
    const DIAS = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
    DIAS.forEach((nombre, d) => {
      const yy = top + d * (rowH + gap);
      text(svg, 0, yy + rowH / 2 + 4, nombre, "tick-day");
      el("rect", { x: labelW, y: yy, width: W - 6 - labelW, height: rowH, rx: 5, fill: "var(--surface-3)" }, svg);
      if (o.horario && o.horario.dias.includes(d)) {
        const a = aMin(o.horario.ini), b = aMin(o.horario.fin);
        const r = el("rect", { x: x(a), y: yy, width: x(b) - x(a), height: rowH, rx: 5, fill: "var(--accent)", opacity: 0.22 }, svg);
        el("title", null, r).textContent = `${nombre}: horario de atención ${o.horario.ini}–${o.horario.fin}`;
      }
      (o.ventanas || []).forEach((w) => {
        if (w.dia != null && w.dia !== d) return;
        const a = aMin(w.ini), b = aMin(w.fin);
        const r = el("rect", { x: x(a), y: yy + 3, width: Math.max(3, x(b) - x(a)), height: rowH - 6, rx: 3, fill: "var(--ink)", opacity: 0.16 }, svg);
        el("title", null, r).textContent = `${nombre}: ${w.nombre} ${w.ini}–${w.fin} (pico anunciado, no se avisa)`;
        if (w.dia != null && x(b) - x(a) > 60) text(svg, x(a) + 4, yy + rowH / 2 + 4, w.nombre, "band-label");
      });
      if (o.horario && o.horario.dias.includes(d)) {
        (o.picos || []).forEach((hhmm) => {
          const c = el("circle", { cx: x(aMin(hhmm)), cy: yy + rowH / 2, r: 4, fill: "var(--ink)", stroke: "var(--surface)", "stroke-width": 2 }, svg);
          el("title", null, c).textContent = `${nombre} ${hhmm}: pico de pedidos`;
        });
      }
    });
  };
})();
