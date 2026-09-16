// Frontend logic for gpsdash — polls the backend for ntp.local GPS/NTP status.

const POLL_INTERVAL_MS = 5000;

const FIX_MODE_LABELS = { 0: "Unknown", 1: "No fix", 2: "2D fix", 3: "3D fix" };

function fmtOffset(seconds) {
  if (seconds === undefined || seconds === null) return "—";
  return `${(seconds * 1000).toFixed(1)} ms`;
}

function fmtCoord(value, digits = 5) {
  if (value === undefined || value === null) return "—";
  return value.toFixed(digits);
}

function renderGps(gps) {
  const el = document.getElementById("gps-panel");
  if (!gps) {
    el.innerHTML = "<p class='error'>No GPS data</p>";
    return;
  }
  el.innerHTML = `
    <dl>
      <dt>Fix</dt><dd>${FIX_MODE_LABELS[gps.mode] ?? "Unknown"}</dd>
      <dt>Satellites</dt><dd>${gps.satellites_used ?? "—"} used / ${gps.satellites_visible ?? "—"} visible</dd>
      <dt>HDOP</dt><dd>${gps.hdop ?? "—"}</dd>
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
  el.innerHTML = `
    <dl>
      <dt>Reference</dt><dd>${ntp.reference_name} (stratum ${ntp.stratum})</dd>
      <dt>System offset</dt><dd>${fmtOffset(ntp.system_offset_seconds)}</dd>
      <dt>Leap status</dt><dd>${ntp.leap_status}</dd>
      <dt>GPS-disciplined</dt><dd class="${gpsSelected ? "ok" : "warn"}">${gpsSelected ? "Yes" : "No — using network NTP"}</dd>
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

async function poll() {
  const banner = document.getElementById("error-banner");
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "unknown error");
    banner.hidden = true;
    renderGps(data.gps);
    renderNtp(data.ntp, data.sources);
    renderSources(data.sources);
  } catch (err) {
    banner.textContent = `Could not load status: ${err.message}`;
    banner.hidden = false;
  }
}

poll();
setInterval(poll, POLL_INTERVAL_MS);
