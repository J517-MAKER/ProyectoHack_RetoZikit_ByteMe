#!/usr/bin/env bash
# ===================================================
#  SecureGuard - arranque de un clic (macOS / Linux)
#  Uso:  bash iniciar.sh
#  Busca un Python 3.10-3.12 (o lo consigue con uv), crea
#  .venv, instala requirements.txt la primera vez y arranca
#  scripts/iniciar.py.
# ===================================================
set -u
cd "$(dirname "$0")" || exit 1
export PYTHONIOENCODING=utf-8
VENV=".venv"
REQ="backend/requirements.txt"
MARCA="$VENV/secureguard-requisitos.txt"

venv_py() { if [ -x "$VENV/bin/python" ]; then echo "$VENV/bin/python"; else echo "$VENV/Scripts/python.exe"; fi; }
# 0 si ese Python es 3.10, 3.11 o 3.12 (las versiones de requirements.txt)
compatible() { "$@" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] <= (3, 12) else 1)' >/dev/null 2>&1; }
huella() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$REQ" | cut -d' ' -f1
  else shasum -a 256 "$REQ" | cut -d' ' -f1; fi
}
buscar_uv() {
  if command -v uv >/dev/null 2>&1; then command -v uv
  elif [ -x "$HOME/.local/bin/uv" ]; then echo "$HOME/.local/bin/uv"; fi
}

PY="$(venv_py)"
if [ -x "$PY" ] && compatible "$PY" && [ "$(cat "$MARCA" 2>/dev/null)" = "$(huella)" ] \
   && "$PY" -c 'import fastapi, aiohttp, uvicorn' >/dev/null 2>&1; then
  :   # entorno listo
else
  echo
  echo "  Preparando SecureGuard (solo la primera vez, de 1 a 3 minutos)..."
  # Un .venv copiado de otra computadora o hecho con otro Python no sirve: se rehace
  if [ -d "$VENV" ] && ! compatible "$(venv_py)"; then rm -rf "$VENV"; fi
  UV="$(buscar_uv)"
  if ! [ -x "$(venv_py)" ]; then
    BASE=""
    for c in python3.12 python3.11 python3.10 python3 python; do
      if command -v "$c" >/dev/null 2>&1 && compatible "$c"; then BASE="$c"; break; fi
    done
    if [ -n "$BASE" ] && "$BASE" -m venv "$VENV" >/dev/null 2>&1; then
      echo "  Usando $("$BASE" --version 2>&1)"
    else
      rm -rf "$VENV"
      if [ -z "$UV" ]; then
        echo "  No encontré Python 3.10, 3.11 ni 3.12."
        echo "  Puedo instalar 'uv' (herramienta gratuita de Astral) para traer Python 3.12"
        echo "  solo para este proyecto, sin tocar otros Python que tengas."
        read -r -p "  ¿Continuar? [S/n] " r
        case "$r" in
          [nN]*) echo "  Instala Python 3.12 (https://www.python.org/downloads/) y vuelve a correr: bash iniciar.sh"; exit 1 ;;
        esac
        curl -LsSf https://astral.sh/uv/install.sh | sh || exit 1
        UV="$(buscar_uv)"
        [ -n "$UV" ] || { echo "  No se pudo instalar uv."; exit 1; }
      fi
      echo "  Preparando Python 3.12 con uv..."
      "$UV" venv --python 3.12 "$VENV" || exit 1
    fi
  fi
  PY="$(venv_py)"
  echo "  Instalando dependencias (fastapi, uvicorn, aiohttp)..."
  if [ -n "$UV" ]; then
    "$UV" pip install --python "$PY" -r "$REQ"
  else
    "$PY" -m pip install --disable-pip-version-check -r "$REQ"
  fi || { echo "  No se pudieron instalar las dependencias (¿hay conexión a internet?)."; exit 1; }
  huella > "$MARCA"
fi

exec "$(venv_py)" scripts/iniciar.py "$@"
