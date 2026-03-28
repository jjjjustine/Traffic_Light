/*
 * ============================================================
 *  IoT Smart Traffic Light System
 *  Hardware: ESP32
 *  Cloud:    Supabase (REST API over HTTPS)
 *  Author:   Generated for Smart Traffic Demo
 * ============================================================
 *
 *  PIN CONFIGURATION
 *  -----------------
 *  Red    LED  →  GPIO 25
 *  Yellow LED  →  GPIO 26
 *  Green  LED  →  GPIO 27
 *
 *  REQUIRED LIBRARIES (install via Arduino Library Manager)
 *  ---------------------------------------------------------
 *  - WiFi          (built-in ESP32)
 *  - HTTPClient    (built-in ESP32)
 *  - ArduinoJson   (Benoit Blanchon) v6.x
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ─── USER CONFIGURATION ──────────────────────────────────────
const char* WIFI_SSID     = "AYAW CONNECT, MA HACK KA!";
const char* WIFI_PASSWORD = "CAT1NG4N02060820";

// Supabase project settings
const char* SUPABASE_URL  = "https://xpgfddrfhnougwnggrgk.supabase.co";
const char* SUPABASE_KEY  = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwZ2ZkZHJmaG5vdWd3bmdncmdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNTkyMTEsImV4cCI6MjA4OTYzNTIxMX0.LAuDx_ZFg_ECrI3ydKqzJ0Pksi-Dqe-G0xo8yPXuIn0";

// Supabase table row ID used for control (must exist after SQL setup)
const int   CONTROL_ROW_ID = 1;
// ─────────────────────────────────────────────────────────────

// LED Pins
#define PIN_RED    18
#define PIN_YELLOW 19
#define PIN_GREEN  21

// Auto-mode durations (milliseconds)
#define DUR_GREEN  60000UL
#define DUR_YELLOW  5000UL
#define DUR_RED    30000UL

// How often to poll Supabase in manual mode (ms)
#define POLL_INTERVAL_MS 1500

// ─── GLOBAL STATE ────────────────────────────────────────────
String  currentMode   = "AUTO";   // "AUTO" | "MANUAL"
String  currentLight  = "GREEN";  // "RED"  | "YELLOW" | "GREEN"
unsigned long phaseStart    = 0;
unsigned long phaseDuration = 0;
unsigned long lastPollTime  = 0;

// ─── FORWARD DECLARATIONS ────────────────────────────────────
void connectWiFi();
void setLight(const String& color);
void allOff();
void autoLoop();
void manualLoop();
bool fetchControlRow(String& outMode, String& outManual);
void postLog(const String& status, const String& mode, int duration);
String buildAuthHeaders(HTTPClient& http);

// ─────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(PIN_RED,    OUTPUT);
  pinMode(PIN_YELLOW, OUTPUT);
  pinMode(PIN_GREEN,  OUTPUT);
  allOff();

  connectWiFi();

  // Start in GREEN for auto mode
  setLight("GREEN");
  phaseStart    = millis();
  phaseDuration = DUR_GREEN;
  postLog("GREEN", "AUTO", DUR_GREEN / 1000);

  Serial.println("[BOOT] Traffic Light System Ready");
}

// ─────────────────────────────────────────────────────────────
void loop() {
  // Periodically check mode from Supabase
  unsigned long now = millis();
  if (now - lastPollTime >= POLL_INTERVAL_MS) {
    lastPollTime = now;

    String fetchedMode, fetchedManual;
    if (fetchControlRow(fetchedMode, fetchedManual)) {
      currentMode = fetchedMode;
      if (currentMode == "MANUAL") {
        // If light changed, update hardware
        if (fetchedManual != currentLight) {
          currentLight = fetchedManual;
          setLight(currentLight);
          postLog(currentLight, "MANUAL", 0);
        }
      }
    }
  }

  if (currentMode == "AUTO") {
    autoLoop();
  }
  // In MANUAL mode, hardware state is set during poll above
}

// ─── AUTO MODE ───────────────────────────────────────────────
void autoLoop() {
  unsigned long elapsed = millis() - phaseStart;

  if (elapsed >= phaseDuration) {
    // Advance to next phase
    if (currentLight == "GREEN") {
      currentLight  = "YELLOW";
      phaseDuration = DUR_YELLOW;
    } else if (currentLight == "YELLOW") {
      currentLight  = "RED";
      phaseDuration = DUR_RED;
    } else {
      currentLight  = "GREEN";
      phaseDuration = DUR_GREEN;
    }

    phaseStart = millis();
    setLight(currentLight);
    postLog(currentLight, "AUTO", (int)(phaseDuration / 1000));

    Serial.print("[AUTO] Phase → ");
    Serial.print(currentLight);
    Serial.print("  (");
    Serial.print(phaseDuration / 1000);
    Serial.println("s)");
  }
}

// ─── HARDWARE CONTROL ────────────────────────────────────────
void allOff() {
  digitalWrite(PIN_RED,    LOW);
  digitalWrite(PIN_YELLOW, LOW);
  digitalWrite(PIN_GREEN,  LOW);
}

void setLight(const String& color) {
  allOff();
  if      (color == "RED")    digitalWrite(PIN_RED,    HIGH);
  else if (color == "YELLOW") digitalWrite(PIN_YELLOW, HIGH);
  else if (color == "GREEN")  digitalWrite(PIN_GREEN,  HIGH);
  currentLight = color;
}

// ─── WIFI ────────────────────────────────────────────────────
void connectWiFi() {
  Serial.print("[WiFi] Connecting to ");
  Serial.println(WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int retries = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (++retries > 40) {
      Serial.println("\n[WiFi] FAILED – restarting");
      ESP.restart();
    }
  }
  Serial.print("\n[WiFi] Connected → IP: ");
  Serial.println(WiFi.localIP());
}

// ─── SUPABASE: FETCH CONTROL ROW ─────────────────────────────
//  GET /rest/v1/traffic_control?id=eq.1&select=mode,manual_status
bool fetchControlRow(String& outMode, String& outManual) {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
    return false;
  }

  HTTPClient http;
  String url = String(SUPABASE_URL)
             + "/rest/v1/traffic_control?id=eq."
             + String(CONTROL_ROW_ID)
             + "&select=mode,manual_status";

  http.begin(url);
  http.addHeader("apikey",        SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Content-Type",  "application/json");

  int code = http.GET();
  if (code != 200) {
    Serial.print("[Supabase] GET failed, HTTP ");
    Serial.println(code);
    http.end();
    return false;
  }

  String payload = http.getString();
  http.end();

  // Response is a JSON array: [{"mode":"AUTO","manual_status":"GREEN"}]
  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, payload);
  if (err || !doc.is<JsonArray>() || doc.as<JsonArray>().size() == 0) {
    Serial.println("[Supabase] Parse error or empty result");
    return false;
  }

  outMode   = doc[0]["mode"].as<String>();
  outManual = doc[0]["manual_status"].as<String>();
  return true;
}

// ─── SUPABASE: POST LOG ───────────────────────────────────────
//  POST /rest/v1/traffic_logs
void postLog(const String& status, const String& mode, int duration) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String(SUPABASE_URL) + "/rest/v1/traffic_logs";

  http.begin(url);
  http.addHeader("apikey",        SUPABASE_KEY);
  http.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
  http.addHeader("Content-Type",  "application/json");
  http.addHeader("Prefer",        "return=minimal");

  StaticJsonDocument<128> doc;
  doc["status"]   = status;
  doc["mode"]     = mode;
  doc["duration"] = duration;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  if (code != 201 && code != 200) {
    Serial.print("[Supabase] POST log failed, HTTP ");
    Serial.println(code);
  } else {
    Serial.print("[Supabase] Log posted: ");
    Serial.print(status);
    Serial.print(" / ");
    Serial.println(mode);
  }
  http.end();
}
