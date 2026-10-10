/*
 * ======================================================
 *  SecureGuard · gramo - Firmware NodeMCU (ESP8266)
 * ======================================================
 *  Reto Zikit "Antes de que suene el telefono" - ByteMe
 *
 *  La NodeMCU hace dos cosas:
 *
 *   1) Representa a app-01 de gramo (la API de pedidos):
 *      cada 2 s manda su telemetria REAL al servidor
 *      (POST /api/nodemcu/telemetria):
 *        - ram:        memoria ocupada, llevada a la escala de app-01
 *        - latencia_ms: lo que tarda el servidor en contestarle
 *        - errores:    envios fallidos en el ultimo ciclo
 *        - cpu:        carga del lazo principal
 *        - disco:      flash ocupada por el programa
 *
 *   2) Es el SEMAFORO fisico del responsable: la respuesta del
 *      servidor trae el estado (verde / ambar / rojo) y la placa
 *      enciende el LED que toca. Si llega un aviso, suena el zumbador.
 *
 *  Demo de falla REAL: el boton FLASH (GPIO0) activa una fuga de
 *  memoria (la placa reserva 1 KB por ciclo). El servidor ve la RAM
 *  sostenida alta y avisa antes de que la placa se quede sin memoria.
 *  Otra pulsacion libera la memoria.
 *
 *  Conexiones:
 *    D1 (GPIO5)  -> jumper con LED verde + ambar + rojo (los 3 al mismo pin)
 *    D3 (GPIO0)  -> boton FLASH de la placa (ya incluido)
 *    (zumbador no conectado en esta configuracion)
 *
 *  Bibliotecas: core ESP8266 para Arduino, ArduinoJson v7+
 * ======================================================
 */

#include <ArduinoJson.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#include <WiFiClient.h>

// =============================================================
//  CONFIGURACION - Modifica antes de compilar
// =============================================================
const char *WIFI_SSID = "ByteMe";
const char *WIFI_PASSWORD = "Maricruz";
// IP de la computadora donde corre dashboard_nodemcu/servidor/server.py
const char *SERVIDOR = "http://10.82.90.113:9091";
const char *PLACA_ID = "nodemcu-01";

const unsigned long PERIODO_MS = 2000; // cada envio = 1 "minuto" del detector

// =============================================================
//  PINES
// =============================================================
const int LED_VERDE = D0; // LED verde -> D0
const int LED_AMBAR = D1; // LED ambar -> D1
const int LED_ROJO = D2;  // LED rojo  -> D2
const int ZUMBADOR = -1;  // sin zumbador en esta config
const int BOTON = D3;     // boton FLASH

// =============================================================
//  FUGA DE MEMORIA DE DEMO (memoria real reservada)
// =============================================================
const int BLOQUE_BYTES = 1024;
const int MAX_BLOQUES = 24; // tope seguro: ~24 KB
const uint32_t HEAP_MINIMO =
    9000; // nunca bajar de aqui (WiFi necesita memoria)
void *bloques[MAX_BLOQUES];
int nBloques = 0;
bool fugaActiva = false;

uint32_t heapInicial = 0;
unsigned long ultimoEnvio = 0;
unsigned long trabajoLazoUs = 0;
int erroresCiclo = 0;
float ultimaLatencia = 0;

void leds(const char *estado) {
  digitalWrite(LED_VERDE, strcmp(estado, "verde") == 0);
  digitalWrite(LED_AMBAR, strcmp(estado, "ambar") == 0);
  digitalWrite(LED_ROJO, strcmp(estado, "rojo") == 0);
}

void pitar(int veces) {
  (void)veces; // zumbador no conectado
}

void avanzarFuga() {
  if (fugaActiva && nBloques < MAX_BLOQUES &&
      ESP.getFreeHeap() > HEAP_MINIMO + BLOQUE_BYTES) {
    bloques[nBloques] = malloc(BLOQUE_BYTES);
    if (bloques[nBloques]) {
      memset(bloques[nBloques], 0xA5,
             BLOQUE_BYTES); // que la memoria se use de verdad
      nBloques++;
    }
  }
}

void liberarFuga() {
  for (int i = 0; i < nBloques; i++)
    free(bloques[i]);
  nBloques = 0;
}

// RAM real ocupada por la fuga, llevada a la escala de app-01 de gramo:
// sana ~55 %, el detector la considera alta desde 82 %.
float ramEscalada() {
  uint32_t libre = ESP.getFreeHeap();
  float usada = heapInicial > libre ? (float)(heapInicial - libre) : 0;
  float tope = (float)(MAX_BLOQUES * BLOQUE_BYTES);
  float pct = 55.0 + 40.0 * min(1.0f, usada / tope);
  return pct;
}

void revisarBoton() {
  static bool antes = HIGH;
  bool ahora = digitalRead(BOTON);
  if (antes == HIGH && ahora == LOW) {
    fugaActiva = !fugaActiva;
    if (!fugaActiva)
      liberarFuga();
    Serial.printf("[demo] Fuga de memoria %s\n",
                  fugaActiva ? "ACTIVADA" : "liberada");
  }
  antes = ahora;
}

void enviarTelemetria() {
  if (WiFi.status() != WL_CONNECTED) {
    erroresCiclo++;
    leds("ambar");
    return;
  }

  JsonDocument doc;
  doc["placa"] = PLACA_ID;
  doc["ip"] = WiFi.localIP().toString();
  doc["cpu"] = min(100.0f, trabajoLazoUs / (PERIODO_MS * 10.0f));
  doc["ram"] = ramEscalada();
  doc["disco"] = 100.0f * ESP.getSketchSize() /
                 (ESP.getSketchSize() + ESP.getFreeSketchSpace());
  doc["latencia_ms"] = ultimaLatencia;
  doc["errores"] = erroresCiclo;
  doc["heap_libre"] = ESP.getFreeHeap();
  String cuerpo;
  serializeJson(doc, cuerpo);

  WiFiClient cliente;
  HTTPClient http;
  http.setTimeout(3000);
  http.begin(cliente, String(SERVIDOR) + "/api/nodemcu/telemetria");
  http.addHeader("Content-Type", "application/json");

  unsigned long t0 = millis();
  int codigo = http.POST(cuerpo);
  ultimaLatencia = millis() - t0;

  if (codigo == 200) {
    erroresCiclo = 0;
    JsonDocument resp;
    if (!deserializeJson(resp, http.getString())) {
      const char *estado = resp["estado"] | "verde";
      leds(estado);
      if (resp["aviso"] | false)
        pitar(3);
      Serial.printf("[gramo] riesgo %d -> %s | RAM %.0f%% | lat %.0f ms\n",
                    resp["riesgo"] | 0, estado, ramEscalada(), ultimaLatencia);
    }
  } else {
    erroresCiclo++;
    Serial.printf("[gramo] Envio fallido (%d)\n", codigo);
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_VERDE, OUTPUT); // D0
  pinMode(LED_AMBAR, OUTPUT); // D1
  pinMode(LED_ROJO, OUTPUT);  // D2
  pinMode(BOTON, INPUT_PULLUP);
  leds("ambar");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("\nConectando a WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\nConectado. IP: %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("Servidor: %s\n", SERVIDOR);

  heapInicial = ESP.getFreeHeap();
  leds("verde");
}

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