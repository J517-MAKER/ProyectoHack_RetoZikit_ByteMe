"""
======================================================
 SecureGuard - Motor de deteccion sobre datos reales
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Recorre las metricas minuto a minuto y decide cuando una
 anomalia es una FALLA REAL que merece aviso, distinguiendola
 del ruido normal del negocio.

 Clave aprendida de los datos: los minutos sueltos NO sirven
 (el trafico normal tiene picos de latencia >230 ms, 94% RAM o
 14 errores en un minuto aislado). Una falla real se delata por
 señales SOSTENIDAS durante varios minutos. Por eso el motor
 cuenta, en una ventana movil amplia, cuantos minutos cumplen
 cada condicion, y solo dispara cuando la evidencia persiste.

 Prioridad del reto: CERO FALSAS ALARMAS.
 Reglas (calibradas contra las 54 corridas de gramo):
   - RAM:        RAM sostenida alta            -> fuga de memoria
   - Latencia:   latencia sostenida muy alta   -> agotamiento/bloqueo
   - Lat+Errores: latencia alta + errores juntos-> trafico hostil
   - Errores:    errores sostenidos fuertes    -> fallo en cascada
 Mas: filtro de contexto (ventanas esperadas) y anti-duplicado.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from statistics import median

from dataset import ventanas_esperadas, en_ventana_esperada


@dataclass
class Config:
    min_base: int = 180           # minutos iniciales para la linea base
    ventana: int = 15             # ventana movil de evaluacion (minutos)

    # Umbrales por metrica (minuto "malo" para cada señal)
    ram_alta: float = 82.0
    lat_muy_alta: float = 180.0   # agotamiento sostiene ~220; normal ~58
    lat_alta: float = 125.0       # trafico sostiene ~144
    err_fuerte: float = 4.0
    err_leve: float = 2.0

    # Cuantos minutos "malos" dentro de la ventana para disparar cada señal
    n_ram: int = 12
    n_lat_muy_alta: int = 12
    n_lat_alta: int = 10          # para la regla combinada
    n_err_junto: int = 8          # errores que acompañan al trafico
    n_err_fuerte: int = 10

    rearme_min: int = 240         # silencio tras un aviso (anti-duplicado)


@dataclass
class Deteccion:
    inicio: datetime
    senal: str
    detalle: str


def _baseline(filas, cfg):
    lats = [f["latencia"] for f in filas[:cfg.min_base] if f["latencia"] is not None]
    return median(lats) if lats else 50.0


def detectar(filas, contexto, cfg: Config = None) -> list[Deteccion]:
    """
    Corre el detector sobre una serie de metricas. Devuelve la lista de
    detecciones (avisos), ya filtradas por contexto y anti-duplicado.
    """
    cfg = cfg or Config()
    ventanas = ventanas_esperadas(contexto)

    detecciones = []
    buf = []                      # ventana movil de filas recientes
    ultimo_aviso = None

    for f in filas:
        buf.append(f)
        if len(buf) > cfg.ventana:
            buf.pop(0)
        if len(buf) < cfg.ventana:
            continue

        # contar minutos "malos" por condicion dentro de la ventana
        c_ram = sum(1 for b in buf if b["ram"] is not None and b["ram"] >= cfg.ram_alta)
        c_lat_mm = sum(1 for b in buf if b["latencia"] is not None and b["latencia"] >= cfg.lat_muy_alta)
        c_lat_a = sum(1 for b in buf if b["latencia"] is not None and b["latencia"] >= cfg.lat_alta)
        c_err_j = sum(1 for b in buf if b["errores"] is not None and b["errores"] >= cfg.err_leve)
        c_err_f = sum(1 for b in buf if b["errores"] is not None and b["errores"] >= cfg.err_fuerte)

        # evaluar reglas (de mas a menos severa)
        senal = detalle = None
        if c_ram >= cfg.n_ram:
            senal, detalle = "RAM", f"RAM alta sostenida ({c_ram}/{cfg.ventana} min)"
        elif c_lat_mm >= cfg.n_lat_muy_alta:
            senal, detalle = "latencia", f"latencia muy alta sostenida ({c_lat_mm}/{cfg.ventana} min)"
        elif c_lat_a >= cfg.n_lat_alta and c_err_j >= cfg.n_err_junto:
            senal, detalle = "latencia+errores", f"latencia alta y errores juntos ({c_lat_a}+{c_err_j}/{cfg.ventana} min)"
        elif c_err_f >= cfg.n_err_fuerte:
            senal, detalle = "errores", f"errores sostenidos ({c_err_f}/{cfg.ventana} min)"

        if senal is None:
            continue

        ts = f["ts"]
        if ultimo_aviso and ts - ultimo_aviso < timedelta(minutes=cfg.rearme_min):
            continue
        if en_ventana_esperada(ts, ventanas):
            continue

        # inicio estimado: primer minuto de la racha dentro de la ventana
        inicio = buf[0]["ts"]
        detecciones.append(Deteccion(inicio=inicio, senal=senal, detalle=detalle))
        ultimo_aviso = ts

    return detecciones
