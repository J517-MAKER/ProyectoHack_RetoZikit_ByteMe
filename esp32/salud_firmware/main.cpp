/*
 * ======================================================
 *  SecureGuard - Firmware de Salud del Equipo (ESP32)
 * ======================================================
 *  Reto Zikit "Antes de que suene el telefono" - ByteMe
 *
 *  El ESP32 representa un equipo de la PyME (una caja, un
 *  mini-servidor). En lugar de defenderse de ataques, REPORTA
 *  SU SALUD en tiempo real para que SecureGuard detecte una
 *  falla ANTES de que el equipo colapse y el cliente llame.
 *
 *  Endpoints:
 *    GET  /health        -> telemetria de salud en JSON
 *    GET  /              -> pagina de estado simple
 *    POST /stress?on=1   -> (demo) fuerza consumo de memoria real
 *    POST /stress?on=0   -> libera la memoria forzada
 *
 *  Hardware: ESP32 DevKit v1
 *  Bibliotecas requeridas:
 *    - ESPAsyncWebServer (https://github.com/me-no-dev/ESPAsyncWebServer)
 *    - AsyncTCP           (https://github.com/me-no-dev/AsyncTCP)
 *    - ArduinoJson v7+    (https://arduinojson.org/)
 * ======================================================
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <WiFi.h>
#include <WiFiClient.h>

const char *ssid = "ByteMe";
const char *password = "Maricruz";

const char *serverUrl = "http://192.168.1.100:3000/api/telemetria";

// =============================================================
//  SERVIDOR WEB
// =============================================================
AsyncWebServer server(80);

// =============================================================
//  TELEMETRIA DE SALUD
// =============================================================
unsigned long bootTime = 0;
volatile unsigned long totalRequests = 0;

float avgResponseTimeMs = 0;
unsigned long responseTimeSamples = 0;

unsigned long rpsWindowStart = 0;
unsigned long requestsInWindow = 0;
unsigned long lastMeasuredRPS = 0;

// =============================================================
//  MODO DEMO: CONSUMO DE MEMORIA FORZADO
// =============================================================
// Permite, en la demostracion, provocar una fuga de memoria REAL
// en el equipo para que SecureGuard la detecte de forma temprana.
#define STRESS_BLOCK_SIZE 4096 // bytes por bloque reservado
#define STRESS_MAX_BLOCKS 200  // tope de bloques (evita reinicio brusco)

uint8_t *stressBlocks[STRESS_MAX_BLOCKS];
int stressCount = 0;
bool stressEnabled = false;
unsigned long lastStressStep = 0;

void releaseStress() {
  for (int i = 0; i < stressCount; i++) {
    if (stressBlocks[i]) {
      free(stressBlocks[i]);
      stressBlocks[i] = nullptr;
    }
  }
  stressCount = 0;
  stressEnabled = false;
}

void stressStep() {
  // Reserva un bloque mas cada ~300 ms mientras este activo
  if (!stressEnabled)
    return;
  unsigned long now = millis();
  if (now - lastStressStep < 300)
    return;
  lastStressStep = now;
  if (stressCount < STRESS_MAX_BLOCKS &&
      ESP.getFreeHeap() > (STRESS_BLOCK_SIZE * 8)) {
    uint8_t *b = (uint8_t *)malloc(STRESS_BLOCK_SIZE);
    if (b) {
      memset(b, 0xAB, STRESS_BLOCK_SIZE);
      stressBlocks[stressCount++] = b;
    }
  }
}

// =============================================================
//  FUNCIONES AUXILIARES
// =============================================================
void updateRPS() {
  unsigned long now = millis();
  if (now - rpsWindowStart >= 1000) {
    lastMeasuredRPS = requestsInWindow;
    requestsInWindow = 0;
    rpsWindowStart = now;
  }
}

// =============================================================
//  SETUP
// =============================================================
void setup() {
  Serial.begin(115200);
  delay(100);

  Serial.println();
  Serial.println("=======================================");
  Serial.println(" SecureGuard - Salud del Equipo (ESP32)");
  Serial.println("=======================================");

  for (int i = 0; i < STRESS_MAX_BLOCKS; i++)
    stressBlocks[i] = nullptr;

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
    Serial.println("\nNo se pudo conectar al WiFi. Reiniciando...");
    ESP.restart();
  }

  Serial.println();
  Serial.println("WiFi conectado");
  Serial.print("   IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("   RSSI: ");
  Serial.print(WiFi.RSSI());
  Serial.println(" dBm");

  bootTime = millis();
  rpsWindowStart = millis();

  // CORS (permite al dashboard consultar la salud)
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods",
                                       "GET, POST, OPTIONS");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers",
                                       "Content-Type");

  // ----------------------------------------------------------
  //  GET /  -> pagina de estado simple
  // ----------------------------------------------------------
  server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
    unsigned long startUs = micros();
    totalRequests++;
    requestsInWindow++;

    float heapPct = 100.0 - (100.0 * ESP.getFreeHeap() / ESP.getHeapSize());
    String html = "<!DOCTYPE html><html><head><meta charset='utf-8'>";
    html += "<title>Equipo - SecureGuard</title></head><body>";
    html += "<h1>Equipo monitoreado</h1>";
    html += "<p>Estado: Operativo</p>";
    html += "<p>Memoria en uso: " + String(heapPct, 1) + " %</p>";
    html += "<p>Uptime: " + String((millis() - bootTime) / 1000) + " s</p>";
    html += "</body></html>";
    request->send(200, "text/html", html);

    float elapsedMs = (micros() - startUs) / 1000.0;
    avgResponseTimeMs = (avgResponseTimeMs * responseTimeSamples + elapsedMs) /
                        (responseTimeSamples + 1);
    responseTimeSamples++;
  });

  // ----------------------------------------------------------
  //  GET /health  -> telemetria de salud en JSON
  // ----------------------------------------------------------
  server.on("/health", HTTP_GET, [](AsyncWebServerRequest *request) {
    updateRPS();

    JsonDocument doc;
    float heapPct = 100.0 - (100.0 * ESP.getFreeHeap() / ESP.getHeapSize());

    doc["uptime_s"] = (millis() - bootTime) / 1000;
    doc["free_heap"] = ESP.getFreeHeap();
    doc["total_heap"] = ESP.getHeapSize();
    doc["min_free_heap"] = ESP.getMinFreeHeap();
    doc["memoria_uso_pct"] = round(heapPct * 10) / 10.0;
    doc["cpu_freq_mhz"] = ESP.getCpuFreqMHz();
    doc["wifi_rssi"] = WiFi.RSSI();
    doc["latencia_ms"] = round(avgResponseTimeMs * 100) / 100.0;
    doc["peticiones_s"] = lastMeasuredRPS;
    doc["peticiones_total"] = totalRequests;
    doc["modo_demo_activo"] = stressEnabled;

    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
  });

  // ----------------------------------------------------------
  //  POST /stress?on=1|0  -> (demo) fuerza/libera consumo de RAM
  // ----------------------------------------------------------
  server.on("/stress", HTTP_POST, [](AsyncWebServerRequest *request) {
    String on = "1";
    if (request->hasParam("on"))
      on = request->getParam("on")->value();
    else if (request->hasParam("on", true))
      on = request->getParam("on", true)->value();

    if (on == "0") {
      releaseStress();
      Serial.println("[demo] Consumo de memoria LIBERADO.");
    } else {
      stressEnabled = true;
      lastStressStep = 0;
      Serial.println(
          "[demo] Consumo de memoria ACTIVADO (fuga simulada real).");
    }

    JsonDocument doc;
    doc["modo_demo_activo"] = stressEnabled;
    doc["bloques"] = stressCount;
    String json;
    serializeJson(doc, json);
    request->send(200, "application/json", json);
  });

  // ----------------------------------------------------------
  //  Preflight CORS
  // ----------------------------------------------------------
  server.on("/stress", HTTP_OPTIONS,
            [](AsyncWebServerRequest *request) { request->send(204); });

  server.onNotFound([](AsyncWebServerRequest *request) {
    if (request->method() == HTTP_OPTIONS) {
      request->send(204);
      return;
    }
    totalRequests++;
    requestsInWindow++;
    request->send(404, "text/plain", "404 - No encontrado");
  });

  server.begin();
  Serial.println();
  Serial.println("Servidor de salud iniciado en el puerto 80");
  Serial.println("   GET  /health       -> telemetria de salud");
  Serial.println("   POST /stress?on=1  -> fuerza fuga de memoria (demo)");
  Serial.println("   POST /stress?on=0  -> libera la memoria (demo)");
  Serial.println();
}

// =============================================================
//  LOOP PRINCIPAL
// =============================================================
void loop() {
  // 1. Tomar múltiples lecturas rápidas y promediarlas para eliminar el ruido
  float sumaTemp = 0;
  int muestras = 15; // Número de muestras para suavizar la lectura

  for (int i = 0; i < muestras; i++) {
    int sensorVal = analogRead(tempPin);
    float voltage = (sensorVal * 3.3) / 1024.0;
    sumaTemp += (voltage * 100.0);
    delay(5); // Pequeña pausa de 5ms entre cada lectura
  }

  float tempC = sumaTemp / muestras; // Temperatura suavizada y estable

  // 2. Transmisión Serial / JSON
  Serial.print("{\"temperatura\": ");
  Serial.print(tempC, 1);
  Serial.print(", \"estado\": ");

  // 3. Lógica de estados con la temperatura ya filtrada
  if (tempC < 25.0) {
    // 🟢 ESTADO NORMAL    estadoSemaforo(HIGH, LOW, LOW);
    digitalWrite(pinRelay, HIGH);
    digitalWrite(pinBuzzer, LOW);
    Serial.println(
        "\"OK\", \"incidente\": \"NINGUNO\", \"accion\": \"Ninguna\"}");

  } else if (tempC >= 25.0 && tempC < 27.0) {
    // 🟡 PRECAUCIÓN
    estadoSemaforo(LOW, HIGH, LOW);
    digitalWrite(pinRelay, HIGH);
    digitalWrite(pinBuzzer, LOW);
    Serial.println("\"PRECAUCION\", \"incidente\": \"SATURACION_CHECKOUT\", "
                   "\"accion\": \"Monitoreo\"}");

  }

  else if (tempC >= 27.0 && tempC < 29.0) {
    // 🟡 PRECAUCIÓN
    estadoSemaforo(LOW, HIGH, LOW);
    digitalWrite(pinRelay, LOW);
    Serial.println("\"PRECAUCION\", \"incidente\": \"SATURACION_CHECKOUT\", "
                   "\"accion\": \"Mitigacion preventiva\"}");

  } else {
    // 🔴 CRÍTICO
    estadoSemaforo(LOW, LOW, HIGH);
    digitalWrite(pinRelay, LOW);
    digitalWrite(pinBuzzer, HIGH);
    Serial.println("\"CRITICO\", \"incidente\": \"FALLA_TERMICA_SRV\", "
                   "\"accion\": \"RECUPERACION_ACTIVA\"}");
  }

  delay(1000); // Pausa de 1 segundo entre ciclos
}