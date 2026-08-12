package cc.skillor.skillconfig;

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
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.widget.AdapterView;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.preference.PreferenceManager;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@SuppressLint("MissingPermission")
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "ESP32_PROV";
    private static final int PERMISSION_REQUEST_CODE = 101;

    private static final UUID SERVICE_UUID = UUID.fromString("4fa0115a-3422-43fe-90ba-094d2112d038");
    private static final UUID CHARACTERISTIC_UUID = UUID.fromString("beb5483e-36e1-4688-b7f5-ea07361b26a8");
    private static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private TextView statusText;
    private Button scanWifiBtn, provisionBtn;
    private Spinner wifiSpinner;
    private EditText ssidInput, wifiPassInput, workerUrlInput, tokenInput, intervalInput, startHourInput, endHourInput;
    private CheckBox externalAntennaCheckbox;

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeScanner bleScanner;
    private BluetoothGatt bluetoothGatt;
    private BluetoothGattCharacteristic targetCharacteristic;

    private final List<String> wifiNames = new ArrayList<>();
    private ArrayAdapter<String> wifiAdapter;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SharedPreferences sharedPreferences;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        statusText = findViewById(R.id.statusText);
        scanWifiBtn = findViewById(R.id.scanWifiBtn);
        provisionBtn = findViewById(R.id.provisionBtn);
        wifiSpinner = findViewById(R.id.wifiSpinner);
        ssidInput = findViewById(R.id.ssidInput);
        wifiPassInput = findViewById(R.id.wifiPassInput);
        workerUrlInput = findViewById(R.id.workerUrlInput);
        tokenInput = findViewById(R.id.tokenInput);
        intervalInput = findViewById(R.id.intervalInput);
        startHourInput = findViewById(R.id.startHourInput);
        endHourInput = findViewById(R.id.endHourInput);
        externalAntennaCheckbox = findViewById(R.id.externalAntennaCheckbox);

        sharedPreferences = PreferenceManager.getDefaultSharedPreferences(this);
        loadSavedPreferences();

        // Setup Wi-Fi dropdown adapter
        wifiAdapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, wifiNames);
        wifiSpinner.setAdapter(wifiAdapter);

        // When a network is chosen from the dropdown, automatically populate the SSID input field
        wifiSpinner.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() {
            @Override
            public void onItemSelected(AdapterView<?> parent, View view, int position, long id) {
                String selected = wifiNames.get(position);
                // Format stored in list is "SSID (-XX dBm)". Extract just the SSID.
                int lastSpaceIdx = selected.lastIndexOf(" (");
                if (lastSpaceIdx > 0) {
                    ssidInput.setText(selected.substring(0, lastSpaceIdx));
                }
            }
            @Override
            public void onNothingSelected(AdapterView<?> parent) {}
        });

        bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
        scanWifiBtn.setEnabled(false);
        provisionBtn.setEnabled(false);

        scanWifiBtn.setOnClickListener(v -> requestWifiScan());
        provisionBtn.setOnClickListener(v -> sendProvisioningData());

        checkAndRequestPermissions();
    }

    private void checkAndRequestPermissions() {
        List<String> listPermissionsNeeded = new ArrayList<>();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                listPermissionsNeeded.add(Manifest.permission.BLUETOOTH_SCAN);
            }
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                listPermissionsNeeded.add(Manifest.permission.BLUETOOTH_CONNECT);
            }
        } else {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                listPermissionsNeeded.add(Manifest.permission.ACCESS_FINE_LOCATION);
            }
        }

        if (!listPermissionsNeeded.isEmpty()) {
            ActivityCompat.requestPermissions(this, listPermissionsNeeded.toArray(new String[0]), PERMISSION_REQUEST_CODE);
        } else {
            initBluetooth();
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == PERMISSION_REQUEST_CODE) {
            boolean allGranted = true;
            for (int res : grantResults) {
                if (res != PackageManager.PERMISSION_GRANTED) {
                    allGranted = false;
                    break;
                }
            }
            if (allGranted) {
                initBluetooth();
            } else {
                statusText.setText("Status: Permissions required for Bluetooth.");
                Toast.makeText(this, "Permissions denied!", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void initBluetooth() {
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
            statusText.setText("Status: Bluetooth is turned off.");
            return;
        }
        bleScanner = bluetoothAdapter.getBluetoothLeScanner();
        startBleScan();
    }

    private void loadSavedPreferences() {
        ssidInput.setText(sharedPreferences.getString("prov_ssid", ""));
        wifiPassInput.setText(sharedPreferences.getString("prov_wifi_pass", ""));
        workerUrlInput.setText(sharedPreferences.getString("prov_worker_url", ""));
        tokenInput.setText(sharedPreferences.getString("prov_token", ""));
        intervalInput.setText(sharedPreferences.getString("prov_interval", "60"));
        startHourInput.setText(sharedPreferences.getString("prov_start", "20"));
        endHourInput.setText(sharedPreferences.getString("prov_end", "8"));
        externalAntennaCheckbox.setChecked(sharedPreferences.getBoolean("prov_ext_antenna", false));
    }

    private void savePreferencesToDisk(String ssid, String pass, String worker, String token, String interval, String start, String end, boolean extAnt) {
        sharedPreferences.edit()
                .putString("prov_ssid", ssid)
                .putString("prov_wifi_pass", pass)
                .putString("prov_worker_url", worker)
                .putString("prov_token", token)
                .putString("prov_interval", interval)
                .putString("prov_start", start)
                .putString("prov_end", end)
                .putBoolean("prov_ext_antenna", extAnt)
                .apply();
    }

    private void startBleScan() {
        if (bleScanner == null) return;
        statusText.setText("Status: Scanning for 'ESP32_Distance_Sensor'...");
        bleScanner.startScan(scanCallback);
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            BluetoothDevice device = result.getDevice();
            String name = device.getName();
            if (name != null && name.equals("ESP32_Distance_Sensor")) {
                bleScanner.stopScan(this);
                statusText.setText("Status: Found device. Connecting...");
                bluetoothGatt = device.connectGatt(MainActivity.this, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
            }
        }
    };

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                runOnUiThread(() -> statusText.setText("Status: Connected! Requesting packet size..."));
                gatt.requestMtu(512);
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                runOnUiThread(() -> {
                    statusText.setText("Status: Disconnected. Rescanning...");
                    startBleScan();
                });
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                gatt.discoverServices();
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                var service = gatt.getService(SERVICE_UUID);
                if (service != null) {
                    targetCharacteristic = service.getCharacteristic(CHARACTERISTIC_UUID);
                    if (targetCharacteristic != null) {
                        enableNotifications(gatt, targetCharacteristic);
                        runOnUiThread(() -> {
                            statusText.setText("Status: Ready for provisioning!");
                            scanWifiBtn.setEnabled(true);
                            provisionBtn.setEnabled(true);
                        });
                    }
                }
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            byte[] data = characteristic.getValue();
            if (data != null) {
                String response = new String(data, StandardCharsets.UTF_8);
                Log.d(TAG, "Received from ESP32: " + response);

                if (!response.startsWith("SET_") && !response.equals("0,0,0")) {
                    wifiNames.clear();
                    String[] networks = response.split(";");
                    for (String net : networks) {
                        String[] parts = net.split(",");
                        if (parts.length >= 2) {
                            wifiNames.add(parts[0] + " (" + parts[1] + " dBm)");
                        }
                    }
                    runOnUiThread(() -> {
                        wifiAdapter.notifyDataSetChanged();
                        statusText.setText("Status: Wi-Fi scan complete.");
                    });
                }
            }
        }
    };

    private void enableNotifications(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
        gatt.setCharacteristicNotification(characteristic, true);
        BluetoothGattDescriptor desc = characteristic.getDescriptor(CCCD_UUID);
        if (desc != null) {
            desc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
            gatt.writeDescriptor(desc);
        }
    }

    private void requestWifiScan() {
        if (targetCharacteristic != null && bluetoothGatt != null) {
            statusText.setText("Status: Scanning Wi-Fi via ESP32...");
            targetCharacteristic.setValue("SCAN_WIFIS".getBytes(StandardCharsets.UTF_8));
            bluetoothGatt.writeCharacteristic(targetCharacteristic);
        }
    }

    private void sendProvisioningData() {
        if (targetCharacteristic == null || bluetoothGatt == null) return;

        String ssid = ssidInput.getText().toString().trim();
        String pass = wifiPassInput.getText().toString();
        String worker = workerUrlInput.getText().toString().trim();
        String token = tokenInput.getText().toString().trim();
        String interval = intervalInput.getText().toString().trim();
        String start = startHourInput.getText().toString().trim();
        String end = endHourInput.getText().toString().trim();

        if (ssid.isEmpty() || worker.isEmpty() || token.isEmpty()) {
            Toast.makeText(this, "Please fill in SSID, Worker URL, and Token", Toast.LENGTH_SHORT).show();
            return;
        }

        boolean useExtAnt = externalAntennaCheckbox.isChecked();
        savePreferencesToDisk(ssid, pass, worker, token, interval, start, end, useExtAnt);

        String encodedSsid = Base64.encodeToString(ssid.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        String encodedPass = Base64.encodeToString(pass.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
        String extAntStr = useExtAnt ? "1" : "0";

        // Payload format: SET_CREDENTIALS:EncSsid,EncPass,Worker,Token,Interval,Start,End,ExtAnt
        String payload = "SET_CREDENTIALS:" + encodedSsid + "," + encodedPass + "," + worker + "," + token + "," + interval + "," + start + "," + end + "," + extAntStr;

        targetCharacteristic.setValue(payload.getBytes(StandardCharsets.UTF_8));
        bluetoothGatt.writeCharacteristic(targetCharacteristic);

        statusText.setText("Status: Credentials sent! Device rebooting...");
        Toast.makeText(this, "Provisioned successfully!", Toast.LENGTH_LONG).show();

        handler.postDelayed(this::finish, 3000);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (bluetoothGatt != null) {
            bluetoothGatt.disconnect();
            bluetoothGatt.close();
        }
    }
}