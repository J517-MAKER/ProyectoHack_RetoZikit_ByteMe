"""
======================================================
 SecureGuard - Reproduccion de datos reales (dataset Zikit)
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Reproduce una corrida real del kit de datos como si pasara en
 vivo: alimenta las metricas minuto a minuto, calcula el riesgo
 con la MISMA logica del detector (señales sostenidas + filtro de
 contexto) y dispara el aviso real cuando detecta una falla,
 ANTES de que llegue al pico.

 Para que la demo sea corta, reproduce por "episodios": ventanas
 alrededor de cada falla real (cuando hay etiquetas). Si no hay
 etiquetas, reproduce la semana completa acelerada.
"""

import asyncio
from collections import deque
from datetime import timedelta

import notificaciones

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / "detector"))
import dataset as ds
import motor as mt


# Traduccion de la señal tecnica detectada a lenguaje de negocio.
SENAL_NEGOCIO = {
    "RAM": {
        "titulo": "Memoria del servidor de pedidos",
        "desc": "El servidor de pedidos esta consumiendo cada vez mas memoria. "
                "Si llega al limite, el proceso se reinicia y se pierden pedidos.",
        "accion": "Reiniciar el worker de pedidos y liberar memoria antes del corte.",
    },
    "latencia": {
        "titulo": "Sistema muy lento",
        "desc": "Los tiempos de respuesta estan sostenidamente altos. El portal "
                "de pedidos se vuelve inusable para los clientes.",
        "accion": "Liberar conexiones atascadas y ampliar el recurso del servidor.",
    },
    "latencia+errores": {
        "titulo": "Trafico anomalo al portal",
        "desc": "Latencia alta junto con errores sostenidos: trafico hostil o una "
                "falla que degrada el servicio de pedidos.",
        "accion": "Activar filtrado de trafico y revisar el portal de pedidos.",
    },
    "errores": {
        "titulo": "Errores en cascada",
        "desc": "Las operaciones estan fallando de forma sostenida; el servicio "
                "puede caerse por completo.",
        "accion": "Reiniciar el servicio afectado y aislar el fallo.",
    },
}


class ReplayEngine:
    """Reproduce una corrida real y detecta fallas en vivo."""

    def __init__(self):
        self.is_running = False
        self.cliente = ""
        self.corrida = ""
        self.ts = None
        self.riesgo = 8.0
        self.estado = "ok"
        self.senal = None
        self.alertado = False
        self.detecciones = []          # [{inicio, senal, anticipacion_min}]
        self.history = deque(maxlen=120)
        self.descripcion = ""
        self.accion_sugerida = ""
        self.aviso_enviado = False
        self.aviso_motivo = ""
        self._task = None
        self._stop = asyncio.Event()
        self._cfg = mt.Config()

    # ---- construccion de episodios ----
    def _episodios(self, filas, reales):
        """Ventanas [inicio-120, inicio+60] alrededor de cada falla real."""
        if not reales:
            # sin etiquetas: una sola 'ventana' = toda la serie
            return [(0, len(filas))]
        idx_por_ts = {f["ts"]: i for i, f in enumerate(filas)}
        eps = []
        for e in reales:
            ini = e["inicio"] - timedelta(minutes=120)
            fin = e["inicio"] + timedelta(minutes=60)
            i0 = next((i for i, f in enumerate(filas) if f["ts"] >= ini), 0)
            i1 = next((i for i, f in enumerate(filas) if f["ts"] > fin), len(filas))
            eps.append((i0, i1))
        return eps

    async def start(self, corrida: str, cliente: str = "gramo",
                    paso: int = 4, intervalo: float = 0.25):
        if self.is_running:
            raise ValueError("Ya hay una reproduccion en curso.")
        filas = ds.cargar_metricas(corrida, cliente)
        contexto = ds.cargar_contexto(corrida, cliente)
        try:
            etiquetas = ds.cargar_etiquetas(corrida, cliente)
            reales = [e for e in etiquetas if e["es_real"]]
        except FileNotFoundError:
            reales = []

        self.cliente, self.corrida = cliente, corrida
        self.is_running = True
        self._stop.clear()
        self.riesgo = 8.0
        self.estado = "ok"
        self.senal = None
        self.alertado = False
        self.detecciones = []
        self.history.clear()
        self.descripcion = ""
        self.accion_sugerida = ""
        self.aviso_enviado = False
        self.aviso_motivo = ""

        self._task = asyncio.create_task(
            self._loop(filas, contexto, reales, paso, intervalo)
        )

    async def stop(self):
        if not self.is_running:
            return
        self.is_running = False
        self._stop.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=3.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            self._task = None

    def _riesgo_actual(self, buf):
        """Riesgo 0-100 a partir de las mismas cuentas del detector."""
        c = self._cfg
        c_ram = sum(1 for b in buf if b["ram"] is not None and b["ram"] >= c.ram_alta)
        c_lat_mm = sum(1 for b in buf if b["latencia"] is not None and b["latencia"] >= c.lat_muy_alta)
        c_lat_a = sum(1 for b in buf if b["latencia"] is not None and b["latencia"] >= c.lat_alta)
        c_err_j = sum(1 for b in buf if b["errores"] is not None and b["errores"] >= c.err_leve)
        c_err_f = sum(1 for b in buf if b["errores"] is not None and b["errores"] >= c.err_fuerte)
        ratios = {
            "RAM": c_ram / c.n_ram,
            "latencia": c_lat_mm / c.n_lat_muy_alta,
            "latencia+errores": min(c_lat_a / c.n_lat_alta, c_err_j / c.n_err_junto),
            "errores": c_err_f / c.n_err_fuerte,
        }
        senal = max(ratios, key=ratios.get)
        riesgo = min(100.0, 100.0 * ratios[senal])
        return riesgo, senal, (ratios[senal] >= 1.0)

    async def _loop(self, filas, contexto, reales, paso, intervalo):
        ventanas = ds.ventanas_esperadas(contexto)
        cfg = self._cfg
        buf = []
        ultimo_aviso = None
        eps = self._episodios(filas, reales)
        try:
            for (i0, i1) in eps:
                buf = []  # cada episodio arranca limpio
                i = i0
                while i < i1 and self.is_running and not self._stop.is_set():
                    # avanzar 'paso' minutos por tick
                    for _ in range(paso):
                        if i >= i1:
                            break
                        buf.append(filas[i])
                        if len(buf) > cfg.ventana:
                            buf.pop(0)
                        i += 1
                    f = filas[min(i, i1) - 1]
                    self.ts = f["ts"]

                    if len(buf) >= cfg.ventana:
                        riesgo, senal, dispara = self._riesgo_actual(buf)
                        self.riesgo = max(8.0, riesgo)
                        self.senal = senal
                        self.history.append(round(self.riesgo, 1))
                        self.estado = ("ok" if self.riesgo < 40
                                       else "warn" if self.riesgo < 65 else "crit")

                        en_vent = ds.en_ventana_esperada(f["ts"], ventanas)
                        reciente = (ultimo_aviso and
                                    f["ts"] - ultimo_aviso < timedelta(minutes=cfg.rearme_min))
                        if dispara and not en_vent and not reciente:
                            await self._disparar(senal, buf[0]["ts"], f["ts"], reales)
                            ultimo_aviso = f["ts"]

                    try:
                        await asyncio.wait_for(self._stop.wait(), timeout=intervalo)
                        break
                    except asyncio.TimeoutError:
                        pass
        finally:
            self.is_running = False

    async def _disparar(self, senal, inicio, ts, reales):
        info = SENAL_NEGOCIO.get(senal, SENAL_NEGOCIO["errores"])
        self.alertado = True
        self.descripcion = info["desc"]
        self.accion_sugerida = info["accion"]

        # anticipacion vs la falla real mas cercana (si hay etiquetas)
        anticipacion = None
        for e in reales:
            if inicio - timedelta(minutes=120) <= inicio <= e["inicio"] + timedelta(minutes=120):
                if abs((e["inicio"] - inicio).total_seconds()) <= 120 * 60:
                    anticipacion = round((e["inicio"] - inicio).total_seconds() / 60)
                    break
        self.detecciones.append({
            "inicio": inicio.isoformat(),
            "senal": senal,
            "anticipacion_min": anticipacion,
        })
        # aviso real al responsable
        try:
            res = await notificaciones.enviar_telegram(info["titulo"], info["desc"])
            self.aviso_enviado = bool(res.get("enviado"))
            self.aviso_motivo = res.get("motivo", "")
        except Exception as e:
            self.aviso_enviado = False
            self.aviso_motivo = str(e)

    def to_dict(self):
        prom = [d["anticipacion_min"] for d in self.detecciones if d["anticipacion_min"] is not None]
        return {
            "fuente": "dataset",
            "is_running": self.is_running,
            "cliente": self.cliente,
            "corrida": self.corrida,
            "ts": self.ts.isoformat() if self.ts else None,
            "riesgo": round(self.riesgo, 1),
            "salud": round(100 - self.riesgo),
            "estado": self.estado,
            "senal": self.senal,
            "alertado": self.alertado,
            "descripcion": self.descripcion,
            "accion_sugerida": self.accion_sugerida,
            "history": list(self.history),
            "detecciones": self.detecciones,
            "aviso_enviado": self.aviso_enviado,
            "aviso_motivo": self.aviso_motivo,
            "aviso_configurado": notificaciones.esta_configurado(),
            "resultado": {
                "detectadas": len(self.detecciones),
                "anticipacion_prom": round(sum(prom) / len(prom)) if prom else None,
            },
        }
