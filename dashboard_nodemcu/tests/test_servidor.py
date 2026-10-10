"""
Pruebas del servidor de gramo. Corren con la muestra incluida en el repo
(backend/datos_muestra/corrida_01); no necesitan el kit completo.

  cd dashboard_nodemcu && python -m pytest tests -q
"""

import asyncio
import os
import sys
from pathlib import Path

os.environ.setdefault("ZIKIT_DATASET", "/no/existe")  # forzar la muestra del repo
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "servidor"))

from fastapi.testclient import TestClient  # noqa: E402

import gramo  # noqa: E402
import motor  # noqa: E402
import server  # noqa: E402
from monitor import MonitorGramo  # noqa: E402

CORRIDA = "corrida_01"


def test_monitor_avisa_igual_que_el_detector_por_lotes():
    filas = gramo.cargar_metricas(CORRIDA)
    ctx = gramo.cargar_contexto(CORRIDA)
    m = MonitorGramo(ctx)
    for f in filas:
        m.procesar(f)
    esperado = [(d.inicio, d.senal) for d in motor.detectar(filas, ctx)]
    assert [(a.inicio, a.senal) for a in m.avisos] == esperado
    assert esperado, "la muestra tiene una falla real que detectar"


def test_repeticion_detecta_la_falla_real_antes_del_pico_sin_falsas_alarmas():
    r = server.Repeticion()
    r.cargar(CORRIDA, "rapida")
    asyncio.run(r.avanzar(len(r.filas)))
    avisos = r.monitor.avisos
    assert avisos and all(a.verificacion["es_real"] for a in avisos)
    assert all(a.verificacion["anticipacion_min"] > 0 for a in avisos)
    estado = r.to_dict()
    assert estado["progreso"] == 100.0
    assert estado["registros"], "se muestran los WARN/ERROR de logs.md"


def test_pico_en_ventana_esperada_no_avisa():
    ctx = gramo.cargar_contexto(CORRIDA)
    m = MonitorGramo(ctx)
    from datetime import datetime, timedelta
    t0 = datetime(2026, 10, 9, 10, 0)  # viernes, promo 2x1
    for i in range(40):
        m.procesar({"ts": t0 + timedelta(minutes=i), "cpu": 40, "ram": 60,
                    "disco": 47, "latencia": 230, "errores": 1})
    assert not m.avisos
    assert m.estado() == "verde" and m.to_dict()["ventana_esperada"]


def test_api_contexto_y_corridas():
    c = TestClient(server.app)
    ctx = c.get("/api/gramo/contexto").json()
    assert ctx["cliente"] == "gramo"
    assert {s["id"] for s in ctx["sistemas"]} >= {"app-01", "inventario", "fw-01"}
    assert CORRIDA in c.get("/api/gramo/corridas").json()["corridas"]
    assert c.get("/").status_code == 200


def test_nodemcu_fuga_de_memoria_pone_el_semaforo_en_rojo():
    c = TestClient(server.app)
    c.post("/api/nodemcu/reiniciar")
    base = {"placa": "test", "cpu": 20, "disco": 40, "latencia_ms": 50, "errores": 0}
    for _ in range(15):
        r = c.post("/api/nodemcu/telemetria", json={**base, "ram": 56}).json()
    assert r["estado"] == "verde" and not r["aviso"]

    avisos = 0
    for _ in range(15):
        r = c.post("/api/nodemcu/telemetria", json={**base, "ram": 90}).json()
        avisos += r["aviso"]
    assert r["estado"] == "rojo" and avisos == 1

    e = c.get("/api/estado?fuente=nodemcu").json()
    assert e["avisos"][0]["titulo"].startswith("Fuga de memoria")
    assert c.get("/api/nodemcu/semaforo").json()["estado"] == "rojo"


def test_telemetria_invalida_se_rechaza():
    c = TestClient(server.app)
    assert c.post("/api/nodemcu/telemetria", json={"ram": 150}).status_code == 422


def test_temperatura_en_vivo():
    c = TestClient(server.app)
    for temp, estado in [(24.0, "OK"), (28.3, "PRECAUCION_ACTIVA")]:
        c.post("/api/nodemcu/telemetria", json={"placa": "test", "ram": 56, "temperatura": temp,
                                               "estado_termico": estado, "rele": temp >= 27})
    t = c.get("/api/estado").json()["termico"]
    assert t["conectada"] and t["temperatura"] == 28.3
    assert t["estado"] == "PRECAUCION_ACTIVA" and t["rele"] is True
    assert c.get("/api/nodemcu/temperatura").json()["serie"][-2]["temperatura"] == 24.0
