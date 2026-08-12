#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>
#include <time.h>

// --- Pin Definitions (Xiao ESP32C6)  ---
// const int BATTERY_PIN   = A0; 
// const int NPN_PIN       = D1; 
// const int SENSOR_RX_PIN = D2; 
// const int SENSOR_TX_PIN = D3; 

// --- Pin Definitions (ESP32D)  ---
const int BATTERY_PIN    = 4; 
const int NPN_PIN        = 16; 
const int SENSOR_RX_PIN  = 17; 
const int SENSOR_TX_PIN  = 5; 

// --- UUIDs matching your Android App ---
#define SERVICE_UUID        "4fa0115a-3422-43fe-90ba-094d2112d038"
#define CHARACTERISTIC_UUID "beb5483e-36e1-4688-b7f5-ea07361b26a8"

Preferences preferences;
BLECharacteristic *pCharacteristic = nullptr;
bool deviceConnected = false;

bool dataRequested = false;
unsigned long requestTime = 0;

int intervalMinutes = 60; 
int quietStartHour  = 20; 
int quietEndHour    = 8;  

String lastSensorReadingsStr = "0,0,0"; // 3 samples to fit BLE 20-byte packet limit
int currentBatteryPct = 0;
uint64_t calculatedSleepSeconds = 3600;

void calculateNextSleepDuration();

class MyServerCallbacks: public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) { deviceConnected = true; Serial.println("App Connected!"); }
    void onDisconnect(BLEServer* pServer) { deviceConnected = false; Serial.println("App Disconnected."); }
};

void calculateNextSleepDuration() {
  time_t now;
  time(&now);
  struct tm timeinfo;
  localtime_r(&now, &timeinfo);

  calculatedSleepSeconds = (uint64_t)intervalMinutes * 60;

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

class CharacteristicCallbacks: public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic *pChar) {
      if (pChar == nullptr) return;
      String value = pChar->getValue();
      if (value.length() > 0) {
        Serial.print("Received from app: ");
        Serial.println(value);

        if (value.startsWith("SET_TIME:")) {
          time_t t = value.substring(9).toInt();
          struct timeval tv = { .tv_sec = t, .tv_usec = 0 };
          settimeofday(&tv, NULL);
          Serial.println("Time synced successfully!");
        }
        else if (value.startsWith("SET_CONFIG:")) {
          String cfg = value.substring(11);
          int c1 = cfg.indexOf(',');
          int c2 = cfg.lastIndexOf(',');
          if (c1 > 0 && c2 > c1) {
            intervalMinutes = cfg.substring(0, c1).toInt();
            quietStartHour  = cfg.substring(c1 + 1, c2).toInt();
            quietEndHour    = cfg.substring(c2 + 1).toInt();

            preferences.begin("settings", false);
            preferences.putInt("interval", intervalMinutes);
            preferences.putInt("qStart", quietStartHour);
            preferences.putInt("qEnd", quietEndHour);
            preferences.end();
            Serial.println("New Schedule Configuration Saved to Flash!");
          }
        }
        else if (value.equals("GET")) {
          calculateNextSleepDuration();
          
          // Compact payload (<20 bytes): readings | nextWakeSeconds | batteryPct
          String payload = lastSensorReadingsStr + "|" + String((unsigned long)calculatedSleepSeconds) + "|" + String(currentBatteryPct);
          
          pChar->setValue(payload.c_str());
          pChar->notify();
          Serial.println("Sent payload: " + payload);

          dataRequested = true;
          requestTime = millis();
        }
      }
    }
};

String collectSensorReadings() {
  int readings[3]; // Reduced from 5 to 3 to fit BLE packet size
  int validCount = 0;
  int attempts = 0;
  String rawString = "";

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
      }
    }
  }

  if (validCount == 0) return "0,0,0";

  // Sort array (Bubble Sort)
  for (int i = 0; i < validCount - 1; i++) {
    for (int j = 0; j < validCount - i - 1; j++) {
      if (readings[j] > readings[j + 1]) {
        int temp = readings[j];
        readings[j] = readings[j + 1];
        readings[j + 1] = temp;
      }
    }
  }

  for (int i = 0; i < validCount; i++) {
    rawString += String(readings[i]);
    if (i < validCount - 1) rawString += ",";
  }
  return rawString;
}

void setup() {
  pinMode(NPN_PIN, OUTPUT);
  digitalWrite(NPN_PIN, HIGH); 

  Serial.begin(9600);
  delay(1000); 

  preferences.begin("settings", true);
  intervalMinutes = preferences.getInt("interval", 60);
  quietStartHour  = preferences.getInt("qStart", 20);
  quietEndHour    = preferences.getInt("qEnd", 8);
  preferences.end();

  pinMode(BATTERY_PIN, INPUT);
  pinMode(SENSOR_TX_PIN, INPUT);

  // Read Battery Voltage & Calculate Percentage
  int adcMilliVolts = analogReadMilliVolts(BATTERY_PIN);
  float batteryVoltage = (adcMilliVolts * 2.0) / 1000.0;
  currentBatteryPct = constrain(((batteryVoltage - 3.3) / (4.5 - 3.3)) * 100, 0, 100);

  // Collect 3 Sensor Readings
  lastSensorReadingsStr = collectSensorReadings();
  Serial.println("Readings: " + lastSensorReadingsStr);

  // Shut down sensor immediately
  digitalWrite(NPN_PIN, LOW); 
  pinMode(SENSOR_TX_PIN, INPUT);
  Serial.println("Sensor powered OFF.");

  // Initialize BLE
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
  pCharacteristic->setCallbacks(new CharacteristicCallbacks());

  pService->start();
  
  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  Serial.println("BLE Active. Waiting for app connection & GET command...");

  unsigned long startMillis = millis();
  while (millis() - startMillis < 25000) {
    delay(50);
    if (dataRequested && (millis() - requestTime > 2000)) {
      Serial.println("App finished downloading data. Exiting window early.");
      break;
    }
  }

  calculateNextSleepDuration();
  
  Serial.print("Going to sleep for ");
  Serial.print((unsigned long)calculatedSleepSeconds);
  Serial.println(" seconds.");
  Serial.flush();
  
  delay(100);

  esp_sleep_enable_timer_wakeup(calculatedSleepSeconds * 1000000ULL);
  esp_deep_sleep_start();
}

void loop() {}