// Frontend logic for gpsdash — polls the backend for ntp.local GPS/NTP status.

const POLL_INTERVAL_MS = 2000;
const OFFSET_HISTORY_WINDOW_MS = 5 * 60 * 1000; // sparkline shows the last 5 minutes
const MAX_OFFSET_HISTORY = OFFSET_HISTORY_WINDOW_MS / POLL_INTERVAL_MS;

const FIX_MODE_LABELS = { 0: "Unknown", 1: "No fix", 2: "2D fix", 3: "3D fix" };

const offsetHistory = [];

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

function renderOffsetSparkline() {
  const el = document.getElementById("offset-sparkline");
  if (offsetHistory.length < 1) {
    el.innerHTML = "<p class='muted'>Collecting data…</p>";
    return;
  }
  const w = 320;
  const h = 96;
  const padL = 44;
  const padR = 8;
  const padT = 10;
  const padB = 18;
  const min = Math.min(...offsetHistory);
  const max = Math.max(...offsetHistory);
  const dataMin = Math.min(min, 0);
  const dataMax = Math.max(max, 0);
  const step = niceStep(Math.max(dataMax - dataMin, 0.5));
  const axisMin = Math.floor(dataMin / step) * step;
  let axisMax = Math.ceil(dataMax / step) * step;
  if (axisMax <= axisMin) axisMax = axisMin + step;
  const axisRange = axisMax - axisMin;
  const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
  // Fixed spacing: the trace starts at the left edge and advances one step per poll until the window is full, then scrolls.
  const stepX = (w - padL - padR) / (MAX_OFFSET_HISTORY - 1);
  const toY = (v) => padT + ((axisMax - v) / axisRange) * (h - padT - padB);
  const toXY = (v, i) => [padL + i * stepX, toY(v)];
  const points = offsetHistory.map((v, i) => toXY(v, i).map((n) => n.toFixed(1)).join(",")).join(" ");
  const [lastX, lastY] = toXY(offsetHistory[offsetHistory.length - 1], offsetHistory.length - 1);
  const last = offsetHistory[offsetHistory.length - 1];
  const tickCount = Math.round(axisRange / step);
  let grid = "";
  for (let t = 0; t <= tickCount; t++) {
    const v = axisMin + t * step;
    const isZero = Math.abs(v) < step / 1000;
    const y = toY(v).toFixed(1);
    const label = isZero ? "0" : (v > 0 ? "+" : "") + v.toFixed(decimals);
    grid += `<line x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" class="${isZero ? "sparkline-zero" : "sparkline-grid"}" />`;
    grid += `<text x="${padL - 5}" y="${(Number(y) + 3).toFixed(1)}" text-anchor="end" class="sparkline-tick">${label}</text>`;
  }
  const spanSeconds =
    offsetHistory.length >= MAX_OFFSET_HISTORY
      ? OFFSET_HISTORY_WINDOW_MS / 1000
      : Math.round(((offsetHistory.length - 1) * POLL_INTERVAL_MS) / 1000);
  const spanLabel = spanSeconds >= 60 ? `${Math.floor(spanSeconds / 60)}m${spanSeconds % 60 ? ` ${spanSeconds % 60}s` : ""}` : `${spanSeconds}s`;
  el.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" class="sparkline-svg" role="img" aria-label="System clock offset in milliseconds over the last few minutes">
      ${grid}
      <text x="2" y="${padT - 1}" class="sparkline-tick">ms</text>
      ${spanSeconds > 0 ? `<text x="${padL}" y="${h - 4}" text-anchor="start" class="sparkline-tick">-${spanLabel}</text>` : ""}
      ${lastX - padL >= 45 ? `<text x="${lastX.toFixed(1)}" y="${h - 4}" text-anchor="end" class="sparkline-tick">now</text>` : ""}
      <polyline points="${points}" class="sparkline-line" />
      <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" class="sparkline-dot" />
    </svg>
    <div class="sparkline-caption">${last.toFixed(1)} ms now · range ${min.toFixed(1)} to ${max.toFixed(1)} ms</div>
  `;
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
      if (offsetHistory.length > MAX_OFFSET_HISTORY) offsetHistory.shift();
    }
    renderOffsetSparkline();
  } catch (err) {
    banner.textContent = `Could not load status: ${err.message}`;
    banner.hidden = false;
  } finally {
    polling = false;
  }
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
