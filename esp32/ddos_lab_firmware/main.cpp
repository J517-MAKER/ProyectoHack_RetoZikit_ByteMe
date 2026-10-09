/*
 * ======================================================
 *  🛡️ DDoS Simulation Lab — ESP32 Firmware
 * ======================================================
 *  Servidor web asíncrono con telemetría en tiempo real
 *  y sistema de defensa anti-DDoS multicapa.
 *
 *  Hardware: ESP32 DevKit v1
 *  Bibliotecas requeridas:
 *    - ESPAsyncWebServer (https://github.com/me-no-dev/ESPAsyncWebServer)
 *    - AsyncTCP           (https://github.com/me-no-dev/AsyncTCP)
 *    - ArduinoJson v7+    (https://arduinojson.org/)
 *
 *  ⚠️ USO EXCLUSIVAMENTE EDUCATIVO — Solo en redes propias.
 * ======================================================
 */

#include <Arduino.h>
#include <WiFi.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <ArduinoJson.h>

// =============================================================
//  CONFIGURACIÓN — Modifica estos valores antes de compilar
// =============================================================
const char* WIFI_SSID     = "TU_RED_WIFI";
const char* WIFI_PASSWORD  = "TU_CONTRASEÑA";

// =============================================================
//  SERVIDOR WEB
// =============================================================
AsyncWebServer server(80);

// =============================================================
//  MÉTRICAS DE TELEMETRÍA
// =============================================================
volatile unsigned long totalRequests       = 0;
volatile unsigned long blockedRequests     = 0;
volatile unsigned long droppedRequests     = 0;
volatile int           currentConnections  = 0;

unsigned long bootTime              = 0;
float         avgResponseTimeMs     = 0;
unsigned long responseTimeSamples   = 0;

// Tasa de peticiones por segundo (sliding window)
unsigned long rpsWindowStart        = 0;
unsigned long requestsInWindow      = 0;
unsigned long lastMeasuredRPS       = 0;

// =============================================================
//  SISTEMA DE DEFENSA ANTI-DDoS
// =============================================================
bool defenseEnabled = false;

// — Configuración de defensa —
#define MAX_TRACKED_IPS           64     // IPs rastreadas simultáneamente
#define RATE_LIMIT_WINDOW_MS      1000   // Ventana de 1 segundo
#define DEFAULT_RATE_LIMIT        10     // Peticiones permitidas por IP/ventana
#define BLACKLIST_BASE_DURATION   30000  // Bloqueo base: 30 segundos
#define BLACKLIST_ESCALATION      2      // Factor de escalamiento por reincidencia
#define MAX_BLACKLIST_DURATION    300000 // Bloqueo máximo: 5 minutos
#define MAX_CONCURRENT_CONN       8     // Conexiones simultáneas máximas

int rateLimit = DEFAULT_RATE_LIMIT;

// — Tabla de rastreo de IPs —
struct IPRecord {
    uint32_t      ipRaw;             // IP en formato uint32
    unsigned long windowStart;       // Inicio de la ventana actual
    unsigned int  requestsInWindow;  // Peticiones en esta ventana
    unsigned long blacklistedUntil;  // Timestamp hasta cuando está bloqueada
    int           violations;        // Número de violaciones acumuladas
    bool          active;            // Slot en uso
};

IPRecord ipTable[MAX_TRACKED_IPS];

// =============================================================
//  FUNCIONES DE DEFENSA
// =============================================================

/**
 * Busca un slot para una IP. Si la IP ya existe, devuelve su índice.
 * Si no, devuelve el primer slot vacío. Si no hay espacio, devuelve -1.
 */
int findOrAllocateSlot(uint32_t ip) {
    int emptySlot = -1;
    unsigned long oldestTime = ULONG_MAX;
    int oldestSlot = -1;

    for (int i = 0; i < MAX_TRACKED_IPS; i++) {
        if (ipTable[i].active && ipTable[i].ipRaw == ip) {
            return i; // IP encontrada
        }
        if (!ipTable[i].active && emptySlot == -1) {
            emptySlot = i; // Primer slot vacío
        }
        // Rastrear el slot más antiguo para LRU eviction
        if (ipTable[i].active && ipTable[i].windowStart < oldestTime) {
            oldestTime = ipTable[i].windowStart;
            oldestSlot = i;
        }
    }

    // Usar slot vacío o reciclar el más antiguo (LRU)
    if (emptySlot != -1) return emptySlot;
    if (oldestSlot != -1) {
        ipTable[oldestSlot].active = false;
        return oldestSlot;
    }
    return -1;
}

/**
 * Verifica si una IP está actualmente en la blacklist.
 */
bool isBlacklisted(uint32_t ip) {
    unsigned long now = millis();
    for (int i = 0; i < MAX_TRACKED_IPS; i++) {
        if (ipTable[i].active && ipTable[i].ipRaw == ip) {
            if (ipTable[i].blacklistedUntil > now) {
                return true; // Aún bloqueada
            }
            if (ipTable[i].blacklistedUntil > 0 && ipTable[i].blacklistedUntil <= now) {
                ipTable[i].blacklistedUntil = 0; // Expiró, limpiar
            }
            return false;
        }
    }
    return false;
}

/**
 * Verifica el rate limit para una IP.
 * Retorna true si la petición es permitida, false si debe bloquearse.
 */
bool checkRateLimit(uint32_t ip) {
    unsigned long now = millis();
    int slot = findOrAllocateSlot(ip);

    if (slot == -1) {
        return true; // Sin espacio para rastrear, permitir (fail-open)
    }

    IPRecord &record = ipTable[slot];

    // IP nueva — inicializar registro
    if (!record.active) {
        record.ipRaw           = ip;
        record.windowStart     = now;
        record.requestsInWindow = 1;
        record.blacklistedUntil = 0;
        record.violations      = 0;
        record.active          = true;
        return true;
    }

    // ¿Está bloqueada?
    if (record.blacklistedUntil > now) {
        return false;
    }

    // ¿Nueva ventana de tiempo?
    if (now - record.windowStart >= RATE_LIMIT_WINDOW_MS) {
        record.windowStart     = now;
        record.requestsInWindow = 1;
        return true;
    }

    // Incrementar contador y verificar límite
    record.requestsInWindow++;

    if ((int)record.requestsInWindow > rateLimit) {
        // Excedió el límite — blacklist con escalamiento adaptativo
        record.violations++;
        unsigned long duration = BLACKLIST_BASE_DURATION *
                                 record.violations * BLACKLIST_ESCALATION;
        if (duration > MAX_BLACKLIST_DURATION) {
            duration = MAX_BLACKLIST_DURATION;
        }
        record.blacklistedUntil = now + duration;

        Serial.printf("[DEFENSA] IP bloqueada por %lu ms (violación #%d)\n",
                      duration, record.violations);
        return false;
    }

    return true;
}

/**
 * Cuenta cuántas IPs están actualmente en la blacklist.
 */
int countBlacklistedIPs() {
    int count = 0;
    unsigned long now = millis();
    for (int i = 0; i < MAX_TRACKED_IPS; i++) {
        if (ipTable[i].active && ipTable[i].blacklistedUntil > now) {
            count++;
        }
    }
    return count;
}

/**
 * Middleware de defensa: evalúa si una petición debe ser permitida o rechazada.
 * Retorna true si la petición puede continuar, false si fue bloqueada.
 */
bool evaluateDefense(AsyncWebServerRequest *request) {
    if (!defenseEnabled) return true; // Defensas desactivadas

    uint32_t clientIP = (uint32_t)request->client()->remoteIP();

    // Capa 1: Blacklist
    if (isBlacklisted(clientIP)) {
        blockedRequests++;
        request->send(429, "text/plain", "429 - IP Temporalmente Bloqueada");
        return false;
    }

    // Capa 2: Rate Limiting
    if (!checkRateLimit(clientIP)) {
        blockedRequests++;
        request->send(429, "text/plain", "429 - Rate Limit Excedido");
        return false;
    }

    // Capa 3: Límite de conexiones concurrentes
    if (currentConnections >= MAX_CONCURRENT_CONN) {
        droppedRequests++;
        request->send(503, "text/plain", "503 - Servidor Sobrecargado");
        return false;
    }

    return true; // Todas las capas pasaron
}

// =============================================================
//  FUNCIONES AUXILIARES
// =============================================================

/**
 * Formatea una dirección IP desde uint32_t a String.
 */
String formatIP(uint32_t ip) {
    return String((ip) & 0xFF) + "." +
           String((ip >> 8) & 0xFF) + "." +
           String((ip >> 16) & 0xFF) + "." +
           String((ip >> 24) & 0xFF);
}

/**
 * Actualiza la medición de RPS (peticiones por segundo).
 */
void updateRPS() {
    unsigned long now = millis();
    if (now - rpsWindowStart >= 1000) {
        lastMeasuredRPS  = requestsInWindow;
        requestsInWindow = 0;
        rpsWindowStart   = now;
    }
}

// =============================================================
//  SETUP
// =============================================================
void setup() {
    Serial.begin(115200);
    delay(100);

    Serial.println();
    Serial.println("=================================");
    Serial.println(" 🛡️ DDoS Simulation Lab — ESP32");
    Serial.println("=================================");

    // Inicializar tabla de IPs
    memset(ipTable, 0, sizeof(ipTable));

    // Conectar a WiFi
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    Serial.print("Conectando a WiFi");

    int attempts = 0;
    while (WiFi.status() != WL_CONNECTED && attempts < 40) {
        delay(500);
        Serial.print(".");
        attempts++;
    }

    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("\n❌ No se pudo conectar al WiFi. Reiniciando...");
        ESP.restart();
    }

    Serial.println();
    Serial.println("✅ WiFi conectado");
    Serial.print("   IP: ");
    Serial.println(WiFi.localIP());
    Serial.print("   RSSI: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");

    bootTime       = millis();
    rpsWindowStart = millis();

    // --- Headers CORS (permite comunicación desde el dashboard) ---
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type");

    // ==========================================================
    //  RUTA: / — Página principal (objetivo del ataque)
    // ==========================================================
    server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
        unsigned long startMs = micros();
        totalRequests++;
        requestsInWindow++;

        if (!evaluateDefense(request)) return;

        currentConnections++;

        // Página HTML mínima (simula carga de trabajo)
        String html = "<!DOCTYPE html><html><head><title>ESP32 Server</title></head><body>";
        html += "<h1>ESP32 DDoS Lab</h1>";
        html += "<p>Estado: Operativo</p>";
        html += "<p>Heap libre: " + String(ESP.getFreeHeap()) + " bytes</p>";
        html += "<p>Uptime: " + String((millis() - bootTime) / 1000) + " s</p>";
        html += "<p>Peticiones totales: " + String(totalRequests) + "</p>";
        html += "</body></html>";

        request->send(200, "text/html", html);

        currentConnections--;

        // Registrar tiempo de respuesta
        unsigned long elapsedUs = micros() - startMs;
        float elapsedMs = elapsedUs / 1000.0;
        avgResponseTimeMs = (avgResponseTimeMs * responseTimeSamples + elapsedMs)
                            / (responseTimeSamples + 1);
        responseTimeSamples++;
    });

    // ==========================================================
    //  RUTA: /metrics — Telemetría en JSON
    // ==========================================================
    server.on("/metrics", HTTP_GET, [](AsyncWebServerRequest *request) {
        // Este endpoint NO pasa por las defensas (siempre accesible)
        updateRPS();

        JsonDocument doc;

        // Telemetría del sistema
        doc["uptime_s"]            = (millis() - bootTime) / 1000;
        doc["free_heap"]           = ESP.getFreeHeap();
        doc["total_heap"]          = ESP.getHeapSize();
        doc["min_free_heap"]       = ESP.getMinFreeHeap();
        doc["heap_usage_pct"]      = 100.0 - (100.0 * ESP.getFreeHeap() / ESP.getHeapSize());
        doc["cpu_freq_mhz"]        = ESP.getCpuFreqMHz();
        doc["wifi_rssi"]           = WiFi.RSSI();

        // Métricas de tráfico
        doc["total_requests"]      = totalRequests;
        doc["blocked_requests"]    = blockedRequests;
        doc["dropped_requests"]    = droppedRequests;
        doc["requests_per_second"] = lastMeasuredRPS;
        doc["avg_response_ms"]     = round(avgResponseTimeMs * 100) / 100.0;
        doc["current_connections"] = currentConnections;

        // Estado de defensa
        doc["defense_enabled"]     = defenseEnabled;
        doc["rate_limit"]          = rateLimit;
        doc["blacklisted_ips"]     = countBlacklistedIPs();

        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // ==========================================================
    //  RUTA: /defense/status — Estado detallado de defensas
    // ==========================================================
    server.on("/defense/status", HTTP_GET, [](AsyncWebServerRequest *request) {
        JsonDocument doc;

        doc["enabled"]           = defenseEnabled;
        doc["rate_limit"]        = rateLimit;
        doc["max_connections"]   = MAX_CONCURRENT_CONN;
        doc["blacklisted_ips"]   = countBlacklistedIPs();
        doc["blocked_total"]     = blockedRequests;
        doc["dropped_total"]     = droppedRequests;
        doc["blacklist_base_ms"] = BLACKLIST_BASE_DURATION;
        doc["blacklist_max_ms"]  = MAX_BLACKLIST_DURATION;

        // Lista de IPs bloqueadas actualmente
        JsonArray blacklist = doc["blacklist"].to<JsonArray>();
        unsigned long now = millis();
        for (int i = 0; i < MAX_TRACKED_IPS; i++) {
            if (ipTable[i].active && ipTable[i].blacklistedUntil > now) {
                JsonObject entry = blacklist.add<JsonObject>();
                entry["ip"]         = formatIP(ipTable[i].ipRaw);
                entry["remaining_s"] = (ipTable[i].blacklistedUntil - now) / 1000;
                entry["violations"]  = ipTable[i].violations;
            }
        }

        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // ==========================================================
    //  RUTA: /defense/toggle — Activar/Desactivar defensas
    // ==========================================================
    server.on("/defense/toggle", HTTP_POST, [](AsyncWebServerRequest *request) {
        defenseEnabled = !defenseEnabled;

        if (defenseEnabled) {
            // Al activar, reiniciar tabla de rastreo
            memset(ipTable, 0, sizeof(ipTable));
            blockedRequests = 0;
            droppedRequests = 0;
            Serial.println("🛡️ Defensas ACTIVADAS");
        } else {
            Serial.println("⚠️  Defensas DESACTIVADAS");
        }

        JsonDocument doc;
        doc["enabled"] = defenseEnabled;
        doc["message"] = defenseEnabled
                         ? "Defensas ACTIVADAS — Rate Limit + Blacklist + Conn Limit"
                         : "Defensas DESACTIVADAS — Servidor vulnerable";

        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // ==========================================================
    //  RUTA: /defense/ratelimit — Ajustar rate limit
    // ==========================================================
    server.on("/defense/ratelimit", HTTP_POST, [](AsyncWebServerRequest *request) {
        if (request->hasParam("value", true)) {
            int newLimit = request->getParam("value", true)->value().toInt();
            if (newLimit < 1) newLimit = 1;
            if (newLimit > 1000) newLimit = 1000;
            rateLimit = newLimit;
            Serial.printf("⚙️  Rate limit ajustado a %d req/s\n", rateLimit);
        }

        JsonDocument doc;
        doc["rate_limit"] = rateLimit;

        String json;
        serializeJson(doc, json);
        request->send(200, "application/json", json);
    });

    // ==========================================================
    //  RUTA: OPTIONS — Preflight CORS
    // ==========================================================
    server.on("/defense/toggle", HTTP_OPTIONS, [](AsyncWebServerRequest *request) {
        request->send(204);
    });
    server.on("/defense/ratelimit", HTTP_OPTIONS, [](AsyncWebServerRequest *request) {
        request->send(204);
    });

    // ==========================================================
    //  RUTA: 404 — Not Found (también cuenta como petición)
    // ==========================================================
    server.onNotFound([](AsyncWebServerRequest *request) {
        if (request->method() == HTTP_OPTIONS) {
            request->send(204);
            return;
        }
        totalRequests++;
        requestsInWindow++;
        if (!evaluateDefense(request)) return;
        request->send(404, "text/plain", "404 - No Encontrado");
    });

    // Iniciar servidor
    server.begin();
    Serial.println();
    Serial.println("🚀 Servidor web iniciado en puerto 80");
    Serial.println("   Endpoints:");
    Serial.println("   GET  /              → Página principal (target)");
    Serial.println("   GET  /metrics       → Telemetría JSON");
    Serial.println("   GET  /defense/status → Estado de defensas");
    Serial.println("   POST /defense/toggle → Activar/Desactivar defensas");
    Serial.println("   POST /defense/ratelimit?value=N → Ajustar rate limit");
    Serial.println();
}

// =============================================================
//  LOOP PRINCIPAL
// =============================================================
void loop() {
    unsigned long now = millis();

    // Actualizar RPS
    updateRPS();

    // Limpieza periódica de registros expirados (cada 60 segundos)
    static unsigned long lastCleanup = 0;
    if (now - lastCleanup > 60000) {
        int cleaned = 0;
        for (int i = 0; i < MAX_TRACKED_IPS; i++) {
            if (ipTable[i].active &&
                ipTable[i].blacklistedUntil < now &&
                now - ipTable[i].windowStart > 60000) {
                ipTable[i].active = false;
                cleaned++;
            }
        }
        if (cleaned > 0) {
            Serial.printf("[CLEANUP] %d registros de IP liberados\n", cleaned);
        }
        lastCleanup = now;
    }

    // Reporte periódico por Serial (cada 5 segundos)
    static unsigned long lastReport = 0;
    if (now - lastReport > 5000) {
        Serial.printf("[%5lus] REQ: %lu | BLOCKED: %lu | DROPPED: %lu | HEAP: %u/%u | DEFENSE: %s | RPS: %lu\n",
            (now - bootTime) / 1000,
            totalRequests,
            blockedRequests,
            droppedRequests,
            ESP.getFreeHeap(),
            ESP.getHeapSize(),
            defenseEnabled ? "ON" : "OFF",
            lastMeasuredRPS
        );
        lastReport = now;
    }

    // Pequeño yield para evitar watchdog timer
    delay(1);
}
