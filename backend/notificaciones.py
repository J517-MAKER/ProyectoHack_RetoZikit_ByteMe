"""
======================================================
 SecureGuard - Envio de avisos reales (Telegram)
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Manda el aviso al celular del responsable via Telegram.
 Lee las credenciales de variables de entorno (archivo .env),
 nunca del codigo, para no exponerlas al subir el repo.

 Configura en backend/.env:
   TELEGRAM_BOT_TOKEN=123456789:AA...
   TELEGRAM_CHAT_ID=123456789
======================================================
"""

import os
import time
from collections import deque
from datetime import datetime

import aiohttp

# Historial en memoria de los avisos (el dashboard lo muestra).
# Si luego se usa base de datos, basta con persistir aqui mismo.
_HISTORIAL: deque = deque(maxlen=100)
_SEQ = 0


def _registrar(titulo: str, cuerpo: str, resultado: dict, origen: str) -> None:
    global _SEQ
    _SEQ += 1
    _HISTORIAL.appendleft({
        "id": _SEQ,
        "ts": time.time(),
        "hora": datetime.now().strftime("%H:%M:%S"),
        "titulo": titulo,
        "cuerpo": cuerpo,
        "origen": origen,
        "enviado": bool(resultado.get("enviado")),
        "motivo": resultado.get("motivo"),
    })


def historial(limite: int = 30) -> list:
    """Avisos mas recientes primero."""
    return list(_HISTORIAL)[:limite]


def limpiar_historial() -> None:
    _HISTORIAL.clear()

# Carga opcional de .env (si python-dotenv esta instalado).
# Si no lo esta, igual se leen las variables del entorno del sistema.
try:
    from dotenv import load_dotenv
    from pathlib import Path
    load_dotenv(Path(__file__).parent / ".env")
except Exception:
    pass


def esta_configurado() -> bool:
    """True si hay token y chat id para enviar."""
    return bool(os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("TELEGRAM_CHAT_ID"))


async def enviar_telegram(titulo: str, cuerpo: str, origen: str = "simulacion") -> dict:
    """Envia y deja constancia en el historial."""
    res = await _enviar(titulo, cuerpo)
    _registrar(titulo, cuerpo, res, origen)
    return res


async def _enviar(titulo: str, cuerpo: str) -> dict:
    """
    Envia un mensaje al chat configurado. Devuelve un dict con el
    resultado. Nunca lanza: si falla, lo reporta en el dict para que
    el monitoreo siga funcionando aunque el aviso no salga.
    """
    token = os.getenv("TELEGRAM_BOT_TOKEN")
    chat_id = os.getenv("TELEGRAM_CHAT_ID")

    if not token or not chat_id:
        return {"enviado": False, "motivo": "sin_configurar"}

    # Mensaje en formato legible para el responsable
    texto = f"⚠️ *{titulo}*\n{cuerpo}\n\n_SecureGuard · aviso preventivo_"

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": texto, "parse_mode": "Markdown"}

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url, json=payload,
                timeout=aiohttp.ClientTimeout(total=8),
            ) as resp:
                data = await resp.json()
                if data.get("ok"):
                    return {"enviado": True}
                return {"enviado": False, "motivo": data.get("description", "error_api")}
    except Exception as e:
        return {"enviado": False, "motivo": str(e)}
