/*
 * ======================================================
 *  SecureGuard · gramo - Firmware NodeMCU (ESP8266)
 * ======================================================
 *  Reto Zikit "Antes de que suene el telefono" - ByteMe
 *
 *  La NodeMCU hace TRES cosas:
 *
 *   1) TELEMETRIA / SIMULACION DE FALLA (Punto de venta):
 *      Cada 2 s manda RAM, latencia, CPU y errores al
 *      servidor central (POST /api/nodemcu/telemetria).
 *      El boton FLASH (GPIO0) activa una fuga de memoria
 *      real que el servidor detecta de forma anticipada.
 *
 *   2) SEMAFORO FISICO:
 *      La respuesta del servidor indica el estado
 *      (verde / ambar / rojo) y enciende el LED correcto.
 *      Si el sensor termico detecta peligro, el LED de
 *      alerta se enciende sin importar la orden del servidor.
 *
 *   3) MONITOR TERMICO LOCAL (LM35 en A0):
 *      Lee la temperatura con promedio de 15 muestras para
 *      eliminar ruido. Controla el rele (ventilacion) y el
 *      zumbador con 4 niveles de alerta NO BLOQUEANTES:
 *        < 25 C          -> OK              (buzzer apagado)
 *        25 C a < 27 C   -> PRECAUCION_TEMPRANA (1 pitido/3s)
 *        27 C a < 29 C   -> PRECAUCION_ACTIVA   (2 pitidos/s + rele)
 *        >= 29 C         -> CRITICO    (pulsos rapidos + rele)
 *
 *  Conexiones:
 *    A0          -> LM35 (centro), 3.3V (izq), GND (der)
 *    D7 (GPIO13) -> LED verde
 *    D8 (GPIO15) -> LED amarillo
 *    D3 (GPIO0)  -> LED rojo  [ojo: mismo pin que boton FLASH]
 *    D6 (GPIO12) -> Zumbador pasivo
 *    D5 (GPIO14) -> Rele (ventilador)
 *
 *  Librerias: core ESP8266 para Arduino, ArduinoJson v7+
 * ======================================================
 */

#include <ArduinoJson.h>
#include <ESP8266HTTPClient.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <WiFiClient.h>

// =============================================================
//  CONFIGURACION DE RED Y SERVIDOR
// =============================================================
const char* WIFI_SSID     = "ByteMe";
const char* WIFI_PASSWORD = "Maricruz";
// IP de la PC donde corre dashboard_nodemcu/servidor/server.py
const char* SERVIDOR      = "http://10.100.0.73:9091";
const char* PLACA_ID      = "nodemcu-01";

const unsigned long PERIODO_TELEMETRIA_MS = 2000; // cada 2 s = 1 "minuto" del detector
const int           MUESTRAS_LM35        = 15;   // promedio de lecturas para filtrar ruido
const unsigned long REFRESCO_TERMICO_MS  = 1000; // refresco del sensor cada 1 s

ESP8266WebServer server(80);

// =============================================================
//  PINES (mapeo del hardware del usuario)
// =============================================================
const int tempPin       = A0;  // LM35 - entrada analogica unica
const int pinLedVerde   = 13;  // D7 (GPIO13)
const int pinLedAmarillo = 15; // D8 (GPIO15)
const int pinLedRojo    = 0;   // D3 (GPIO0) - comparte con boton FLASH
const int pinBuzzer     = 12;  // D6 (GPIO12)
const int pinRelay      = 14;  // D5 (GPIO14)

// El modulo de rele es ACTIVO-BAJO: LOW = ventilacion encendida
// Si tu modulo es activo-alto, cambia a false
const bool RELE_ACTIVO_BAJO = true;

// =============================================================
//  VARIABLES DE ESTADO GLOBAL
// =============================================================
float  temperatura    = 0.0;
String estadoTermico  = "OK";
String estadoBackend  = "verde";
bool   releEncendido  = false;

// Telemetria
uint32_t      heapInicial    = 0;
unsigned long ultimoEnvio    = 0;
unsigned long trabajoLazoUs  = 0;
int           erroresCiclo   = 0;
float         ultimaLatencia = 0;

// Buzzer no bloqueante
bool          buzzerPinActivo         = false;
int           pitidosBackendRestantes = 0;
unsigned long proximoCambioBackend    = 0;

// Simulacion de fuga de memoria (punto de venta)
const int      BLOQUE_BYTES = 1024;
const int      MAX_BLOQUES  = 24;
const uint32_t HEAP_MINIMO  = 9000;
void*  bloques[MAX_BLOQUES];
int    nBloques   = 0;
bool   fugaActiva = false;

// =============================================================
//  SECCION 1 – SEMAFORO: estadoSemaforo() y leds()
// =============================================================

/**
 * Enciende directamente los tres LEDs del semaforo.
 * Parametros: HIGH = encendido, LOW = apagado.
 */
void estadoSemaforo(int estadoVerde, int estadoAmarillo, int estadoRojo) {
  digitalWrite(pinLedVerde,    estadoVerde);
  digitalWrite(pinLedAmarillo, estadoAmarillo);
  digitalWrite(pinLedRojo,     estadoRojo);
}

/**
 * Enciende el semaforo segun el estado termico y la orden del backend.
 * El estado termico tiene prioridad sobre el backend.
 */
void leds(const char* estado) {
  estadoBackend = estado;

  if (estadoTermico == "CRITICO") {
    estadoSemaforo(LOW, LOW, HIGH);
  } else if (estadoTermico == "PRECAUCION_ACTIVA" ||
             estadoTermico == "PRECAUCION_TEMPRANA") {
    estadoSemaforo(LOW, HIGH, LOW);
  } else {
    // Estado termico OK -> obedece la orden del backend
    if      (strcmp(estado, "verde") == 0) estadoSemaforo(HIGH, LOW, LOW);
    else if (strcmp(estado, "ambar") == 0) estadoSemaforo(LOW, HIGH, LOW);
    else if (strcmp(estado, "rojo")  == 0) estadoSemaforo(LOW, LOW, HIGH);
    else                                   estadoSemaforo(LOW, LOW, LOW);
  }
}

// =============================================================
//  SECCION 2 – RELE Y BUZZER (no bloqueante)
// =============================================================

/** Enciende/apaga el rele respetando logica activo-bajo. */
void setRele(bool encender) {
  releEncendido = encender;
  if (RELE_ACTIVO_BAJO) {
    digitalWrite(pinRelay, encender ? LOW : HIGH);
  } else {
    digitalWrite(pinRelay, encender ? HIGH : LOW);
  }
}

/** Cambia el pin del buzzer solo cuando realmente cambia de estado. */
void setBuzzer(bool encender) {
  if (buzzerPinActivo != encender) {
    digitalWrite(pinBuzzer, encender ? HIGH : LOW);
    buzzerPinActivo = encender;
  }
}

/** Encola pitidos de confirmacion del backend (no bloqueante). */
void pitar(int veces) {
  if (pitidosBackendRestantes == 0) {
    pitidosBackendRestantes = veces * 2;
    proximoCambioBackend    = millis();
  } else {
    pitidosBackendRestantes += veces * 2;
  }
}

/**
 * Gestiona el buzzer de forma no bloqueante. Llamar en cada loop().
 *
 * Patrones:
 *   PRECAUCION_TEMPRANA -> 1 pitido de 100 ms cada 3 s
 *   PRECAUCION_ACTIVA   -> 2 pitidos rapidos por segundo
 *   CRITICO             -> pulsos continuos 100 ms ON / 100 ms OFF
 *   OK                  -> pitidos de confirmacion del backend (si hay)
 */
void manejarBuzzer() {
  unsigned long ahora = millis();

  if (estadoTermico != "OK") {
    pitidosBackendRestantes = 0; // prioridad al estado termico

    if (estadoTermico == "PRECAUCION_TEMPRANA") {
      setBuzzer((ahora % 3000UL) < 100);

    } else if (estadoTermico == "PRECAUCION_ACTIVA") {
      unsigned long c = ahora % 1000UL;
      setBuzzer(c < 100 || (c > 200 && c < 300));

    } else { // CRITICO
      setBuzzer((ahora % 200UL) < 100);
    }

  } else {
    // OK: procesar cola de pitidos del backend
    if (pitidosBackendRestantes > 0) {
      if (ahora >= proximoCambioBackend) {
        setBuzzer(pitidosBackendRestantes % 2 == 0);
        pitidosBackendRestantes--;
        proximoCambioBackend = ahora + 100;
      }
    } else {
      setBuzzer(false);
    }
  }
}

// =============================================================
//  SECCION 3 – SENSOR TERMICO (LM35)
// =============================================================

/**
 * Lee el LM35 promediando MUESTRAS_LM35 lecturas para eliminar ruido.
 * Actualiza temperatura, estadoTermico, rele y LEDs.
 */
void actualizarTermico() {
  // Promedio de muestras para suavizar la temperatura
  float sumaTemp = 0;
  for (int i = 0; i < MUESTRAS_LM35; i++) {
    int   sensorVal = analogRead(tempPin);
    float voltage   = (sensorVal * 3.3f) / 1024.0f;
    sumaTemp += voltage * 100.0f; // LM35: 10 mV/°C, Vcc = 3.3 V
  }
  temperatura = sumaTemp / MUESTRAS_LM35;

  // Determinar nivel de alerta y controlar actuadores
  if (temperatura < 25.0f) {
    estadoTermico = "OK";
    setRele(false);

  } else if (temperatura < 27.0f) {
    estadoTermico = "PRECAUCION_TEMPRANA";
    setRele(false); // ventilacion aun apagada en precaucion temprana

  } else if (temperatura < 29.0f) {
    estadoTermico = "PRECAUCION_ACTIVA";
    setRele(true);

  } else {
    estadoTermico = "CRITICO";
    setRele(true);
  }

  // Imprimir estado por Serial en formato JSON para depuracion
  Serial.printf("{\"temperatura\": %.1f, \"estado\": \"%s\", "
                "\"incidente\": \"%s\", \"accion\": \"%s\"}\n",
                temperatura,
                estadoTermico.c_str(),
                estadoTermico == "OK"                  ? "NINGUNO"             :
                estadoTermico == "PRECAUCION_TEMPRANA"  ? "TEMP_ELEVADA"        :
                estadoTermico == "PRECAUCION_ACTIVA"    ? "SATURACION_TERMICA"  :
                                                          "FALLA_TERMICA_SRV",
                estadoTermico == "OK"                  ? "Ninguna"              :
                estadoTermico == "PRECAUCION_TEMPRANA"  ? "Monitoreo"           :
                estadoTermico == "PRECAUCION_ACTIVA"    ? "Mitigacion preventiva":
                                                          "RECUPERACION_ACTIVA");

  // Re-aplicar LEDs con el nuevo estado termico
  leds(estadoBackend.c_str());
}

// =============================================================
//  SECCION 4 – SERVIDOR WEB LOCAL (puerto 80)
// =============================================================
void handleRoot() {
  String html = F("<!DOCTYPE html><html lang='es'><head>"
    "<meta charset='UTF-8'>"
    "<meta name='viewport' content='width=device-width,initial-scale=1.0'>"
    "<meta http-equiv='refresh' content='3'>"
    "<title>ByteMe · Panel Hibrido</title>"
    "<style>"
    "body{font-family:sans-serif;background:#1e1e2e;color:#cdd6f4;"
          "text-align:center;padding:20px;margin:0}"
    ".card{background:#313244;max-width:420px;margin:16px auto;"
           "padding:20px;border-radius:12px;text-align:left;"
           "box-shadow:0 4px 12px rgba(0,0,0,.5)}"
    "h2{color:#89b4fa;border-bottom:1px solid #45475a;padding-bottom:6px;margin-top:0}"
    "p{font-size:17px;margin:8px 0;display:flex;justify-content:space-between}"
    ".v{font-weight:700}.ok{color:#a6e3a1}.warn{color:#f9e2af}.crit{color:#f38ba8}"
    "</style></head><body>");

  // Tarjeta: Monitor Termico
  html += F("<div class='card'><h2>Monitor Termico Local</h2>");
  html += "<p>Temperatura: <span class='v'>" + String(temperatura, 1) + " &deg;C</span></p>";

  if      (estadoTermico == "OK")                  html += F("<p>Estado: <span class='v ok'>Normal</span></p>");
  else if (estadoTermico == "PRECAUCION_TEMPRANA")  html += F("<p>Estado: <span class='v warn'>Precaucion Temprana</span></p>");
  else if (estadoTermico == "PRECAUCION_ACTIVA")    html += F("<p>Estado: <span class='v warn'>Precaucion Activa</span></p>");
  else                                              html += F("<p>Estado: <span class='v crit'>CRITICO</span></p>");

  html += "<p>Ventilacion (rele): <span class='v'>" +
          String(releEncendido ? "ENCENDIDO" : "APAGADO") + "</span></p>";
  html += F("</div>");

  // Tarjeta: Simulacion Punto de Venta
  float ramPct = 55.0f + 40.0f * min(1.0f,
    (float)max(0, (int)(heapInicial - ESP.getFreeHeap())) /
    (float)(MAX_BLOQUES * BLOQUE_BYTES));
  html += F("<div class='card'><h2>Simulacion Punto de Venta</h2>");
  html += "<p>Fuga de memoria: <span class='v'>" +
          String(fugaActiva ? "ACTIVA" : "APAGADA") + "</span></p>";
  html += "<p>RAM simulada: <span class='v'>" + String(ramPct, 1) + " %</span></p>";
  html += "<p>Orden API central: <span class='v'>" + estadoBackend + "</span></p>";
  html += F("</div>");

  html += F("<p style='color:#585b70;font-size:13px'>Auto-refresco cada 3 s</p>");
  html += F("</body></html>");

  server.send(200, "text/html", html);
}

// =============================================================
//  SECCION 5 – SIMULACION DE FUGA DE MEMORIA
// =============================================================
void avanzarFuga() {
  if (fugaActiva && nBloques < MAX_BLOQUES &&
      ESP.getFreeHeap() > HEAP_MINIMO + BLOQUE_BYTES) {
    bloques[nBloques] = malloc(BLOQUE_BYTES);
    if (bloques[nBloques]) {
      memset(bloques[nBloques], 0xA5, BLOQUE_BYTES);
      nBloques++;
    }
  }
}

void liberarFuga() {
  for (int i = 0; i < nBloques; i++) free(bloques[i]);
  nBloques   = 0;
  fugaActiva = false;
}

float ramEscalada() {
  float usada = heapInicial > ESP.getFreeHeap()
                ? (float)(heapInicial - ESP.getFreeHeap()) : 0;
  float tope  = (float)(MAX_BLOQUES * BLOQUE_BYTES);
  return 55.0f + 40.0f * min(1.0f, usada / tope);
}

// Detecta el flanco de bajada del boton FLASH (GPIO0)
void revisarBoton() {
  static bool antes = HIGH;
  bool ahora = digitalRead(pinLedRojo); // GPIO0 = D3 = FLASH button
  if (antes == HIGH && ahora == LOW) {
    fugaActiva = !fugaActiva;
    if (!fugaActiva) liberarFuga();
    Serial.printf("[demo] Fuga de memoria %s\n",
                  fugaActiva ? "ACTIVADA" : "liberada");
  }
  antes = ahora;
}

// =============================================================
//  SECCION 6 – TELEMETRIA AL BACKEND
// =============================================================
void enviarTelemetria() {
  if (WiFi.status() != WL_CONNECTED) {
    erroresCiclo++;
    leds("ambar");
    return;
  }

  JsonDocument doc;
  doc["placa"]          = PLACA_ID;
  doc["ip"]             = WiFi.localIP().toString();
  doc["cpu"]            = min(100.0f, trabajoLazoUs / (PERIODO_TELEMETRIA_MS * 10.0f));
  doc["ram"]            = ramEscalada();
  doc["disco"]          = 100.0f * ESP.getSketchSize() /
                          (ESP.getSketchSize() + ESP.getFreeSketchSpace());
  doc["latencia_ms"]    = ultimaLatencia;
  doc["errores"]        = erroresCiclo;
  doc["heap_libre"]     = ESP.getFreeHeap();
  doc["temperatura"]    = round(temperatura * 10) / 10.0;
  doc["estado_termico"] = estadoTermico;
  doc["rele"]           = releEncendido;

  String cuerpo;
  serializeJson(doc, cuerpo);

  WiFiClient cliente;
  HTTPClient http;
  http.setTimeout(3000);
  http.begin(cliente, String(SERVIDOR) + "/api/nodemcu/telemetria");
  http.addHeader("Content-Type", "application/json");

  unsigned long t0 = millis();
  int codigo = http.POST(cuerpo);
  ultimaLatencia = (float)(millis() - t0);

  if (codigo == 200) {
    erroresCiclo = 0;
    JsonDocument resp;
    if (!deserializeJson(resp, http.getString())) {
      const char* estado = resp["estado"] | "verde";
      leds(estado);
      if (resp["aviso"] | false) pitar(3);
      Serial.printf("[gramo] riesgo %d -> %s | RAM %.0f%% | lat %.0f ms\n",
                    resp["riesgo"] | 0, estado, ramEscalada(), ultimaLatencia);
    }
  } else {
    erroresCiclo++;
    Serial.printf("[gramo] Envio fallido (codigo %d: %s)\n",
                  codigo, http.errorToString(codigo).c_str());
  }
  http.end();
}

// =============================================================
//  SECCION 7 – SETUP
// =============================================================
void setup() {
  Serial.begin(115200);
  Serial.println("\n==============================================");
  Serial.println(" SecureGuard - gramo  (NodeMCU ESP8266)");
  Serial.println(" Reto Zikit 'Antes de que suene el telefono'");
  Serial.println("==============================================");

  // Inicializar pines de salida
  pinMode(pinLedVerde,    OUTPUT);
  pinMode(pinLedAmarillo, OUTPUT);
  pinMode(pinLedRojo,     OUTPUT);
  pinMode(pinBuzzer,      OUTPUT);
  pinMode(pinRelay,       OUTPUT);

  // Estado inicial seguro
  setRele(false);      // ventilacion apagada
  setBuzzer(false);    // silencio
  estadoSemaforo(HIGH, LOW, LOW); // inicia en verde

  // Conectar a WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.printf("Conectando a \"%s\"", WIFI_SSID);
  // Durante la conexion usa los LEDs como indicador
  estadoSemaforo(LOW, HIGH, LOW); // ambar = conectando
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\nConectado. IP local:  %s\n", WiFi.localIP().toString().c_str());
  Serial.printf("IP gateway:           %s\n",   WiFi.gatewayIP().toString().c_str());
  Serial.printf("Servidor telemetria:  %s\n",   SERVIDOR);
  Serial.println("Servidor web local:   http://" + WiFi.localIP().toString());

  heapInicial = ESP.getFreeHeap();
  estadoSemaforo(HIGH, LOW, LOW); // verde = listo

  // Arrancar servidor web
  server.on("/", handleRoot);
  server.begin();
  Serial.println("Servidor web listo en el puerto 80.");
}

// =============================================================
//  SECCION 8 – LOOP PRINCIPAL
// =============================================================
void loop() {
  unsigned long t0 = micros();

  // Tareas rapidas en cada iteracion
  server.handleClient();
  manejarBuzzer();

  // Lectura termica cada REFRESCO_TERMICO_MS (no bloqueante)
  static unsigned long ultimoRefrescoTermico = 0;
  if (millis() - ultimoRefrescoTermico >= REFRESCO_TERMICO_MS) {
    ultimoRefrescoTermico = millis();
    actualizarTermico();
  }

  trabajoLazoUs += micros() - t0;

  // Telemetria al backend cada PERIODO_TELEMETRIA_MS
  if (millis() - ultimoEnvio >= PERIODO_TELEMETRIA_MS) {
    ultimoEnvio = millis();
    avanzarFuga();
    enviarTelemetria();
    trabajoLazoUs = 0;
  }

  delay(10);
}