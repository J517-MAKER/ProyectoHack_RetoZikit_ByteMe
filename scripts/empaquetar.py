"""
======================================================
 SecureGuard - Paquete para compartir
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Arma dist/<proyecto>.zip listo para mandarlo: quien lo recibe solo
 descomprime y da doble clic en INICIAR.bat (o bash iniciar.sh).
 Incluye el codigo y los datos reales de gramo del kit Zikit
 (licencia MIT del kit incluida).

 Deja fuera lo que no sirve en otra computadora o no se debe
 compartir: .venv, caches, registros y backend/.env (credenciales
 de Telegram).

 Uso:  python scripts/empaquetar.py
======================================================
"""

import os
import re
import zipfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
FUERA_CARPETAS = {".venv", "venv", "__pycache__", ".pytest_cache", ".git", "dist", "logs", "zikit-dataset",
                  "zikit-dataset.descargando", "node_modules", ".idea", ".vscode", ".claude"}
FUERA_ARCHIVOS = {".env", ".DS_Store", "Thumbs.db"}
FUERA_EXTENSIONES = {".pyc", ".log"}
SOLO_GRAMO = re.compile(r"^(LICENSE|README\.md|data/(gramo|_solucion/gramo|corridas/[^/]+/(gramo|_solucion/gramo))/[^/]+)$")
EJECUTABLES = {"iniciar.sh"}


def kit_encontrado() -> Path | None:
    for c in (os.getenv("ZIKIT_DATASET"), RAIZ / "zikit-dataset", RAIZ.parent / "zikit-dataset"):
        if c and (Path(c) / "data" / "gramo" / "metricas.csv").exists():
            return Path(c)
    return None


def agregar(z: zipfile.ZipFile, origen: Path, nombre: str):
    info = zipfile.ZipInfo.from_file(origen, nombre)
    info.compress_type = zipfile.ZIP_DEFLATED
    contenido = origen.read_bytes()
    # Fin de linea correcto para cada sistema, aunque se hayan editado en Windows
    if origen.suffix == ".sh":
        contenido = contenido.replace(b"\r\n", b"\n")
    elif origen.suffix == ".bat":
        contenido = contenido.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    if Path(nombre).name in EJECUTABLES:
        info.external_attr = 0o100755 << 16   # se puede ejecutar al descomprimir en Mac/Linux
    z.writestr(info, contenido, compresslevel=9)


def main():
    destino = RAIZ / "dist" / f"{RAIZ.name}.zip"
    destino.parent.mkdir(exist_ok=True)
    codigo = datos = 0
    with zipfile.ZipFile(destino, "w") as z:
        for carpeta, subcarpetas, archivos in os.walk(RAIZ):
            subcarpetas[:] = sorted(d for d in subcarpetas if d not in FUERA_CARPETAS)
            for nombre in sorted(archivos):
                ruta = Path(carpeta) / nombre
                if nombre in FUERA_ARCHIVOS or ruta.suffix in FUERA_EXTENSIONES:
                    continue
                agregar(z, ruta, f"{RAIZ.name}/{ruta.relative_to(RAIZ).as_posix()}")
                codigo += 1
        kit = kit_encontrado()
        if kit:
            for ruta in sorted(kit.rglob("*")):
                rel = ruta.relative_to(kit).as_posix()
                if ruta.is_file() and SOLO_GRAMO.match(rel):
                    agregar(z, ruta, f"{RAIZ.name}/zikit-dataset/{rel}")
                    datos += 1

    print(f"\n  Listo: {destino}")
    print(f"  {codigo} archivos del proyecto + {datos} del kit de gramo · {destino.stat().st_size / 1e6:.1f} MB")
    if not kit:
        print("  Ojo: no encontre el kit Zikit; quien lo reciba lo descargara la primera vez (necesita internet).")
    print("  Quien lo reciba: descomprime y doble clic en INICIAR.bat (Windows) o bash iniciar.sh (Mac/Linux).\n")


if __name__ == "__main__":
    main()
