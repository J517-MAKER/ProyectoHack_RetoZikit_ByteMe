# 🛡️ SecureGuard — Monitoreo Predictivo de Fallas

**Reto Zikit · "Antes de que suene el teléfono" · Equipo ByteMe**

En una PyME, las fallas de TI se descubren cuando el cliente llama molesto. Las señales ya estaban ahí, pero nadie las vio a tiempo. **SecureGuard** reduce el tiempo entre la primera señal de falla y la acción efectiva: vigila la salud de los equipos, detecta cuándo algo empieza a ir mal y avisa al responsable **antes** de que el problema llegue al cliente.

---

## 🎯 La idea en una frase

> El sistema calcula un **índice de riesgo (0–100)** a partir de las señales de cada equipo. Cuando el riesgo cruza un umbral, emite la alerta y propone una acción — **antes** del punto de falla. La diferencia entre "cuándo avisamos" y "cuándo habría fallado" es el tiempo que el negocio gana para resolver sin que el cliente lo note.

---

## 🧩 Arquitectura

El proyecto tiene tres componentes:

1. **Equipo monitoreado (ESP32)** — `esp32/salud_firmware/`
   Representa un equipo de la PyME (una caja, un mini-servidor). Reporta su salud en tiempo real (memoria, uptime, latencia, WiFi) en el endpoint `/health`. No se defiende de ataques: solo informa cómo está.

2. **Backend (FastAPI)** — `backend/`
   El cerebro. Un **motor de riesgo** (`RiskEngine`) que calcula el índice 0–100 combinando el **nivel** (qué tan cerca del fallo) y la **tendencia** (qué tan rápido sube). Puede simular escenarios de falla para la demo, o leer la salud real del ESP32 (modo híbrido).

3. **Dashboard web** — `dashboard/`
   Un tablero sobrio, pensado para que **alguien que no es de Sistemas** lo entienda de un vistazo: un semáforo de salud, "qué está pasando", "qué conviene hacer", y el aviso tal como le llegaría al responsable.

```
Señal de un equipo  ──►  Motor de riesgo  ──►  Alerta + acción
 (ESP32 o simulada)      (índice 0-100,        (aviso al responsable,
                          umbral + tendencia)   runbook, antes de fallar)
```

---

## 🚀 Cómo ejecutarlo

### Opción A — Solo el tablero (la más rápida para la demo)

El dashboard funciona por sí solo: si no encuentra el backend, corre la simulación en el propio navegador.

1. Abre `dashboard/index.html` en el navegador.
2. Despliega **"Modo demostración"**, elige una falla y presiona **"Simular la falla"**.

### Opción B — Con el backend (recomendada)

1. Python 3.10+ instalado.
2. Instala dependencias:
   ```bash
   cd backend
   pip install -r requirements.txt
   ```
3. Inicia el servidor:
   ```bash
   python server.py
   ```
4. Abre **http://localhost:9090** (el backend sirve el dashboard).

### Opción C — Modo híbrido (con el ESP32 real)

1. Abre `esp32/salud_firmware/main.cpp` en Arduino IDE o PlatformIO.
2. Edita tu WiFi:
   ```cpp
   const char* WIFI_SSID     = "TU_RED_WIFI";
   const char* WIFI_PASSWORD = "TU_CONTRASENA";
   ```
3. Instala las bibliotecas: `ESPAsyncWebServer`, `AsyncTCP`, `ArduinoJson` (v7+).
4. Compila, sube y abre el Monitor Serie a `115200` para ver la **IP**.
5. En el dashboard (Modo demostración → "Equipo real"), escribe esa IP.
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

---

## 👥 Equipo ByteMe — Reto Zikit
