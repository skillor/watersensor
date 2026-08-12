package cc.skillor.skillhome;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.CountDownTimer;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Menu;
import android.view.MenuItem;
import android.widget.TextView;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;

@SuppressLint("MissingPermission")
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "ESP32_BLE_APP";

    // Matching ESP32 Custom BLE UUIDs
    private static final UUID SERVICE_UUID = UUID.fromString("4fa0115a-3422-43fe-90ba-094d2112d038");
    private static final UUID CHARACTERISTIC_UUID = UUID.fromString("beb5483e-36e1-4688-b7f5-ea07361b26a8");
    private static final UUID CLIENT_CHARACTERISTIC_CONFIG = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private static final int PERMISSION_REQUEST_CODE = 101;
    private static final long SCAN_RESTART_DELAY_MS = 3000;

    private TextView messageTextView;
    private TextView statusTextView;
    private TextView serialTextView;

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner bleScanner;
    private BluetoothGatt bluetoothGatt;
    private BluetoothGattCharacteristic distanceCharacteristic;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private CountDownTimer wakeCountDownTimer;

    private boolean isScanning = false;
    private boolean shouldAutoReconnect = true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        messageTextView = findViewById(R.id.messageTextView);
        statusTextView = findViewById(R.id.statusTextView);
        serialTextView = findViewById(R.id.serialTextView);

        bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
        if (bluetoothAdapter != null) {
            bleScanner = bluetoothAdapter.getBluetoothLeScanner();
        }

        updateUi("Status: Initializing...", "App ready.");
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.menu_main, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        if (item.getItemId() == R.id.action_settings) {
            startActivity(new Intent(MainActivity.this, SettingsActivity.class));
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    protected void onResume() {
        super.onResume();
        shouldAutoReconnect = true;

        // Immediately start predictive countdown based on phone clock
        startPredictiveCountdown();

        if (checkAndRequestPermissions()) {
            startBleScan();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        shouldAutoReconnect = false;
        if (wakeCountDownTimer != null) {
            wakeCountDownTimer.cancel();
        }
        stopBleScan();
        disconnectBle();
    }

    // ================= BLE SCANNING =================

    private void startBleScan() {
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
            updateUi("Status: BT Disabled", "Turn on Bluetooth.");
            return;
        }

        if (isScanning || !shouldAutoReconnect) return;

        updateUi("Status: Scanning...", "Looking for ESP32_Distance_Sensor...");

        ScanSettings settings = new ScanSettings.Builder()
                .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                .build();

        isScanning = true;
        bleScanner.startScan(null, settings, scanCallback);
    }

    private void stopBleScan() {
        if (isScanning && bleScanner != null && bluetoothAdapter != null && bluetoothAdapter.isEnabled()) {
            bleScanner.stopScan(scanCallback);
            isScanning = false;
        }
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device = result.getDevice();
            String name = device.getName();

            if (name != null && name.equals("ESP32_Distance_Sensor")) {
                Log.d(TAG, "Found ESP32 device!");
                stopBleScan();
                disconnectBle();

                updateUi("Status: Found ESP32!", "Connecting in 300ms...");

                handler.postDelayed(() -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        bluetoothGatt = device.connectGatt(MainActivity.this, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
                    } else {
                        bluetoothGatt = device.connectGatt(MainActivity.this, false, gattCallback);
                    }
                }, 300);
            }
        }

        @Override
        public void onScanFailed(int errorCode) {
            Log.e(TAG, "Scan failed with error: " + errorCode);
            updateUi("Status: Scan Error " + errorCode, "Retrying...");
            isScanning = false;
            if (shouldAutoReconnect) {
                handler.postDelayed(MainActivity.this::startBleScan, SCAN_RESTART_DELAY_MS);
            }
        }
    };

    // ================= GATT CALLBACKS =================

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            Log.d(TAG, "onConnectionStateChange - Status: " + status + " NewState: " + newState);

            if (status != BluetoothGatt.GATT_SUCCESS) {
                disconnectBle();
                if (shouldAutoReconnect) {
                    updateUi("Status: GATT Error (" + status + ")", "Retrying scan in 3s...");
                    handler.postDelayed(MainActivity.this::startBleScan, SCAN_RESTART_DELAY_MS);
                }
                return;
            }

            if (newState == BluetoothProfile.STATE_CONNECTED) {
                updateUi("Status: Connected!", "Discovering services...");
                handler.postDelayed(gatt::discoverServices, 300);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                disconnectBle();
                if (shouldAutoReconnect) {
                    updateUi("Status: ESP32 Slept", "Waiting for next wake cycle...");
                    handler.postDelayed(MainActivity.this::startBleScan, SCAN_RESTART_DELAY_MS);
                }
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            Log.d(TAG, "onServicesDiscovered - Status: " + status);
            if (status == BluetoothGatt.GATT_SUCCESS) {
                var service = gatt.getService(SERVICE_UUID);
                if (service != null) {
                    distanceCharacteristic = service.getCharacteristic(CHARACTERISTIC_UUID);
                    if (distanceCharacteristic != null) {
                        updateUi("Status: Services Found!", "Enabling notifications...");
                        enableNotifications(gatt, distanceCharacteristic);

                        handler.postDelayed(() -> sendTriggerCommand(gatt), 500);
                        return;
                    }
                }
            }
            updateUi("Status: Service Not Found", "UUID match error.");
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            byte[] value = characteristic.getValue();
            if (value != null) {
                String rawData = new String(value, StandardCharsets.UTF_8); // Expected format: "176,176,177|1800|85"
                Log.d(TAG, "Received payload: " + rawData);

                String[] parts = rawData.split("\\|");
                String[] readings = parts[0].split(",");

                // Extract next wake seconds (part 1) and battery percentage (part 2)
                long actualNextWakeSeconds = (parts.length > 1) ? Long.parseLong(parts[1].trim()) : 300;

                int batteryPct = -1;
                if (parts.length > 2) {
                    try {
                        batteryPct = Integer.parseInt(parts[2].trim());
                    } catch (NumberFormatException ignored) {}
                }

                // Calculate average distance from valid readings
                int sum = 0, validCount = 0;
                for (String r : readings) {
                    try {
                        int dist = Integer.parseInt(r.trim());
                        if (dist >= 0) {
                            sum += dist;
                            validCount++;
                        }
                    } catch (NumberFormatException ignored) {}
                }

                // Format UI strings
                String distanceDisplay = (validCount > 0) ? ("Avg: " + (sum / validCount) + " cm") : "Sensor Error";
                String batteryDisplay = (batteryPct >= 0) ? (" | Battery: " + batteryPct + "%") : "";

                // Update UI fields (messageTextView displays distance + battery)
                updateUi("Status: Data Received!", distanceDisplay + batteryDisplay, "Raw readings: " + rawData);

                // Sync UI countdown timer with the exact time calculated by the ESP32
                startWakeCountdown(actualNextWakeSeconds);
            }
        }
    };

    // ================= COMMANDS & NOTIFICATIONS =================

    private void enableNotifications(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
        gatt.setCharacteristicNotification(characteristic, true);
        BluetoothGattDescriptor descriptor = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG);
        if (descriptor != null) {
            descriptor.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            gatt.writeDescriptor(descriptor);
        }
    }

    private void sendTriggerCommand(BluetoothGatt gatt) {
        if (distanceCharacteristic != null) {
            // 1. Sync phone Unix epoch timestamp to ESP32
            long epochSeconds = System.currentTimeMillis() / 1000;
            distanceCharacteristic.setValue(("SET_TIME:" + epochSeconds).getBytes(StandardCharsets.UTF_8));
            gatt.writeCharacteristic(distanceCharacteristic);

            updateUi("Status: Syncing Time...", "Sending current time & config...");

            // 2. Read preferences and send configuration to ESP32 after a brief delay
            handler.postDelayed(() -> {
                android.content.SharedPreferences prefs = androidx.preference.PreferenceManager.getDefaultSharedPreferences(this);

                // Read values from preferences (with safe fallbacks)
                String interval = prefs.getString("sleep_interval", "60");
                String quietStart = prefs.getString("quiet_start", "20");
                String quietEnd = prefs.getString("quiet_end", "8");

                // Format matches ESP32 expectation: "SET_CONFIG:interval,start,end"
                String configCommand = "SET_CONFIG:" + interval + "," + quietStart + "," + quietEnd;

                distanceCharacteristic.setValue(configCommand.getBytes(StandardCharsets.UTF_8));
                gatt.writeCharacteristic(distanceCharacteristic);
                Log.d(TAG, "Sent Config: " + configCommand);
            }, 200);

            // 3. Send GET command to fetch latest distance and battery data
            handler.postDelayed(() -> {
                distanceCharacteristic.setValue("GET".getBytes(StandardCharsets.UTF_8));
                gatt.writeCharacteristic(distanceCharacteristic);
                updateUi("Status: Requesting...", "Fetching distance & battery data...");
            }, 500);
        }
    }

    // ================= COUNTDOWN TIMER LOGIC =================

    /**
     * Predictive countdown calculation based on phone's clock before connecting.
     */
    private void startPredictiveCountdown() {
        android.content.SharedPreferences prefs = androidx.preference.PreferenceManager.getDefaultSharedPreferences(this);
        int intervalMinutes = Integer.parseInt(prefs.getString("sleep_interval", "60"));
        int quietStartHour = Integer.parseInt(prefs.getString("quiet_start", "20"));
        int quietEndHour = Integer.parseInt(prefs.getString("quiet_end", "8"));

        // Get current local time components
        java.util.Calendar calendar = java.util.Calendar.getInstance();
        int currentHour = calendar.get(java.util.Calendar.HOUR_OF_DAY);
        int currentMinute = calendar.get(java.util.Calendar.MINUTE);
        int currentSecond = calendar.get(java.util.Calendar.SECOND);

        long sleepSeconds = intervalMinutes * 60L; // default fallback

        // Check if quiet hours are active
        boolean isQuietTime = false;
        if (quietStartHour > quietEndHour) { // Spans midnight (e.g., 20:00 to 08:00)
            if (currentHour >= quietStartHour || currentHour < quietEndHour) {
                isQuietTime = true;
            }
        } else { // Normal window
            if (currentHour >= quietStartHour && currentHour < quietEndHour) {
                isQuietTime = true;
            }
        }

        if (isQuietTime) {
            int hoursRemaining = (quietEndHour - currentHour + 24) % 24;
            if (hoursRemaining == 0) hoursRemaining = 24;
            sleepSeconds = (hoursRemaining * 3600L) - (currentMinute * 60L) - currentSecond;
        } else {
            // "On the dot" alignment based on interval minutes
            int minsIntoInterval = currentMinute % intervalMinutes;
            int minsToNext = intervalMinutes - minsIntoInterval;
            sleepSeconds = (minsToNext * 60L) - currentSecond;
            if (sleepSeconds <= 0) {
                sleepSeconds = intervalMinutes * 60L;
            }
        }

        startWakeCountdown(sleepSeconds);
    }

    private void startWakeCountdown(long secondsUntilWake) {
        if (wakeCountDownTimer != null) {
            wakeCountDownTimer.cancel();
        }

        wakeCountDownTimer = new CountDownTimer(secondsUntilWake * 1000, 1000) {
            @Override
            public void onTick(long millisUntilFinished) {
                long sec = millisUntilFinished / 1000;
                long mins = sec / 60;
                long remSec = sec % 60;
                String timeFormatted = String.format(Locale.US, "%02d:%02d", mins, remSec);

                statusTextView.setText("Status: Next window in " + timeFormatted);
            }

            @Override
            public void onFinish() {
                statusTextView.setText("Status: Sensor waking up now...");
                startBleScan();
            }
        }.start();
    }

    // ================= CLEANUP =================

    private void disconnectBle() {
        if (bluetoothGatt != null) {
            try {
                bluetoothGatt.disconnect();
                bluetoothGatt.close();
            } catch (Exception ignored) {
            } finally {
                bluetoothGatt = null;
            }
        }
    }

    private void updateUi(String status, String message) {
        updateUi(status, message, null);
    }

    private void updateUi(String status, String message, String rawReceived) {
        runOnUiThread(() -> {
            if (status != null) statusTextView.setText(status);
            if (message != null) messageTextView.setText(message);
            if (rawReceived != null) serialTextView.setText(rawReceived);
        });
    }

    // ================= PERMISSIONS =================

    private boolean checkAndRequestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED ||
                    ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {

                ActivityCompat.requestPermissions(this, new String[]{
                        Manifest.permission.BLUETOOTH_SCAN,
                        Manifest.permission.BLUETOOTH_CONNECT
                }, PERMISSION_REQUEST_CODE);
                return false;
            }
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{
                        Manifest.permission.ACCESS_FINE_LOCATION
                }, PERMISSION_REQUEST_CODE);
                return false;
            }
        }
        return true;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQUEST_CODE && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startBleScan();
        } else {
            updateUi("Status: Permission Denied", "Grant permissions in Settings.");
        }
    }
}