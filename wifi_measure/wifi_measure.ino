#include <WiFi.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Preferences.h>
#include <time.h>
#include <WiFiClientSecure.h>
#include <mDNS.h>
#include <DNSServer.h>
#include "mbedtls/base64.h"

// --- Pin Definitions (Xiao ESP32C6) ---
// const int BATTERY_PIN    = A0;
// const int NPN_PIN        = D1;
// const int SENSOR_RX_PIN  = D2;
// const int SENSOR_TX_PIN  = D3;
// const int RESET_PIN_1    = D7;
// const int RESET_PIN_2    = D8;
// const int LED_PIN = LED_BUILTIN;
// const bool HAS_ANT = true;
// const int ANT_POWER_PIN  = 3;  // Powers the RF antenna switch
// const int ANT_SELECT_PIN = 14; // HIGH = External Antenna, LOW = Internal Antenna

// --- Pin Definitions (ESP32D) ---
// const int BATTERY_PIN    = 4;
// const int NPN_PIN        = 16;
// const int SENSOR_RX_PIN  = 17;
// const int SENSOR_TX_PIN  = 5;
// const int RESET_PIN_1    = 22;
// const int RESET_PIN_2    = 23;
// const int LED_PIN = 2;
// const bool HAS_ANT = false;
// const int ANT_POWER_PIN  = 3;  // Powers the RF antenna switch
// const int ANT_SELECT_PIN = 14; // HIGH = External Antenna, LOW = Internal Antenna

// --- Pin Definitions (ESP32 S3 CAM) ---
const int BATTERY_PIN    = 4;
const int NPN_PIN        = 5;
const int SENSOR_RX_PIN  = 6;
const int SENSOR_TX_PIN  = 7;
const int RESET_PIN_1    = 12;
const int RESET_PIN_2    = 13;
const int LED_PIN = 2;
const bool HAS_ANT = false;
const int ANT_POWER_PIN  = 3;  // Powers the RF antenna switch
const int ANT_SELECT_PIN = 14; // HIGH = External Antenna, LOW = Internal Antenna

Preferences preferences;
WebServer server(80);
DNSServer dnsServer;

bool configured          = false;
String wifiSsid          = "";
String wifiPass          = "";
String aioUser           = "";
String aioKey            = "";
int intervalMinutes      = 60;
int quietStartHour       = 20;
int quietEndHour         = 8;
bool useExternalAntenna  = false;

uint64_t calculatedSleepSeconds = 3600;

const long gmtOffset_sec = 3600;
const int daylightOffset_sec = 3600;
const char* AP_SSID = "ESP-Watersensor";
const char* AP_PASS = "12345678";

bool checkPinsBridged(int outPin, int inPin) {
  pinMode(outPin, OUTPUT);
  pinMode(inPin, INPUT_PULLUP);
  digitalWrite(outPin, LOW);
  delay(5);
  int readingLow = digitalRead(inPin);
  digitalWrite(outPin, HIGH);
  delay(5);
  int readingHigh = digitalRead(inPin);
  pinMode(outPin, INPUT);
  pinMode(inPin, INPUT);
  return (readingLow == LOW && readingHigh == HIGH);
}

String collectSensorReadings() {
  int readings[3];
  int validCount = 0;
  int attempts = 0;

  Serial.println("Polling sensor for readings...");
  while (validCount < 3 && attempts < 10) {
    attempts++;
    digitalWrite(SENSOR_RX_PIN, LOW);
    delayMicroseconds(2);
    digitalWrite(SENSOR_RX_PIN, HIGH);
    delayMicroseconds(10);
    digitalWrite(SENSOR_RX_PIN, LOW);
    unsigned long duration = pulseIn(SENSOR_TX_PIN, HIGH, 250000);
    if (duration > 0) {
      int dist = (duration * 0.0343) / 2;
      if (dist > 0 && dist <= 600) {
        readings[validCount] = dist;
        validCount++;
        Serial.print("Got valid reading: "); Serial.println(dist);
      }
    }
  }

  if (validCount == 0) {
    Serial.println("Sensor warning: No valid readings captured!");
    return "0";
  }

  for (int i = 0; i < validCount - 1; i++) {
    for (int j = 0; j < validCount - i - 1; j++) {
      if (readings[j] > readings[j + 1]) {
        int temp = readings[j];
        readings[j] = readings[j + 1];
        readings[j + 1] = temp;
      }
    }
  }
  return String(readings[validCount / 2]);
}

void calculateNextSleepDuration(time_t currentTime) {
  struct tm timeinfo;
  localtime_r(&currentTime, &timeinfo);

  calculatedSleepSeconds = (uint64_t)intervalMinutes * 60;

  if (timeinfo.tm_year > (2025 - 1900)) {
    int currentHour = timeinfo.tm_hour;
    int currentMin = timeinfo.tm_min;
    int currentSec = timeinfo.tm_sec;
    bool isQuietTime = false;

    if (quietStartHour > quietEndHour) {
      if (currentHour >= quietStartHour || currentHour < quietEndHour) isQuietTime = true;
    } else {
      if (currentHour >= quietStartHour && currentHour < quietEndHour) isQuietTime = true;
    }

    if (isQuietTime) {
      int hoursRemaining = (quietEndHour - currentHour + 24) % 24;
      if (hoursRemaining == 0) hoursRemaining = 24;
      calculatedSleepSeconds = (hoursRemaining * 3600) - (currentMin * 60) - currentSec;
      Serial.print("Quiet hours active. Sleeping until "); Serial.print(quietEndHour); Serial.println(":00");
    } else {
      // Calculate sleep to next interval boundary
      // If interval is 60 min and current time is 12:35:45, sleep until 13:00:00
      int totalMinutes = currentHour * 60 + currentMin;
      int minsIntoInterval = totalMinutes % intervalMinutes;
      int minsToNextBoundary = (minsIntoInterval == 0) ? intervalMinutes : (intervalMinutes - minsIntoInterval);

      calculatedSleepSeconds = (minsToNextBoundary * 60) - currentSec;
      if (calculatedSleepSeconds <= 0) {
        calculatedSleepSeconds = intervalMinutes * 60;
      }

      Serial.print("Normal mode. Next interval boundary in ");
      Serial.print(calculatedSleepSeconds);
      Serial.println(" seconds");
    }
  } else {
    Serial.println("Time not synced, using default interval");
  }
}

String getProvisioningPage(String wifiList) {
  return R"(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ESP Watersensor Setup</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .container { background: white; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.3); padding: 30px; max-width: 500px; width: 100%; }
    h1 { color: #333; margin-bottom: 10px; font-size: 24px; }
    .subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
    .form-group { margin-bottom: 20px; }
    label { display: block; margin-bottom: 8px; color: #333; font-weight: 500; font-size: 14px; }
    input, select { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; }
    input:focus, select:focus { outline: none; border-color: #667eea; box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1); }
    .checkbox-group { display: flex; align-items: center; gap: 8px; }
    input[type="checkbox"] { width: auto; }
    button { width: 100%; padding: 12px; background: #667eea; color: white; border: none; border-radius: 5px; font-weight: 600; cursor: pointer; font-size: 16px; }
    button:hover { background: #5568d3; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    .status { margin-top: 20px; padding: 12px; border-radius: 5px; text-align: center; display: none; }
    .status.success { background: #d4edda; color: #155724; }
    .status.error { background: #f8d7da; color: #721c24; }
    .wifi-list { margin-top: 10px; max-height: 150px; overflow-y: auto; border: 1px solid #ddd; border-radius: 5px; }
    .wifi-item { padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #eee; }
    .wifi-item:hover { background: #f5f5f5; }
  </style>
</head>
<body>
  <div class="container">
    <h1>💧 Watersensor Setup</h1>
    <p class="subtitle">Configure WiFi and sensor settings</p>
    <form id="provForm">
      <div class="form-group">
        <label>Select WiFi Network</label>
        <input type="text" id="ssid" placeholder="WiFi SSID" required>
        <div class="wifi-list" id="wifiList"></div>
      </div>
      <div class="form-group">
        <label>WiFi Password</label>
        <input type="password" id="pass" placeholder="WiFi Password" required>
      </div>
      <div class="form-group">
        <label>Upload Endpoint URL</label>
        <input type="text" id="worker" placeholder="https://your-api.example.com/api/upload" required>
      </div>
      <div class="form-group">
        <label>API Token/Secret</label>
        <input type="password" id="token" placeholder="Your API token" required>
      </div>
      <div class="form-group">
        <label>Interval (minutes)</label>
        <input type="number" id="interval" min="5" max="1440" value="60" required>
      </div>
      <div class="form-group">
        <label>Quiet Hours Start (0-23)</label>
        <input type="number" id="qStart" min="0" max="23" value="20" required>
      </div>
      <div class="form-group">
        <label>Quiet Hours End (0-23)</label>
        <input type="number" id="qEnd" min="0" max="23" value="8" required>
      </div>
      <div class="form-group checkbox-group">
        <input type="checkbox" id="extAnt">
        <label for="extAnt" style="margin-bottom: 0;">Use External Antenna</label>
      </div>
      <button type="submit" id="submitBtn">Save & Reboot</button>
      <div class="status" id="status"></div>
    </form>
  </div>
  <script>
    const wifiListHTML = `)" + wifiList + R"(`;
    const wifiList = document.getElementById('wifiList');
    if (wifiListHTML !== '' && wifiListHTML !== 'NO_NETWORKS_FOUND') {
      const networks = wifiListHTML.split(';').filter(n => n.length > 0);
      networks.forEach(network => {
        const [ssid, rssi] = network.split(',');
        const item = document.createElement('div');
        item.className = 'wifi-item';
        item.textContent = ssid + ' (' + rssi + ' dBm)';
        item.onclick = () => document.getElementById('ssid').value = ssid;
        wifiList.appendChild(item);
      });
    }
    document.getElementById('provForm').onsubmit = async (e) => {
      e.preventDefault();
      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      const data = 'SET_CONFIG:' +
        btoa(document.getElementById('ssid').value) + ',' +
        btoa(document.getElementById('pass').value) + ',' +
        document.getElementById('worker').value + ',' +
        document.getElementById('token').value + ',' +
        document.getElementById('interval').value + ',' +
        document.getElementById('qStart').value + ',' +
        document.getElementById('qEnd').value + ',' +
        (document.getElementById('extAnt').checked ? '1' : '0');
      try {
        const res = await fetch('/api/config', { method: 'POST', body: data });
        if (res.ok) {
          document.getElementById('status').className = 'status success';
          document.getElementById('status').textContent = 'Configuration saved! Device rebooting...';
          document.getElementById('status').style.display = 'block';
          setTimeout(() => location.href = 'about:blank', 3000);
        }
      } catch (e) {
        document.getElementById('status').className = 'status error';
        document.getElementById('status').textContent = 'Error: ' + e.message;
        document.getElementById('status').style.display = 'block';
        btn.disabled = false;
      }
    };
  </script>
</body>
</html>
  )";
}

void handleRoot() {
  Serial.println("GET / - Serving provisioning page");
  String wifiList = "";

  WiFi.mode(WIFI_AP_STA);
  int n = WiFi.scanNetworks();

  for (int i = 0; i < n; ++i) {
    String ssid = WiFi.SSID(i);
    int rssi = WiFi.RSSI(i);
    if (ssid.length() > 0) {
      bool alreadyExists = false;
      for (int j = 0; j < i; j++) {
        if (WiFi.SSID(j) == ssid) {
          alreadyExists = true;
          break;
        }
      }
      if (!alreadyExists) {
        if (wifiList.length() > 0) wifiList += ";";
        wifiList += ssid + "," + String(rssi);
      }
    }
  }

  if (wifiList.length() == 0) wifiList = "NO_NETWORKS_FOUND";

  server.send(200, "text/html", getProvisioningPage(wifiList));
}

void handleConfig() {
  if (server.method() != HTTP_POST) {
    server.send(405, "text/plain", "Method Not Allowed");
    return;
  }

  String body = server.arg("plain");
  Serial.print("POST /api/config: ");
  Serial.println(body);

  if (!body.startsWith("SET_CONFIG:")) {
    server.send(400, "text/plain", "Invalid format");
    return;
  }

  String data = body.substring(11);

  int idx0 = 0;
  int idx1 = data.indexOf(',', idx0);
  int idx2 = data.indexOf(',', idx1 + 1);
  int idx3 = data.indexOf(',', idx2 + 1);
  int idx4 = data.indexOf(',', idx3 + 1);
  int idx5 = data.indexOf(',', idx4 + 1);
  int idx6 = data.indexOf(',', idx5 + 1);
  int idx7 = data.lastIndexOf(',');

  if (idx1 <= 0 || idx2 <= 0 || idx3 <= 0 || idx4 <= 0 || idx5 <= 0 || idx6 <= 0 || idx7 <= 0) {
    server.send(400, "text/plain", "Malformed payload");
    return;
  }

  String encodedSsid = data.substring(idx0, idx1);
  String encodedPass = data.substring(idx1 + 1, idx2);
  String sSsid = "";
  String sPass = "";

  // Decode base64
  size_t maxLen = encodedSsid.length();
  unsigned char *buf = new unsigned char[maxLen];
  size_t outLen = 0;
  if (mbedtls_base64_decode(buf, maxLen, &outLen, (unsigned char*)encodedSsid.c_str(), maxLen) == 0) {
    for (size_t i = 0; i < outLen; i++) {
      sSsid += (char)buf[i];
    }
  }
  delete[] buf;

  maxLen = encodedPass.length();
  buf = new unsigned char[maxLen];
  outLen = 0;
  if (mbedtls_base64_decode(buf, maxLen, &outLen, (unsigned char*)encodedPass.c_str(), maxLen) == 0) {
    for (size_t i = 0; i < outLen; i++) {
      sPass += (char)buf[i];
    }
  }
  delete[] buf;

  String sWorker = data.substring(idx2 + 1, idx3);
  String sToken = data.substring(idx3 + 1, idx4);
  int sInterval = data.substring(idx4 + 1, idx5).toInt();
  int sQStart = data.substring(idx5 + 1, idx6).toInt();
  int sQEnd = data.substring(idx6 + 1, idx7).toInt();
  bool sExtAnt = data.substring(idx7 + 1).toInt() == 1;

  preferences.begin("settings", false);
  preferences.putString("ssid", sSsid);
  preferences.putString("pass", sPass);
  preferences.putString("worker", sWorker);
  preferences.putString("token", sToken);
  preferences.putInt("interval", sInterval);
  preferences.putInt("qStart", sQStart);
  preferences.putInt("qEnd", sQEnd);
  preferences.putBool("extAnt", sExtAnt);
  preferences.putBool("configured", true);
  preferences.end();

  Serial.println("Configuration saved! Rebooting...");
  server.send(200, "text/plain", "OK");
  delay(500);
  ESP.restart();
}

void setup() {
  Serial.begin(9600);
  delay(1000);

  if (checkPinsBridged(RESET_PIN_1, RESET_PIN_2) || checkPinsBridged(RESET_PIN_2, RESET_PIN_1)) {
    Serial.println("\n[!] FACTORY RESET: D7 and D8 bridge detected! Wiping settings...");
    preferences.begin("settings", false);
    preferences.clear();
    preferences.end();
    Serial.println("Memory cleared. Blinking LED and waiting for reset...");
    pinMode(LED_PIN, OUTPUT);
    while (true) {
      digitalWrite(LED_PIN, HIGH);
      delay(1000);
      digitalWrite(LED_PIN, LOW);
      delay(1000);
    }
  }

  preferences.begin("settings", true);
  configured = preferences.getBool("configured", false);
  wifiSsid = preferences.getString("ssid", "");
  wifiPass = preferences.getString("pass", "");
  aioUser = preferences.getString("worker", "");
  aioKey = preferences.getString("token", "");
  intervalMinutes = preferences.getInt("interval", 60);
  quietStartHour = preferences.getInt("qStart", 20);
  quietEndHour = preferences.getInt("qEnd", 8);
  useExternalAntenna = preferences.getBool("extAnt", false);
  preferences.end();

  if (HAS_ANT) {
    pinMode(ANT_POWER_PIN, OUTPUT);
    digitalWrite(ANT_POWER_PIN, LOW);
    delay(50);
    pinMode(ANT_SELECT_PIN, OUTPUT);
    if (useExternalAntenna) {
      digitalWrite(ANT_SELECT_PIN, HIGH);
      Serial.println("Active Antenna: External (U.FL)");
    } else {
      digitalWrite(ANT_SELECT_PIN, LOW);
      Serial.println("Active Antenna: Internal Ceramic");
    }
  }

  // ========================================================
  // 1. UNCONFIGURED STATE: RUN AP PROVISIONING MODE
  // ========================================================
  if (!configured || wifiSsid.length() == 0) {
    Serial.println("\n--- UNCONFIGURED: STARTING AP PROVISIONING ---");

    WiFi.mode(WIFI_AP);
    WiFi.softAP(AP_SSID, AP_PASS);
    IPAddress apIP(192, 168, 4, 1);
    WiFi.softAPConfig(apIP, apIP, IPAddress(255, 255, 255, 0));

    Serial.print("AP SSID: "); Serial.println(AP_SSID);
    Serial.print("AP IP: "); Serial.println(WiFi.softAPIP());

    // Start mDNS
    if (mdns_init() == ESP_OK) {
      mdns_hostname_set("esp-watersensor");
      mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
      Serial.println("mDNS started: esp-watersensor.local");
    }

    // Setup Captive Portal DNS - redirect all DNS requests to this device
    dnsServer.start(53, "*", apIP);  // Catch all DNS requests and redirect to AP IP

    server.on("/", handleRoot);
    server.on("/api/config", handleConfig);
    server.onNotFound(handleRoot);  // Redirect unknown paths to provisioning page
    server.begin();

    Serial.println("Captive Portal started!");
    Serial.println("Connect to WiFi: " + String(AP_SSID));
    Serial.println("Your phone should prompt to sign in - tap it to open provisioning page");
    Serial.println("Or manually navigate to http://192.168.4.1 or http://esp-watersensor.local");

    while (true) {
      dnsServer.processNextRequest();  // Handle DNS requests for captive portal
      server.handleClient();
      delay(10);
    }
  }

  // ========================================================
  // 2. NORMAL OPERATION MODE
  // ========================================================
  Serial.println("\n--- Waking up for sensor & upload cycle ---");

  // Power up sensor
  Serial.println("Turning on sensor power...");
  pinMode(NPN_PIN, OUTPUT);
  digitalWrite(NPN_PIN, HIGH);
  delay(1000);

  // Read Battery Voltage
  pinMode(BATTERY_PIN, INPUT);
  int adcMilliVolts = analogReadMilliVolts(BATTERY_PIN);
  float batteryVoltage = (adcMilliVolts * 2.0) / 1000.0;

  // Read Distance Sensor
  pinMode(SENSOR_RX_PIN, OUTPUT);
  pinMode(SENSOR_TX_PIN, INPUT);
  int distanceCm = collectSensorReadings().toInt();

  // Power down sensor
  Serial.println("Shutting down sensor power...");
  digitalWrite(NPN_PIN, LOW);

  // OPTIMIZATION: Disconnect digital input buffers so unpowered pins don't float and leak battery
  pinMode(SENSOR_TX_PIN, ANALOG);
  pinMode(BATTERY_PIN, ANALOG);

  Serial.print("Final Measurement -> Distance: "); Serial.print(distanceCm); Serial.print(" cm | ");
  Serial.print("Voltage: "); Serial.print(batteryVoltage, 2); Serial.println("V");

  Serial.print("Connecting to Wi-Fi: "); Serial.println(wifiSsid);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 12000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi Connected! Syncing time via NTP...");
    configTime(gmtOffset_sec, daylightOffset_sec, "pool.ntp.org", "time.nist.gov");

    // Wait for time to sync
    time_t now = time(nullptr);
    int syncAttempts = 0;
    while (localtime(&now)->tm_year < (2025 - 1900) && syncAttempts < 20) {
      delay(500);
      now = time(nullptr);
      syncAttempts++;
    }

    Serial.println("Uploading data...");

    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient http;
    http.setTimeout(15000);

    // --- NEW: Robust HTTPS Configuration ---
    http.begin(client, aioUser);
    http.addHeader("X-Sensor-Token", aioKey);
    http.addHeader("Content-Type", "application/json");

    // Cloudflare Bot-Protection Bypass
    http.addHeader("User-Agent", "Mozilla/5.0 (ESP32 IoT Sensor)");
    // ---------------------------------------

    String payload = "{\"distance\":" + String(distanceCm) + ", \"battery\":" + String(batteryVoltage, 2) + "}";
    int httpResponseCode = http.POST(payload);

    if (httpResponseCode > 0) {
      Serial.print("Upload successful! HTTP Response code: ");
      Serial.println(httpResponseCode);
    } else {
      Serial.print("Upload failed, error code: ");
      Serial.println(httpResponseCode);
    }
    http.end();

    // OPTIMIZATION: Immediately sever Wi-Fi and Radio connections
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);

    // Calculate sleep duration based on synced time
    now = time(nullptr);
    calculateNextSleepDuration(now);
  } else {
    Serial.println("ERROR: Wi-Fi connection failed or timed out.");
    WiFi.mode(WIFI_OFF);
    calculateNextSleepDuration(time(nullptr));
  }

  // --- ANTENNA SWITCH OPTIMIZATION: Kill power to prevent deep sleep leakage ---
  if (HAS_ANT) {
    digitalWrite(ANT_SELECT_PIN, LOW);
    digitalWrite(ANT_POWER_PIN, LOW);
    pinMode(ANT_SELECT_PIN, ANALOG);
    pinMode(ANT_POWER_PIN, ANALOG);
  }
  // ---------------------------------------------------------------------------

  Serial.print("Going to deep sleep for ");
  Serial.print((unsigned long)calculatedSleepSeconds);
  Serial.println(" seconds.\n");
  Serial.flush();

  delay(100);
  esp_sleep_enable_timer_wakeup(calculatedSleepSeconds * 1000000ULL);
  esp_deep_sleep_start();
}

void loop() {}
