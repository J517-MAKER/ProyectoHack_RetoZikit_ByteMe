# 🛡️ SecureGuard · gramo — Servidor y tablero NodeMCU

**Reto Zikit · "Antes de que suene el teléfono" · Equipo ByteMe**

Servidor dedicado al cliente **gramo** del [kit de datos Zikit](https://github.com/brunovillarrrrrr/zikit-dataset):
una distribuidora de alimentos a restaurantes y comercios (25 empleados, lunes a sábado 07:00–16:00,
pedidos en línea 24/7). Mismo enfoque que el resto de SecureGuard: **índice de riesgo 0–100**, tablero en
lenguaje de negocio, **avisos por Telegram** y una placa física, aquí una **NodeMCU (ESP8266)** que hace de
semáforo del responsable.

## Qué vigila de gramo

| Sistema | Qué es | Falla que se anticipa | Firma en los datos |
|---|---|---|---|
| **app-01** | API de pedidos + `pedidos-worker` | Fuga de memoria en el worker | RAM ≥ 82 % sostenida 12 de 15 min |
| **Servidor de inventario** | Existencias y lotes | Pool de conexiones agotado | latencia ≥ 180 ms sostenida |
| **fw-01** | Firewall que publica la API | Tráfico hostil lento | latencia ≥ 125 ms **y** errores ≥ 2, juntos |

**Picos que no son falla** (se ven, pero no se avisa), leídos del `contexto.md` de gramo: la promo 2x1
del viernes 10:00–12:00, el snapshot de inventario del sábado 03:00–04:30 y los reportes nocturnos.

## Resultado sobre el kit completo

El monitor de este servidor procesa la telemetría **minuto a minuto** (como llegaría en producción) y avisa
exactamente en los mismos minutos que el detector por lotes de `backend/detector/`. Sobre las 55 series de
gramo (la principal y 54 corridas):

- **33 de 33 fallas reales avisadas, 0 falsas alarmas**
- **El aviso llega ~48 min antes del pico de la falla** en promedio (mínimo 31 min)

## Piezas

```
dashboard_nodemcu/
├── servidor/
│   ├── server.py     FastAPI (puerto 9091): repetición del kit, NodeMCU en vivo, avisos
│   ├── monitor.py    detector en vivo + índice de riesgo (nivel 80 % + tendencia EWMA)
│   └── gramo.py      contexto de gramo, runbooks y lectura de corridas/logs
├── web/              tablero (lo sirve el servidor en http://localhost:9091)
├── nodemcu/gramo_semaforo/gramo_semaforo.ino   firmware ESP8266
└── tests/            pruebas (usan la muestra incluida en el repo)
```

El servidor reutiliza el detector calibrado (`backend/detector/`) y el envío por Telegram
(`backend/notificaciones.py`, que lee `backend/.env`), así que no hay que configurar nada dos veces. El tablero
también comparte el diseño del tablero principal: el servidor publica `dashboard/` en `/dashboard` y la página
usa su `style.css` y `charts.js`.

## Cómo ejecutarlo

```bash
cd dashboard_nodemcu
pip install -r requirements.txt
cd servidor
python server.py              # abre http://localhost:9091
```

Sin más configuración usa la corrida de muestra del repo (`backend/datos_muestra/corrida_01`).
Para elegir entre todas las corridas, clona el kit al lado del repo o apunta a él:

```bash
git clone https://github.com/brunovillarrrrrr/zikit-dataset ../../zikit-dataset
# o bien:  ZIKIT_DATASET=/ruta/a/zikit-dataset python server.py
```

En el tablero, abre **Modo demostración**, elige la corrida y la velocidad (10 min/s, 1 h/s o 4 h/s) y
presiona **Reproducir**. Verás el semáforo cambiar antes de la falla, el aviso con su acción sugerida, la
verificación contra la solución del kit ("avisamos N min antes del pico") y los WARN/ERROR de `logs.md`.

## La NodeMCU

1. Abre `nodemcu/gramo_semaforo/gramo_semaforo.ino` en Arduino IDE (placa *NodeMCU 1.0 (ESP-12E)*).
2. Instala **ArduinoJson** (v7+) y edita `WIFI_SSID`, `WIFI_PASSWORD` y `SERVIDOR`
   (la IP de la computadora donde corre `server.py`, puerto 9091).
3. Conecta los LEDs: **D5 verde, D6 ámbar, D7 rojo** (con resistencia de 220 Ω) y, opcional, un zumbador en **D8**.
4. Sube el firmware y abre el Monitor Serie a 115200.

La placa manda su telemetría real cada 2 s (`POST /api/nodemcu/telemetria`) y enciende el LED que le
indica el servidor. Mientras la NodeMCU está conectada, el tablero muestra su estado en lugar de la repetición.

**Demo de falla real:** pulsa el botón **FLASH** de la placa. La NodeMCU empieza a reservar 1 KB de memoria
por ciclo (fuga real, con un tope seguro). Su RAM se reporta en la escala de app-01 (sana ~55 %). En ~1 min
la memoria alta se sostiene, el servidor confirma la falla, el LED pasa a rojo, suena el zumbador y sale el
aviso por Telegram. Otra pulsación libera la memoria. Cada envío cuenta como un "minuto" del detector para
que la demo dure segundos y no horas; con la placa no se aplica el filtro de horarios de gramo (la demo
puede ser de madrugada), se activa con `POST /api/nodemcu/reiniciar?respetar_contexto=true`.

## Endpoints (puerto 9091)

| Método | Ruta | Qué hace |
|---|---|---|
| GET  | `/api/gramo/contexto` | Sistemas, picos esperados y fallas de gramo |
| GET  | `/api/gramo/corridas` | Corridas disponibles y velocidades |
| POST | `/api/repeticion/iniciar` | `{corrida, velocidad}` reproduce una corrida del kit |
| POST | `/api/repeticion/detener` | Detiene la repetición |
| GET  | `/api/estado?fuente=` | Estado: riesgo, semáforo, qué pasa, avisos, registros, serie |
| POST | `/api/nodemcu/telemetria` | La placa manda `{cpu, ram, disco, latencia_ms, errores}`; responde el semáforo |
| GET  | `/api/nodemcu/semaforo` | Semáforo de la fuente activa |
| POST | `/api/nodemcu/reiniciar` | Reinicia el monitor en vivo de la placa |
| GET/POST | `/api/aviso/estado`, `/api/aviso/probar` | Estado y prueba del aviso por Telegram |

## Pruebas

```bash
cd dashboard_nodemcu
python -m pytest tests -q
```
