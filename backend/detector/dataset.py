"""
======================================================
 SecureGuard - Lector del dataset Zikit
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Carga una corrida + cliente del kit de datos:
   - metricas.csv  -> serie por minuto (cpu, ram, disco, latencia, errores)
   - contexto.md   -> ventanas ESPERADAS (backups, promos, snapshots...)
   - _solucion/etiquetas.csv -> respuesta correcta (solo para evaluar)

 El dataset no vive en este repo (pesa ~186 MB). Se apunta con la
 variable de entorno ZIKIT_DATASET, o se usa la corrida de muestra
 incluida en backend/datos_muestra/.
======================================================
"""

import csv
import os
import re
from datetime import datetime, time
from pathlib import Path


def _ruta_por_defecto() -> str:
    """zikit-dataset dentro del proyecto (como viene en el .zip para compartir) o junto a el."""
    raiz = Path(__file__).resolve().parent.parent.parent
    for candidata in (raiz / "zikit-dataset", raiz.parent / "zikit-dataset"):
        if candidata.exists():
            return str(candidata)
    return str(raiz.parent / "zikit-dataset")


# Donde esta el dataset completo (clonado aparte). Si no existe, se usa la muestra.
RUTA_DATASET = os.getenv("ZIKIT_DATASET", _ruta_por_defecto())
RUTA_MUESTRA = Path(__file__).resolve().parent.parent / "datos_muestra"


def _dir_corrida(corrida: str) -> Path:
    """Devuelve la carpeta de una corrida, del dataset completo o de la muestra."""
    completo = Path(RUTA_DATASET) / "data" / "corridas" / corrida
    if completo.exists():
        return completo
    # fallback: muestra incluida en el repo
    muestra = RUTA_MUESTRA / corrida
    if muestra.exists():
        return muestra
    raise FileNotFoundError(
        f"No encontre la corrida '{corrida}'. Define ZIKIT_DATASET con la ruta "
        f"al kit de datos, o usa una corrida incluida en datos_muestra/."
    )


def _num(v):
    """Convierte a float; devuelve None si el valor falta (hueco en la telemetria)."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except ValueError:
        return None


def cargar_metricas(corrida: str, cliente: str) -> list[dict]:
    """
    Lee metricas.csv de un cliente en una corrida. Cada fila:
      {ts: datetime, cpu, ram, disco, latencia, errores}  (None donde falte)
    """
    f = _dir_corrida(corrida) / cliente / "metricas.csv"
    filas = []
    with open(f, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            filas.append({
                "ts": datetime.fromisoformat(row["timestamp"]),
                "cpu": _num(row.get("cpu")),
                "ram": _num(row.get("ram")),
                "disco": _num(row.get("disco")),
                "latencia": _num(row.get("latencia_ms")),
                "errores": _num(row.get("errores")),
            })
    return filas


def cargar_contexto(corrida: str, cliente: str) -> str:
    """Devuelve el texto crudo de contexto.md."""
    f = _dir_corrida(corrida) / cliente / "contexto.md"
    return f.read_text(encoding="utf-8")


def cargar_etiquetas(corrida: str, cliente: str) -> list[dict]:
    """
    Lee la solucion (_solucion/<cliente>/etiquetas.csv). SOLO para evaluar,
    nunca para detectar. Cada fila: {inicio: datetime, tipo, es_real: bool}
    """
    f = _dir_corrida(corrida) / "_solucion" / cliente / "etiquetas.csv"
    out = []
    with open(f, encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            out.append({
                "inicio": datetime.fromisoformat(row["inicio_incidente"]),
                "tipo": row["tipo"],
                "es_real": row["es_real"].strip().lower() == "true",
            })
    return out


# =============================================================
#  VENTANAS ESPERADAS (a partir del contexto de negocio)
# =============================================================
# Una ventana esperada describe un pico NORMAL anunciado: si una anomalia
# cae dentro, no se alerta. Se arman combinando:
#   1) patrones genericos (batches nocturnos de madrugada), y
#   2) eventos de negocio parseados del contexto.md.

DIAS = {"lunes": 0, "martes": 1, "miercoles": 2, "jueves": 3,
        "viernes": 4, "sabado": 5, "domingo": 6}


def _sin_acentos(s: str) -> str:
    for a, b in zip("áéíóú", "aeiou"):
        s = s.replace(a, b)
    return s


# Lineas que describen OPERACION, no picos esperados: se ignoran para ventanas.
#   "Horario:" = cuando opera el negocio.
#   "Ventana critica" = cuando un sistema IMPORTA (lo contrario de ignorar picos).
_IGNORAR = ("horario", "ventana critica", "| todo el horario", "24/7")

# Palabras que marcan un pico ESPERADO (evento de negocio o batch programado).
_EVENTO = ("promo", "snapshot", "respaldo", "backup", "carga masiva", "cierre",
           "campana", "reindex", "mantenimiento", "reporte", "dump", "pedido urgente",
           "copia", "temporada")


def ventanas_esperadas(contexto: str) -> list[dict]:
    """
    Extrae ventanas ESPERADAS del contexto (picos normales anunciados).
    Cada ventana: {motivo, dia (0-6 o None), ini (time), fin (time)}.
    Un pico dentro de una ventana se considera NORMAL (no se alerta).

    Solo cuentan los EVENTOS DE NEGOCIO y batches programados; el horario
    laboral y las "ventanas criticas" de los sistemas NO son ventanas
    esperadas (ahi justamente SI queremos detectar fallas).
    """
    txt = _sin_acentos(contexto.lower())
    v = []

    # 1) Batch nocturno generico: el kit siempre tiene tareas de madrugada
    #    (respaldos, reportes, dumps). Ventana amplia 00:30-05:00 cualquier dia.
    v.append({"motivo": "tareas nocturnas (respaldo/reporte)",
              "dia": None, "ini": time(0, 30), "fin": time(5, 0)})

    # 2) Eventos de negocio: solo lineas que hablan de un pico esperado.
    en_seccion_eventos = False
    for linea in txt.splitlines():
        if linea.strip().startswith("##"):
            en_seccion_eventos = "evento" in linea
        # saltar lineas de operacion (horario / ventana critica)
        if any(k in linea for k in _IGNORAR):
            continue
        rangos = re.findall(r"(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})", linea)
        if not rangos:
            continue
        # la linea debe ser un evento esperado (por seccion o por palabra clave)
        if not (en_seccion_eventos or any(k in linea for k in _EVENTO)):
            continue
        dia = next((idx for nombre, idx in DIAS.items() if nombre in linea), None)
        motivo = re.sub(r"[*>#-]", "", linea).strip()[:60]
        for h1, m1, h2, m2 in rangos:
            try:
                ini, fin = time(int(h1), int(m1)), time(int(h2), int(m2))
            except ValueError:
                continue
            v.append({"motivo": motivo or "evento de negocio",
                      "dia": dia, "ini": ini, "fin": fin})
    return v


def en_ventana_esperada(ts: datetime, ventanas: list[dict], margen_min: int = 20) -> dict | None:
    """
    Si ts cae dentro de alguna ventana esperada (con un margen de holgura),
    devuelve esa ventana; si no, None.
    """
    for w in ventanas:
        if w["dia"] is not None and ts.weekday() != w["dia"]:
            continue
        minutos = ts.hour * 60 + ts.minute
        ini = w["ini"].hour * 60 + w["ini"].minute - margen_min
        fin = w["fin"].hour * 60 + w["fin"].minute + margen_min
        if ini <= minutos <= fin:
            return w
    return None
