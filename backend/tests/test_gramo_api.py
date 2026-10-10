"""
Pruebas de la API de datos reales de gramo (/api/gramo) que usa el
tablero principal. Corren con la muestra del repo (ver conftest.py):
    python -m pytest tests
"""

import time

from fastapi.testclient import TestClient

import server

CORRIDA = "corrida_01"


def test_corridas_y_contexto_del_negocio():
    with TestClient(server.app) as c:
        r = c.get("/api/gramo/corridas").json()
        assert CORRIDA in [x["id"] for x in r["corridas"]]

        ctx = c.get("/api/gramo/contexto").json()
        assert ctx["cabecera"]["giro"].startswith("distribuidora de alimentos")
        assert len(ctx["sistemas"]) == 4
        assert ctx["horario"]["dias"] == [0, 1, 2, 3, 4, 5]
        nombres = {w["nombre"] for w in ctx["ventanas_esperadas"]}
        assert {"Promoción 2x1", "Snapshot de inventario"} <= nombres


def test_semana_trae_la_telemetria_y_avisos_verificados():
    with TestClient(server.app) as c:
        s = c.get(f"/api/gramo/semana?corrida={CORRIDA}").json()
        assert s["n"] == len(s["riesgo"]) == len(s["metricas"]["ram"])
        assert s["avisos"], "la muestra tiene fallas reales"
        for a in s["avisos"]:
            v = a["verificacion"]
            assert v["es_real"] and v["anticipacion_min"] > 0   # avisa ANTES del pico
            assert v["diagnostico_ok"]                          # y nombra el sistema correcto
        assert s["resumen"]["falsas"] == 0
        assert any(w["motivo"] == "Promoción 2x1" for w in s["ventanas"])


def test_corrida_inexistente_no_arma_rutas():
    with TestClient(server.app) as c:
        assert c.get("/api/gramo/semana?corrida=../../etc").status_code == 404
        assert c.post("/api/gramo/repeticion/cargar", json={"corrida": "no-existe"}).status_code == 404


def test_el_estado_de_un_minuto_no_mira_hacia_adelante():
    with TestClient(server.app) as c:
        c.post("/api/gramo/repeticion/cargar", json={"corrida": CORRIDA})
        aviso = c.get(f"/api/gramo/semana?corrida={CORRIDA}").json()["avisos"][0]

        antes = c.post("/api/gramo/repeticion/saltar", json={"minuto": aviso["i"] - 1}).json()
        assert antes["avisos_hasta_ahora"] == 0

        en = c.post("/api/gramo/repeticion/saltar", json={"minuto": aviso["i"]}).json()
        assert en["avisos_hasta_ahora"] == 1 and en["estado"] == "rojo"
        assert en["falla_probable"]["sistema"] == aviso["sistema"]


def test_repeticion_en_vivo_avanza_y_se_pausa():
    with TestClient(server.app) as c:
        c.post("/api/gramo/repeticion/iniciar", json={"corrida": CORRIDA, "velocidad": "rapida", "desde": 0})
        time.sleep(0.5)
        e = c.get("/api/gramo/estado").json()
        assert e["corriendo"] and e["minuto"] > 0
        assert not c.post("/api/gramo/repeticion/pausar").json()["corriendo"]


def test_evaluacion_sobre_las_semanas_disponibles():
    with TestClient(server.app) as c:
        for _ in range(200):
            ev = c.get("/api/gramo/evaluacion").json()
            if ev["estado"] == "listo":
                break
            time.sleep(0.05)
        assert ev["estado"] == "listo"
        assert ev["reales"] == ev["anticipadas"] > 0
        assert ev["falsas"] == 0
        assert ev["diagnostico_ok"] == ev["anticipadas"]
