// ═══════════════════════════════════════════════════════════════
//  Smart Traffic Light — script.js  (production-ready)
//  All values come from Supabase / ESP32 only.
//  Nothing initializes until real data arrives.
// ═══════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {

  // ─── SUPABASE CREDENTIALS ─────────────────────────────────────
  const SUPABASE_URL = 'https://xpgfddrfhnougwnggrgk.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwZ2ZkZHJmaG5vdWd3bmdncmdrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwNTkyMTEsImV4cCI6MjA4OTYzNTIxMX0.LAuDx_ZFg_ECrI3ydKqzJ0Pksi-Dqe-G0xo8yPXuIn0';

  // ─── RUNTIME STATE ────────────────────────────────────────────
  let supabase        = null;
  let realtimeChannel = null;
  let currentMode     = null;   // null = not yet loaded from DB
  let currentStatus   = null;   // null = not yet loaded from DB
  let countdownSec    = 0;
  let countdownMax    = 0;
  let countdownTimer  = null;
  let logEntries      = [];
  let usageChart      = null;
  let dataLoaded      = false;  // true only after first successful DB fetch
  let toastTimer      = null;

  const DURATIONS    = { GREEN: 60, YELLOW: 5, RED: 30 };
  const COLOR_CSS    = { RED: 'var(--red)', YELLOW: 'var(--yellow)', GREEN: 'var(--green)' };
  const VALID_COLORS = ['RED', 'YELLOW', 'GREEN'];

  // Human-friendly signal words shown above the countdown
  const SIGNAL_WORD  = { RED: 'STOP', YELLOW: 'SLOW', GREEN: 'GO' };

  // ─── SAFE DOM HELPERS ─────────────────────────────────────────
  function $(id)           { return document.getElementById(id); }
  function setText(id, v)  { const e = $(id); if (e) e.textContent = v; }
  function setClass(id, c) { const e = $(id); if (e) e.className   = c; }

  // ─── CACHED DOM REFS ──────────────────────────────────────────
  const lensRed          = $('lens-red');
  const lensYellow       = $('lens-yellow');
  const lensGreen        = $('lens-green');
  const statusLabel      = $('status-label');
  const countdownVal     = $('countdown-val');
  const countdownBarFill = $('countdown-bar-fill');

  // ─── TOAST ────────────────────────────────────────────────────
  function showToast(msg, isError = false) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className   = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; }, 3000);
  }

  // ─── LOADING OVERLAY ──────────────────────────────────────────
  const loadLeds   = [$('ll-r'), $('ll-y'), $('ll-g')].filter(Boolean);
  let   loadLedIdx = 0;
  let   loadInterval = loadLeds.length
    ? setInterval(() => {
        loadLeds.forEach((l, i) => {
          l.style.opacity = i === loadLedIdx % 3 ? '1' : '0.15';
        });
        loadLedIdx++;
      }, 350)
    : null;

  // Hard deadline: always dismiss loading after 6 s
  const loadingDeadline = setTimeout(hideLoading, 6000);

  function hideLoading() {
    clearTimeout(loadingDeadline);
    if (loadInterval) { clearInterval(loadInterval); loadInterval = null; }
    const el = $('loading');
    if (!el || el.style.display === 'none') return;
    el.style.opacity = '0';
    setTimeout(() => { el.style.display = 'none'; }, 400);
  }

  // ─── CONNECTION INDICATOR ─────────────────────────────────────
  function setConnected(yes) {
    const dot = $('conn-dot');
    const lbl = $('conn-label');
    if (dot) dot.className = 'status-dot' + (yes ? ' connected' : '');
    if (lbl) {
      lbl.textContent = yes ? 'CONNECTED' : 'DISCONNECTED';
      lbl.className   = 'conn-label' + (yes ? ' connected' : '');
    }
  }

  // ─── NEUTRAL STATE (shown until first real DB data) ───────────
  //
  //  FIX 1: setNeutralLight now also locks out manual buttons and
  //          resets all esp-info fields to '—'. Nothing is assumed.
  //
  function setNeutralLight() {
    if (lensRed)    lensRed.className    = 'tl-lens';
    if (lensYellow) lensYellow.className = 'tl-lens';
    if (lensGreen)  lensGreen.className  = 'tl-lens';

    if (statusLabel) {
      statusLabel.textContent = '—';
      statusLabel.className   = 'status-color-label';
    }
    if (countdownVal)     countdownVal.textContent    = '—';
    if (countdownBarFill) {
      countdownBarFill.style.width      = '0%';
      countdownBarFill.style.background = '';
    }

    // Deactivate all manual color buttons
    ['red', 'yellow', 'green'].forEach(c => {
      const btn = $('ctrl-' + c);
      if (btn) btn.className = 'ctrl-btn ' + c + '-btn';
    });
  }

  // ─── NEUTRAL MODE UI (no button highlighted, controls hidden) ─
  //
  //  FIX 2: Don't call updateModeUI('AUTO') at boot. Instead use
  //          setNeutralModeUI so no mode button appears active and
  //          manual controls stay hidden before DB data arrives.
  //
  function setNeutralModeUI() {
    setClass('btn-auto',   'mode-btn');
    setClass('btn-manual', 'mode-btn');
    const mc = $('manual-controls');
    if (mc) mc.className = 'manual-controls hidden';
  }

  // ─── INIT SUPABASE ────────────────────────────────────────────
  function initSupabase() {
    try {
      if (!window.supabase) throw new Error('Supabase CDN not loaded.');

      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

      // Reflect "waiting for DB" in esp-info panel
      setText('ei-mode',  '—');
      setText('ei-led',   '—');
      setText('ei-time',  '—');
      setText('ei-count', '—');

      fetchControlState();
      fetchLogs();
      subscribeRealtime();
      initChart();

    } catch (e) {
      console.error('[initSupabase]', e);
      showToast('Supabase error: ' + e.message, true);
      hideLoading();
    }
  }

  // ─── FETCH CONTROL STATE FROM DB ──────────────────────────────
  async function fetchControlState() {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from('traffic_control')
        .select('mode, manual_status, updated_at')
        .eq('id', 1)
        .single();

      if (error) throw error;
      if (!data)  throw new Error('No control row found (id=1).');

      dataLoaded = true;                             // ← gate is open
      applyControlState(data.mode, data.manual_status, data.updated_at);
      hideLoading();
      setConnected(true);

    } catch (e) {
      console.error('[fetchControlState]', e);
      showToast('Could not load control state: ' + e.message, true);
      hideLoading();
      // dataLoaded stays false — UI stays neutral, no countdown starts
    }
  }

  // ─── APPLY CONTROL STATE ──────────────────────────────────────
  //
  //  FIX 3: Removed the hardcoded 'GREEN' fallback. If AUTO mode
  //          has no known status yet, the light stays neutral until
  //          a log row or realtime event provides the real color.
  //
  function applyControlState(mode, manualStatus, updatedAt) {
    // Reject calls before the initial DB fetch completes (e.g. stale
    // realtime events that arrive during the loading phase).
    if (!dataLoaded) return;

    const prevMode = currentMode;
    currentMode    = mode;

    updateModeUI(mode);

    if (mode === 'MANUAL') {
      stopCountdown();

      if (manualStatus && VALID_COLORS.includes(manualStatus)) {
        currentStatus = manualStatus;
        updateTrafficLight(currentStatus);
      } else {
        // Manual mode but no valid color yet — stay neutral
        currentStatus = null;
        setNeutralLight();
      }

      if (countdownVal)     countdownVal.textContent    = '—';
      if (countdownBarFill) countdownBarFill.style.width = '0%';

    } else if (mode === 'AUTO') {
      // Only start the countdown if we already know the current color.
      // If coming from MANUAL with a valid status keep it; otherwise wait
      // for the next realtime log INSERT to provide the real phase.
      if (prevMode === 'MANUAL' && currentStatus && VALID_COLORS.includes(currentStatus)) {
        // Keep the last known color and let countdown run from it
        updateTrafficLight(currentStatus);
        startLocalCountdown();
      } else if (currentStatus && VALID_COLORS.includes(currentStatus)) {
        // AUTO → AUTO (e.g. page reload, subscription reconnect)
        updateTrafficLight(currentStatus);
        startLocalCountdown();
      } else {
        // No known status yet — stay neutral, countdown will start when
        // the next INSERT arrives via subscribeRealtime()
        setNeutralLight();
        stopCountdown();
      }
    }

    // Update esp-info panel
    setText('ei-mode', mode || '—');
    setText('ei-led',  currentStatus || '—');

    const eiLed = $('ei-led');
    if (eiLed) {
      eiLed.className = currentStatus
        ? 'val ' + currentStatus.toLowerCase()
        : 'val';
    }
    if (updatedAt) {
      setText('ei-time', new Date(updatedAt).toLocaleTimeString());
    }
  }

  // ─── FETCH LOGS ───────────────────────────────────────────────
  async function fetchLogs() {
    if (!supabase) return;
    try {
      const { data, error } = await supabase
        .from('traffic_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      logEntries = data || [];
      renderLogs();
      updateStats();
      updateChart();

    } catch (e) {
      console.error('[fetchLogs]', e);
      showToast('Could not load logs: ' + e.message, true);
    }
  }

  // ─── REALTIME SUBSCRIPTION ────────────────────────────────────
  function subscribeRealtime() {
    if (!supabase) return;
    try {
      if (realtimeChannel) supabase.removeChannel(realtimeChannel);

      realtimeChannel = supabase
        .channel('traffic-rt')

        // ── traffic_control changes (mode / manual_status) ──
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'traffic_control'
        }, payload => {
          if (!payload.new) return;
          const r = payload.new;
          // applyControlState guards against pre-load calls internally
          applyControlState(r.mode, r.manual_status, r.updated_at);
          showToast(`ESP32 update → ${r.mode} / ${r.manual_status || '—'}`);
        })

        // ── new log row from ESP32 ──
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'traffic_logs'
        }, payload => {
          if (!payload.new) return;

          logEntries.unshift(payload.new);
          if (logEntries.length > 50) logEntries.pop();
          renderLogs();
          updateStats();
          updateChart();
          setText('ei-count', logEntries.length);

          // Sync traffic light & countdown from the real ESP32 log row.
          //
          //  FIX 4: Guard with dataLoaded so an early INSERT (race with
          //         fetchControlState) cannot start the countdown before
          //         the initial state is known.
          //
          const { status, mode } = payload.new;
          if (!dataLoaded) return;

          if (status && VALID_COLORS.includes(status) && mode === 'AUTO' && currentMode === 'AUTO') {
            currentStatus = status;
            updateTrafficLight(status);
            startLocalCountdown();   // reset to real phase from ESP32
          }
        })

        .subscribe(subStatus => {
          setConnected(subStatus === 'SUBSCRIBED');
        });

    } catch (e) {
      console.error('[subscribeRealtime]', e);
    }
  }

  // ─── TRAFFIC LIGHT UI ─────────────────────────────────────────
  function updateTrafficLight(color) {
    if (!color || !VALID_COLORS.includes(color)) return;

    if (lensRed)    lensRed.className    = 'tl-lens' + (color === 'RED'    ? ' red-on'    : '');
    if (lensYellow) lensYellow.className = 'tl-lens' + (color === 'YELLOW' ? ' yellow-on' : '');
    if (lensGreen)  lensGreen.className  = 'tl-lens' + (color === 'GREEN'  ? ' green-on'  : '');

    if (statusLabel) {
      statusLabel.textContent = SIGNAL_WORD[color] ?? color;
      statusLabel.className   = 'status-color-label ' + color;
    }
    if (countdownBarFill) {
      countdownBarFill.style.background = COLOR_CSS[color];
    }

    // Highlight the active manual button only when in MANUAL mode
    ['red', 'yellow', 'green'].forEach(c => {
      const btn = $('ctrl-' + c);
      if (!btn) return;
      btn.className = 'ctrl-btn ' + c + '-btn' +
        (color === c.toUpperCase() && currentMode === 'MANUAL' ? ' active-' + c : '');
    });

    currentStatus = color;

    // Always keep the ACTIVE LED panel in sync with the current color
    setText('ei-led', color);
    const eiLed = $('ei-led');
    if (eiLed) eiLed.className = 'val ' + color.toLowerCase();
  }

  // ─── MODE UI ──────────────────────────────────────────────────
  function updateModeUI(mode) {
    setClass('btn-auto',   'mode-btn' + (mode === 'AUTO'   ? ' active-auto'   : ''));
    setClass('btn-manual', 'mode-btn' + (mode === 'MANUAL' ? ' active-manual' : ''));
    const mc = $('manual-controls');
    if (mc) mc.className = 'manual-controls' + (mode === 'MANUAL' ? '' : ' hidden');
  }

  // ─── COUNTDOWN (AUTO mode, only after dataLoaded) ─────────────
  function stopCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  }

  function startLocalCountdown() {
    // Safety: never start before real data arrives
    if (!dataLoaded || !currentStatus || !DURATIONS[currentStatus]) return;

    stopCountdown();

    countdownMax = DURATIONS[currentStatus];
    countdownSec = countdownMax;

    if (countdownVal)     countdownVal.textContent    = countdownSec;
    if (countdownBarFill) countdownBarFill.style.width = '100%';

    countdownTimer = setInterval(() => {
      // Abort if mode changed away from AUTO
      if (currentMode !== 'AUTO') { stopCountdown(); return; }

      countdownSec = Math.max(0, countdownSec - 1);
      if (countdownVal) countdownVal.textContent = countdownSec;

      const pct = countdownMax > 0 ? (countdownSec / countdownMax) * 100 : 0;
      if (countdownBarFill) countdownBarFill.style.width = pct + '%';

      // Local phase advance (visual only — real state always comes from Supabase)
      if (countdownSec === 0) {
        const seq  = ['GREEN', 'YELLOW', 'RED'];
        const next = seq[(seq.indexOf(currentStatus) + 1) % 3];
        updateTrafficLight(next);
        countdownMax = DURATIONS[next];
        countdownSec = countdownMax;
      }
    }, 1000);
  }

  // ─── SET MODE (write to Supabase) ─────────────────────────────
  async function setMode(mode) {
    if (!supabase)    { showToast('Not connected to Supabase', true); return; }
    if (!dataLoaded)  { showToast('Waiting for initial data…', true); return; }
    try {
      const { error } = await supabase
        .from('traffic_control')
        .update({ mode })
        .eq('id', 1);
      if (error) throw error;
      showToast('Mode → ' + mode);
      // UI updates via realtime subscription, not optimistically
    } catch (e) {
      console.error('[setMode]', e);
      showToast('Error: ' + e.message, true);
    }
  }
  window.setMode = setMode;

  // ─── MANUAL LIGHT CONTROL (write to Supabase) ─────────────────
  async function setManualLight(color) {
    if (!supabase)   { showToast('Not connected to Supabase', true); return; }
    if (!dataLoaded) { showToast('Waiting for initial data…', true); return; }
    if (currentMode !== 'MANUAL') {
      showToast('Switch to MANUAL mode first', true); return;
    }
    try {
      const { error } = await supabase
        .from('traffic_control')
        .update({ manual_status: color })
        .eq('id', 1);
      if (error) throw error;
      showToast(color + ' light activated');
      // UI updates via realtime subscription
    } catch (e) {
      console.error('[setManualLight]', e);
      showToast('Error: ' + e.message, true);
    }
  }
  window.setManualLight = setManualLight;

  // ─── RENDER LOG TABLE ─────────────────────────────────────────
  function renderLogs() {
    const tbody = $('log-tbody');
    if (!tbody) return;

    if (!logEntries.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="color:var(--text-dim);padding:20px 0;
        text-align:center;font-family:var(--font-mono);font-size:0.72rem">
        No logs yet</td></tr>`;
      setText('log-count-badge', '0 entries');
      setText('ei-count', '0');
      return;
    }

    setText('log-count-badge', logEntries.length + ' entries');
    setText('ei-count', logEntries.length);

    tbody.innerHTML = logEntries.slice(0, 30).map((row, i) => `
      <tr>
        <td style="color:var(--text-dim)">${logEntries.length - i}</td>
        <td>
          <span class="cell-status ${row.status}">
            <span class="cell-dot ${row.status}"></span>${row.status}
          </span>
        </td>
        <td><span class="badge-mode ${row.mode}">${row.mode}</span></td>
        <td style="color:var(--text)">${row.duration != null ? row.duration : '—'}</td>
        <td style="color:var(--text-dim)">${new Date(row.created_at).toLocaleTimeString()}</td>
      </tr>`).join('');
  }

  // ─── STATS ────────────────────────────────────────────────────
  function updateStats() {
    const total   = logEntries.length;
    const auto    = logEntries.filter(r => r.mode   === 'AUTO').length;
    const manual  = logEntries.filter(r => r.mode   === 'MANUAL').length;
    const reds    = logEntries.filter(r => r.status === 'RED').length;
    const yellows = logEntries.filter(r => r.status === 'YELLOW').length;
    const greens  = logEntries.filter(r => r.status === 'GREEN').length;

    setText('stat-total',  total);
    setText('stat-auto',   auto);
    setText('stat-manual', manual);

    if (total > 0) {
      const sbr = $('sb-r'), sby = $('sb-y'), sbg = $('sb-g');
      if (sbr) sbr.style.flex = String(reds);
      if (sby) sby.style.flex = String(yellows);
      if (sbg) sbg.style.flex = String(greens);
    }
  }

  // ─── CHART ────────────────────────────────────────────────────
  function initChart() {
    const canvas = $('usageChart');
    if (!canvas || typeof Chart === 'undefined') {
      console.warn('[initChart] Chart.js or canvas not available');
      return;
    }
    if (usageChart) return;

    usageChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [
          { label: 'RED',    data: [], backgroundColor: 'rgba(255,59,59,0.7)',  borderColor: '#ff3b3b', borderWidth: 1 },
          { label: 'YELLOW', data: [], backgroundColor: 'rgba(255,193,7,0.7)',  borderColor: '#ffc107', borderWidth: 1 },
          { label: 'GREEN',  data: [], backgroundColor: 'rgba(0,230,118,0.7)',  borderColor: '#00e676', borderWidth: 1 },
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            labels: { color: '#5a6878', font: { family: 'Share Tech Mono', size: 10 }, boxWidth: 10 }
          },
          tooltip: {
            backgroundColor: '#0f1218', titleColor: '#c8d4e0',
            bodyColor: '#8a9ab0', borderColor: '#1e2530', borderWidth: 1,
            titleFont: { family: 'Share Tech Mono' },
            bodyFont:  { family: 'Share Tech Mono' }
          }
        },
        scales: {
          x: {
            ticks: { color: '#5a6878', font: { family: 'Share Tech Mono', size: 9 } },
            grid:  { color: '#1e2530' }
          },
          y: {
            beginAtZero: true,
            ticks: { color: '#5a6878', font: { family: 'Share Tech Mono', size: 9 } },
            grid:  { color: '#1e2530' },
            title: { display: true, text: 'Count', color: '#5a6878',
                     font: { family: 'Share Tech Mono', size: 9 } }
          }
        }
      }
    });
  }

  function updateChart() {
    if (!usageChart) return;
    const recent = [...logEntries].reverse().slice(-20);
    const labels = recent.map((_, i) => `#${logEntries.length - recent.length + i + 1}`);
    usageChart.data.labels           = labels;
    usageChart.data.datasets[0].data = recent.map(r => r.status === 'RED'    ? 1 : 0);
    usageChart.data.datasets[1].data = recent.map(r => r.status === 'YELLOW' ? 1 : 0);
    usageChart.data.datasets[2].data = recent.map(r => r.status === 'GREEN'  ? 1 : 0);
    usageChart.update('none');
  }

  // ─── BOOT SEQUENCE ────────────────────────────────────────────
  //
  //  FIX 5: Boot into a fully neutral state. No mode button is
  //          highlighted, no light is on, no countdown runs.
  //          Everything waits for fetchControlState() to complete.
  //
  setNeutralLight();
  setNeutralModeUI();   // ← was: updateModeUI('AUTO')  ← root cause of green flash

  initSupabase();       // fetches real state; all display flows from here

}); // end DOMContentLoaded