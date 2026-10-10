"""
======================================================
 SecureGuard · gramo - Servidor del tablero NodeMCU
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Servidor dedicado al cliente gramo (distribuidora de alimentos).
 Dos fuentes de telemetria alimentan el mismo monitor:

   1) REPETICION del kit Zikit: reproduce una corrida real de
      gramo minuto a minuto (acelerada) y avisa en el momento en
      que el detector confirma una falla, antes del pico.
   2) NODEMCU en vivo: la placa (ESP8266) manda su telemetria a
      /api/nodemcu/telemetria y recibe de vuelta el semaforo para
      encender sus LEDs y su zumbador.

 El aviso al responsable sale por Telegram con la misma
 configuracion del backend principal (backend/.env).

 La vista "Tablero NodeMCU" del tablero principal (puerto 9090)
 lee este mismo servidor.

 Ejecutar:
   pip install -r ../requirements.txt
   python server.py          ->  http://localhost:9091
======================================================
"""

import asyncio
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import gramo
from monitor import EnVivo, MonitorGramo

sys.path.insert(0, str(gramo.RAIZ_REPO / "backend"))
import notificaciones  # noqa: E402  (backend/notificaciones.py, lee backend/.env)

PUERTO = 9091

# minutos simulados por segundo real
VELOCIDADES = {"lenta": 10, "media": 60, "rapida": 240}
TICK_S = 0.25


# =============================================================
#  AVISOS
# =============================================================

async def avisar(aviso, origen: str):
    """Manda el aviso por Telegram. Nunca rompe el monitoreo si falla."""
    f = aviso.falla
    cuerpo = (f"gramo · {f['sistema']} · {origen}\n"
              f"{f['que_pasa']}\n\n"
              f"Detectado: {aviso.disparo:%a %d %H:%M} ({aviso.detalle})\n"
              f"Qué hacer: {f['accion']}")
    try:
        aviso.telegram = await notificaciones.enviar_telegram(f["titulo"], cuerpo, origen=origen)
    except Exception as e:  # pragma: no cover
        aviso.telegram = {"enviado": False, "motivo": str(e)}


# =============================================================
#  REPETICION DE UNA CORRIDA DEL KIT
# =============================================================

class Repeticion:
    def __init__(self):
        self.corrida: str | None = None
        self.velocidad = VELOCIDADES["media"]
        self.filas: list[dict] = []
        self.i = 0
        self.monitor: MonitorGramo | None = None
        self.contexto = ""
        self.corriendo = False
        self._task: asyncio.Task | None = None

    def cargar(self, corrida: str, velocidad: str):
        self.corrida = corrida
        self.velocidad = VELOCIDADES.get(velocidad, VELOCIDADES["media"])
        self.filas = gramo.cargar_metricas(corrida)
        self.contexto = gramo.cargar_contexto(corrida)
        self.monitor = MonitorGramo(self.contexto, gramo.cargar_etiquetas(corrida),
                                    gramo.cargar_logs(corrida))
        self.i = 0

    async def iniciar(self, corrida: str, velocidad: str):
        await self.detener()
        self.cargar(corrida, velocidad)
        self.corriendo = True
        self._task = asyncio.create_task(self._loop())

    async def detener(self):
        self.corriendo = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def avanzar(self, minutos: int):
        """Procesa los siguientes N minutos de la corrida."""
        for _ in range(minutos):
            if self.i >= len(self.filas):
                self.corriendo = False
                return
            aviso = self.monitor.procesar(self.filas[self.i])
            self.i += 1
            if aviso:
                await avisar(aviso, f"repeticion {self.corrida}")

    async def _loop(self):
        acumulado = 0.0
        while self.corriendo:
            acumulado += self.velocidad * TICK_S
            paso = int(acumulado)
            acumulado -= paso
            await self.avanzar(paso)
            await asyncio.sleep(TICK_S)

    def to_dict(self) -> dict:
        if not self.monitor:
            return {"fuente": "repeticion", "cargada": False, "corriendo": False}
        return {
            "fuente": "repeticion", "cargada": True, "corriendo": self.corriendo,
            "corrida": self.corrida, "velocidad_min_s": self.velocidad,
            "progreso": round(100 * self.i / max(1, len(self.filas)), 1),
            "total_minutos": len(self.filas),
            **self.monitor.to_dict(),
        }


# =============================================================
#  NODEMCU EN VIVO
# =============================================================

# La logica de la placa en vivo (EnVivo) vive en monitor.py.


repeticion = Repeticion()
en_vivo = EnVivo()


def fuente_activa() -> str:
    """La NodeMCU manda si esta conectada; si no, la repeticion."""
    return "nodemcu" if en_vivo.conectada() else "repeticion"


# =============================================================
#  APLICACION
# =============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    await repeticion.detener()


app = FastAPI(title="SecureGuard · gramo (NodeMCU)",
              description="Monitoreo predictivo del cliente gramo con NodeMCU",
              version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


class ConfigRepeticion(BaseModel):
    corrida: str = gramo.PRINCIPAL
    velocidad: str = "media"


class Telemetria(BaseModel):
    placa: str = "nodemcu-01"
    ip: str = ""
    cpu: float | None = Field(default=None, ge=0, le=100)
    ram: float | None = Field(default=None, ge=0, le=100)
    disco: float | None = Field(default=None, ge=0, le=100)
    latencia_ms: float | None = Field(default=None, ge=0)
    errores: float | None = Field(default=None, ge=0)
    heap_libre: int | None = None
    temperatura: float | None = Field(default=None, ge=-40, le=150)
    estado_termico: str | None = None
    rele: bool | None = None


@app.get("/api/gramo/contexto")
async def contexto():
    """Contexto de negocio de gramo: sistemas, ventanas esperadas y fallas."""
    return gramo.contexto_publico(gramo.contexto_por_defecto())


@app.get("/api/gramo/corridas")
async def corridas():
    return {"corridas": gramo.listar_corridas(), "velocidades": VELOCIDADES}


@app.post("/api/repeticion/iniciar")
async def repeticion_iniciar(cfg: ConfigRepeticion):
    try:
        await repeticion.iniciar(cfg.corrida, cfg.velocidad)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return repeticion.to_dict()


@app.post("/api/repeticion/detener")
async def repeticion_detener():
    await repeticion.detener()
    return repeticion.to_dict()


@app.get("/api/estado")
async def estado(fuente: str = Query(default="")):
    """Estado del monitor. fuente = repeticion | nodemcu (por defecto, la activa)."""
    f = fuente or fuente_activa()
    data = en_vivo.to_dict() if f == "nodemcu" else repeticion.to_dict()
    data["aviso_configurado"] = notificaciones.esta_configurado()
    data["nodemcu_conectada"] = en_vivo.conectada()
    data["termico"] = en_vivo.termico_dict()
    return data


# =============================================================
#  RUTAS DE LA PLACA  (/api/nodemcu/...)
# =============================================================

router_placa = APIRouter(prefix="/api/nodemcu", tags=["nodemcu"])


@router_placa.post("/telemetria")
async def nodemcu_telemetria(t: Telemetria):
    """
    La NodeMCU manda su telemetria; la respuesta trae el semaforo a mostrar.
    Respuesta compacta para que ArduinoJson la lea con poca memoria.
    """
    aviso = en_vivo.recibir(t)
    if aviso:
        await avisar(aviso, f"NodeMCU {t.placa}")
    m = en_vivo.monitor
    return {"estado": m.estado(), "riesgo": round(m.riesgo), "aviso": bool(aviso),
            "minutos": m.minutos}


@router_placa.get("/semaforo")
async def nodemcu_semaforo():
    """Semaforo de la fuente activa (para que la placa solo lo muestre)."""
    data = en_vivo.monitor if fuente_activa() == "nodemcu" else repeticion.monitor
    if data is None:
        return {"estado": "verde", "riesgo": 0, "fuente": "ninguna"}
    return {"estado": data.estado(), "riesgo": round(data.riesgo), "fuente": fuente_activa(),
            "avisos": len(data.avisos)}


@router_placa.get("/temperatura")
async def nodemcu_temperatura():
    """Temperatura del sensor LM35 de la placa (ultima lectura e historial)."""
    return en_vivo.termico_dict()


@router_placa.post("/reiniciar")
async def nodemcu_reiniciar(respetar_contexto: bool = False):
    en_vivo.reiniciar(respetar_contexto)
    return en_vivo.to_dict()


app.include_router(router_placa)


@app.get("/api/aviso/estado")
async def aviso_estado():
    return {"configurado": notificaciones.esta_configurado()}


@app.post("/api/aviso/probar")
async def aviso_probar():
    if not notificaciones.esta_configurado():
        raise HTTPException(status_code=400,
                            detail="Falta configurar TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID en backend/.env")
    return await notificaciones.enviar_telegram(
        "Prueba de SecureGuard · gramo",
        "Si recibes este mensaje, los avisos de gramo estan funcionando.")


# Estilos y graficas compartidos con el tablero principal (dashboard/): la
# pagina los pide como dashboard/...
dashboard_dir = gramo.RAIZ_REPO / "dashboard"
if dashboard_dir.exists():
    app.mount("/dashboard", StaticFiles(directory=str(dashboard_dir)), name="dashboard")

web_dir = Path(__file__).resolve().parent.parent / "web"
if web_dir.exists():
    app.mount("/", StaticFiles(directory=str(web_dir), html=True), name="web")



if __name__ == "__main__":
    import uvicorn

    print("\n=======================================")
    print(" SecureGuard · gramo (NodeMCU)")
    print(f" Corridas disponibles: {len(gramo.listar_corridas())}")
    print(f" Abre: http://localhost:{PUERTO}")
    print("=======================================\n")
    uvicorn.run(app, host="0.0.0.0", port=PUERTO, log_level="info")
