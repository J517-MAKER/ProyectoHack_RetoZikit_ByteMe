"""
======================================================
 SecureGuard - Evaluador contra la solucion
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Corre el detector sobre las corridas y compara sus avisos
 contra _solucion/etiquetas.csv. Reporta los numeros de oro:
   - Fallas reales detectadas (de las es_real=true)
   - Falsas alarmas (avisos que no corresponden a una falla real)
   - Tiempo de reaccion (minutos desde el inicio de la falla al aviso)

 Uso:
   ZIKIT_DATASET=/ruta/al/zikit-dataset python evaluacion.py gramo
"""

import sys
from datetime import timedelta

import dataset as d
import motor as m


# Una deteccion "acierta" a una falla real si cae en esta ventana alrededor
# de su inicio. Las fallas del kit son RAMPAS graduales: la señal empieza a
# subir hasta ~2 h antes de la etiqueta (que marca el pico). Detectar temprano
# es el objetivo del reto, asi que aceptamos detecciones desde 120 min antes.
PRE = timedelta(minutes=120)
POST = timedelta(minutes=120)


def evaluar_corrida(corrida: str, cliente: str, cfg: m.Config = None):
    filas = d.cargar_metricas(corrida, cliente)
    ctx = d.cargar_contexto(corrida, cliente)
    etiquetas = d.cargar_etiquetas(corrida, cliente)
    reales = [e for e in etiquetas if e["es_real"]]

    dets = m.detectar(filas, ctx, cfg)

    # Emparejar cada deteccion con una falla real
    det_usadas = set()
    aciertos = []           # (falla, deteccion, minutos_reaccion)
    for falla in reales:
        mejor = None
        for i, det in enumerate(dets):
            if i in det_usadas:
                continue
            if falla["inicio"] - PRE <= det.inicio <= falla["inicio"] + POST:
                if mejor is None or det.inicio < dets[mejor].inicio:
                    mejor = i
        if mejor is not None:
            det_usadas.add(mejor)
            # anticipacion positiva = detectamos ANTES de la etiqueta (el pico)
            anticipacion = (falla["inicio"] - dets[mejor].inicio).total_seconds() / 60
            aciertos.append((falla, dets[mejor], anticipacion))

    falsas = [det for i, det in enumerate(dets) if i not in det_usadas]

    return {
        "reales": len(reales),
        "detectadas": len(aciertos),
        "falsas_alarmas": len(falsas),
        "aciertos": aciertos,
        "falsas": falsas,
        "perdidas": [f for f in reales if f["inicio"] not in {a[0]["inicio"] for a in aciertos}],
    }


def evaluar_cliente(cliente: str, cfg: m.Config = None, verbose=False):
    import os
    from pathlib import Path
    base = Path(d.RUTA_DATASET) / "data" / "corridas"
    if not base.exists():
        base = d.RUTA_MUESTRA
    corridas = sorted(p.name for p in base.iterdir() if p.is_dir() and p.name.startswith("corrida"))

    tot_reales = tot_det = tot_fa = 0
    reacciones = []
    perdidas_tipo = {}
    for c in corridas:
        try:
            r = evaluar_corrida(c, cliente, cfg)
        except FileNotFoundError:
            continue
        tot_reales += r["reales"]; tot_det += r["detectadas"]; tot_fa += r["falsas_alarmas"]
        reacciones += [antic for _, _, antic in r["aciertos"]]
        for f in r["perdidas"]:
            perdidas_tipo[f["tipo"]] = perdidas_tipo.get(f["tipo"], 0) + 1
        if verbose and (r["falsas_alarmas"] or r["perdidas"]):
            print(f"  {c}: det {r['detectadas']}/{r['reales']}, falsas {r['falsas_alarmas']}")
            for det in r["falsas"]:
                print(f"      FALSA: {det.inicio} {det.senal} ({det.detalle})")

    print(f"\n===== RESULTADO · cliente '{cliente}' · {len(corridas)} corridas =====")
    print(f"  Fallas reales:         {tot_reales}")
    print(f"  Detectadas:            {tot_det}  ({100*tot_det/tot_reales:.0f}% de recall)")
    print(f"  FALSAS ALARMAS:        {tot_fa}")
    if reacciones:
        prom = sum(reacciones)/len(reacciones)
        print(f"  Anticipacion promedio: {prom:+.0f} min antes de la etiqueta (el pico)")
    if perdidas_tipo:
        print(f"  Fallas perdidas por tipo: {perdidas_tipo}")
    return tot_reales, tot_det, tot_fa


if __name__ == "__main__":
    cliente = sys.argv[1] if len(sys.argv) > 1 else "gramo"
    verbose = "-v" in sys.argv
    evaluar_cliente(cliente, verbose=verbose)
