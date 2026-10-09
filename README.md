# 🛡️ DDoS Simulation Lab — Reto Zikit ByteMe

Un entorno de laboratorio educativo, diseñado para simular, monitorear y aprender a mitigar ataques DDoS dirigidos a dispositivos IoT (ESP32).

## 🚀 Arquitectura del Proyecto

El proyecto consta de tres componentes principales:
1. **Target (ESP32)**: Servidor web asíncrono con telemetría integrada y un firewall/defensa en capa de aplicación.
2. **Backend (FastAPI)**: Motor de ataque de alto rendimiento (`asyncio` + `aiohttp`) y proxy de métricas.
3. **Dashboard Web**: Interfaz de control y monitoreo en tiempo real con diseño oscuro y métricas reactivas (`Chart.js`).

---

## 🛠️ Guía de Instalación y Uso

### 1. Preparar el ESP32 (La Víctima)
1. Abre el archivo `esp32/ddos_lab_firmware/ddos_lab_firmware.ino` en Arduino IDE o PlatformIO.
2. Edita la configuración WiFi con tus credenciales:
   ```cpp
   const char* WIFI_SSID     = "TU_RED_WIFI";
   const char* WIFI_PASSWORD = "TU_CONTRASEÑA";
   ```
3. Instala las bibliotecas requeridas desde el Gestor de Bibliotecas:
   - `ESPAsyncWebServer` (de me-no-dev)
   - `AsyncTCP` (de me-no-dev)
   - `ArduinoJson` (versión 7 o superior)
4. Compila, sube al ESP32 y abre el Monitor Serie a `115200` baudios para obtener la **IP asignada**.

### 2. Levantar el Motor de Ataque y Dashboard (El Atacante)
1. Asegúrate de tener Python 3.10+ instalado.
2. Abre una terminal en la raíz del proyecto y navega al directorio del backend:
   ```bash
   cd backend
   ```
3. Instala las dependencias:
   ```bash
   pip install -r requirements.txt
   ```
4. Inicia el servidor:
   ```bash
   python server.py
   ```
5. Abre en tu navegador: **http://localhost:8000** (El backend servirá el Dashboard automáticamente).

### 3. Ejecutar la Simulación
1. En el Dashboard, ingresa la IP de tu ESP32. El indicador superior derecho debería cambiar a "Conectado".
2. **Sin Defensas (Fase 1)**: Lanza un ataque con alta intensidad (ej. 200 req/s, 100 concurrentes). Observa en el panel derecho cómo la latencia se dispara, los RPS caen a cero y el ESP32 colapsa por falta de memoria RAM.
3. Detén el ataque y espera a que el ESP32 se recupere (o reinícialo físicamente).
4. **Con Defensas (Fase 2)**: Activa las defensas desde el panel derecho. Lanza el ataque nuevamente. Observa cómo el sistema bloquea las IPs maliciosas y mantiene los recursos estables.

---

## 🛡️ Estrategia de Mitigación (Paso a Paso)

Este proyecto implementa una defensa anti-DDoS multicapa directamente en el firmware del ESP32. Aquí explicamos cómo funciona y por qué es efectiva para mitigar ataques volumétricos en IoT.

### Capa 1: Límite de Conexiones Concurrentes (Anti-Exhaustion)
**Problema:** Un atacante abre cientos de conexiones simultáneas sin cerrarlas (ej. Slowloris), agotando la RAM del ESP32.
**Implementación:**
Definimos un `MAX_CONCURRENT_CONN` (ej. 8). Llevamos un contador atómico de las conexiones activas.
```cpp
if (currentConnections >= MAX_CONCURRENT_CONN) {
    droppedRequests++;
    request->send(503, "text/plain", "503 - Servidor Sobrecargado");
    return false; // Cortar conexión inmediatamente
}
```

### Capa 2: Rate Limiting por IP (Ventana Deslizante)
**Problema:** Un atacante inunda el servidor con miles de peticiones válidas por segundo.
**Implementación:**
Mantenemos un arreglo (`ipTable`) de las últimas IPs vistas. Para cada IP, registramos el inicio de una ventana de tiempo (ej. 1 segundo) y contamos las peticiones.
```cpp
if (now - record.windowStart >= 1000) {
    // Nueva ventana, reiniciar contador
    record.windowStart = now;
    record.requestsInWindow = 1;
} else {
    record.requestsInWindow++;
    if (record.requestsInWindow > rateLimit) {
        // Bloquear (Pasar a Capa 3)
    }
}
```

### Capa 3: Blacklisting Dinámico con Escalamiento
**Problema:** Rate limit bloquea el exceso, pero seguir evaluando cada paquete consume CPU y memoria valiosa.
**Implementación:**
Si una IP excede el Rate Limit, se añade a una Blacklist temporal. Si la IP insiste, el tiempo de bloqueo se multiplica (Cooldown adaptativo).
```cpp
record.violations++;
unsigned long duration = BASE_DURATION * record.violations * ESCALATION_FACTOR;
record.blacklistedUntil = now + duration;
```
En el middleware, revisamos esto **antes** de procesar cualquier dato de la petición. Si la IP está en la lista, se descarta el request retornando un código `429 Too Many Requests` casi sin costo computacional.

### El Rol de la Asincronía
La decisión arquitectónica de usar `ESPAsyncWebServer` en lugar de `WebServer` estándar es clave. Al ser asíncrono, un ataque no bloquea el hilo principal del procesador. Esto permite que el ESP32:
1. Siga calculando métricas.
2. Mantenga vivo el stack de WiFi y TCP.
3. Permita la intervención humana (Dashboard) para activar medidas o modificar reglas en medio del ataque.

---
> ⚠️ **Aviso de Uso Responsable:** Todo el software provisto en este repositorio debe utilizarse EXCLUSIVAMENTE contra dispositivos y redes de tu propiedad. El "Motor de Ataque" incluido puede interrumpir redes reales.
