// Frontend logic for gpsdash — polls the backend for ntp.local GPS/NTP status.

const POLL_INTERVAL_MS = 2000;
const OFFSET_HISTORY_WINDOW_MS = 15 * 60 * 1000; // the offset graph keeps the last 15 minutes
const MAX_OFFSET_HISTORY = OFFSET_HISTORY_WINDOW_MS / POLL_INTERVAL_MS;

const FIX_MODE_LABELS = { 0: "Unknown", 1: "No fix", 2: "2D fix", 3: "3D fix" };

const offsetHistory = []; // offsets in ms, oldest first
const offsetTimes = []; // poll timestamps (ms since epoch), parallel to offsetHistory

// Graph view options, remembered per browser: symmetric-log value axis and log-spaced time axis.
const graphMode = { yLog: true, tLog: true };
try {
  const saved = JSON.parse(localStorage.getItem("gpsdash.graphMode") || "null");
  if (saved) {
    graphMode.yLog = saved.yLog !== false;
    graphMode.tLog = saved.tLog !== false;
  }
} catch (e) {
  // localStorage unavailable (private mode etc.): keep the defaults
}
function saveGraphMode() {
  try {
    localStorage.setItem("gpsdash.graphMode", JSON.stringify(graphMode));
  } catch (e) {
    // ignore: the choice just won't persist
  }
}

function fmtOffset(seconds) {
  if (seconds === undefined || seconds === null) return "—";
  return `${(seconds * 1000).toFixed(1)} ms`;
}

function fmtCoord(value, digits = 5) {
  if (value === undefined || value === null) return "—";
  return value.toFixed(digits);
}

function statusDot(level, label) {
  return `<span class="status-dot status-${level}" aria-hidden="true"></span><span>${label}</span>`;
}

function hdopStatus(hdop) {
  if (hdop === undefined || hdop === null) return { level: "critical", label: "No HDOP data" };
  if (hdop < 2) return { level: "good", label: `Good (HDOP ${hdop.toFixed(2)})` };
  if (hdop < 5) return { level: "warning", label: `Fair (HDOP ${hdop.toFixed(2)})` };
  if (hdop < 10) return { level: "serious", label: `Moderate (HDOP ${hdop.toFixed(2)})` };
  return { level: "critical", label: `Poor (HDOP ${hdop.toFixed(2)})` };
}

function renderGps(gps) {
  const el = document.getElementById("gps-panel");
  if (!gps) {
    el.innerHTML = "<p class='error'>No GPS data</p>";
    return;
  }
  const hdopStat = hdopStatus(gps.hdop);
  el.innerHTML = `
    <dl>
      <dt>Fix</dt><dd>${FIX_MODE_LABELS[gps.mode] ?? "Unknown"}</dd>
      <dt>Quality</dt><dd class="status-line">${statusDot(hdopStat.level, hdopStat.label)}</dd>
      <dt>Satellites</dt><dd>${gps.satellites_used ?? "—"} used / ${gps.satellites_visible ?? "—"} visible</dd>
      <dt>Position</dt><dd>${fmtCoord(gps.lat)}, ${fmtCoord(gps.lon)}</dd>
      <dt>Altitude</dt><dd>${gps.alt_m !== undefined && gps.alt_m !== null ? gps.alt_m.toFixed(1) + " m" : "—"}</dd>
    </dl>
  `;
}

function renderNtp(ntp, sources) {
  const el = document.getElementById("ntp-panel");
  if (!ntp) {
    el.innerHTML = "<p class='error'>No NTP data</p>";
    return;
  }
  const gpsSource = (sources || []).find((s) => s.name === "GPS");
  const gpsSelected = gpsSource && gpsSource.state === "selected";
  const disciplineStat = gpsSelected
    ? { level: "good", label: "Yes" }
    : { level: "warning", label: "No — using network NTP" };
  el.innerHTML = `
    <dl>
      <dt>Reference</dt><dd>${ntp.reference_name} (stratum ${ntp.stratum})</dd>
      <dt>System offset</dt><dd>${fmtOffset(ntp.system_offset_seconds)}</dd>
      <dt>Leap status</dt><dd>${ntp.leap_status}</dd>
      <dt>GPS-disciplined</dt><dd class="status-line">${statusDot(disciplineStat.level, disciplineStat.label)}</dd>
    </dl>
  `;
}

function renderSources(sources) {
  const el = document.getElementById("sources-panel");
  if (!sources || sources.length === 0) {
    el.innerHTML = "<p class='error'>No source data</p>";
    return;
  }
  const rows = sources
    .map(
      (s) => `
      <tr class="state-${s.state}">
        <td>${s.name}</td>
        <td>${s.state}</td>
        <td>${s.stratum}</td>
        <td>${fmtOffset(s.adjusted_offset_seconds)}</td>
        <td>${fmtOffset(s.estimated_error_seconds)}</td>
      </tr>`
    )
    .join("");
  el.innerHTML = `
    <table>
      <thead><tr><th>Source</th><th>State</th><th>Stratum</th><th>Offset</th><th>Est. error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

const SKY_SIZE = 220;

function renderSkyPlot(satellites) {
  const el = document.getElementById("sky-plot");
  if (!satellites || satellites.length === 0) {
    el.innerHTML = "<p class='error'>No satellite data</p>";
    return;
  }
  const cx = SKY_SIZE / 2;
  const cy = SKY_SIZE / 2;
  const r = SKY_SIZE / 2 - 14;
  const rings = [30, 60].map((elDeg) => {
    const ringR = r * (1 - elDeg / 90);
    return `<circle cx="${cx}" cy="${cy}" r="${ringR.toFixed(1)}" class="sky-ring" />`;
  }).join("");
  const dots = satellites
    .filter((s) => s.el !== null && s.el !== undefined && s.az !== null && s.az !== undefined)
    .map((s) => {
      const radius = r * (1 - s.el / 90);
      const azRad = (s.az * Math.PI) / 180;
      const x = cx + radius * Math.sin(azRad);
      const y = cy - radius * Math.cos(azRad);
      const cls = s.used ? "sky-dot-used" : "sky-dot-unused";
      const snr = s.ss !== null && s.ss !== undefined ? `${s.ss.toFixed(0)} dB` : "no signal";
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" class="${cls}"><title>PRN ${s.prn} · el ${s.el.toFixed(0)}° · az ${s.az.toFixed(0)}° · ${snr}${s.used ? " · used in fix" : ""}</title></circle>`;
    })
    .join("");
  const usedCount = satellites.filter((s) => s.used).length;
  const unusedCount = satellites.length - usedCount;
  el.innerHTML = `
    <svg viewBox="0 0 ${SKY_SIZE} ${SKY_SIZE}" class="sky-svg" role="img" aria-label="Satellite sky view, North at top">
      <circle cx="${cx}" cy="${cy}" r="${r}" class="sky-horizon" />
      ${rings}
      <text x="${cx}" y="12" class="sky-label" text-anchor="middle">N</text>
      <text x="${SKY_SIZE - 4}" y="${cy + 4}" class="sky-label" text-anchor="end">E</text>
      <text x="${cx}" y="${SKY_SIZE - 4}" class="sky-label" text-anchor="middle">S</text>
      <text x="4" y="${cy + 4}" class="sky-label" text-anchor="start">W</text>
      ${dots}
    </svg>
    <div class="legend">
      <span><i class="dot dot-used"></i> Used (${usedCount})</span>
      <span><i class="dot dot-unused"></i> Not used (${unusedCount})</span>
    </div>
  `;
}

function niceStep(range) {
  const target = range / 3;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

// ---- Clock-offset graph -----------------------------------------------------------------
const GRAPH = { w: 320, h: 128, padL: 46, padR: 8, padT: 10, padB: 18 };
const LOG_Y_FLOOR_MS = 0.001; // symmetric-log: values within ~1 µs of zero stay roughly linear
const LOG_T_TAU_S = 8; // log time axis: the newest seconds get the most room
const TIME_TICKS = [
  [0, "now"],
  [10, "-10s"],
  [60, "-1m"],
  [300, "-5m"],
  [900, "-15m"],
];

// Symmetric log: keeps the sign, handles zero, and compresses large offsets so µs and ms both stay visible.
const symlog = (ms) => Math.sign(ms) * Math.log10(1 + Math.abs(ms) / LOG_Y_FLOOR_MS);

function fmtTickMs(ms) {
  if (ms === 0) return "0";
  const a = Math.abs(ms);
  const sign = ms > 0 ? "+" : "-";
  if (a < 1) return `${sign}${(a * 1000).toFixed(0)}µs`;
  if (a < 1000) return `${sign}${a.toFixed(0)}ms`;
  return `${sign}${(a / 1000).toFixed(0)}s`;
}

// Unit for the caption, chosen from the size of the numbers (an 18 µs offset should not read "0.0 ms").
function pickUnit(ms) {
  const a = Math.abs(ms);
  if (a < 1) return { unit: "µs", k: 1000 };
  if (a < 1000) return { unit: "ms", k: 1 };
  return { unit: "s", k: 0.001 };
}

function gridLine(y, cls) {
  const { w, padL, padR } = GRAPH;
  return `<line x1="${padL}" x2="${w - padR}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="${cls}" />`;
}

function tickLabel(y, text) {
  return `<text x="${GRAPH.padL - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="sparkline-tick">${text}</text>`;
}

// Value axis, linear: auto-scaled to the data with "nice" round steps (the original view).
function linearValueAxis(values) {
  const { h, padT, padB } = GRAPH;
  const dataMin = Math.min(Math.min(...values), 0);
  const dataMax = Math.max(Math.max(...values), 0);
  const step = niceStep(Math.max(dataMax - dataMin, 0.5));
  const axisMin = Math.floor(dataMin / step) * step;
  let axisMax = Math.ceil(dataMax / step) * step;
  if (axisMax <= axisMin) axisMax = axisMin + step;
  const axisRange = axisMax - axisMin;
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  const toY = (v) => padT + ((axisMax - v) / axisRange) * (h - padT - padB);
  let grid = "";
  const tickCount = Math.round(axisRange / step);
  for (let t = 0; t <= tickCount; t++) {
    const v = axisMin + t * step;
    const isZero = Math.abs(v) < step / 1000;
    grid += gridLine(toY(v), isZero ? "sparkline-zero" : "sparkline-grid");
    grid += tickLabel(toY(v), isZero ? "0" : (v > 0 ? "+" : "") + v.toFixed(decimals));
  }
  return { toY, grid };
}

// Value axis, symmetric log: zero in the middle, decade ticks (±10 µs, ±100 µs, ±1 ms, ...) each side.
function logValueAxis(values) {
  const { h, padT, padB } = GRAPH;
  const maxAbs = Math.max(...values.map(Math.abs), 0);
  let topExp = -2; // never zoom in past ±10 µs
  while (Math.pow(10, topExp) < maxAbs && topExp < 4) topExp++;
  const top = Math.pow(10, topExp);
  const yMax = symlog(top);
  const plotH = h - padT - padB;
  const toY = (v) => padT + (1 - (symlog(Math.max(-top, Math.min(top, v))) + yMax) / (2 * yMax)) * plotH;
  let grid = gridLine(toY(0), "sparkline-zero") + tickLabel(toY(0), "0");
  for (let k = -3; k <= topExp; k++) {
    const v = Math.pow(10, k);
    const labelled = k >= -2; // the ±1 µs lines are minor: drawn, but not labelled
    for (const s of [1, -1]) {
      grid += gridLine(toY(s * v), "sparkline-grid");
      if (labelled) grid += tickLabel(toY(s * v), fmtTickMs(s * v));
    }
  }
  return { toY, grid };
}

// Time axis, linear: one fixed step per poll, fills left to right until the window is full, then scrolls.
function linearTimeAxis(count) {
  const { w, h, padL, padR } = GRAPH;
  const stepX = (w - padL - padR) / (MAX_OFFSET_HISTORY - 1);
  const toX = (i) => padL + i * stepX;
  const spanSeconds =
    count >= MAX_OFFSET_HISTORY ? OFFSET_HISTORY_WINDOW_MS / 1000 : Math.round(((count - 1) * POLL_INTERVAL_MS) / 1000);
  const spanLabel =
    spanSeconds >= 60 ? `${Math.floor(spanSeconds / 60)}m${spanSeconds % 60 ? ` ${spanSeconds % 60}s` : ""}` : `${spanSeconds}s`;
  const lastX = toX(count - 1);
  const labels =
    (spanSeconds > 0 ? `<text x="${padL}" y="${h - 4}" text-anchor="start" class="sparkline-tick">-${spanLabel}</text>` : "") +
    (lastX - padL >= 45 ? `<text x="${lastX.toFixed(1)}" y="${h - 4}" text-anchor="end" class="sparkline-tick">now</text>` : "");
  return { toX, grid: "", labels, spanText: spanLabel };
}

// Time axis, log: newest sample at the right edge; the last seconds are spread out and the minutes before
// are squeezed to the left, so 15 minutes fit in the same width. The axis is fixed at the full window.
function logTimeAxis(times) {
  const { w, h, padL, padR, padT, padB } = GRAPH;
  const plotW = w - padL - padR;
  const windowS = OFFSET_HISTORY_WINDOW_MS / 1000;
  const denom = Math.log10(1 + windowS / LOG_T_TAU_S);
  const xForAge = (ageS) => padL + (1 - Math.min(1, Math.log10(1 + Math.max(0, ageS) / LOG_T_TAU_S) / denom)) * plotW;
  const newest = times[times.length - 1];
  const toX = (i) => xForAge((newest - times[i]) / 1000);
  let grid = "";
  let labels = "";
  for (const [ageS, text] of TIME_TICKS) {
    if (ageS > windowS) continue;
    const x = xForAge(ageS);
    grid += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${padT}" y2="${h - padB}" class="sparkline-grid" />`;
    const anchor = ageS === 0 ? "end" : ageS >= windowS ? "start" : "middle";
    labels += `<text x="${x.toFixed(1)}" y="${h - 4}" text-anchor="${anchor}" class="sparkline-tick">${text}</text>`;
  }
  return { toX, grid, labels, spanText: `${Math.round(windowS / 60)}m` };
}

function renderOffsetSparkline() {
  const el = document.getElementById("offset-sparkline");
  if (offsetHistory.length < 1) {
    el.innerHTML = "<p class='muted'>Collecting data…</p>";
    return;
  }
  const { w, h } = GRAPH;
  const yAxis = graphMode.yLog ? logValueAxis(offsetHistory) : linearValueAxis(offsetHistory);
  const xAxis = graphMode.tLog ? logTimeAxis(offsetTimes) : linearTimeAxis(offsetHistory.length);
  const points = offsetHistory
    .map((v, i) => `${xAxis.toX(i).toFixed(1)},${yAxis.toY(v).toFixed(1)}`)
    .join(" ");
  const lastIdx = offsetHistory.length - 1;
  const last = offsetHistory[lastIdx];
  const min = Math.min(...offsetHistory);
  const max = Math.max(...offsetHistory);
  const u = pickUnit(Math.max(Math.abs(min), Math.abs(max), Math.abs(last)));
  const num = (ms) => (ms * u.k).toFixed(1);
  const aria =
    `System clock offset over the last ${xAxis.spanText}; ` +
    `value axis ${graphMode.yLog ? "logarithmic" : "linear"}, time axis ${graphMode.tLog ? "logarithmic" : "linear"}`;
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" class="sparkline-svg" role="img" aria-label="${aria}">
      ${yAxis.grid}
      ${xAxis.grid}
      ${xAxis.labels}
      <polyline points="${points}" class="sparkline-line" />
      <circle cx="${xAxis.toX(lastIdx).toFixed(1)}" cy="${yAxis.toY(last).toFixed(1)}" r="4" class="sparkline-dot" />
    </svg>
    <div class="sparkline-caption">${num(last)} ${u.unit} now · range ${num(min)} to ${num(max)} ${u.unit}</div>
  `;
}

function updateGraphControls() {
  for (const [id, key, name] of [["toggle-y", "yLog", "Value"], ["toggle-t", "tLog", "Time"]]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.textContent = `${name}: ${graphMode[key] ? "log" : "linear"}`;
    btn.setAttribute("aria-pressed", graphMode[key] ? "true" : "false");
  }
}

function wireGraphControls() {
  for (const [id, key] of [["toggle-y", "yLog"], ["toggle-t", "tLog"]]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      graphMode[key] = !graphMode[key];
      saveGraphMode();
      updateGraphControls();
      renderOffsetSparkline();
    });
  }
  updateGraphControls();
}

let polling = false;

async function poll() {
  if (polling) return; // skip this tick if the previous request is still in flight
  polling = true;
  const banner = document.getElementById("error-banner");
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "unknown error");
    banner.hidden = true;
    renderGps(data.gps);
    renderNtp(data.ntp, data.sources);
    renderSources(data.sources);
    renderSkyPlot(data.gps && data.gps.satellites);
    if (data.ntp && data.ntp.system_offset_seconds !== undefined) {
      offsetHistory.push(data.ntp.system_offset_seconds * 1000);
      offsetTimes.push(Date.now());
      if (offsetHistory.length > MAX_OFFSET_HISTORY) {
        offsetHistory.shift();
        offsetTimes.shift();
      }
    }
    renderOffsetSparkline();
  } catch (err) {
    banner.textContent = `Could not load status: ${err.message}`;
    banner.hidden = false;
  } finally {
    polling = false;
  }
}

wireGraphControls();
poll();
setInterval(poll, POLL_INTERVAL_MS);
