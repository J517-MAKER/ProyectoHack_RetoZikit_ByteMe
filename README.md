# 🛡️ SecureGuard — Monitoreo Predictivo de Fallas

**Reto Zikit · "Antes de que suene el teléfono" · Equipo ByteMe**

En una PyME, las fallas de TI se descubren cuando el cliente llama molesto. Las señales ya estaban ahí, pero nadie las vio a tiempo. **SecureGuard** reduce el tiempo entre la primera señal de falla y la acción efectiva: vigila la salud de los equipos, detecta cuándo algo empieza a ir mal y avisa al responsable **antes** de que el problema llegue al cliente.

---

## 🎯 La idea en una frase

> El sistema calcula un **índice de riesgo (0–100)** a partir de las señales de cada equipo. Cuando el riesgo cruza un umbral, emite la alerta y propone una acción — **antes** del punto de falla. La diferencia entre "cuándo avisamos" y "cuándo habría fallado" es el tiempo que el negocio gana para resolver sin que el cliente lo note.

---

## 🧩 Arquitectura

El proyecto tiene cuatro componentes:

1. **Equipo monitoreado (ESP32)** — `esp32/salud_firmware/`
   Representa un equipo de la PyME (una caja, un mini-servidor). Reporta su salud en tiempo real (memoria, uptime, latencia, WiFi) en el endpoint `/health`. No se defiende de ataques: solo informa cómo está.

2. **Backend (FastAPI)** — `backend/`
   El cerebro. Un **motor de riesgo** (`RiskEngine`) que calcula el índice 0–100 combinando el **nivel** (qué tan cerca del fallo) y la **tendencia** (qué tan rápido sube). Puede simular escenarios de falla para la demo, o leer la salud real del ESP32 (modo híbrido).

3. **Dashboard web** — `dashboard/`
   Consola de monitoreo de **gramo** (la distribuidora de alimentos del kit Zikit) con **datos reales**, pensada para que
   **alguien que no es de Sistemas** la entienda de un vistazo. Cuatro vistas:
   - **Monitor en vivo:** reproduce cualquier semana del kit minuto a minuto. Índice de riesgo, estado de cada sistema
     (app-01, inventario, fw-01, portal), por qué el riesgo está así, el aviso tal como llega al celular, la línea de
     tiempo de la semana con avisos y picos reales, telemetría de app-01 y los registros de `logs.md`.
   - **Resultados del kit:** el detector sobre las 55 semanas de gramo, verificado contra la solución.
   - **Negocio y contexto:** lo que dice `contexto.md` (sistemas, horario, picos anunciados) y cómo decide el detector.
   - **Simulador de fallas:** fallas sintéticas en los sistemas de gramo y el modo híbrido con el ESP32.

4. **Tablero NodeMCU para gramo** — `dashboard_nodemcu/`
   Servidor dedicado al cliente **gramo** del kit Zikit: reproduce sus corridas reales minuto a minuto,
   avisa antes del pico de cada falla (33/33 fallas reales, 0 falsas alarmas) y usa una NodeMCU (ESP8266)
   como semáforo físico. Ver [`dashboard_nodemcu/README.md`](dashboard_nodemcu/README.md).

```
Señal de un equipo  ──►  Motor de riesgo  ──►  Alerta + acción
 (ESP32 o simulada)      (índice 0-100,        (aviso al responsable,
                          umbral + tendencia)   runbook, antes de fallar)
```

---

## 🚀 Cómo ejecutarlo

### Lo más fácil — doble clic

- **Windows:** doble clic en **`INICIAR.bat`**.
- **Mac / Linux:** en una terminal dentro de la carpeta, `bash iniciar.sh`.

La primera vez (1 a 3 minutos, con internet) busca un Python 3.10–3.12. Si no lo hay, ofrece instalar
[uv](https://docs.astral.sh/uv/) para traer Python 3.12 solo para el proyecto. Luego crea `.venv`, instala las
dependencias, baja los datos de gramo si faltan, levanta los dos servidores y abre el tablero. Las siguientes
veces arranca directo. Los registros de los servidores quedan en `logs/`.

**Para compartirlo** con alguien del equipo: `.venv\Scripts\python scripts\empaquetar.py` (en Mac/Linux
`.venv/bin/python scripts/empaquetar.py`) arma `dist/<carpeta>.zip` (~5 MB) con el código y los datos reales de
gramo, sin `.venv`, cachés ni `backend/.env`. Quien lo recibe solo descomprime y da doble clic en `INICIAR.bat`
(las instrucciones cortas están en `LEEME.txt`).

### Opción A — Con el backend y los datos reales, paso a paso

1. Python **3.10 a 3.12** (las versiones fijadas en `requirements.txt` aún no tienen paquetes para 3.13+).
2. Clona el kit de datos **junto a este repo** (el backend lo busca ahí; también puedes apuntar a otra ruta con
   la variable `ZIKIT_DATASET`). Sin el kit, el tablero usa la semana de muestra incluida en `backend/datos_muestra/`.
   ```bash
   git clone https://github.com/brunovillarrrrrr/zikit-dataset ../zikit-dataset
   ```
3. Instala dependencias e inicia el servidor:
   ```bash
   cd backend
   pip install -r requirements.txt
   python server.py
   ```
4. Abre **http://localhost:9090** (el backend sirve el dashboard). En **Monitor en vivo** elige la semana y presiona
   **«Reproducir la semana»**: a 1 h/s una semana completa dura unos 2,5 minutos y cada aviso sale en el minuto en
   que el detector lo confirma (por Telegram si configuraste `backend/.env`). Haz clic en la línea de tiempo para
   saltar a cualquier momento.

### Opción B — Solo el tablero, sin servidor

Abre `dashboard/index.html` directo en el navegador. Sin servidor solo funciona el **Simulador de fallas** (la
simulación corre en el propio navegador); los datos reales de gramo necesitan `server.py`.

### Opción C — Modo híbrido (con el ESP32 real)

1. Abre `esp32/salud_firmware/main.cpp` en Arduino IDE o PlatformIO.
2. Edita tu WiFi:
   ```cpp
   const char* WIFI_SSID     = "TU_RED_WIFI";
   const char* WIFI_PASSWORD = "TU_CONTRASENA";
   ```
3. Instala las bibliotecas: `ESPAsyncWebServer`, `AsyncTCP`, `ArduinoJson` (v7+).
4. Compila, sube y abre el Monitor Serie a `115200` para ver la **IP**.
5. En el dashboard (**Simulador de fallas** → Origen de la señal → «Equipo real (ESP32)»), escribe esa IP: el
   tablero muestra su memoria, heap libre, latencia y WiFi en vivo.
6. Para provocar una fuga de memoria **real** en el equipo durante la demo:
   ```
   POST http://<IP_DEL_ESP32>/stress?on=1   (activar)
   POST http://<IP_DEL_ESP32>/stress?on=0   (liberar)
   ```

---

## 📡 Endpoints

### Backend (`server.py`, puerto 9090)
| Método | Ruta | Qué hace |
|--------|------|----------|
| GET  | `/api/escenarios` | Catálogo de fallas simulables |
| POST | `/api/simular/iniciar` | Inyecta un escenario y arranca el monitoreo |
| POST | `/api/simular/detener` | Detiene la simulación |
| POST | `/api/simular/resolver` | Ejecuta el runbook (contiene el riesgo) |
| GET  | `/api/estado` | Estado actual: salud, riesgo, tendencia, resultado |
| GET  | `/api/equipo/salud?ip=` | Lee la salud real de un ESP32 |
| GET  | `/api/equipo/estado?ip=` | Verifica si el ESP32 responde |

#### Datos reales de gramo (`gramo_api.py`)
| Método | Ruta | Qué hace |
|--------|------|----------|
| GET  | `/api/gramo/corridas` | Semanas disponibles (principal + corridas) y cuáles traen solución |
| GET  | `/api/gramo/contexto` | `contexto.md` estructurado, sistemas, runbooks y umbrales del detector |
| GET  | `/api/gramo/semana?corrida=` | Semana completa minuto a minuto: métricas, riesgo, avisos verificados, registros |
| GET  | `/api/gramo/estado` | Minuto actual de la repetición y lo que el monitor sabe en ese minuto |
| POST | `/api/gramo/repeticion/cargar` · `iniciar` · `pausar` · `reanudar` · `velocidad` · `saltar` | Controla la repetición |
| GET  | `/api/gramo/evaluacion` | El detector sobre todas las semanas del kit (se calcula al arrancar) |

### Firmware ESP32 (puerto 80)
| Método | Ruta | Qué hace |
|--------|------|----------|
| GET  | `/health` | Telemetría de salud en JSON |
| GET  | `/` | Página de estado simple |
| POST | `/stress?on=1\|0` | (Demo) fuerza o libera consumo de memoria real |

---

## 🧮 Cómo se calcula el riesgo

El índice no es una caja negra; es explicable y defendible ante el jurado:

- **Nivel (80%):** qué tan cerca está la señal del punto de falla.
- **Tendencia (hasta +35):** qué tan rápido sube, medido con una media móvil (EWMA). Una señal que se dispara pesa más que una que sube despacio.
- **Umbral de aviso:** la *sensibilidad* configurable decide a qué nivel de riesgo se alerta. Más sensible = más anticipación, con algo más de riesgo de falsa alarma.

---

## 📊 Cómo se demuestra que funciona

La demo mide tres números por cada falla:

1. **Cuándo lo detectamos** — el segundo en que el riesgo cruzó el umbral.
2. **Cuándo habría fallado** — el segundo en que el equipo habría colapsado.
3. **Tiempo ganado** — la diferencia: la ventana de anticipación.

Escenario base (sin SecureGuard): la falla se descubre cuando el cliente llama. Con SecureGuard: el aviso llega antes. Esa diferencia es el reto resuelto, y es medible.

### Con los datos reales de gramo (kit Zikit completo)

El mismo monitor, corriendo minuto a minuto sobre las **55 semanas** de gramo (la principal y 54 corridas):

| Medida | Resultado |
|---|---|
| Fallas reales avisadas antes del pico (11 semanas con solución) | **33 de 33** |
| Falsas alarmas | **0** (88 picos normales ignorados: promo 2x1, snapshots y reportes nocturnos) |
| Anticipación desde el aviso hasta el pico | **47,5 min** en promedio (mínimo 31, máximo 61) |
| El aviso nombra el sistema correcto | **33 de 33** (las pistas de `logs.md` separan tráfico hostil de inventario saturado) |
| Semanas de prueba sin solución | 44 de 44 con los mismos 3 avisos, el mismo día y casi a la misma hora |

La solución del kit solo se usa para verificar; el detector nunca la ve. La vista **Resultados del kit** del
tablero muestra el detalle por semana y por tipo de falla.

---

## 👥 Equipo ByteMe — Reto Zikit
