"""
Prueba de humo del backend: la app arranca y los endpoints
principales responden. Se corre desde backend/:
    python -m pytest tests
"""

from fastapi.testclient import TestClient

import server


def test_endpoints_principales():
    with TestClient(server.app) as client:
        r = client.get("/api/escenarios")
        assert r.status_code == 200
        assert "memory" in r.json()

        r = client.get("/api/estado")
        assert r.status_code == 200

        r = client.get("/api/aviso/estado")
        assert r.status_code == 200
        assert "configurado" in r.json()


def test_simulacion_inicia_y_se_detiene():
    with TestClient(server.app) as client:
        r = client.post("/api/simular/iniciar", json={"escenario": "memory"})
        assert r.status_code == 200
        assert r.json()["status"] == "iniciado"

        r = client.post("/api/simular/detener")
        assert r.status_code == 200
        assert r.json()["status"] == "detenido"


def test_escenario_invalido():
    with TestClient(server.app) as client:
        r = client.post("/api/simular/iniciar", json={"escenario": "no-existe"})
        assert r.status_code == 400


def test_dashboard_servido():
    with TestClient(server.app) as client:
        r = client.get("/")
        assert r.status_code == 200
