"""
======================================================
 SecureGuard - Arranque de un clic
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Lo ejecutan INICIAR.bat (Windows) e iniciar.sh (Mac/Linux) con el
 entorno de Python ya listo. Hace todo lo demas:

   1) busca los datos de gramo del kit Zikit y, si faltan, baja
      solo esa parte desde GitHub (sin internet usa la muestra),
   2) levanta el tablero principal (9090) y el tablero NodeMCU (9091),
   3) abre el navegador y se queda vigilando hasta Ctrl+C.

 Uso directo:  python scripts/iniciar.py [--sin-navegador]
======================================================
"""

import io
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
import zipfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DATOS = RAIZ / "zikit-dataset"
LOGS = RAIZ / "logs"
KIT_ZIP = "https://github.com/brunovillarrrrrr/zikit-dataset/archive/refs/heads/main.zip"
# Del kit solo hace falta gramo (la distribuidora de alimentos) y su licencia
SOLO_GRAMO = re.compile(
    r"^[^/]+/(LICENSE|README\.md|data/(gramo|_solucion/gramo|corridas/[^/]+/(gramo|_solucion/gramo))/[^/]+)$")

SERVIDORES = [
    # (nombre, carpeta, puerto, ruta que prueba que es nuestro servidor)
    ("Tablero principal", RAIZ / "backend", 9090, "/api/gramo/corridas"),
    ("Tablero NodeMCU", RAIZ / "dashboard_nodemcu" / "servidor", 9091, "/api/gramo/corridas"),
]


def titulo(texto: str):
    print(f"\n  {texto}")


# =============================================================
#  DATOS DE GRAMO
# =============================================================

def kit_encontrado() -> Path | None:
    """El kit en ZIKIT_DATASET, dentro del proyecto o junto a el."""
    candidatas = [os.getenv("ZIKIT_DATASET"), DATOS, RAIZ.parent / "zikit-dataset"]
    for c in candidatas:
        if c and (Path(c) / "data" / "gramo" / "metricas.csv").exists():
            return Path(c)
    return None


def bajar_datos_de_gramo() -> Path | None:
    titulo("Descargando los datos reales de gramo del kit Zikit (solo la primera vez)...")
    try:
        with urllib.request.urlopen(KIT_ZIP, timeout=30) as r:
            buf, bajado = io.BytesIO(), 0
            while True:
                trozo = r.read(1 << 20)
                if not trozo:
                    break
                buf.write(trozo)
                bajado += len(trozo)
                print(f"\r    {bajado / 1e6:5.1f} MB", end="", flush=True)
        print()
        temporal = RAIZ / "zikit-dataset.descargando"
        shutil.rmtree(temporal, ignore_errors=True)
        with zipfile.ZipFile(buf) as z:
            for nombre in z.namelist():
                if SOLO_GRAMO.match(nombre):
                    destino = temporal / nombre.split("/", 1)[1]
                    destino.parent.mkdir(parents=True, exist_ok=True)
                    destino.write_bytes(z.read(nombre))
        if not (temporal / "data" / "gramo" / "metricas.csv").exists():
            raise RuntimeError("el archivo descargado no trae los datos de gramo")
        shutil.rmtree(DATOS, ignore_errors=True)
        temporal.rename(DATOS)
        print("    Listo: 55 semanas de gramo en zikit-dataset/")
        return DATOS
    except Exception as e:  # sin internet o GitHub no responde: se sigue con la muestra
        print(f"\n    No se pudo descargar ({e}).")
        print("    Sigo con la semana de muestra incluida en el proyecto.")
        return None


# =============================================================
#  SERVIDORES
# =============================================================

def puerto_ocupado(puerto: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", puerto)) == 0


def responde(puerto: int, ruta: str) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{puerto}{ruta}", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def cola_del_log(archivo: Path, lineas: int = 15) -> str:
    try:
        return "\n".join(archivo.read_text(encoding="utf-8", errors="replace").splitlines()[-lineas:])
    except OSError:
        return ""


def ip_local() -> str | None:
    """IP de esta computadora en la red (la que va en el firmware de la NodeMCU)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))   # no envia nada; solo elige la interfaz
            return s.getsockname()[0]
    except OSError:
        return None


def main():
    sys.stdout.reconfigure(line_buffering=True)   # que cada mensaje se vea al momento
    abrir_navegador = "--sin-navegador" not in sys.argv
    print("\n  ==============================================")
    print("   SecureGuard · gramo — Monitoreo predictivo")
    print("   Reto Zikit «Antes de que suene el teléfono»")
    print("  ==============================================")

    kit = kit_encontrado() or bajar_datos_de_gramo()
    entorno = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
    if kit:
        entorno["ZIKIT_DATASET"] = str(kit)
    else:
        entorno.pop("ZIKIT_DATASET", None)

    LOGS.mkdir(exist_ok=True)
    procesos = []
    titulo("Iniciando servidores...")
    for nombre, carpeta, puerto, ruta in SERVIDORES:
        if puerto_ocupado(puerto):
            if responde(puerto, ruta):
                print(f"    {nombre}: ya estaba corriendo en el puerto {puerto}.")
                continue
            sys.exit(f"\n  El puerto {puerto} lo está usando otro programa. Ciérralo y vuelve a intentar.")
        log = LOGS / f"servidor-{puerto}.log"
        salida = open(log, "w", encoding="utf-8")
        p = subprocess.Popen([sys.executable, "server.py"], cwd=carpeta, env=entorno,
                             stdout=salida, stderr=subprocess.STDOUT)
        procesos.append((nombre, puerto, p, log))

    # esperar a que respondan (la primera vez tardan unos segundos)
    limite = time.time() + 90
    for nombre, puerto, p, log in procesos:
        while not responde(puerto, "/api/gramo/corridas"):
            if p.poll() is not None:
                print(f"\n  {nombre} se detuvo al arrancar. Últimas líneas de {log.relative_to(RAIZ)}:\n")
                print(cola_del_log(log))
                sys.exit(1)
            if time.time() > limite:
                sys.exit(f"\n  {nombre} no respondió a tiempo. Revisa {log.relative_to(RAIZ)}.")
            time.sleep(0.5)
        print(f"    {nombre}: listo en http://localhost:{puerto}")

    ip = ip_local()
    print("\n  ----------------------------------------------")
    print("   Abre el tablero:   http://localhost:9090")
    print("   Semáforo NodeMCU:  http://localhost:9091")
    if ip:
        print(f"   IP para la NodeMCU / ESP32: {ip}")
    print(f"   Datos: {'kit Zikit completo de gramo' if kit else 'semana de muestra del proyecto'}")
    print("  ----------------------------------------------")
    print("   Para cerrar SecureGuard: Ctrl+C o cierra esta ventana.\n")
    if abrir_navegador:
        webbrowser.open("http://localhost:9090")

    try:
        while True:
            time.sleep(1)
            for nombre, puerto, p, log in procesos:
                if p.poll() is not None:
                    print(f"\n  {nombre} se detuvo. Últimas líneas de {log.relative_to(RAIZ)}:\n")
                    print(cola_del_log(log))
                    raise KeyboardInterrupt
    except KeyboardInterrupt:
        print("\n  Cerrando SecureGuard...")
    finally:
        for _, _, p, _ in procesos:
            if p.poll() is None:
                p.terminate()
        for _, _, p, _ in procesos:
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()


if __name__ == "__main__":
    main()
