export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Ensure database tables exist
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS readings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, 
        distance INTEGER, 
        battery REAL, 
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, 
        value TEXT
      )
    `).run();

    // Helper to get settings with fallback defaults
    const getSettings = async () => {
      const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
      const settings = {
        public_token: env.PUBLIC_VIEW_TOKEN || 'my-default-public-token',
        water_formula: '((200 - distance) / 180) * 100' // Default formula
      };
      for (const row of results) {
        settings[row.key] = row.value;
      }
      return settings;
    };

    // ==========================================
    // 1. API ENDPOINT FOR ESP32 (POST /api/upload)
    // ==========================================
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      const token = request.headers.get('X-Sensor-Token');
      if (token !== env.SENSOR_SECRET_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }

      try {
        const body = await request.json();

        // 50-second cooldown guardrail
        const lastEntry = await env.DB.prepare(
          'SELECT timestamp FROM readings ORDER BY timestamp DESC LIMIT 1'
        ).first();

        if (lastEntry) {
          const lastTime = new Date(lastEntry.timestamp + ' UTC').getTime();
          const now = Date.now();
          if ((now - lastTime) / 1000 < Number(env.RATE_LIMIT)) {
            return new Response('Skipped: Rate limit cooldown active', { status: 200 });
          }
        }

        await env.DB.prepare(
          'INSERT INTO readings (distance, battery) VALUES (?, ?)'
        ).bind(body.distance, body.battery).run();

        // 2-year retention guardrail
        await env.DB.prepare(`
          DELETE FROM readings 
          WHERE timestamp < datetime('now', '-2 years')
        `).run();

        return new Response('Success', { status: 200 });
      } catch (e) {
        return new Response('Error: ' + e.message, { status: 400 });
      }
    }

    // ==========================================
    // 2. ADMIN SETTINGS UPDATE API (POST /api/settings)
    // ==========================================
    if (url.pathname === '/api/settings' && request.method === 'POST') {
      const auth = request.headers.get('Authorization');
      if (!auth || !auth.startsWith('Basic ')) {
        return new Response('Unauthorized', { status: 401 });
      }
      const b64Creds = auth.split(' ')[1];
      const creds = atob(b64Creds).split(':');
      if (creds[0] !== env.ADMIN_USER || creds[1] !== env.ADMIN_PASS) {
        return new Response('Invalid credentials', { status: 403 });
      }

      try {
        const body = await request.json();
        const { public_token, water_formula } = body;

        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('public_token', public_token).run();
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('water_formula', water_formula).run();

        return new Response('Settings updated successfully', { status: 200 });
      } catch (e) {
        return new Response('Error saving settings: ' + e.message, { status: 400 });
      }
    }

    const settings = await getSettings();

    // ==========================================
    // 3. PUBLIC SHARED URL & ADMIN DASHBOARD
    // ==========================================
    const publicToken = url.searchParams.get('token');
    const isPublicReq = publicToken && publicToken === settings.public_token;

    if (!isPublicReq) {
      const auth = request.headers.get('Authorization');
      if (!auth || !auth.startsWith('Basic ')) {
        return new Response('Authentication required', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="Water Tank Dashboard"' },
        });
      }

      const b64Creds = auth.split(' ')[1];
      const creds = atob(b64Creds).split(':');
      if (creds[0] !== env.ADMIN_USER || creds[1] !== env.ADMIN_PASS) {
        return new Response('Invalid credentials', { status: 403 });
      }
    }

    const { results } = await env.DB.prepare(
      'SELECT * FROM readings ORDER BY timestamp DESC LIMIT 50'
    ).all();

    return new Response(renderDashboard(results, settings, isPublicReq), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });

    // --- HTML RENDER HELPER ---
    function renderDashboard(results, cfg, isPublic) {
      const publicLink = `${url.origin}/?token=${cfg.public_token}`;
      const safeFormulaHTML = (cfg.water_formula || '').replace(/"/g, '&quot;');

      return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Water Tank Monitor</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      </head>
      <body class="bg-gray-900 text-white font-sans p-6">
        <div class="max-w-3xl mx-auto">
          <div class="flex justify-between items-center mb-6">
            <h1 class="text-3xl font-bold text-cyan-400">💧 Water Tank Monitor</h1>
            ${isPublic ? '<span class="bg-blue-900 text-blue-300 text-xs px-3 py-1 rounded-full font-semibold border border-blue-700">Public Read-Only View</span>' : '<span class="bg-emerald-900 text-emerald-300 text-xs px-3 py-1 rounded-full font-semibold border border-emerald-700">Admin Panel</span>'}
          </div>
          
          <!-- Latest Stat Cards -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div class="bg-gray-800 p-5 rounded-xl shadow-lg border border-gray-700">
              <p class="text-sm text-gray-400 mb-1">Calculated Value</p>
              <p id="latestValCard" class="text-2xl font-extrabold text-cyan-300">Loading...</p>
            </div>
            <div class="bg-gray-800 p-5 rounded-xl shadow-lg border border-gray-700">
              <p class="text-sm text-gray-400 mb-1">Battery Level</p>
              <p id="latestBatteryCard" class="text-2xl font-extrabold text-green-400">Loading...</p>
            </div>
            <div class="bg-gray-800 p-5 rounded-xl shadow-lg border border-gray-700">
              <p class="text-sm text-gray-400 mb-1">Prediction Status</p>
              <p id="timeToFull" class="text-xl font-bold text-yellow-400">Calculating...</p>
            </div>
          </div>

          <!-- Chart Card -->
          <div class="bg-gray-800 p-6 rounded-xl shadow-lg mb-6 border border-gray-700">
            <h2 class="text-lg font-medium text-gray-300 mb-4">Water Metric History & Trend</h2>
            <div class="relative h-64 w-full">
              <canvas id="waterChart"></canvas>
            </div>
          </div>

          <!-- ADMIN SETTINGS PANEL -->
          ${!isPublic ? `
          <div class="bg-gray-800 p-6 rounded-xl shadow-lg mb-6 border border-gray-700">
            <h2 class="text-lg font-medium text-cyan-300 mb-4">⚙️ Settings & Formula</h2>
            <form id="settingsForm" onsubmit="saveSettings(event)" class="space-y-4">
              <div>
                <label class="block text-sm text-gray-400 mb-1">Public Shareable Link</label>
                <div class="flex gap-2">
                  <input type="text" readonly value="${publicLink}" class="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm w-full text-gray-300 select-all"/>
                  <button type="button" onclick="navigator.clipboard.writeText('${publicLink}')" class="bg-gray-700 hover:bg-gray-600 px-3 py-2 rounded text-sm font-semibold">Copy</button>
                </div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label class="block text-sm text-gray-400 mb-1">Public Token String</label>
                  <input type="text" id="publicToken" value="${cfg.public_token}" class="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm w-full text-white" required />
                </div>
                <div>
                  <label class="block text-sm text-gray-400 mb-1">Custom Formula</label>
                  <input type="text" id="waterFormula" value="${safeFormulaHTML}" class="bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm w-full text-white font-mono" required />
                  <p class="text-xs text-gray-500 mt-1">Example: <code>distance / 3</code> or <code>200 - distance</code></p>
                </div>
              </div>
              <div class="flex items-center gap-3 pt-2">
                <button type="submit" class="bg-cyan-600 hover:bg-cyan-500 text-white font-semibold px-4 py-2 rounded text-sm transition">Save Settings</button>
                <span id="saveStatus" class="text-sm text-green-400 hidden">Saved successfully!</span>
              </div>
            </form>
          </div>
          ` : ''}

          <!-- History Table -->
          <div class="bg-gray-800 p-6 rounded-xl shadow-lg border border-gray-700">
            <h2 class="text-lg font-medium text-gray-300 mb-4">Reading Logs (Last 50)</h2>
            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse">
                <thead>
                  <tr class="border-b border-gray-700 text-gray-400 text-sm">
                    <th class="py-2 px-3">Timestamp</th>
                    <th class="py-2 px-3">Formula Result</th>
                    <th class="py-2 px-3">Raw Distance</th>
                    <th class="py-2 px-3">Battery</th>
                  </tr>
                </thead>
                <tbody id="logsTableBody">
                  <!-- Populated dynamically via client-side script -->
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <script>
          const rawReadings = ${JSON.stringify(results)};
          let currentFormula = ${JSON.stringify(cfg.water_formula)};

          // Helper to convert SQLite UTC strings to local browser time
          function formatLocalDate(utcString) {
            if (!utcString) return '';
            const dateObj = new Date(utcString.replace(' ', 'T') + 'Z');
            if (isNaN(dateObj.getTime())) return utcString;
            return dateObj.toLocaleString(undefined, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit'
            });
          }

          function evaluateFormula(distance, formulaString) {
            const d = parseFloat(distance);
            if (isNaN(d)) return 0;
            
            let formula = formulaString && formulaString.trim().length > 0 ? formulaString : '((200 - distance) / 180) * 100';
            formula = formula.replace(new RegExp(String.fromCharCode(160), 'g'), ' ').trim();
            
            try {
              const evalFn = new Function('distance', 'return Number(' + formula + ');');
              let result = evalFn(d);
              if (isNaN(result)) return 0;
              return Math.round(result * 10) / 10;
            } catch (e) {
              console.error("Client Formula Error for expression:", formula, e);
              return 0;
            }
          }

          function getBatteryPercentage(voltage) {
            const v = parseFloat(voltage);
            if (isNaN(v)) return 0;
            const pct = ((v - 3.3) / (4.2 - 3.3)) * 100;
            return Math.min(Math.max(Math.round(pct), 0), 100);
          }

          function renderDashboardUI() {
            if (rawReadings.length === 0) {
              document.getElementById('latestValCard').innerText = 'N/A';
              document.getElementById('latestBatteryCard').innerText = 'N/A';
              document.getElementById('logsTableBody').innerHTML = '<tr><td colspan="4" class="py-4 text-center text-gray-500">No readings found</td></tr>';
              return;
            }

            const latest = rawReadings[0];
            const latestVal = evaluateFormula(latest.distance, currentFormula);
            const batteryPct = getBatteryPercentage(latest.battery);
            const batteryVolt = Number(latest.battery).toFixed(2);

            document.getElementById('latestValCard').innerHTML = latestVal + ' <span class="text-sm text-gray-400 font-normal">(Raw: ' + latest.distance + 'cm)</span>';
            document.getElementById('latestBatteryCard').innerHTML = batteryPct + '% <span class="text-sm text-gray-400 font-normal">(' + batteryVolt + 'V)</span>';

            const tbody = document.getElementById('logsTableBody');
            tbody.innerHTML = rawReadings.map(function(r) {
              return '<tr class="border-b border-gray-700/50 hover:bg-gray-700/30 text-sm">' +
                '<td class="py-2.5 px-3 text-gray-300">' + formatLocalDate(r.timestamp) + '</td>' +
                '<td class="py-2.5 px-3 text-cyan-300 font-semibold">' + evaluateFormula(r.distance, currentFormula) + '</td>' +
                '<td class="py-2.5 px-3 text-gray-400">' + r.distance + ' cm</td>' +
                '<td class="py-2.5 px-3 text-green-300 font-semibold">' + getBatteryPercentage(r.battery) + '% <span class="text-xs text-gray-400 font-normal">(' + Number(r.battery).toFixed(2) + 'V)</span></td>' +
              '</tr>';
            }).join('');

            updateChart();
            updatePrediction();
          }

          let waterChart = null;
          function updateChart() {
            const chartData = [...rawReadings].reverse().map(function(r) {
              return { timestamp: formatLocalDate(r.timestamp), value: evaluateFormula(r.distance, currentFormula) };
            });

            const ctx = document.getElementById('waterChart').getContext('2d');
            if (waterChart) waterChart.destroy();

            waterChart = new Chart(ctx, {
              type: 'line',
              data: {
                labels: chartData.map(function(d) { return d.timestamp; }),
                datasets: [{
                  label: 'Formula Value',
                  data: chartData.map(function(d) { return d.value; }),
                  borderColor: '#00e5ff',
                  backgroundColor: 'rgba(0, 229, 255, 0.1)',
                  borderWidth: 2,
                  fill: true,
                  tension: 0.3
                }]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                  y: { grid: { color: 'rgba(255, 255, 255, 0.1)' }, ticks: { color: '#9ca3af' } },
                  x: { grid: { display: false }, ticks: { color: '#9ca3af', maxTicksLimit: 6 } }
                },
                plugins: { legend: { display: false } }
              }
            });
          }

          function updatePrediction() {
            const el = document.getElementById('timeToFull');
            if (!el) return;

            if (rawReadings.length < 2) {
              el.innerText = "Not enough data";
              return;
            }

            const latest = rawReadings[0];
            const latestVal = evaluateFormula(latest.distance, currentFormula);
            
            if (latestVal >= 100) {
              el.innerText = "Tank is Full!";
              return;
            }

            const sampleSize = Math.min(rawReadings.length, 10);
            const past = rawReadings[sampleSize - 1];
            const pastVal = evaluateFormula(past.distance, currentFormula);

            const timeDiffHours = (new Date(latest.timestamp.replace(' ', 'T') + 'Z') - new Date(past.timestamp.replace(' ', 'T') + 'Z')) / (1000 * 60 * 60);
            const valDiff = latestVal - pastVal;

            if (timeDiffHours <= 0 || valDiff <= 0) {
              el.innerText = "Not currently filling";
              return;
            }

            const ratePerHour = valDiff / timeDiffHours;
            const remaining = 100 - latestVal;
            const hoursToFull = remaining / ratePerHour;

            if (hoursToFull < 1) {
              el.innerText = "~ " + Math.round(hoursToFull * 60) + " mins";
            } else if (hoursToFull > 48) {
              el.innerText = "2+ days";
            } else {
              el.innerText = "~ " + (Math.round(hoursToFull * 10) / 10) + " hours";
            }
          }

          renderDashboardUI();

          async function saveSettings(e) {
            e.preventDefault();
            const newFormula = document.getElementById('waterFormula').value;
            const payload = {
              public_token: document.getElementById('publicToken').value,
              water_formula: newFormula
            };

            const res = await fetch('/api/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });

            if (res.ok) {
              currentFormula = newFormula;
              renderDashboardUI();
              const status = document.getElementById('saveStatus');
              status.classList.remove('hidden');
              setTimeout(function() { status.classList.add('hidden'); }, 2000);
            } else {
              alert('Failed to save settings.');
            }
          }
        </script>
      </body>
      </html>`;
    }
  }
};