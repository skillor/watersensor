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
        <!-- Tailwind + DaisyUI -->
        <link href="https://cdn.jsdelivr.net/npm/daisyui@4.7.2/dist/full.min.css" rel="stylesheet" type="text/css" />
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      </head>
      <body class="bg-base-100 text-base-content font-sans p-4 md:p-6 min-h-screen">
        <div class="max-w-4xl mx-auto space-y-6">

          <!-- Header -->
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

          <!-- Latest Stat Cards -->
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="card bg-base-200 shadow-sm border border-base-300">
              <div class="card-body p-5">
                <p class="text-sm opacity-70 mb-1" data-i18n="calcValue">Calculated Value</p>
                <p id="latestValCard" class="text-3xl font-extrabold text-primary" data-i18n="loading">Loading...</p>
              </div>
            </div>
            <div class="card bg-base-200 shadow-sm border border-base-300">
              <div class="card-body p-5">
                <p class="text-sm opacity-70 mb-1" data-i18n="batteryLevel">Battery Level</p>
                <p id="latestBatteryCard" class="text-3xl font-extrabold text-success" data-i18n="loading">Loading...</p>
              </div>
            </div>
            <div class="card bg-base-200 shadow-sm border border-base-300">
              <div class="card-body p-5">
                <p class="text-sm opacity-70 mb-1" data-i18n="predictionStatus">Prediction Status</p>
                <p id="timeToFull" class="text-2xl font-bold text-warning" data-i18n="calculating">Calculating...</p>
              </div>
            </div>
          </div>

          <!-- Chart Card -->
          <div class="card bg-base-200 shadow-sm border border-base-300">
            <div class="card-body p-5">
              <h2 class="card-title text-lg mb-4" data-i18n="historyTrend">Water Metric History & Trend</h2>
              <div class="relative h-64 w-full">
                <canvas id="waterChart"></canvas>
              </div>
            </div>
          </div>

          <!-- ADMIN SETTINGS PANEL -->
          ${!isPublic ? `
          <div class="card bg-base-200 shadow-sm border border-base-300">
            <div class="card-body p-5">
              <h2 class="card-title text-lg text-primary mb-4" data-i18n="settingsFormula">⚙️ Settings & Formula</h2>
              <form id="settingsForm" onsubmit="saveSettings(event)" class="space-y-4">

                <div class="form-control w-full">
                  <label class="label"><span class="label-text opacity-70" data-i18n="publicLink">Public Shareable Link</span></label>
                  <div class="join w-full">
                    <input type="text" readonly value="${publicLink}" class="input input-bordered join-item w-full font-mono text-sm" />
                    <button type="button" onclick="navigator.clipboard.writeText('${publicLink}')" class="btn btn-neutral join-item" data-i18n="copy">Copy</button>
                  </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div class="form-control w-full">
                    <label class="label"><span class="label-text opacity-70" data-i18n="publicToken">Public Token String</span></label>
                    <input type="text" id="publicToken" value="${cfg.public_token}" class="input input-bordered w-full" required />
                  </div>
                  <div class="form-control w-full">
                    <label class="label"><span class="label-text opacity-70" data-i18n="customFormula">Custom Formula</span></label>
                    <input type="text" id="waterFormula" value="${safeFormulaHTML}" class="input input-bordered w-full font-mono" required />
                    <label class="label"><span class="label-text-alt opacity-60"><span data-i18n="example">Example</span>: <code>distance / 3</code></span></label>
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

          <!-- History Table -->
          <div class="card bg-base-200 shadow-sm border border-base-300">
            <div class="card-body p-5">
              <h2 class="card-title text-lg mb-4" data-i18n="readingLogs">Reading Logs (Last 50)</h2>
              <div class="overflow-x-auto">
                <table class="table table-zebra w-full">
                  <thead>
                    <tr class="opacity-70">
                      <th data-i18n="timestamp">Timestamp</th>
                      <th data-i18n="formulaResult">Formula Result</th>
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

          // --- i18n DICTIONARY ---
          const dict = {
            en: {
              title: "Water Tank Monitor",
              publicView: "Public Read-Only View",
              adminPanel: "Admin Panel",
              calcValue: "Calculated Value",
              batteryLevel: "Battery Level",
              predictionStatus: "Prediction Status",
              historyTrend: "Water Metric History & Trend",
              settingsFormula: "⚙️ Settings & Formula",
              publicLink: "Public Shareable Link",
              copy: "Copy",
              publicToken: "Public Token String",
              customFormula: "Custom Formula",
              example: "Example",
              saveSettings: "Save Settings",
              savedSuccess: "Saved successfully!",
              readingLogs: "Reading Logs (Last 50)",
              timestamp: "Timestamp",
              formulaResult: "Formula Result",
              rawDistance: "Raw Distance",
              battery: "Battery",
              loading: "Loading...",
              calculating: "Calculating...",
              noReadings: "No readings found",
              tankFull: "Tank is Full!",
              notEnoughData: "Not enough data",
              notFilling: "Not currently filling",
              mins: "mins",
              days: "days",
              hours: "hours",
              raw: "Raw"
            },
            de: {
              title: "Wassertank Monitor",
              publicView: "Öffentliche Ansicht",
              adminPanel: "Admin-Panel",
              calcValue: "Berechneter Wert",
              batteryLevel: "Batteriestand",
              predictionStatus: "Vorhersage",
              historyTrend: "Verlauf & Trend",
              settingsFormula: "⚙️ Einstellungen & Formel",
              publicLink: "Öffentlicher Link",
              copy: "Kopieren",
              publicToken: "Öffentliches Token",
              customFormula: "Eigene Formel",
              example: "Beispiel",
              saveSettings: "Speichern",
              savedSuccess: "Erfolgreich gespeichert!",
              readingLogs: "Messprotokolle (Letzte 50)",
              timestamp: "Zeitstempel",
              formulaResult: "Ergebnis",
              rawDistance: "Rohabstand",
              battery: "Batterie",
              loading: "Wird geladen...",
              calculating: "Berechne...",
              noReadings: "Keine Messwerte gefunden",
              tankFull: "Tank ist voll!",
              notEnoughData: "Nicht genug Daten",
              notFilling: "Wird aktuell nicht gefüllt",
              mins: "Minuten",
              days: "Tage",
              hours: "Stunden",
              raw: "Roh"
            }
          };

          // --- LANGUAGE STATE MANAGEMENT ---
          let currentLang = localStorage.getItem('appLang');
          if (!currentLang) {
            currentLang = (navigator.language || 'en').startsWith('de') ? 'de' : 'en';
          }

          function toggleLanguage() {
            currentLang = currentLang === 'en' ? 'de' : 'en';
            localStorage.setItem('appLang', currentLang);
            updateLangButton();
            applyTranslations();
            renderDashboardUI(); // Re-render dynamic components (charts, tables)
          }

          function updateLangButton() {
            const btn = document.getElementById('langToggleBtn');
            if (btn) {
              // Show the flag of the language they can switch TO
              btn.innerText = currentLang === 'en' ? '🇩🇪 DE' : '🇬🇧 EN';
            }
          }

          // Translation Helper
          function t(key) {
            return dict[currentLang][key] || key;
          }

          // Apply translations to static DOM elements
          function applyTranslations() {
            document.querySelectorAll('[data-i18n]').forEach(function(el) {
              const key = el.getAttribute('data-i18n');
              if (dict[currentLang][key]) el.innerText = dict[currentLang][key];
            });
            document.documentElement.lang = currentLang;
          }

          // Format UTC string to local browser timezone
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
            let formula = formulaString && formulaString.trim().length > 0 ? formulaString : '((200 - distance) / 180) * 100';
            formula = formula.replace(new RegExp(String.fromCharCode(160), 'g'), ' ').trim();
            try {
              const evalFn = new Function('distance', 'return Number(' + formula + ');');
              let result = evalFn(d);
              if (isNaN(result)) return 0;
              return Math.round(result * 10) / 10;
            } catch (e) { return 0; }
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
              document.getElementById('logsTableBody').innerHTML = '<tr><td colspan="4" class="py-4 text-center opacity-50">' + t('noReadings') + '</td></tr>';
              return;
            }

            const latest = rawReadings[0];
            const latestVal = evaluateFormula(latest.distance, currentFormula);
            const batteryPct = getBatteryPercentage(latest.battery);
            const batteryVolt = Number(latest.battery).toFixed(2);

            document.getElementById('latestValCard').innerHTML = latestVal + ' <span class="text-sm opacity-60 font-normal">(' + t('raw') + ': ' + latest.distance + 'cm)</span>';
            document.getElementById('latestBatteryCard').innerHTML = batteryPct + '% <span class="text-sm opacity-60 font-normal">(' + batteryVolt + 'V)</span>';

            const tbody = document.getElementById('logsTableBody');
            tbody.innerHTML = rawReadings.map(function(r) {
              return '<tr class="text-sm">' +
                '<td class="py-3 font-mono opacity-80">' + formatLocalDate(r.timestamp) + '</td>' +
                '<td class="py-3 text-primary font-bold">' + evaluateFormula(r.distance, currentFormula) + '</td>' +
                '<td class="py-3 opacity-80">' + r.distance + ' cm</td>' +
                '<td class="py-3 text-success font-semibold">' + getBatteryPercentage(r.battery) + '% <span class="text-xs opacity-60 font-normal">(' + Number(r.battery).toFixed(2) + 'V)</span></td>' +
              '</tr>';
            }).join('');

            updateChart();
            updatePrediction();
            applyTranslations(); // Re-apply in case dynamic elements overwrote static ones
          }

          let waterChart = null;
          function updateChart() {
            const chartData = [...rawReadings].reverse().map(function(r) {
              return { timestamp: formatLocalDate(r.timestamp), value: evaluateFormula(r.distance, currentFormula) };
            });

            const ctx = document.getElementById('waterChart').getContext('2d');
            if (waterChart) waterChart.destroy();

            // Neutral chart colors that look good in Light and Dark mode
            const gridColor = 'rgba(150, 150, 150, 0.15)';
            const tickColor = '#888888';

            waterChart = new Chart(ctx, {
              type: 'line',
              data: {
                labels: chartData.map(function(d) { return d.timestamp; }),
                datasets: [{
                  label: t('formulaResult'),
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

            const latest = rawReadings[0];
            const latestVal = evaluateFormula(latest.distance, currentFormula);

            if (latestVal >= 100) {
              el.innerText = t('tankFull');
              return;
            }

            const sampleSize = Math.min(rawReadings.length, 10);
            const past = rawReadings[sampleSize - 1];
            const pastVal = evaluateFormula(past.distance, currentFormula);

            const timeDiffHours = (new Date(latest.timestamp.replace(' ', 'T') + 'Z') - new Date(past.timestamp.replace(' ', 'T') + 'Z')) / (1000 * 60 * 60);
            const valDiff = latestVal - pastVal;

            if (timeDiffHours <= 0 || valDiff <= 0) {
              el.innerText = t('notFilling');
              return;
            }

            const ratePerHour = valDiff / timeDiffHours;
            const remaining = 100 - latestVal;
            const hoursToFull = remaining / ratePerHour;

            if (hoursToFull < 1) {
              el.innerText = "~ " + Math.round(hoursToFull * 60) + " " + t('mins');
            } else if (hoursToFull > 48) {
              el.innerText = "2+ " + t('days');
            } else {
              el.innerText = "~ " + (Math.round(hoursToFull * 10) / 10) + " " + t('hours');
            }
          }

          // Initial Render
          updateLangButton();
          applyTranslations();
          renderDashboardUI();

          // Handle Settings Saves
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
