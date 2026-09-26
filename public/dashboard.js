// Frontend logic for gpsdash — polls the backend for ntp.local GPS/NTP status.

const POLL_INTERVAL_MS = 2000;
const OFFSET_HISTORY_WINDOW_MS = 15 * 60 * 1000; // the offset graph keeps the last 15 minutes
const MAX_OFFSET_HISTORY = OFFSET_HISTORY_WINDOW_MS / POLL_INTERVAL_MS;

const FIX_MODE_LABELS = { 0: "Unknown", 1: "No fix", 2: "2D fix", 3: "3D fix" };

const offsetHistory = []; // offsets in ms, oldest first
const offsetTimes = []; // poll timestamps (ms since epoch), parallel to offsetHistory

// The server owns the offset history (so a reload shows the whole window at once, and every viewer sees the same one);
// the page only keeps a copy to draw. Each poll sends the newest sample we hold (historySeq) and the server run it came
// from (historyEpoch), and gets back only the newer samples.
let historySeq = 0;
let historyEpoch = null;

function applyHistory(h) {
  if (h.reset) {
    offsetHistory.length = 0;
    offsetTimes.length = 0;
  }
  const now = Date.now();
  for (const sample of h.samples) {
    offsetHistory.push(sample.offsetMs);
    offsetTimes.push(now - sample.ageMs); // the server sends ages, so its clock and ours never get mixed
  }
  while (offsetHistory.length > MAX_OFFSET_HISTORY) {
    offsetHistory.shift();
    offsetTimes.shift();
  }
  historySeq = h.seq;
  historyEpoch = h.epoch;
}

// Graph view options, remembered per browser. Defaults: log-spaced time axis, linear value axis
// (a symmetric-log value axis is available with the "Value" toggle).
const graphMode = { yLog: false, tLog: true };
try {
  const saved = JSON.parse(localStorage.getItem("gpsdash.graphMode") || "null");
  if (saved) {
    graphMode.yLog = saved.yLog === true;
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

// Constellations, from gpsd's gnssid. Each is identified TWICE, by a COLOUR and by a marker SHAPE, so it stays legible
// without colour vision; the satellite's STATE is shown by the fill style instead:
// solid = used in the fix, translucent = signal heard but not used, dashed ring = no signal.
const CONSTELLATIONS = {
  0: { name: "GPS", color: "#3987e5", shape: "circle" },
  1: { name: "SBAS", color: "#f0e442", shape: "square" },
  2: { name: "Galileo", color: "#00b58a", shape: "triangle-down" },
  3: { name: "BeiDou", color: "#ee6a2c", shape: "hexagon" },
  4: { name: "IMES", color: "#b0b0b0", shape: "pentagon" },
  5: { name: "QZSS", color: "#cc79a7", shape: "diamond" },
  6: { name: "GLONASS", color: "#e69f00", shape: "triangle" },
  7: { name: "NavIC", color: "#56b4e9", shape: "plus" },
};
const UNKNOWN_CONSTELLATION = { name: null, color: "#8b98a5", shape: "circle" }; // older agent, or a gnssid we don't know

function constellationOf(s) {
  return CONSTELLATIONS[s.gnssid] || UNKNOWN_CONSTELLATION;
}

// Corners of a regular n-gon around (cx, cy); rotDeg 0 puts one corner straight up.
function polygonPoints(cx, cy, r, n, rotDeg) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = ((rotDeg + (360 / n) * i) * Math.PI) / 180;
    pts.push(`${(cx + r * Math.sin(a)).toFixed(1)},${(cy - r * Math.cos(a)).toFixed(1)}`);
  }
  return pts.join(" ");
}

// One marker, centred on (x, y). Sizes are tuned so every shape has a similar visual weight.
function shapeMarkup(shape, x, y, size, attrs, inner = "") {
  const poly = (points) => `<polygon points="${points}" ${attrs}>${inner}</polygon>`;
  switch (shape) {
    case "square": {
      const half = size * 0.9;
      return `<rect x="${(x - half).toFixed(1)}" y="${(y - half).toFixed(1)}" width="${(half * 2).toFixed(1)}" height="${(half * 2).toFixed(1)}" ${attrs}>${inner}</rect>`;
    }
    case "diamond":
      return poly(polygonPoints(x, y, size * 1.28, 4, 0));
    case "triangle":
      return poly(polygonPoints(x, y, size * 1.55, 3, 0));
    case "triangle-down":
      return poly(polygonPoints(x, y, size * 1.55, 3, 180));
    case "hexagon":
      return poly(polygonPoints(x, y, size * 1.11, 6, 0));
    case "pentagon":
      return poly(polygonPoints(x, y, size * 1.16, 5, 0));
    case "plus": {
      const a = size * 0.45;
      const b = size * 1.3;
      const pts = [[-a, -b], [a, -b], [a, -a], [b, -a], [b, a], [a, a], [a, b], [-a, b], [-a, a], [-b, a], [-b, -a], [-a, -a]];
      return poly(pts.map(([dx, dy]) => `${(x + dx).toFixed(1)},${(y + dy).toFixed(1)}`).join(" "));
    }
    default:
      return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size}" ${attrs}>${inner}</circle>`;
  }
}

// Sort satellites into the groups the plot and legend show, so the legend always adds up to the total.
//  - used:       in the position fix
//  - unused:     above the horizon, signal heard, but not used in the fix
//  - noSignal:   above the horizon, but no signal heard (SNR 0/unknown), e.g. a geostationary satellite not being tracked
//  - below:      a valid position, below the horizon
//  - noPosition: gpsd knows the satellite exists but has no position for it (it reports az 0, el -999)
function classifySatellites(satellites) {
  const g = { used: [], unused: [], noSignal: [], below: [], noPosition: [] };
  for (const s of satellites) {
    const valid =
      Number.isFinite(s.el) && Number.isFinite(s.az) && s.el >= -90 && s.el <= 90 && s.az >= 0 && s.az <= 360;
    if (!valid) g.noPosition.push(s);
    else if (s.el < 0) g.below.push(s);
    else if (s.used) g.used.push(s);
    else if (s.ss > 0) g.unused.push(s);
    else g.noSignal.push(s);
  }
  return g;
}

// "QZSS 193, 194; PRN 12": PRNs grouped under their constellation name (or plain "PRN" when the constellation is unknown).
function describeSatellites(sats) {
  const groups = new Map();
  for (const s of sats) {
    const key = constellationOf(s).name || "PRN";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s.prn);
  }
  return [...groups].map(([key, prns]) => `${key} ${prns.join(", ")}`).join("; ");
}

// One line under the legend: how many satellites of each constellation are used, out of those listed.
function constellationSummary(satellites) {
  if (!satellites.some((s) => CONSTELLATIONS[s.gnssid])) return "";
  const byId = new Map();
  for (const s of satellites) {
    const id = CONSTELLATIONS[s.gnssid] ? s.gnssid : 99;
    const entry = byId.get(id) || { c: CONSTELLATIONS[id] || { name: "Other", color: UNKNOWN_CONSTELLATION.color, shape: "circle" }, total: 0, used: 0 };
    entry.total += 1;
    if (s.used) entry.used += 1;
    byId.set(id, entry);
  }
  const items = [...byId.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([, e]) =>
        `<span title="${e.used} of ${e.total} used in the fix"><svg class="shape-icon" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">${shapeMarkup(e.c.shape, 6, 6, 4, `style="fill:${e.c.color}"`)}</svg> ${e.c.name} ${e.used}/${e.total}</span>`
    );
  return `<div class="legend legend-constellations" aria-label="Satellites by constellation, used out of listed">${items.join("")}<span class="sky-hint">used / listed</span></div>`;
}

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
  const groups = classifySatellites(satellites);
  const dotFor = (s, cls) => {
    const radius = r * (1 - s.el / 90);
    const azRad = (s.az * Math.PI) / 180;
    const x = cx + radius * Math.sin(azRad);
    const y = cy - radius * Math.cos(azRad);
    const c = constellationOf(s);
    const snr = s.ss !== null && s.ss !== undefined && s.ss > 0 ? `${s.ss.toFixed(0)} dB` : "no signal";
    const svid = s.svid !== undefined && s.svid !== null && s.svid !== s.prn ? ` (sv ${s.svid})` : "";
    const who = c.name ? `${c.name} · PRN ${s.prn}${svid}` : `PRN ${s.prn}`;
    const title = `<title>${who} · el ${s.el.toFixed(0)}° · az ${s.az.toFixed(0)}° · ${snr}${s.used ? " · used in fix" : ""}</title>`;
    return shapeMarkup(c.shape, x, y, 5, `class="${cls}" style="--sat:${c.color}"`, title);
  };
  // Not-used dots go underneath the used ones, so a used satellite is never hidden behind a grey one.
  const dots =
    groups.noSignal.map((s) => dotFor(s, "sky-dot-nosignal")).join("") +
    groups.unused.map((s) => dotFor(s, "sky-dot-unused")).join("") +
    groups.used.map((s) => dotFor(s, "sky-dot-used")).join("");
  const legendItem = (cls, label, sats) => `<span><i class="dot ${cls}"></i> ${label} (${sats.length})</span>`;
  const notes = [];
  if (groups.noPosition.length) notes.push(`No position reported: ${describeSatellites(groups.noPosition)}`);
  if (groups.below.length) notes.push(`Below the horizon: ${describeSatellites(groups.below)}`);
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
    <div class="legend legend-states">
      ${legendItem("dot-used", "Used", groups.used)}
      ${legendItem("dot-unused", "Not used", groups.unused)}
      ${groups.noSignal.length ? legendItem("dot-nosignal", "No signal", groups.noSignal) : ""}
      ${groups.below.length ? legendItem("dot-below", "Below horizon", groups.below) : ""}
      ${groups.noPosition.length ? legendItem("dot-noposition", "No position", groups.noPosition) : ""}
    </div>
    ${constellationSummary(satellites)}
    ${notes.length ? `<div class="sky-note">${notes.join(" · ")}</div>` : ""}
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
  const num = (ms) => {
    const t = (ms * u.k).toFixed(1);
    return t === "-0.0" ? "0.0" : t; // avoid a negative zero in the caption
  };
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
    const res = await fetch(`/api/status?since=${historySeq}&epoch=${historyEpoch === null ? "" : historyEpoch}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "unknown error");
    banner.hidden = true;
    renderGps(data.gps);
    renderNtp(data.ntp, data.sources);
    renderSources(data.sources);
    renderSkyPlot(data.gps && data.gps.satellites);
    if (data.history) applyHistory(data.history); // the server keeps the offset history; the page only draws it
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
