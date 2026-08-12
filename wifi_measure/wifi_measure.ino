#include <WiFi.h>
#include <HTTPClient.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>
#include <time.h>
#include <WiFiClientSecure.h>
#include "mbedtls/base64.h"

// --- Pin Definitions (Xiao ESP32C6) ---
const int BATTERY_PIN    = A0; 
const int NPN_PIN        = D1; 
const int SENSOR_RX_PIN  = D2; 
const int SENSOR_TX_PIN  = D3; 
const int RESET_PIN_1    = D7;
const int RESET_PIN_2    = D8;
const int LED_PIN = LED_BUILTIN;
const bool HAS_ANT = true;
const int ANT_POWER_PIN  = 3;  // Powers the RF antenna switch
const int ANT_SELECT_PIN = 14; // HIGH = External Antenna, LOW = Internal Antenna

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
// const int BATTERY_PIN    = 4; 
// const int NPN_PIN        = 5; 
// const int SENSOR_RX_PIN  = 6; 
// const int SENSOR_TX_PIN  = 7; 
// const int RESET_PIN_1    = 12;
// const int RESET_PIN_2    = 13;
// const int LED_PIN = 2;
// const bool HAS_ANT = false;
// const int ANT_POWER_PIN  = 3;  // Powers the RF antenna switch
// const int ANT_SELECT_PIN = 14; // HIGH = External Antenna, LOW = Internal Antenna

// --- BLE UUIDs for First-Time Provisioning Only ---
#define SERVICE_UUID        "4fa0115a-3422-43fe-90ba-094d2112d038"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

Preferences preferences;
BLECharacteristic *pCharacteristic = nullptr;

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

// Base64 decoder helper
String decodeBase64(String input) {
  if (input.length() == 0) return "";
  size_t maxLen = input.length();
  unsigned char *buf = new unsigned char[maxLen];
  size_t outLen = 0;
  int res = mbedtls_base64_decode(buf, maxLen, &outLen, (unsigned char*)input.c_str(), maxLen);
  String decoded = "";
  if (res == 0) {
    for (size_t i = 0; i < outLen; i++) {
      decoded += (char)buf[i];
    }
  }
  delete[] buf;
  return decoded;
}

// Hardware bridge test for factory reset
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

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) { Serial.println("Provisioning App Connected!"); }
    void onDisconnect(BLEServer* pServer) { 
        Serial.println("Provisioning App Disconnected. Restarting advertising..."); 
        pServer->startAdvertising(); 
    }
};

class ProvisioningCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pChar) {
      if (pChar == nullptr) return;
      String value = pChar->getValue();
      if (value.length() > 0) {
        Serial.print("Received Provisioning Data: ");
        Serial.println(value);

        if (value.equals("SCAN_WIFIS")) {
          Serial.println("Scanning nearby Wi-Fi networks...");
          WiFi.mode(WIFI_STA);
          WiFi.disconnect();
          delay(100);

          int n = WiFi.scanNetworks();
          String wifiList = "";
          
          for (int i = 0; i < n; ++i) {
            String ssid = WiFi.SSID(i);
            int rssi = WiFi.RSSI(i);

            if (ssid.length() > 0) {
              bool alreadyExists = false;
              int startIndex = 0;
              while (true) {
                int foundIndex = wifiList.indexOf(ssid + ",", startIndex);
                if (foundIndex == -1) break;
                if (foundIndex == 0 || wifiList.charAt(foundIndex - 1) == ';') {
                  alreadyExists = true;
                  break;
                }
                startIndex = foundIndex + 1;
              }

              if (!alreadyExists) {
                if (wifiList.length() > 0) wifiList += ";";
                wifiList += ssid + "," + String(rssi);
              }
            }
          }

          if (wifiList.length() == 0) wifiList = "NO_NETWORKS_FOUND";

          pChar->setValue(wifiList.c_str());
          pChar->notify();
          Serial.println("Sent unique Wi-Fi list to app: " + wifiList);
        }
        else if (value.startsWith("SET_CREDENTIALS:")) {
          String data = value.substring(16);
          
          int idx0 = 0;
          int idx1 = data.indexOf(',', idx0);
          int idx2 = data.indexOf(',', idx1 + 1);
          int idx3 = data.indexOf(',', idx2 + 1);
          int idx4 = data.indexOf(',', idx3 + 1);
          int idx5 = data.indexOf(',', idx4 + 1);
          int idx6 = data.indexOf(',', idx5 + 1);
          int idx7 = data.lastIndexOf(',');

          if (idx1 > 0 && idx2 > 0 && idx3 > 0 && idx4 > 0 && idx5 > 0 && idx6 > 0 && idx7 > 0) {
            String encodedSsid = data.substring(idx0, idx1);
            String encodedPass = data.substring(idx1 + 1, idx2);
            
            String sSsid    = decodeBase64(encodedSsid);
            String sPass    = decodeBase64(encodedPass);
            String sWorker  = data.substring(idx2 + 1, idx3);
            String sToken   = data.substring(idx3 + 1, idx4);
            int sInterval   = data.substring(idx4 + 1, idx5).toInt();
            int sQStart     = data.substring(idx5 + 1, idx6).toInt();
            int sQEnd       = data.substring(idx6 + 1, idx7).toInt();
            bool sExtAnt    = data.substring(idx7 + 1).toInt() == 1;

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

            Serial.println("Configuration Saved Successfully!");
            Serial.println("Decoded SSID: " + sSsid);
            Serial.println("External Antenna: " + String(sExtAnt ? "YES" : "NO"));
            Serial.println("Rebooting into normal operation...");
            delay(1000);
            ESP.restart();
          } else {
            Serial.println("Error: Malformed provisioning payload string.");
          }
        }
      }
    }
};

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

  // Simple sort to grab the median reading
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

void calculateNextSleepDuration() {
  time_t now;
  time(&now);
  struct tm timeinfo;
  localtime_r(&now, &timeinfo);

  calculatedSleepSeconds = (uint64_t)intervalMinutes * 60;

  // Only calculate quiet hours if NTP time successfully synced (Year > 2025)
  if (timeinfo.tm_year > (2025 - 1900)) {
    int currentHour = timeinfo.tm_hour;
    bool isQuietTime = false;

    if (quietStartHour > quietEndHour) {
      if (currentHour >= quietStartHour || currentHour < quietEndHour) isQuietTime = true;
    } else {
      if (currentHour >= quietStartHour && currentHour < quietEndHour) isQuietTime = true;
    }

    if (isQuietTime) {
      int hoursRemaining = (quietEndHour - currentHour + 24) % 24;
      if (hoursRemaining == 0) hoursRemaining = 24;
      calculatedSleepSeconds = (hoursRemaining * 3600) - (timeinfo.tm_min * 60) - timeinfo.tm_sec;
    } else {
      int minsIntoInterval = timeinfo.tm_min % intervalMinutes;
      int minsToNext = intervalMinutes - minsIntoInterval;
      calculatedSleepSeconds = (minsToNext * 60) - timeinfo.tm_sec;
      if (calculatedSleepSeconds <= 0) calculatedSleepSeconds = intervalMinutes * 60;
    }
  }
}

void setup() {
  Serial.begin(9600);
  delay(1000); 

  // --- HARDWARE FACTORY RESET CHECK VIA D7/D8 BRIDGE ---
  if (checkPinsBridged(RESET_PIN_1, RESET_PIN_2) || checkPinsBridged(RESET_PIN_2, RESET_PIN_1)) {
    Serial.println("\n[!] FACTORY RESET: D7 and D8 bridge detected! Wiping settings...");
    
    preferences.begin("settings", false);
    preferences.clear();
    preferences.end();
    
    Serial.println("Memory cleared successfully. Blinking LED and waiting for reset...");
    
    pinMode(LED_PIN, OUTPUT);
    while (true) {
      digitalWrite(LED_PIN, HIGH);
      delay(1000);
      digitalWrite(LED_PIN, LOW);
      delay(1000);
    }
  }
  // -----------------------------------------------------

  preferences.begin("settings", true);
  configured           = preferences.getBool("configured", false);
  wifiSsid             = preferences.getString("ssid", "");
  wifiPass             = preferences.getString("pass", "");
  aioUser              = preferences.getString("worker", ""); 
  aioKey               = preferences.getString("token", "");  
  intervalMinutes      = preferences.getInt("interval", 60);
  quietStartHour       = preferences.getInt("qStart", 20);
  quietEndHour         = preferences.getInt("qEnd", 8);
  useExternalAntenna   = preferences.getBool("extAnt", false);
  preferences.end();

  // --- Configure Antenna Switch using defined constants ---
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
  // 1. UNCONFIGURED STATE: RUN BLE PROVISIONING MODE
  // ========================================================
  if (!configured || wifiSsid.length() == 0) {
    Serial.println("\n--- UNCONFIGURED: STARTING BLE PROVISIONING ---");

    BLEDevice::init("ESP32_Distance_Sensor");
    BLEServer *pServer = BLEDevice::createServer();
    pServer->setCallbacks(new MyServerCallbacks());
    BLEService *pService = pServer->createService(SERVICE_UUID);

    pCharacteristic = pService->createCharacteristic(
                        CHARACTERISTIC_UUID,
                        BLECharacteristic::PROPERTY_READ |
                        BLECharacteristic::PROPERTY_NOTIFY |
                        BLECharacteristic::PROPERTY_WRITE
                      );
                      
    pCharacteristic->addDescriptor(new BLE2902());
    pCharacteristic->setCallbacks(new ProvisioningCallbacks());

    pService->start();
    BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
    pAdvertising->addServiceUUID(SERVICE_UUID);
    pAdvertising->setScanResponse(true);
    BLEDevice::startAdvertising();

    while (true) {
      delay(100);
    }
  }

  // ========================================================
  // 2. NORMAL OPERATION MODE (BLE BYPASSED)
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

  // Connect to Wi-Fi
  Serial.print("Connecting to Wi-Fi: "); Serial.println(wifiSsid);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 12000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi Connected successfully! Syncing time via NTP...");
    configTime(gmtOffset_sec, daylightOffset_sec, "pool.ntp.org", "time.nist.gov");

    Serial.println("Uploading data...");
    
    // --- NEW: Robust HTTPS Configuration ---
    WiFiClientSecure client;
    client.setInsecure(); // Skip SSL certificate verification to save time/memory

    HTTPClient http;
    http.setTimeout(15000); // Increase timeout to 15 seconds for Cloudflare cold starts
    
    // Pass the secure client to the HTTP instance
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
  } else {
    Serial.println("ERROR: Wi-Fi connection failed or timed out.");
    WiFi.mode(WIFI_OFF);
  }

  // --- ANTENNA SWITCH OPTIMIZATION: Kill power to prevent deep sleep leakage ---
  if (HAS_ANT) {
    digitalWrite(ANT_SELECT_PIN, LOW);
    digitalWrite(ANT_POWER_PIN, LOW);
    pinMode(ANT_SELECT_PIN, ANALOG);
    pinMode(ANT_POWER_PIN, ANALOG);
  }
  // ---------------------------------------------------------------------------

  // Sleep scheduling
  calculateNextSleepDuration();
  
  Serial.print("Going to deep sleep for ");
  Serial.print((unsigned long)calculatedSleepSeconds);
  Serial.println(" seconds.\n");
  Serial.flush();
  
  delay(100);
  esp_sleep_enable_timer_wakeup(calculatedSleepSeconds * 1000000ULL);
  esp_deep_sleep_start();
}

void loop() {}