"""
======================================================
 SecureGuard - Backend de Monitoreo Predictivo
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Detecta temprano fallas de TI en una PyME y calcula un
 indice de riesgo (0-100) por umbrales + tendencia, para
 avisar ANTES de que el equipo falle y el cliente llame.

 Stack: FastAPI + aiohttp + asyncio

 Ejecutar:
   pip install -r requirements.txt
   python server.py
======================================================
"""

import asyncio
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

import aiohttp
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import notificaciones


# =============================================================
#  ESCENARIOS DE FALLA
# =============================================================
# Cada escenario describe como se degrada una senal real de un
# equipo de PyME. "base" es el valor sano, "fail" el valor al que
# el equipo colapsa. El motor interpola entre ambos en el tiempo.

SCENARIOS = {
    "memory": {
        "nombre": "Fuga de memoria en la caja",
        "driver": "mem", "unidad": "%", "base": 12, "fail": 100,
        "descripcion": "La caja registradora consume cada vez mas memoria. "
                       "Si llega al limite, se reinicia y se pierde la venta en curso.",
        "accion": "Liberar memoria y reiniciar el programa de la caja "
                  "(sin perder la venta actual).",
    },
    "disk": {
        "nombre": "Disco del servidor lleno",
        "driver": "mem", "unidad": "%", "base": 20, "fail": 100,
        "descripcion": "El servidor donde se guardan ventas y facturas se esta llenando. "
                       "Sin espacio, deja de registrar operaciones.",
        "accion": "Liberar espacio y archivar registros antiguos de forma automatica.",
    },
    "latency": {
        "nombre": "Sistema lento",
        "driver": "lat", "unidad": "ms", "base": 40, "fail": 600,
        "descripcion": "El sistema responde cada vez mas lento. Los cobros tardan "
                       "y los clientes esperan.",
        "accion": "Liberar conexiones atascadas y ampliar el recurso del servidor.",
    },
    "errors": {
        "nombre": "Errores en cascada",
        "driver": "err", "unidad": "", "base": 0, "fail": 50,
        "descripcion": "Empiezan a fallar operaciones sueltas. Un fallo puede arrastrar "
                       "a otros hasta detener el servicio.",
        "accion": "Reiniciar el servicio afectado y aislar el fallo antes de que se extienda.",
    },
}

# Velocidad de degradacion (multiplicador del avance temporal)
SPEEDS = {"lenta": 0.55, "media": 1.0, "rapida": 1.7}

# Sensibilidad del aviso -> umbral de riesgo al que se dispara la alerta
SENSITIVITIES = {"baja": 78, "normal": 65, "alta": 52}


# =============================================================
#  MOTOR DE RIESGO
# =============================================================

class RiskEngine:
    """
    Simula la degradacion de un equipo y calcula un indice de
    riesgo 0-100 combinando NIVEL (que tan cerca del fallo) y
    TENDENCIA (que tan rapido sube). Emite la alerta cuando el
    riesgo cruza el umbral configurado, antes del punto de falla.
    """

    def __init__(self):
        self.is_running: bool = False
        self.scenario_key: str = "memory"
        self.speed: float = 1.0
        self.threshold: int = 65
        self.t: int = 0                       # segundos simulados
        self.value: float = 0.0               # valor actual de la senal
        self.risk: float = 0.0                # indice de riesgo actual
        self.ewma: float = 0.0                # media movil para la tendencia
        self.history: deque = deque(maxlen=120)
        self.detect_t: int | None = None      # segundo en que se detecto
        self.fail_t: int | None = None        # segundo en que fallaria
        self.alerted: bool = False
        self.resolved: bool = False
        self.aviso_enviado: bool = False      # si el aviso real salio
        self.aviso_motivo: str = ""           # motivo si no salio
        self._pending_alert: bool = False
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    @property
    def scenario(self) -> dict:
        return SCENARIOS[self.scenario_key]

    def _reset_stats(self):
        scn = self.scenario
        self.t = 0
        self.value = scn["base"]
        self.risk = 8.0
        self.ewma = scn["base"]
        self.history.clear()
        self.detect_t = None
        self.fail_t = None
        self.alerted = False
        self.resolved = False
        self.aviso_enviado = False
        self.aviso_motivo = ""
        self._pending_alert = False

    async def start(self, scenario: str, speed: str, sensitivity: str):
        if self.is_running:
            raise ValueError("Ya hay una simulacion en curso. Detenla primero.")
        if scenario not in SCENARIOS:
            raise ValueError(f"Escenario desconocido: {scenario}")

        self.scenario_key = scenario
        self.speed = SPEEDS.get(speed, 1.0)
        self.threshold = SENSITIVITIES.get(sensitivity, 65)
        self.is_running = True
        self._stop.clear()
        self._reset_stats()

        self._task = asyncio.create_task(self._loop())
        print(f"[sim] Escenario '{scenario}' iniciado "
              f"(velocidad {speed}, sensibilidad {sensitivity}, umbral {self.threshold}).")

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

    async def resolve(self):
        """Aplica el runbook: dobla la curva de riesgo hacia abajo."""
        if not self.is_running or self.resolved:
            return
        self.resolved = True
        print("[sim] Runbook ejecutado. Riesgo contenido antes del punto de falla.")

    def _step(self):
        """Un tick de un segundo simulado."""
        scn = self.scenario
        self.t += 1

        if self.resolved:
            # Recuperacion: el riesgo baja hasta estabilizarse
            self.risk = max(8.0, self.risk - 7)
            self.value = max(scn["base"], self.value * 0.85)
            self.history.append(round(self.risk, 1))
            if self.risk <= 10:
                self.is_running = False
            return

        # Progresion de la senal (ease-in cuadratico)
        p = min(self.t * self.speed / 42.0, 1.25)
        raw = scn["base"] + (scn["fail"] - scn["base"]) * (p * p)
        self.value = min(raw, scn["fail"])

        # --- Indice de riesgo = NIVEL + TENDENCIA ---
        span = scn["fail"] - scn["base"]
        level = _clamp((self.value - scn["base"]) / span * 100, 0, 100)
        self.ewma += 0.5 * (self.value - self.ewma)
        slope = self.value - self.ewma
        trend_boost = _clamp(slope / span * 100 * 1.6, 0, 35)
        risk = _clamp(level * 0.8 + trend_boost, 0, 100)
        self.risk = max(risk, self.risk - 2)  # suaviza, casi monotono
        self.history.append(round(self.risk, 1))

        # Deteccion: cruce del umbral
        if not self.alerted and self.risk >= self.threshold:
            self.alerted = True
            self.detect_t = self.t
            self._pending_alert = True   # el loop enviara el aviso real

        # Punto de falla
        if self.fail_t is None and self.value >= scn["fail"]:
            self.fail_t = self.t
            self.is_running = False

        if self.t > 80:
            self.is_running = False

    async def _loop(self):
        try:
            while self.is_running and not self._stop.is_set():
                self._step()
                # Si se cruzo el umbral en este tick, manda el aviso real
                if getattr(self, "_pending_alert", False):
                    self._pending_alert = False
                    await self._enviar_aviso()
                try:
                    await asyncio.wait_for(self._stop.wait(), timeout=0.35)
                    break
                except asyncio.TimeoutError:
                    pass
        finally:
            self.is_running = False

    async def _enviar_aviso(self):
        """Dispara el aviso al responsable (Telegram) al detectar el riesgo."""
        scn = self.scenario
        try:
            res = await notificaciones.enviar_telegram(scn["nombre"], scn["descripcion"])
            self.aviso_enviado = bool(res.get("enviado"))
            self.aviso_motivo = res.get("motivo", "")
            if self.aviso_enviado:
                print(f"[aviso] Enviado al responsable: {scn['nombre']}")
            else:
                print(f"[aviso] No se envio ({self.aviso_motivo}). "
                      f"La demo visual sigue funcionando.")
        except Exception as e:
            self.aviso_enviado = False
            self.aviso_motivo = str(e)

    def _band(self) -> str:
        if self.risk < 40:
            return "ok"
        if self.risk < self.threshold:
            return "warn"
        return "crit"

    def _window(self):
        """Ventana de anticipacion: segundos entre deteccion y falla."""
        if self.detect_t is None:
            return None
        fail = self.fail_t
        if fail is None:
            # estima el punto de falla si aun no se alcanzo
            fail = self.detect_t + max(1, round(12 / self.speed))
        return {"detect_t": self.detect_t, "fail_t": fail,
                "ventana_s": fail - self.detect_t}

    def to_dict(self) -> dict:
        scn = self.scenario
        return {
            "is_running": self.is_running,
            "escenario": self.scenario_key,
            "escenario_nombre": scn["nombre"],
            "descripcion": scn["descripcion"],
            "accion_sugerida": scn["accion"],
            "unidad": scn["unidad"],
            "t": self.t,
            "valor_senal": round(self.value, 1),
            "riesgo": round(self.risk, 1),
            "salud": round(100 - self.risk),
            "estado": self._band(),
            "umbral": self.threshold,
            "alertado": self.alerted,
            "resuelto": self.resolved,
            "aviso_enviado": self.aviso_enviado,
            "aviso_motivo": self.aviso_motivo,
            "aviso_configurado": notificaciones.esta_configurado(),
            "history": list(self.history),
            "resultado": self._window(),
        }


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


# =============================================================
#  APLICACION FASTAPI
# =============================================================

engine = RiskEngine()


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await engine.stop()


app = FastAPI(
    title="SecureGuard - Monitoreo Predictivo",
    description="Deteccion temprana de fallas de TI en PyMEs (Reto Zikit)",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================
#  MODELOS
# =============================================================

class SimConfig(BaseModel):
    escenario: str = "memory"
    velocidad: str = "media"       # lenta | media | rapida
    sensibilidad: str = "normal"   # baja | normal | alta


# =============================================================
#  ENDPOINTS - SIMULACION / MONITOREO
# =============================================================

@app.get("/api/escenarios")
async def listar_escenarios():
    """Catalogo de fallas simulables, para poblar el panel de demo."""
    return {
        k: {"nombre": v["nombre"], "descripcion": v["descripcion"]}
        for k, v in SCENARIOS.items()
    }


@app.get("/api/aviso/estado")
async def aviso_estado():
    """Dice si el envio de avisos reales (Telegram) esta configurado."""
    return {"configurado": notificaciones.esta_configurado()}


@app.post("/api/aviso/probar")
async def probar_aviso():
    """Manda un aviso de prueba al celular del responsable."""
    if not notificaciones.esta_configurado():
        raise HTTPException(
            status_code=400,
            detail="Falta configurar TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en backend/.env",
        )
    res = await notificaciones.enviar_telegram(
        "Prueba de SecureGuard",
        "Si recibes este mensaje, los avisos al responsable estan funcionando.",
    )
    return res


@app.post("/api/simular/iniciar")
async def iniciar_simulacion(config: SimConfig):
    """Inyecta un escenario de falla y arranca el monitoreo."""
    try:
        await engine.start(config.escenario, config.velocidad, config.sensibilidad)
        return {"status": "iniciado", **engine.to_dict()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/simular/detener")
async def detener_simulacion():
    """Detiene la simulacion en curso."""
    await engine.stop()
    return {"status": "detenido", **engine.to_dict()}


@app.post("/api/simular/resolver")
async def resolver():
    """Ejecuta el runbook: contiene el riesgo antes del punto de falla."""
    await engine.resolve()
    return {"status": "resuelto", **engine.to_dict()}


@app.get("/api/estado")
async def estado():
    """Estado actual del monitor (salud, riesgo, tendencia, resultado)."""
    return engine.to_dict()


# =============================================================
#  ENDPOINTS - TELEMETRIA REAL DEL ESP32 (MODO HIBRIDO)
# =============================================================

@app.get("/api/equipo/salud")
async def salud_equipo(ip: str = Query(default="")):
    """
    Lee la salud real de un ESP32 en la red (endpoint /health del
    firmware). Si no responde, el monitor sigue en modo simulado.
    """
    if not ip:
        return {"reachable": False, "ip": "", "salud": None}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"http://{ip}/health",
                timeout=aiohttp.ClientTimeout(total=3),
            ) as resp:
                data = await resp.json()
                return {"reachable": True, "ip": ip, "salud": data}
    except Exception:
        return {"reachable": False, "ip": ip, "salud": None}


@app.get("/api/equipo/estado")
async def equipo_estado(ip: str = Query(default="")):
    """Verifica si el ESP32 es alcanzable."""
    if not ip:
        return {"reachable": False, "ip": ""}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"http://{ip}/health",
                timeout=aiohttp.ClientTimeout(total=2),
            ) as resp:
                if resp.status == 200:
                    return {"reachable": True, "ip": ip}
    except Exception:
        pass
    return {"reachable": False, "ip": ip}


# =============================================================
#  SERVIR DASHBOARD (ARCHIVOS ESTATICOS)
# =============================================================

dashboard_dir = Path(__file__).parent.parent / "dashboard"
if dashboard_dir.exists():
    app.mount("/", StaticFiles(directory=str(dashboard_dir), html=True), name="dashboard")
    print(f"[web] Dashboard servido desde: {dashboard_dir}")


# =============================================================
#  PUNTO DE ENTRADA
# =============================================================

if __name__ == "__main__":
    import uvicorn

    print()
    print("=======================================")
    print(" SecureGuard - Monitoreo Predictivo")
    print(" Reto Zikit 'Antes de que suene el telefono'")
    print("=======================================")
    print(" Abre: http://localhost:9090")
    print()

    uvicorn.run(app, host="0.0.0.0", port=9090, log_level="info")
