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
        water_formula: '(-0.5 * distance) + 150',
        battery_formula: '(100 * battery) - 360'
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
        const { public_token, water_formula, battery_formula } = body;

        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('public_token', public_token).run();
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('water_formula', water_formula).run();
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind('battery_formula', battery_formula).run();

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
      const safeBattFormulaHTML = (cfg.battery_formula || '').replace(/"/g, '&quot;');

      return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Water Tank Monitor</title>
        <link href="https://cdn.jsdelivr.net/npm/daisyui@4.7.2/dist/full.min.css" rel="stylesheet" type="text/css" />
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
				<style>
					/* Force dark zebra stripes and hover effect inside base-200 cards */
					.custom-zebra tbody tr:nth-child(even) td {
						background-color: oklch(var(--b3)) !important;
					}
					.custom-zebra tbody tr:hover td {
						background-color: oklch(var(--bc) / 0.05) !important;
					}
				</style>
      </head>
      <body class="bg-base-100 text-base-content font-sans p-4 md:p-6 min-h-screen">
        <div class="max-w-4xl mx-auto space-y-6">

          <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div class="flex items-center gap-3">
              <h1 class="text-3xl font-bold text-primary flex items-center gap-2">
                💧 <span data-i18n="title">Water Tank Monitor</span>
              </h1>
              <button onclick="toggleLanguage()" id="langToggleBtn" class="btn btn-sm btn-outline btn-primary ml-2 rounded-full px-3">
                🇩🇪 DE
              </button>
            </div>
            ${isPublic
              ? '<div class="badge badge-info badge-outline font-semibold" data-i18n="publicView">Public Read-Only View</div>'
              : '<div class="badge badge-success badge-outline font-semibold" data-i18n="adminPanel">Admin Panel</div>'
            }
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="card bg-base-200 shadow-sm border border-base-300">
              <div class="card-body p-5">
                <p class="text-sm opacity-70 mb-1" data-i18n="calcValue">Calculated Level</p>
                <!-- Removed data-i18n to prevent overwriting dynamic data -->
                <p id="latestValCard" class="text-3xl font-extrabold text-primary">Loading...</p>
              </div>
            </div>
            <div class="card bg-base-200 shadow-sm border border-base-300">
              <div class="card-body p-5">
                <p class="text-sm opacity-70 mb-1" data-i18n="batteryLevel">Battery Level</p>
                <!-- Removed data-i18n to prevent overwriting dynamic data -->
                <p id="latestBatteryCard" class="text-3xl font-extrabold text-success">Loading...</p>
              </div>
            </div>
            <div class="card bg-base-200 shadow-sm border border-base-300">
              <div class="card-body p-5">
                <p class="text-sm opacity-70 mb-1" data-i18n="predictionStatus">Prediction Status</p>
                <!-- Removed data-i18n to prevent overwriting dynamic data -->
                <p id="timeToFull" class="text-2xl font-bold text-warning">Calculating...</p>
              </div>
            </div>
          </div>

          <div class="card bg-base-200 shadow-sm border border-base-300">
            <div class="card-body p-5">
              <h2 class="card-title text-lg mb-4" data-i18n="historyTrend">Water Metric History & Trend</h2>
              <div class="relative h-64 w-full">
                <canvas id="waterChart"></canvas>
              </div>
            </div>
          </div>

          ${!isPublic ? `
          <div class="card bg-base-200 shadow-sm border border-base-300">
            <div class="card-body p-5">
              <h2 class="card-title text-lg text-primary mb-4" data-i18n="settingsFormula">⚙️ Settings & Formulas</h2>
              <form id="settingsForm" onsubmit="saveSettings(event)" class="space-y-4">
                <div class="form-control w-full">
                  <label class="label"><span class="label-text opacity-70" data-i18n="publicLink">Public Shareable Link</span></label>
                  <div class="join w-full">
                    <input type="text" readonly value="${publicLink}" class="input input-bordered join-item w-full font-mono text-sm" />
                    <button type="button" onclick="navigator.clipboard.writeText('${publicLink}')" class="btn btn-neutral join-item" data-i18n="copy">Copy</button>
                  </div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div class="form-control w-full">
                    <label class="label"><span class="label-text opacity-70" data-i18n="publicToken">Public Token String</span></label>
                    <input type="text" id="publicToken" value="${cfg.public_token}" class="input input-bordered w-full" required />
                  </div>
                  <div class="form-control w-full">
                    <label class="label"><span class="label-text opacity-70" data-i18n="customFormula">Water Formula (%)</span></label>
                    <input type="text" id="waterFormula" value="${safeFormulaHTML}" class="input input-bordered w-full font-mono" required />
                    <label class="label"><span class="label-text-alt opacity-60">Ex: <code>(-0.5 * distance) + 150</code></span></label>
                  </div>
                  <div class="form-control w-full">
                    <label class="label"><span class="label-text opacity-70" data-i18n="batteryFormula">Battery Formula (%)</span></label>
                    <input type="text" id="batteryFormula" value="${safeBattFormulaHTML}" class="input input-bordered w-full font-mono" required />
                    <label class="label"><span class="label-text-alt opacity-60">Ex: <code>(100 * battery) - 360</code></span></label>
                  </div>
                </div>
                <div class="flex items-center gap-3 pt-2">
                  <button type="submit" class="btn btn-primary" data-i18n="saveSettings">Save Settings</button>
                  <span id="saveStatus" class="text-sm text-success hidden" data-i18n="savedSuccess">Saved successfully!</span>
                </div>
              </form>
            </div>
          </div>
          ` : ''}

          <div class="card bg-base-200 shadow-sm border border-base-300">
            <div class="card-body p-5">
              <h2 class="card-title text-lg mb-4" data-i18n="readingLogs">Reading Logs (Last 50)</h2>
              <div class="overflow-x-auto">
                <table class="table custom-zebra w-full">
                  <thead>
                    <tr class="opacity-70">
                      <th data-i18n="timestamp">Timestamp</th>
                      <th data-i18n="formulaResult">Calculated %</th>
                      <th data-i18n="rawDistance">Raw Distance</th>
                      <th data-i18n="battery">Battery</th>
                    </tr>
                  </thead>
                  <tbody id="logsTableBody">
                    <!-- Populated dynamically via client-side script -->
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <script>
          const rawReadings = ${JSON.stringify(results)};
          let currentFormula = ${JSON.stringify(cfg.water_formula)};
          let currentBattFormula = ${JSON.stringify(cfg.battery_formula)};

          const dict = {
            en: {
              title: "Water Tank Monitor",
              publicView: "Public Read-Only View",
              adminPanel: "Admin Panel",
              calcValue: "Calculated Level",
              batteryLevel: "Battery Level",
              predictionStatus: "Prediction Status",
              historyTrend: "Water Metric History & Trend",
              settingsFormula: "⚙️ Settings & Formulas",
              publicLink: "Public Shareable Link",
              copy: "Copy",
              publicToken: "Public Token String",
              customFormula: "Water Formula (%)",
              batteryFormula: "Battery Formula (%)",
              example: "Example",
              saveSettings: "Save Settings",
              savedSuccess: "Saved successfully!",
              readingLogs: "Reading Logs (Last 50)",
              timestamp: "Timestamp",
              formulaResult: "Calculated %",
              rawDistance: "Raw Distance",
              battery: "Battery",
              loading: "Loading...",
              calculating: "Calculating...",
              noReadings: "No readings found",
              tankFull: "Tank is Full!",
              notEnoughData: "Not enough data",
              notFilling: "Not currently filling",
							daysUntilFull: "days until full"
            },
            de: {
              title: "Wassertank Monitor",
              publicView: "Öffentliche Ansicht",
              adminPanel: "Admin-Panel",
              calcValue: "Füllstand",
              batteryLevel: "Batteriestand",
              predictionStatus: "Vorhersage",
              historyTrend: "Verlauf & Trend",
              settingsFormula: "⚙️ Einstellungen & Formeln",
              publicLink: "Öffentlicher Link",
              copy: "Kopieren",
              publicToken: "Öffentliches Token",
              customFormula: "Wasserformel (%)",
              batteryFormula: "Batterieformel (%)",
              example: "Beispiel",
              saveSettings: "Speichern",
              savedSuccess: "Erfolgreich gespeichert!",
              readingLogs: "Messprotokolle (Letzte 50)",
              timestamp: "Zeitstempel",
              formulaResult: "Berechnet %",
              rawDistance: "Rohabstand",
              battery: "Batterie",
              loading: "Wird geladen...",
              calculating: "Berechne...",
              noReadings: "Keine Messwerte gefunden",
              tankFull: "Tank ist voll!",
              notEnoughData: "Nicht genug Daten",
              notFilling: "Wird aktuell nicht gefüllt",
							daysUntilFull: "Tage bis voll"
            }
          };

          // --- BULLETPROOF LANGUAGE SETUP ---
          let currentLang = 'en';
          try {
            const saved = localStorage.getItem('appLang');
            if (saved && dict[saved]) {
              currentLang = saved;
            } else {
              currentLang = (navigator.language || 'en').startsWith('de') ? 'de' : 'en';
            }
          } catch(e) {
            currentLang = (navigator.language || 'en').startsWith('de') ? 'de' : 'en';
          }

          function toggleLanguage() {
            currentLang = currentLang === 'en' ? 'de' : 'en';
            try { localStorage.setItem('appLang', currentLang); } catch(e) {}
            updateLangButton();
            applyTranslations(); // Only translates static HTML framework
            renderDashboardUI(); // Re-renders dynamic data with new translation variables
          }

          function updateLangButton() {
            const btn = document.getElementById('langToggleBtn');
            if (btn) btn.innerText = currentLang === 'en' ? '🇩🇪 DE' : '🇬🇧 EN';
          }

          function t(key) {
            if (!dict[currentLang]) currentLang = 'en';
            return dict[currentLang][key] || key;
          }

          function applyTranslations() {
            document.querySelectorAll('[data-i18n]').forEach(function(el) {
              const key = el.getAttribute('data-i18n');
              if (dict[currentLang] && dict[currentLang][key]) el.innerText = dict[currentLang][key];
            });
            document.documentElement.lang = currentLang;
          }

          function formatLocalDate(utcString) {
            if (!utcString) return '';
            const dateObj = new Date(utcString.replace(' ', 'T') + 'Z');
            if (isNaN(dateObj.getTime())) return utcString;
            return dateObj.toLocaleString(undefined, {
              year: 'numeric', month: 'short', day: 'numeric',
              hour: '2-digit', minute: '2-digit', second: '2-digit'
            });
          }

          function evaluateFormula(distance, formulaString) {
            const d = parseFloat(distance);
            if (isNaN(d)) return 0;
            let formula = formulaString && formulaString.trim().length > 0 ? formulaString : '(-0.5 * distance) + 150';
            formula = formula.replace(new RegExp(String.fromCharCode(160), 'g'), ' ').trim();
            try {
              const evalFn = new Function('distance', 'return Number(' + formula + ');');
              let result = evalFn(d);
              if (isNaN(result)) return 0;
              return Math.round(result * 10) / 10;
            } catch (e) { return 0; }
          }

          function evaluateBattery(voltage, formulaString) {
            const b = parseFloat(voltage);
            if (isNaN(b)) return 0;
            let formula = formulaString && formulaString.trim().length > 0 ? formulaString : '(100 * battery) - 360';
            formula = formula.replace(new RegExp(String.fromCharCode(160), 'g'), ' ').trim();
            try {
              const evalFn = new Function('battery', 'return Number(' + formula + ');');
              let result = evalFn(b);
              if (isNaN(result)) return 0;
              return Math.min(Math.max(Math.round(result), 0), 100);
            } catch (e) { return 0; }
          }

          function renderDashboardUI() {
            try {
              if (!rawReadings || rawReadings.length === 0) {
                document.getElementById('latestValCard').innerText = 'N/A';
                document.getElementById('latestBatteryCard').innerText = 'N/A';
                document.getElementById('timeToFull').innerText = 'N/A';
                document.getElementById('logsTableBody').innerHTML = '<tr><td colspan="4" class="py-4 text-center opacity-50">' + t('noReadings') + '</td></tr>';
                return;
              }

              const latest = rawReadings[0];
              const latestVal = evaluateFormula(latest.distance, currentFormula);
              const batteryPct = evaluateBattery(latest.battery, currentBattFormula);
              const rawBatt = latest.battery ? Number(latest.battery).toFixed(2) : '0.00';

              document.getElementById('latestValCard').innerHTML = latestVal + '% <span class="text-sm opacity-60 font-normal">(' + latest.distance + 'cm)</span>';
              document.getElementById('latestBatteryCard').innerHTML = batteryPct + '% <span class="text-sm opacity-60 font-normal">(' + rawBatt + 'V)</span>';

              const tbody = document.getElementById('logsTableBody');
              tbody.innerHTML = rawReadings.map(function(r) {
                const rBatt = r.battery ? Number(r.battery).toFixed(2) : '0.00';
                return '<tr class="text-sm transition-colors">' +
                  '<td class="py-3 font-mono opacity-80">' + formatLocalDate(r.timestamp) + '</td>' +
                  '<td class="py-3 text-primary font-bold">' + evaluateFormula(r.distance, currentFormula) + '%</td>' +
                  '<td class="py-3 opacity-80">' + r.distance + ' cm</td>' +
                  '<td class="py-3 text-success font-semibold">' + evaluateBattery(r.battery, currentBattFormula) + '% <span class="text-xs opacity-60 font-normal">(' + rBatt + 'V)</span></td>' +
                '</tr>';
              }).join('');

              updateChart();
              updatePrediction();

            } catch (error) {
              console.error("Dashboard rendering error:", error);
              document.getElementById('latestValCard').innerText = 'Error';
              document.getElementById('latestBatteryCard').innerText = 'Error';
              document.getElementById('timeToFull').innerText = 'Error';
            }
          }

          let waterChart = null;
          function updateChart() {
            if (!window.Chart) return;

            const chartData = [...rawReadings].reverse().map(function(r) {
              return { timestamp: formatLocalDate(r.timestamp), value: evaluateFormula(r.distance, currentFormula) };
            });

            const ctx = document.getElementById('waterChart').getContext('2d');
            if (waterChart) waterChart.destroy();

            const gridColor = 'rgba(150, 150, 150, 0.15)';
            const tickColor = '#888888';

            waterChart = new Chart(ctx, {
              type: 'line',
              data: {
                labels: chartData.map(function(d) { return d.timestamp; }),
                datasets: [{
                  label: t('formulaResult') + ' (%)',
                  data: chartData.map(function(d) { return d.value; }),
                  borderColor: '#3b82f6',
                  backgroundColor: 'rgba(59, 130, 246, 0.15)',
                  borderWidth: 3,
                  fill: true,
                  tension: 0.4
                }]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                  y: { grid: { color: gridColor }, ticks: { color: tickColor } },
                  x: { grid: { display: false }, ticks: { color: tickColor, maxTicksLimit: 6 } }
                },
                plugins: { legend: { display: false } }
              }
            });
          }

          function updatePrediction() {
            const el = document.getElementById('timeToFull');
            if (!el) return;

            if (rawReadings.length < 2) {
              el.innerText = t('notEnoughData');
              return;
            }

            const latestVal = evaluateFormula(rawReadings[0].distance, currentFormula);
            if (latestVal >= 100) {
              el.innerText = t('tankFull');
              return;
            }

            let totalIncrease = 0;
            let daysFilling = 0;

            for (let i = 0; i < rawReadings.length - 1; i++) {
              const current = rawReadings[i];
              const prev = rawReadings[i + 1];

              const currentV = evaluateFormula(current.distance, currentFormula);
              const prevV = evaluateFormula(prev.distance, currentFormula);
              const diffVal = currentV - prevV;

              if (diffVal > 0) {
                const t1 = new Date(current.timestamp.replace(' ', 'T') + 'Z').getTime();
                const t2 = new Date(prev.timestamp.replace(' ', 'T') + 'Z').getTime();
                const diffDays = (t1 - t2) / (1000 * 60 * 60 * 24);

                if (diffDays > 0 && diffDays < 30) {
                  totalIncrease += diffVal;
                  daysFilling += diffDays;
                }
              }
            }

            if (totalIncrease <= 0 || daysFilling <= 0) {
              el.innerText = t('notFilling');
              return;
            }

            const avgDailyIncrease = totalIncrease / daysFilling;
            const remaining = 100 - latestVal;
            const daysToFull = Math.ceil(remaining / avgDailyIncrease);

            el.innerText = "~ " + daysToFull + " " + t('daysUntilFull');
          }

          // Initial Render - No redundant applyTranslations needed in renderDashboardUI
          updateLangButton();
          applyTranslations();
          renderDashboardUI();

          // Handle Settings Saves
          async function saveSettings(e) {
            e.preventDefault();
            const newFormula = document.getElementById('waterFormula').value;
            const newBattFormula = document.getElementById('batteryFormula').value;
            const payload = {
              public_token: document.getElementById('publicToken').value,
              water_formula: newFormula,
              battery_formula: newBattFormula
            };

            const res = await fetch('/api/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });

            if (res.ok) {
              currentFormula = newFormula;
              currentBattFormula = newBattFormula;
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
