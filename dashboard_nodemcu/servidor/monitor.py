"""
======================================================
 SecureGuard · gramo - Monitor minuto a minuto
======================================================
 Reto Zikit "Antes de que suene el telefono" - ByteMe

 Version EN VIVO del detector de backend/detector/motor.py:
 recibe una fila de telemetria a la vez (de una corrida del kit
 o de la NodeMCU) y en cada minuto:

   1) aplica exactamente las mismas reglas calibradas (señales
      SOSTENIDAS en una ventana movil + filtro de contexto +
      anti-duplicado), asi que avisa en los mismos minutos que
      el detector por lotes (100 % recall, 0 falsas alarmas);
   2) calcula el indice de riesgo 0-100 con el mismo enfoque del
      RiskEngine: NIVEL (80 %) + TENDENCIA (EWMA, hasta +35).
      El NIVEL es que tan cerca esta cada señal de su disparo
      (minutos malos / minutos necesarios).
======================================================
"""

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import gramo
from motor import Config  # backend/detector/motor.py (ya en sys.path via gramo)

UMBRAL_AMBAR = 40
UMBRAL_ROJO = 65


@dataclass
class Aviso:
    inicio: datetime        # primer minuto de la racha (como el detector por lotes)
    disparo: datetime       # minuto en que se confirmo y se aviso
    senal: str
    detalle: str
    falla: dict
    verificacion: dict | None = None
    telegram: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "inicio": self.inicio.isoformat(),
            "disparo": self.disparo.isoformat(),
            "senal": self.senal,
            "detalle": self.detalle,
            "titulo": self.falla["titulo"],
            "sistema": self.falla["sistema"],
            "que_pasa": self.falla["que_pasa"],
            "accion": self.falla["accion"],
            "verificacion": self.verificacion,
            "telegram": self.telegram,
        }


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


class MonitorGramo:
    """Detector + indice de riesgo, alimentado fila por fila."""

    def __init__(self, contexto: str, etiquetas: list[dict] | None = None,
                 logs: list[dict] | None = None, cfg: Config | None = None,
                 respetar_contexto: bool = True):
        self.cfg = cfg or Config()
        self.ventanas = gramo.ventanas_esperadas(contexto) if respetar_contexto else []
        self.etiquetas_reales = [e for e in (etiquetas or []) if e["es_real"]]
        self._usadas: set[int] = set()
        self.logs = logs or []
        self._log_i = 0

        self.buf: deque = deque(maxlen=self.cfg.ventana)
        self.ultimo_aviso: datetime | None = None
        self.avisos: list[Aviso] = []
        self.minutos = 0
        self.ts: datetime | None = None
        self.ultima: dict | None = None
        self.riesgo = 0.0
        self.ewma = 0.0
        self.senal_dominante = None
        self.cuentas: dict = {}
        self.ventana_actual: dict | None = None
        self.serie: deque = deque(maxlen=240)      # metricas + riesgo para la grafica
        self.registros: deque = deque(maxlen=8)    # ultimos WARN/ERROR vistos

    # ---------------------------------------------------------
    def procesar(self, f: dict) -> Aviso | None:
        """Procesa un minuto. Devuelve el Aviso si en este minuto hay que avisar."""
        cfg = self.cfg
        self.minutos += 1
        self.ts = f["ts"]
        self.ultima = f
        self.buf.append(f)
        self._avanzar_logs(f["ts"])
        self.ventana_actual = gramo.en_ventana_esperada(f["ts"], self.ventanas)

        aviso = None
        if len(self.buf) == cfg.ventana:
            aviso = self._evaluar(f["ts"])
        self._actualizar_riesgo()

        self.serie.append({
            "ts": f["ts"].isoformat(), "ram": f["ram"], "latencia": f["latencia"],
            "errores": f["errores"], "cpu": f["cpu"], "riesgo": round(self.riesgo, 1),
        })
        return aviso

    def _contar(self):
        cfg, b = self.cfg, self.buf

        def n(campo, umbral):
            return sum(1 for x in b if x[campo] is not None and x[campo] >= umbral)

        self.cuentas = {
            "ram": n("ram", cfg.ram_alta),
            "lat_muy_alta": n("latencia", cfg.lat_muy_alta),
            "lat_alta": n("latencia", cfg.lat_alta),
            "err_leve": n("errores", cfg.err_leve),
            "err_fuerte": n("errores", cfg.err_fuerte),
        }
        return self.cuentas

    def _evaluar(self, ts: datetime) -> Aviso | None:
        cfg, c = self.cfg, self._contar()
        senal = detalle = None
        if c["ram"] >= cfg.n_ram:
            senal, detalle = "RAM", f"RAM alta sostenida ({c['ram']}/{cfg.ventana} min)"
        elif c["lat_muy_alta"] >= cfg.n_lat_muy_alta:
            senal, detalle = "latencia", f"latencia muy alta sostenida ({c['lat_muy_alta']}/{cfg.ventana} min)"
        elif c["lat_alta"] >= cfg.n_lat_alta and c["err_leve"] >= cfg.n_err_junto:
            senal, detalle = ("latencia+errores",
                              f"latencia alta y errores juntos ({c['lat_alta']}+{c['err_leve']}/{cfg.ventana} min)")
        elif c["err_fuerte"] >= cfg.n_err_fuerte:
            senal, detalle = "errores", f"errores sostenidos ({c['err_fuerte']}/{cfg.ventana} min)"

        if senal is None:
            return None
        if self.ultimo_aviso and ts - self.ultimo_aviso < timedelta(minutes=cfg.rearme_min):
            return None
        if self.ventana_actual:
            return None

        aviso = Aviso(inicio=self.buf[0]["ts"], disparo=ts, senal=senal,
                      detalle=detalle, falla=gramo.FALLAS[senal])
        aviso.verificacion = self._verificar(aviso)
        self.avisos.append(aviso)
        self.ultimo_aviso = ts
        return aviso

    def _verificar(self, aviso: Aviso) -> dict | None:
        """
        Compara el aviso con la solucion del kit (si la hay), con la misma
        regla que backend/detector/evaluacion.py (±120 min alrededor del pico).
        El detector NUNCA usa esto para decidir; solo sirve para la demo.
        """
        if not self.etiquetas_reales:
            return None
        margen = timedelta(minutes=120)
        for i, e in enumerate(self.etiquetas_reales):
            if i in self._usadas:
                continue
            if e["inicio"] - margen <= aviso.inicio <= e["inicio"] + margen:
                self._usadas.add(i)
                antic = (e["inicio"] - aviso.disparo).total_seconds() / 60
                return {"es_real": True, "tipo": e["tipo"], "pico": e["inicio"].isoformat(),
                        "anticipacion_min": round(antic)}
        return {"es_real": False}

    def _actualizar_riesgo(self):
        """NIVEL (80 %) + TENDENCIA (hasta +35), como el RiskEngine del backend."""
        cfg = self.cfg
        c = self.cuentas or self._contar()
        ratios = {
            "RAM": c["ram"] / cfg.n_ram,
            "latencia": c["lat_muy_alta"] / cfg.n_lat_muy_alta,
            "latencia+errores": min(c["lat_alta"] / cfg.n_lat_alta, c["err_leve"] / cfg.n_err_junto),
            "errores": c["err_fuerte"] / cfg.n_err_fuerte,
        }
        self.senal_dominante = max(ratios, key=ratios.get)
        nivel = _clamp(ratios[self.senal_dominante], 0, 1) * 100
        self.ewma += 0.3 * (nivel - self.ewma)
        tendencia = _clamp((nivel - self.ewma) * 1.6, 0, 35)
        riesgo = _clamp(nivel * 0.8 + tendencia, 0, 100)
        if self.ventana_actual:
            # pico anunciado en el contexto: se ve, pero no es motivo de alarma
            riesgo = min(riesgo, UMBRAL_AMBAR - 1)
        self.riesgo = riesgo

    def _avanzar_logs(self, ts: datetime):
        while self._log_i < len(self.logs) and self.logs[self._log_i]["ts"] <= ts:
            l = self.logs[self._log_i]
            self.registros.appendleft({"ts": l["ts"].isoformat(), "fuente": l["fuente"],
                                       "nivel": l["nivel"], "mensaje": l["mensaje"]})
            self._log_i += 1

    # ---------------------------------------------------------
    def estado(self) -> str:
        if self.riesgo >= UMBRAL_ROJO:
            return "rojo"
        if self.riesgo >= UMBRAL_AMBAR:
            return "ambar"
        return "verde"

    def to_dict(self) -> dict:
        falla = gramo.FALLAS.get(self.senal_dominante) if self.riesgo >= UMBRAL_AMBAR else None
        return {
            "ts": self.ts.isoformat() if self.ts else None,
            "minutos": self.minutos,
            "ultima": ({k: v for k, v in self.ultima.items() if k != "ts"} if self.ultima else None),
            "riesgo": round(self.riesgo, 1),
            "salud": round(100 - self.riesgo),
            "estado": self.estado(),
            "senal": self.senal_dominante if falla else None,
            "falla_probable": falla,
            "cuentas": self.cuentas,
            "ventana_esperada": (self.ventana_actual["motivo"] if self.ventana_actual else None),
            "avisos": [a.to_dict() for a in self.avisos],
            "registros": list(self.registros),
            "serie": list(self.serie),
        }


# =============================================================
#  NODEMCU EN VIVO
# =============================================================

class EnVivo:
    """
    Telemetria real de la NodeMCU. Cada envio cuenta como un "minuto"
    del detector, para que la demo dure segundos y no horas. Ademas
    guarda el historial del sensor termico (LM35) de la placa.
    """

    SEGUNDOS_CONECTADA = 15   # sin envios en este tiempo, la placa se da por desconectada

    def __init__(self):
        # historial del sensor termico; no se borra al reiniciar el monitor
        self.termico: deque = deque(maxlen=150)
        self.reiniciar()

    def reiniciar(self, respetar_contexto: bool = False):
        # Por defecto sin filtro de contexto: la demo puede caer de madrugada.
        self.monitor = MonitorGramo(gramo.contexto_por_defecto(),
                                    respetar_contexto=respetar_contexto)
        self.ultimo_envio: datetime | None = None
        self.placa: dict = {}

    def recibir(self, t) -> "Aviso | None":
        """Procesa un envio de la placa (objeto con los campos de la telemetria)."""
        self.ultimo_envio = datetime.now()
        self.placa = {"id": t.placa, "ip": t.ip, "heap_libre": t.heap_libre}
        fila = {"ts": self.ultimo_envio.replace(microsecond=0), "cpu": t.cpu, "ram": t.ram,
                "disco": t.disco, "latencia": t.latencia_ms, "errores": t.errores}
        if t.temperatura is not None:
            self.termico.append({"ts": fila["ts"].isoformat(), "temperatura": round(t.temperatura, 1),
                                 "estado": t.estado_termico or "OK", "rele": bool(t.rele)})
        return self.monitor.procesar(fila)

    def conectada(self) -> bool:
        return bool(self.ultimo_envio and
                    (datetime.now() - self.ultimo_envio).total_seconds() < self.SEGUNDOS_CONECTADA)

    def to_dict(self) -> dict:
        return {"fuente": "nodemcu", "conectada": self.conectada(), "placa": self.placa,
                **self.monitor.to_dict()}

    def termico_dict(self) -> dict:
        """Temperatura en vivo de la placa: ultima lectura e historial."""
        ultima = self.termico[-1] if self.termico else {}
        return {"conectada": self.conectada(), "temperatura": ultima.get("temperatura"),
                "estado": ultima.get("estado"), "rele": ultima.get("rele"), "ts": ultima.get("ts"),
                "serie": list(self.termico)}
