"""
======================================================
 SecureGuard - Datos reales de gramo (kit Zikit)
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 API del tablero principal para gramo, la distribuidora de
 alimentos del kit de datos. Para cada semana (corrida) sirve:

   - la telemetria real minuto a minuto (metricas.csv),
   - el indice de riesgo y los avisos del detector, verificados
     contra la solucion del kit cuando existe,
   - los registros (logs.md) y el contexto del negocio (contexto.md),

 y controla la repeticion en vivo de una semana: mientras avanza,
 cada aviso sale al responsable por Telegram en el minuto en que
 el detector lo confirma, antes del pico de la falla.

 Reutiliza la logica ya calibrada y probada, sin duplicarla:
   backend/detector/            lectura del kit y reglas del detector
   dashboard_nodemcu/servidor/  gramo.py (contexto y runbooks) y
                                monitor.py (detector minuto a minuto)
======================================================
"""

import asyncio
import json
import re
import sys
import threading
import time
from bisect import bisect_left, bisect_right
from collections import Counter, OrderedDict
from dataclasses import asdict
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

import notificaciones

sys.path.append(str(Path(__file__).resolve().parent.parent / "dashboard_nodemcu" / "servidor"))
import gramo  # noqa: E402  (dashboard_nodemcu/servidor/gramo.py)
from monitor import UMBRAL_AMBAR, UMBRAL_ROJO, MonitorGramo  # noqa: E402
from motor import Config  # noqa: E402  (backend/detector/motor.py, en sys.path via gramo)
import dataset as ds  # noqa: E402  (backend/detector/dataset.py)

router = APIRouter(prefix="/api/gramo", tags=["gramo"])

VELOCIDADES = {"lenta": 10, "media": 60, "rapida": 240}   # minutos de datos por segundo
TICK_S = 0.1
METRICAS = ("cpu", "ram", "disco", "latencia", "errores")
SENALES = list(gramo.FALLAS)          # orden fijo para codificar la señal de cada minuto

# Nombre legible de cada tipo que aparece en la solucion del kit.
TIPOS = {
    "trafico_hostil_lento": "Tráfico hostil lento hacia el portal",
    "fuga_memoria_worker": "Fuga de memoria en pedidos-worker",
    "agotamiento_pool_inventario": "Pool de conexiones de inventario agotado",
    "promo_2x1": "Promoción 2x1 para restaurantes",
    "snapshot_inventario": "Snapshot semanal de inventario",
    "reporte_rutas_nocturno": "Reporte nocturno de rutas",
}


# =============================================================
#  DIAGNOSTICO: QUE SISTEMA REVISAR
# =============================================================
# El detector decide CUANDO avisar solo con las metricas. Pero la misma
# firma (latencia alta + errores) aparece en dos fallas distintas de gramo:
# trafico hostil (fw-01) y el pool de inventario agotado. Las pistas de
# logs.md de las horas previas dicen cual es, para que el aviso nombre el
# sistema correcto y su runbook. No cambian ni adelantan ningun aviso.

PISTAS = {
    "RAM": re.compile(r"memoria|heap|pausa de GC", re.I),
    "latencia": re.compile(r"pool de conexiones a inventario|consultando inventario", re.I),
    "latencia+errores": re.compile(r"por encima de lo habitual|conn/s|syn flood", re.I),
}
HORAS_PISTAS = timedelta(hours=12)


def diagnosticar(senal: str, ts: datetime, registros: list[dict], ts_registros: list[datetime]):
    """(clave de gramo.FALLAS, registro que la respalda o None) para la señal en ts."""
    previos = registros[bisect_left(ts_registros, ts - HORAS_PISTAS):bisect_right(ts_registros, ts)]

    def pista(clave):
        patron = PISTAS.get(clave)
        if patron is None:
            return None
        return next((r for r in reversed(previos) if patron.search(r["mensaje"])), None)

    if senal == "latencia+errores":
        inventario = pista("latencia")
        if inventario:
            return "latencia", inventario
    return senal, pista(senal)


# =============================================================
#  CONTEXTO DEL NEGOCIO (contexto.md)
# =============================================================

_DIAS = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]
_RE_CAMPO = re.compile(r"-\s*\*\*(.+?):\*\*\s*(.*)")


def leer_contexto(texto: str) -> dict:
    """Estructura contexto.md: cabecera, sistemas criticos, eventos y notas."""
    datos = {"titulo": "", "cabecera": {}, "sistemas": [], "eventos": [], "notas": []}
    seccion = ""
    for linea in texto.splitlines():
        s = linea.strip()
        if s.startswith("# "):
            datos["titulo"] = s[2:].strip()
        elif s.startswith("## "):
            seccion = ds._sin_acentos(s[3:].lower())
        elif not seccion and _RE_CAMPO.match(s):
            m = _RE_CAMPO.match(s)
            datos["cabecera"][ds._sin_acentos(m.group(1).strip().lower())] = m.group(2).strip()
        elif seccion.startswith("sistemas") and s.startswith("|"):
            celdas = [c.strip() for c in s.strip("|").split("|")]
            if len(celdas) >= 3 and celdas[0].lower() != "sistema" and set(celdas[0]) - set("-: "):
                datos["sistemas"].append({"nombre": celdas[0], "descripcion": celdas[1],
                                          "ventana_critica": celdas[2]})
        elif seccion.startswith("eventos") and s.startswith("- "):
            m = _RE_CAMPO.match(s)
            datos["eventos"].append({"cuando": m.group(1), "que": m.group(2)} if m
                                    else {"cuando": "", "que": s[2:]})
        elif seccion.startswith("notas") and s.startswith("- "):
            datos["notas"].append(s[2:].strip())
    return datos


def horario_atencion(contexto: str) -> dict | None:
    """Dias y horas de atencion declarados ('lunes a sabado 07:00–16:00')."""
    txt = ds._sin_acentos(contexto.lower())
    m = re.search(r"horario:\*\*\s*(\w+)\s+a\s+(\w+)\s+(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})", txt)
    if not m or m.group(1) not in _DIAS or m.group(2) not in _DIAS:
        return None
    d0, d1 = _DIAS.index(m.group(1)), _DIAS.index(m.group(2))
    return {"dias": list(range(d0, d1 + 1)),
            "ini": f"{int(m.group(3)):02d}:{m.group(4)}", "fin": f"{int(m.group(5)):02d}:{m.group(6)}"}


def nombre_ventana(motivo: str) -> str:
    """Nombre corto de una ventana esperada del detector (pico anunciado)."""
    m = motivo.lower()
    if "promo" in m:
        return "Promoción 2x1"
    if "snapshot" in m:
        return "Snapshot de inventario"
    if "nocturn" in m:
        return "Tareas nocturnas"
    return motivo.split(":")[0].strip().capitalize()


def reglas_detector() -> dict:
    """Umbrales del detector calibrado, para explicar en el tablero por que avisa."""
    return {**asdict(Config()), "umbral_ambar": UMBRAL_AMBAR, "umbral_rojo": UMBRAL_ROJO}


# =============================================================
#  UNA SEMANA PROCESADA
# =============================================================

def _registro(r: dict, i: int) -> dict:
    return {"i": i, "ts": r["ts"].isoformat(), "fuente": r["fuente"],
            "nivel": r["nivel"], "mensaje": r["mensaje"]}


def _entero(v):
    return None if v is None else int(round(v))


class Semana:
    """Una semana (corrida) de gramo procesada minuto a minuto por el monitor."""

    def __init__(self, corrida: str):
        filas = gramo.cargar_metricas(corrida)
        if not filas:
            raise FileNotFoundError(f"La corrida '{corrida}' no tiene metricas.")
        self.corrida = corrida
        self.filas = filas
        self.n = len(filas)
        self.ts = [f["ts"] for f in filas]
        self.contexto = gramo.cargar_contexto(corrida)
        self.etiquetas = gramo.cargar_etiquetas(corrida)
        self.registros = gramo.cargar_logs(corrida, niveles=("DEBUG", "INFO", "WARN", "ERROR"))
        self.ts_registros = [r["ts"] for r in self.registros]

        monitor = MonitorGramo(self.contexto, self.etiquetas)
        self.estados = []      # por minuto: (riesgo, señal dominante, cuentas, ventana esperada)
        self.avisos = []
        for i, f in enumerate(filas):
            aviso = monitor.procesar(f)
            ventana = monitor.ventana_actual
            self.estados.append((round(monitor.riesgo, 1), monitor.senal_dominante,
                                 dict(monitor.cuentas),
                                 nombre_ventana(ventana["motivo"]) if ventana else None))
            if aviso:
                self.avisos.append(self._aviso(i, aviso))

    def indice(self, ts: datetime) -> int:
        """Minuto de la serie que corresponde a ts (el ultimo que no lo pasa)."""
        return min(self.n - 1, max(0, bisect_right(self.ts, ts) - 1))

    def _aviso(self, i: int, aviso) -> dict:
        clave, pista = diagnosticar(aviso.senal, aviso.disparo, self.registros, self.ts_registros)
        falla = gramo.FALLAS[clave]
        verificacion = aviso.verificacion
        if verificacion and verificacion.get("es_real"):
            pico = datetime.fromisoformat(verificacion["pico"])
            verificacion = {**verificacion, "nombre": TIPOS.get(verificacion["tipo"], verificacion["tipo"]),
                            "i_pico": self.indice(pico),
                            "diagnostico_ok": falla["tipo"] == verificacion["tipo"]}
        return {
            "i": i, "i_inicio": self.indice(aviso.inicio),
            "inicio": aviso.inicio.isoformat(), "disparo": aviso.disparo.isoformat(),
            "senal": aviso.senal, "detalle": aviso.detalle, "clave": clave,
            "titulo": falla["titulo"], "sistema": falla["sistema"],
            "que_pasa": falla["que_pasa"], "accion": falla["accion"],
            "pista": _registro(pista, self.indice(pista["ts"])) if pista else None,
            "verificacion": verificacion,
        }

    # ---------------------------------------------------------
    def _intervalos_ventanas(self) -> list[dict]:
        """Tramos donde el detector trata la carga como esperada (no avisa)."""
        out, actual = [], None
        for i, (_, _, _, motivo) in enumerate(self.estados):
            if actual and motivo == actual["motivo"]:
                actual["i1"] = i
            elif motivo:
                actual = {"motivo": motivo, "i0": i, "i1": i}
                out.append(actual)
            else:
                actual = None
        return out

    def _intervalos_horario(self) -> list[dict]:
        h = horario_atencion(self.contexto)
        if not h:
            return []
        ini = datetime.strptime(h["ini"], "%H:%M").time()
        fin = datetime.strptime(h["fin"], "%H:%M").time()
        out, dia = [], self.ts[0].date()
        while dia <= self.ts[-1].date():
            a, b = datetime.combine(dia, ini), datetime.combine(dia, fin)
            if dia.weekday() in h["dias"] and b >= self.ts[0] and a <= self.ts[-1]:
                out.append({"i0": self.indice(max(a, self.ts[0])), "i1": self.indice(min(b, self.ts[-1]))})
            dia += timedelta(days=1)
        return out

    def resumen(self) -> dict:
        reales = [e for e in self.etiquetas if e["es_real"]]
        verdaderos = [a for a in self.avisos if a["verificacion"] and a["verificacion"]["es_real"]]
        falsas = [a for a in self.avisos if a["verificacion"] and not a["verificacion"]["es_real"]]
        avisados = {a["verificacion"]["pico"] for a in verdaderos}
        antic = [a["verificacion"]["anticipacion_min"] for a in verdaderos]
        return {
            "etiquetada": bool(self.etiquetas),
            "avisos": len(self.avisos),
            "reales": len(reales),
            "anticipadas": len(verdaderos),
            "falsas": len(falsas),
            "perdidas": [{"tipo": e["tipo"], "nombre": TIPOS.get(e["tipo"], e["tipo"]),
                          "ts": e["inicio"].isoformat()}
                         for e in reales if e["inicio"].isoformat() not in avisados],
            "diagnostico_ok": sum(1 for a in verdaderos if a["verificacion"]["diagnostico_ok"]),
            "anticipacion": ({"prom": round(sum(antic) / len(antic), 1), "min": min(antic), "max": max(antic)}
                             if antic else None),
        }

    def datos(self) -> dict:
        """Todo lo que el tablero necesita para dibujar la semana completa."""
        inicio = self.ts[0]
        contiguo = all(t == inicio + timedelta(minutes=i) for i, t in enumerate(self.ts))
        metricas = {k: [f[k] for f in self.filas] for k in ("cpu", "ram", "disco")}
        metricas["latencia"] = [_entero(f["latencia"]) for f in self.filas]
        metricas["errores"] = [_entero(f["errores"]) for f in self.filas]
        return {
            "corrida": self.corrida,
            "etiquetada": bool(self.etiquetas),
            "inicio": inicio.isoformat(), "fin": self.ts[-1].isoformat(), "n": self.n,
            # minutos desde el inicio de cada fila (solo si la serie tiene saltos)
            "minutos": None if contiguo else [int((t - inicio).total_seconds() // 60) for t in self.ts],
            "metricas": metricas,
            "riesgo": [e[0] for e in self.estados],
            "senal": [SENALES.index(e[1]) if e[0] >= UMBRAL_AMBAR and e[1] in SENALES else None
                      for e in self.estados],
            "senales": SENALES,
            "ventanas": self._intervalos_ventanas(),
            "horario": self._intervalos_horario(),
            "avisos": self.avisos,
            "etiquetas": [{"i": self.indice(e["inicio"]), "ts": e["inicio"].isoformat(), "tipo": e["tipo"],
                           "nombre": TIPOS.get(e["tipo"], e["tipo"]), "es_real": e["es_real"]}
                          for e in self.etiquetas],
            "registros": [_registro(r, self.indice(r["ts"])) for r in self.registros],
            "resumen": self.resumen(),
        }

    def estado_en(self, i: int) -> dict:
        """Lo que el monitor sabia en el minuto i (nunca mira hacia adelante)."""
        riesgo, senal, cuentas, ventana = self.estados[i]
        falla = None
        if riesgo >= UMBRAL_AMBAR and senal in gramo.FALLAS:
            clave, pista = diagnosticar(senal, self.ts[i], self.registros, self.ts_registros)
            falla = {"clave": clave, **gramo.FALLAS[clave],
                     "pista": _registro(pista, self.indice(pista["ts"])) if pista else None}
        return {
            "minuto": i, "ts": self.ts[i].isoformat(),
            "riesgo": riesgo, "salud": round(100 - riesgo),
            "estado": "rojo" if riesgo >= UMBRAL_ROJO else "ambar" if riesgo >= UMBRAL_AMBAR else "verde",
            "senal": senal if falla else None,
            "falla_probable": falla,
            "cuentas": cuentas,
            "ventana_esperada": ventana,
            "ultima": {k: self.filas[i][k] for k in METRICAS},
            "avisos_hasta_ahora": sum(1 for a in self.avisos if a["i"] <= i),
        }


# Semanas ya procesadas (cada una pesa unos MB; se guardan las ultimas).
_CACHE: "OrderedDict[str, tuple[Semana, bytes]]" = OrderedDict()
_CACHE_MAX = 4
_cache_lock = threading.Lock()


def corridas_disponibles() -> list[str]:
    return gramo.listar_corridas()


def validar_corrida(corrida: str) -> str:
    """Solo se aceptan corridas que existen (el nombre nunca arma una ruta libre)."""
    if corrida not in corridas_disponibles():
        raise HTTPException(status_code=404, detail=f"No existe la corrida '{corrida}' de gramo.")
    return corrida


def semana(corrida: str) -> tuple[Semana, bytes]:
    with _cache_lock:
        if corrida in _CACHE:
            _CACHE.move_to_end(corrida)
            return _CACHE[corrida]
    s = Semana(corrida)
    cuerpo = json.dumps(s.datos(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with _cache_lock:
        _CACHE[corrida] = (s, cuerpo)
        _CACHE.move_to_end(corrida)
        while len(_CACHE) > _CACHE_MAX:
            _CACHE.popitem(last=False)
    return s, cuerpo


# =============================================================
#  REPETICION EN VIVO
# =============================================================

class Repeticion:
    """
    Recorre una semana minuto a minuto a la velocidad elegida. El tablero
    pregunta en que minuto va; los avisos se mandan por Telegram cuando la
    repeticion llega al minuto en que el detector los confirmo (al saltar
    con el cursor no se reenvian).
    """

    def __init__(self):
        self.semana: Semana | None = None
        self.pos = 0.0
        self.corriendo = False
        self.velocidad = "media"
        self.telegram: dict[int, dict] = {}    # indice del aviso -> resultado del envio
        self._task: asyncio.Task | None = None

    async def asegurar(self):
        """Carga la semana por defecto (la principal del kit, o la muestra)."""
        if self.semana is None:
            corridas = corridas_disponibles()
            if not corridas:
                raise HTTPException(status_code=404, detail="No hay corridas de gramo disponibles.")
            await self.cargar(corridas[0])

    async def cargar(self, corrida: str):
        """Abre una semana con el cursor al final (vista de la semana completa)."""
        await self.pausar()
        self.semana, _ = await asyncio.to_thread(semana, corrida)
        self.pos = self.semana.n - 1
        self.telegram = {}

    async def iniciar(self, corrida: str | None, velocidad: str, desde: int = 0):
        if corrida and (self.semana is None or corrida != self.semana.corrida):
            await self.cargar(corrida)
        await self.asegurar()
        await self.pausar()
        self.velocidad = velocidad if velocidad in VELOCIDADES else "media"
        self.pos = float(min(max(0, desde), self.semana.n - 1))
        self.telegram = {}
        self.reanudar()

    def reanudar(self):
        if self.semana is None or self.corriendo:
            return
        if self.pos >= self.semana.n - 1:
            self.pos = 0.0
            self.telegram = {}
        self.corriendo = True
        self._task = asyncio.create_task(self._loop())

    async def pausar(self):
        self.corriendo = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    def saltar(self, minuto: int):
        if self.semana:
            self.pos = float(min(max(0, minuto), self.semana.n - 1))

    async def _loop(self):
        ultimo = time.monotonic()
        while self.corriendo:
            await asyncio.sleep(TICK_S)
            ahora = time.monotonic()
            antes = int(self.pos)
            self.pos = min(self.pos + VELOCIDADES[self.velocidad] * (ahora - ultimo), self.semana.n - 1)
            ultimo = ahora
            for k, aviso in enumerate(self.semana.avisos):
                if antes < aviso["i"] <= int(self.pos) and k not in self.telegram:
                    self.telegram[k] = {"enviando": True}
                    asyncio.create_task(self._avisar(k, aviso))
            if self.pos >= self.semana.n - 1:
                self.corriendo = False

    async def _avisar(self, k: int, aviso: dict):
        disparo = datetime.fromisoformat(aviso["disparo"])
        cuerpo = (f"gramo · {aviso['sistema']} · semana {self.semana.corrida}\n"
                  f"{aviso['que_pasa']}\n\n"
                  f"Detectado: {disparo:%d/%m %H:%M} ({aviso['detalle']})\n"
                  f"Qué hacer: {aviso['accion']}")
        try:
            self.telegram[k] = await notificaciones.enviar_telegram(aviso["titulo"], cuerpo,
                                                                    origen="datos reales")
        except Exception as e:  # pragma: no cover - el envio nunca debe tumbar la repeticion
            self.telegram[k] = {"enviado": False, "motivo": str(e)}

    def to_dict(self) -> dict:
        s = self.semana
        return {
            "cargada": True, "corrida": s.corrida, "etiquetada": bool(s.etiquetas),
            "corriendo": self.corriendo, "velocidad": self.velocidad,
            "velocidad_min_s": VELOCIDADES[self.velocidad], "total": s.n,
            **s.estado_en(int(self.pos)),
            "telegram": {str(k): v for k, v in self.telegram.items()},
            "aviso_configurado": notificaciones.esta_configurado(),
        }


repeticion = Repeticion()


# =============================================================
#  EVALUACION SOBRE TODAS LAS SEMANAS DEL KIT
# =============================================================

MINUTOS_SENUELO = 60   # tramo que se mira despues del inicio de un pico normal


def _evaluar(corrida: str) -> dict:
    s = Semana(corrida)
    r = s.resumen()
    senuelos = []
    for e in s.etiquetas:
        if e["es_real"]:
            continue
        # que tan fuerte fue el pico normal y hasta donde llego el indice de riesgo
        i0 = s.indice(e["inicio"])
        tramo = s.filas[i0:i0 + MINUTOS_SENUELO + 1]
        pico = {k: max((f[k] for f in tramo if f[k] is not None), default=None)
                for k in ("latencia", "errores", "cpu", "ram")}
        senuelos.append({"tipo": e["tipo"], "ts": e["inicio"].isoformat(), "pico": pico,
                         "riesgo_max": max(est[0] for est in s.estados[i0:i0 + MINUTOS_SENUELO + 1])})
    return {
        "corrida": corrida, **r,
        "avisos_detalle": [
            {"disparo": a["disparo"], "clave": a["clave"], "titulo": a["titulo"],
             "verificacion": a["verificacion"]} for a in s.avisos],
        "senuelos": senuelos,
        "falsas_ts": [a["disparo"] for a in s.avisos
                      if a["verificacion"] and not a["verificacion"]["es_real"]],
    }


def _ignorado(senuelo: dict, falsas_ts: list[str]) -> bool:
    """Un pico normal se ignoro si ninguna falsa alarma cae cerca de el."""
    ini = datetime.fromisoformat(senuelo["ts"])
    return not any(ini - timedelta(minutes=30) <= datetime.fromisoformat(f) <= ini + timedelta(hours=3)
                   for f in falsas_ts)


def resumir(series: list[dict]) -> dict:
    etiquetadas = [x for x in series if x["etiquetada"]]
    prueba = [x for x in series if not x["etiquetada"]]

    por_tipo = {}

    def tipo(nombre_tipo: str) -> dict:
        return por_tipo.setdefault(nombre_tipo, {"tipo": nombre_tipo, "nombre": TIPOS.get(nombre_tipo, nombre_tipo),
                                                 "anticipaciones": [], "perdidas": 0, "diagnostico_ok": 0})

    for x in etiquetadas:
        for a in x["avisos_detalle"]:
            v = a["verificacion"]
            if v and v["es_real"]:
                t = tipo(v["tipo"])
                t["anticipaciones"].append({"corrida": x["corrida"], "min": v["anticipacion_min"]})
                t["diagnostico_ok"] += int(v["diagnostico_ok"])
        for p in x["perdidas"]:
            tipo(p["tipo"])["perdidas"] += 1
    for t in por_tipo.values():
        mins = [a["min"] for a in t["anticipaciones"]]
        t.update(anticipadas=len(mins), reales=len(mins) + t["perdidas"],
                 prom=round(sum(mins) / len(mins), 1) if mins else None,
                 min=min(mins, default=None), max=max(mins, default=None))
        falla = next((f for f in gramo.FALLAS.values() if f["tipo"] == t["tipo"]), None)
        t["sistema"] = falla["sistema"] if falla else ""

    senuelos = {}
    for x in etiquetadas:
        for s in x["senuelos"]:
            d = senuelos.setdefault(s["tipo"], {"tipo": s["tipo"], "nombre": TIPOS.get(s["tipo"], s["tipo"]),
                                                "total": 0, "ignorados": 0, "pico": {}, "riesgo_max": 0})
            d["total"] += 1
            d["ignorados"] += int(_ignorado(s, x["falsas_ts"]))
            d["riesgo_max"] = max(d["riesgo_max"], s["riesgo_max"])
            for k, v in s["pico"].items():
                if v is not None and (d["pico"].get(k) is None or v > d["pico"][k]):
                    d["pico"][k] = v

    # En las semanas de prueba no hay solucion: se reporta que avisos dio el
    # detector y si su patron es consistente (mismo dia, misma falla, misma hora).
    patron = {}
    for x in prueba:
        for a in x["avisos_detalle"]:
            t = datetime.fromisoformat(a["disparo"])
            p = patron.setdefault((t.weekday(), a["clave"]), {"dia": t.weekday(), "clave": a["clave"],
                                                              "titulo": a["titulo"], "semanas": 0,
                                                              "horas": []})
            p["semanas"] += 1
            p["horas"].append(t.hour * 60 + t.minute)
    patrones = []
    for p in sorted(patron.values(), key=lambda p: (p["dia"], min(p["horas"]))):
        h = p.pop("horas")
        p["desde"] = f"{min(h) // 60:02d}:{min(h) % 60:02d}"
        p["hasta"] = f"{max(h) // 60:02d}:{max(h) % 60:02d}"
        patrones.append(p)

    antic = [a["min"] for t in por_tipo.values() for a in t["anticipaciones"]]
    return {
        "series": len(series), "etiquetadas": len(etiquetadas), "prueba": len(prueba),
        "reales": sum(x["reales"] for x in etiquetadas),
        "anticipadas": sum(x["anticipadas"] for x in etiquetadas),
        "falsas": sum(x["falsas"] for x in etiquetadas),
        "diagnostico_ok": sum(x["diagnostico_ok"] for x in etiquetadas),
        "anticipacion": ({"prom": round(sum(antic) / len(antic), 1), "min": min(antic), "max": max(antic)}
                         if antic else None),
        "por_tipo": sorted(por_tipo.values(), key=lambda t: t["prom"] if t["prom"] is not None else -1),
        "senuelos": sorted(senuelos.values(), key=lambda d: -d["total"]),
        "semanas": [{k: x[k] for k in ("corrida", "etiquetada", "avisos", "reales", "anticipadas", "falsas",
                                       "anticipacion", "perdidas")}
                    | {"detalle": [{"clave": a["clave"], "titulo": a["titulo"], "disparo": a["disparo"],
                                    "verificacion": a["verificacion"]} for a in x["avisos_detalle"]]}
                    for x in series],
        "prueba_avisos": dict(Counter(str(x["avisos"]) for x in prueba)),
        "prueba_patrones": patrones,
    }


class Evaluacion:
    """Corre el monitor sobre todas las semanas del kit en segundo plano."""

    def __init__(self):
        self.estado = "pendiente"
        self.hechas = 0
        self.total = 0
        self.resultado: dict | None = None
        self.error = ""
        self._hilo: threading.Thread | None = None
        self._lock = threading.Lock()

    def iniciar(self):
        with self._lock:
            if self._hilo is not None:
                return
            self.estado = "calculando"
            self._hilo = threading.Thread(target=self._calcular, name="evaluacion-gramo", daemon=True)
            self._hilo.start()

    def _calcular(self):
        try:
            corridas = corridas_disponibles()
            self.total = len(corridas)
            series = []
            for c in corridas:
                series.append(_evaluar(c))
                self.hechas += 1
            self.resultado = resumir(series)
            self.estado = "listo"
        except Exception as e:  # pragma: no cover
            self.estado, self.error = "error", str(e)

    def to_dict(self) -> dict:
        return {"estado": self.estado, "hechas": self.hechas, "total": self.total,
                "error": self.error, "fuente": fuente_datos(), **(self.resultado or {})}


evaluacion = Evaluacion()


def fuente_datos() -> str:
    return "completo" if gramo.PRINCIPAL in corridas_disponibles() else "muestra"


# =============================================================
#  ENDPOINTS
# =============================================================

class ConfigRepeticion(BaseModel):
    corrida: str | None = None
    velocidad: str = "media"
    desde: int = 0


class Corrida(BaseModel):
    corrida: str


class Velocidad(BaseModel):
    velocidad: str


class Salto(BaseModel):
    minuto: int


@router.get("/corridas")
async def listar_corridas():
    """Semanas de gramo disponibles: la principal del kit y sus corridas."""
    out = []
    for c in corridas_disponibles():
        _, solucion = gramo._dir_cliente(c)
        out.append({"id": c, "etiquetada": (solucion / "etiquetas.csv").exists(),
                    "nombre": "Semana principal" if c == gramo.PRINCIPAL else c.replace("corrida_", "Corrida ")})
    return {"corridas": out, "fuente": fuente_datos(), "velocidades": VELOCIDADES}


@router.get("/contexto")
async def contexto():
    """contexto.md de gramo estructurado, sus sistemas, runbooks y reglas del detector."""
    texto = gramo.contexto_por_defecto()
    if not texto:
        raise HTTPException(status_code=404, detail="No encontre el contexto de gramo.")
    dias = {v: k for k, v in ds.DIAS.items()}
    return {
        **leer_contexto(texto),
        "horario": horario_atencion(texto),
        "sistemas_monitoreados": gramo.SISTEMAS,
        "fallas": gramo.FALLAS,
        "ventanas_esperadas": [
            {"nombre": nombre_ventana(w["motivo"]), "motivo": w["motivo"],
             "dia": dias.get(w["dia"]) if w["dia"] is not None else None,
             "ini": w["ini"].strftime("%H:%M"), "fin": w["fin"].strftime("%H:%M")}
            for w in gramo.ventanas_esperadas(texto)],
        "detector": reglas_detector(),
    }


@router.get("/semana")
async def datos_semana(corrida: str = Query(default="")):
    """La semana completa minuto a minuto: metricas, riesgo, avisos, registros."""
    if not corrida:
        await repeticion.asegurar()
        corrida = repeticion.semana.corrida
    validar_corrida(corrida)
    _, cuerpo = await asyncio.to_thread(semana, corrida)
    return Response(content=cuerpo, media_type="application/json")


@router.get("/estado")
async def estado():
    """Minuto actual de la repeticion y lo que el monitor sabe en ese minuto."""
    await repeticion.asegurar()
    return repeticion.to_dict()


@router.post("/repeticion/cargar")
async def repeticion_cargar(cfg: Corrida):
    await repeticion.cargar(validar_corrida(cfg.corrida))
    return repeticion.to_dict()


@router.post("/repeticion/iniciar")
async def repeticion_iniciar(cfg: ConfigRepeticion):
    if cfg.corrida:
        validar_corrida(cfg.corrida)
    await repeticion.iniciar(cfg.corrida, cfg.velocidad, cfg.desde)
    return repeticion.to_dict()


@router.post("/repeticion/pausar")
async def repeticion_pausar():
    await repeticion.asegurar()
    await repeticion.pausar()
    return repeticion.to_dict()


@router.post("/repeticion/reanudar")
async def repeticion_reanudar():
    await repeticion.asegurar()
    repeticion.reanudar()
    return repeticion.to_dict()


@router.post("/repeticion/velocidad")
async def repeticion_velocidad(cfg: Velocidad):
    if cfg.velocidad not in VELOCIDADES:
        raise HTTPException(status_code=400, detail=f"Velocidad desconocida: {cfg.velocidad}")
    await repeticion.asegurar()
    repeticion.velocidad = cfg.velocidad
    return repeticion.to_dict()


@router.post("/repeticion/saltar")
async def repeticion_saltar(cfg: Salto):
    await repeticion.asegurar()
    repeticion.saltar(cfg.minuto)
    return repeticion.to_dict()


@router.get("/evaluacion")
async def resultados():
    """Resultado del detector sobre todas las semanas de gramo del kit."""
    evaluacion.iniciar()
    return evaluacion.to_dict()
