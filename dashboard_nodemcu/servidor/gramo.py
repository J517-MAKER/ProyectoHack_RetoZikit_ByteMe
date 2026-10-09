"""
======================================================
 SecureGuard · gramo - Contexto y datos del cliente
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Todo lo que el servidor sabe de gramo (distribuidora de
 alimentos a restaurantes y comercios), en lenguaje de negocio:
   - sus sistemas criticos (app-01, inventario, fw-01, portal),
   - las fallas reales que aparecen en el kit y su runbook,
   - la carga de una corrida del kit: metricas.csv, contexto.md,
     logs.md y, si existe, la solucion (solo para verificar).

 Reutiliza el lector y las ventanas esperadas del detector de
 backend/detector/ para no duplicar la logica ya calibrada.
======================================================
"""

import csv
import os
import re
import sys
from datetime import datetime
from pathlib import Path

RAIZ_REPO = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(RAIZ_REPO / "backend" / "detector"))

import dataset as ds  # noqa: E402  (backend/detector/dataset.py)

CLIENTE = "gramo"

# Corrida "principal" = data/gramo del kit (la serie publica, sin carpeta de corrida).
PRINCIPAL = "principal"


# =============================================================
#  SISTEMAS Y FALLAS DE GRAMO
# =============================================================

SISTEMAS = [
    {"id": "app-01", "nombre": "API de pedidos (app-01)",
     "que_es": "Recibe los pedidos de restaurantes y comercios; corre el proceso pedidos-worker.",
     "critico": "07:00–16:00"},
    {"id": "inventario", "nombre": "Servidor de inventario",
     "que_es": "Existencias y lotes con caducidad. Si se traba, no se pueden confirmar pedidos.",
     "critico": "Todo el horario"},
    {"id": "fw-01", "nombre": "Firewall perimetral (fw-01)",
     "que_es": "Publica la API y deja entrar a los clientes por HTTPS.",
     "critico": "24/7"},
    {"id": "portal", "nombre": "Portal de clientes",
     "que_es": "Pedidos en linea; depende de la API de app-01.",
     "critico": "24/7"},
]

# Señal del detector -> falla de gramo que delata, con su explicacion y runbook.
FALLAS = {
    "RAM": {
        "tipo": "fuga_memoria_worker",
        "titulo": "Fuga de memoria en pedidos-worker",
        "sistema": "app-01",
        "que_pasa": "La memoria de app-01 sube sin bajar desde hace rato. Si se agota, "
                    "pedidos-worker se cae y los pedidos en curso se pierden.",
        "accion": "Reiniciar pedidos-worker de forma controlada (drenar la cola primero) "
                  "y revisar el ultimo despliegue del worker.",
    },
    "latencia": {
        "tipo": "agotamiento_pool_inventario",
        "titulo": "Inventario saturado (pool de conexiones agotado)",
        "sistema": "inventario",
        "que_pasa": "La API tarda cada vez mas porque espera al inventario. Pronto los pedidos "
                    "empezaran a fallar por tiempo de espera.",
        "accion": "Liberar conexiones atascadas al inventario y ampliar el pool; "
                  "pausar reportes pesados mientras dura el horario de pedidos.",
    },
    "latencia+errores": {
        "tipo": "trafico_hostil_lento",
        "titulo": "Trafico hostil hacia el portal",
        "sistema": "fw-01",
        "que_pasa": "Llega trafico anormal por HTTPS: la API se vuelve lenta y empiezan los errores. "
                    "Los restaurantes no podran hacer pedidos en linea.",
        "accion": "Activar limite de conexiones por IP en fw-01 y bloquear el origen sospechoso.",
    },
    "errores": {
        "tipo": "errores_en_cascada",
        "titulo": "Errores en cascada en la API",
        "sistema": "app-01",
        "que_pasa": "Fallan operaciones de forma sostenida; un fallo arrastra a otros.",
        "accion": "Reiniciar el servicio afectado y aislar la dependencia que falla.",
    },
}


# =============================================================
#  CORRIDAS DEL KIT
# =============================================================

def _ruta_kit() -> Path:
    return Path(os.getenv("ZIKIT_DATASET", ds.RUTA_DATASET))


def _dir_cliente(corrida: str) -> tuple[Path, Path]:
    """(carpeta del cliente, carpeta de la solucion) de una corrida."""
    if corrida == PRINCIPAL:
        base = _ruta_kit() / "data"
        if not (base / CLIENTE).exists():
            raise FileNotFoundError("No encontre data/gramo del kit. Define ZIKIT_DATASET.")
        return base / CLIENTE, base / "_solucion" / CLIENTE
    base = ds._dir_corrida(corrida)
    return base / CLIENTE, base / "_solucion" / CLIENTE


def listar_corridas() -> list[str]:
    """Corridas disponibles con datos de gramo (kit completo o muestra del repo)."""
    out = []
    kit = _ruta_kit() / "data"
    if (kit / CLIENTE / "metricas.csv").exists():
        out.append(PRINCIPAL)
    for base in (kit / "corridas", ds.RUTA_MUESTRA):
        if base.exists():
            for p in sorted(base.iterdir()):
                if (p / CLIENTE / "metricas.csv").exists() and p.name not in out:
                    out.append(p.name)
    return out


def cargar_metricas(corrida: str) -> list[dict]:
    d, _ = _dir_cliente(corrida)
    filas = []
    with open(d / "metricas.csv", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            filas.append({
                "ts": datetime.fromisoformat(row["timestamp"]),
                "cpu": ds._num(row.get("cpu")),
                "ram": ds._num(row.get("ram")),
                "disco": ds._num(row.get("disco")),
                "latencia": ds._num(row.get("latencia_ms")),
                "errores": ds._num(row.get("errores")),
            })
    return filas


def cargar_contexto(corrida: str) -> str:
    d, _ = _dir_cliente(corrida)
    return (d / "contexto.md").read_text(encoding="utf-8")


_LOG = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\s+(\w+)\s+(.*)$")


def contexto_por_defecto() -> str:
    """contexto.md de la primera corrida disponible (es el mismo en todas)."""
    for c in listar_corridas():
        try:
            return cargar_contexto(c)
        except FileNotFoundError:
            continue
    return ""


def cargar_logs(corrida: str, niveles=("WARN", "ERROR")) -> list[dict]:
    """
    Lineas relevantes de logs.md (por defecto solo WARN/ERROR), ordenadas.
    Cada una: {ts, fuente (servidor|firewall|app), nivel, mensaje}.
    """
    d, _ = _dir_cliente(corrida)
    f = d / "logs.md"
    if not f.exists():
        return []
    out, fuente = [], ""
    for linea in f.read_text(encoding="utf-8").splitlines():
        if linea.startswith("## "):
            fuente = linea[3:].strip()
            continue
        m = _LOG.match(linea)
        if m and m.group(2) in niveles:
            out.append({"ts": datetime.fromisoformat(m.group(1)), "fuente": fuente,
                        "nivel": m.group(2), "mensaje": m.group(3)})
    out.sort(key=lambda x: x["ts"])
    return out


def cargar_etiquetas(corrida: str) -> list[dict]:
    """Solucion del kit (SOLO para verificar los avisos, nunca para detectar)."""
    _, sol = _dir_cliente(corrida)
    f = sol / "etiquetas.csv"
    if not f.exists():
        return []
    with open(f, encoding="utf-8") as fh:
        return [{"inicio": datetime.fromisoformat(r["inicio_incidente"]),
                 "tipo": r["tipo"],
                 "es_real": r["es_real"].strip().lower() == "true"}
                for r in csv.DictReader(fh)]


def ventanas_esperadas(contexto: str) -> list[dict]:
    return ds.ventanas_esperadas(contexto)


def en_ventana_esperada(ts, ventanas):
    return ds.en_ventana_esperada(ts, ventanas)


def contexto_publico(contexto: str) -> dict:
    """Resumen legible del contexto de gramo para el tablero."""
    ventanas = ventanas_esperadas(contexto)
    dias = {v: k for k, v in ds.DIAS.items()}
    return {
        "cliente": CLIENTE,
        "giro": "Distribuidora de alimentos a restaurantes y comercios",
        "horario": "Lunes a sabado 07:00–16:00; pedidos en linea 24/7",
        "picos_normales": ["07:30 y 13:00 (reposicion de restaurantes)"],
        "sistemas": SISTEMAS,
        "ventanas_esperadas": [
            {"motivo": w["motivo"],
             "dia": dias.get(w["dia"], "todos los dias") if w["dia"] is not None else "todos los dias",
             "ini": w["ini"].strftime("%H:%M"), "fin": w["fin"].strftime("%H:%M")}
            for w in ventanas
        ],
        "fallas": {k: {kk: vv for kk, vv in v.items()} for k, v in FALLAS.items()},
    }
