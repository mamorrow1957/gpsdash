const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;
const agentUrl = process.env.AGENT_URL || "http://ntp.local:8081/status";
const agentTimeoutMs = 5000;

// The server polls the agent once per interval and keeps the last HISTORY_WINDOW_MS of clock-offset samples, so the
// graph survives page reloads and is the same for every viewer. /api/status serves the cached poll, so the agent
// (each request opens a gpsd session, ~1 s) sees one request per interval however many pages are open.
// Both values can be overridden through the environment (the tests use short ones).
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 2000;
const HISTORY_WINDOW_MS = Number(process.env.HISTORY_WINDOW_MS) || 15 * 60 * 1000;
const MAX_HISTORY = Math.max(1, Math.round(HISTORY_WINDOW_MS / POLL_INTERVAL_MS));
const STALE_AFTER_MS = 3 * POLL_INTERVAL_MS;

const epoch = Date.now(); // identifies this server run: a client holding an older epoch must discard its history
let seq = 0; // number of samples ever recorded; each sample gets the next number
const history = []; // { seq, t (ms since epoch), offsetMs }, oldest first, at most MAX_HISTORY entries
let latest = null; // { at, data } from the last successful poll
let lastError = "no data from the agent yet";
let inflight = null;

// ---- Persistence ---------------------------------------------------------------------------------------------
// The buffer is saved to a file so a restart or a deploy does not empty the graph. The file must live OUTSIDE the app
// folder: the deploy job runs `rsync --delete` into it. Default: ~/.local/state/gpsdash/history.json (the service user's
// own state directory). HISTORY_FILE=<path> overrides it; HISTORY_FILE="" or "off" turns persistence off.
function historyFilePath() {
  const configured = process.env.HISTORY_FILE;
  if (configured === "" || configured === "off") return null;
  if (configured) return configured;
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "gpsdash", "history.json");
}
const HISTORY_FILE = historyFilePath();
const SAVE_INTERVAL_MS = Number(process.env.HISTORY_SAVE_INTERVAL_MS) || 30000;
// Restored samples are flagged `stale` (the page draws them dashed) when the newest one is older than this: a restart that
// takes a few seconds is invisible, an outage of minutes or hours is shown as such.
const RESTORED_STALE_AFTER_MS = Number(process.env.HISTORY_STALE_AFTER_MS) || 60000;
let dirty = false; // samples recorded since the last save
let saveErrorLogged = false;

// Samples are stored with absolute timestamps, so after a restart their ages (and the gap while the server was down)
// come out right. Old samples are KEPT, however old: after an outage the graph is still fully populated, and the samples
// restored from disk are flagged stale so the page can show which part is old. Only invalid samples and ones stamped in
// the future (a clock that was stepped) are dropped, and the buffer's capacity keeps the newest MAX_HISTORY.
function loadHistory() {
  if (!HISTORY_FILE) {
    console.log("history persistence is off");
    return;
  }
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.log(`ignoring unreadable history file ${HISTORY_FILE}: ${err.message}`);
    else console.log(`no saved history yet (${HISTORY_FILE})`);
    return;
  }
  const now = Date.now();
  const kept = (Array.isArray(saved && saved.samples) ? saved.samples : [])
    .filter((x) => x && Number.isFinite(x.t) && Number.isFinite(x.offsetMs) && x.t <= now + 5000)
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_HISTORY);
  if (!kept.length) {
    console.log(`saved history in ${HISTORY_FILE} was empty`);
    return;
  }
  const newestAgeMs = now - kept[kept.length - 1].t;
  const stale = newestAgeMs > RESTORED_STALE_AFTER_MS;
  for (const x of kept) {
    seq += 1;
    history.push({ seq, t: x.t, offsetMs: x.offsetMs, stale });
  }
  console.log(
    `restored ${kept.length} history samples from ${HISTORY_FILE} (newest ${Math.round(newestAgeMs / 1000)} s old` +
      `${stale ? ", marked stale" : ""})`
  );
}

// Written to a temporary file first and renamed into place, so a crash mid-write never leaves a half-written file.
function saveHistory() {
  if (!HISTORY_FILE) return;
  const tmp = `${HISTORY_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    const body = JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      windowMs: HISTORY_WINDOW_MS,
      intervalMs: POLL_INTERVAL_MS,
      samples: history.map(({ t, offsetMs }) => ({ t, offsetMs })),
    });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, HISTORY_FILE);
    dirty = false;
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (e) {
      // nothing to clean up
    }
    if (!saveErrorLogged) console.log(`could not save history to ${HISTORY_FILE}: ${err.message}`);
    saveErrorLogged = true;
  }
}

async function pollAgent() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), agentTimeoutMs);
  try {
    const agentRes = await fetch(agentUrl, { signal: controller.signal });
    if (!agentRes.ok) {
      throw new Error(`agent responded with ${agentRes.status}`);
    }
    const data = await agentRes.json();
    const now = Date.now();
    latest = { at: now, data };
    lastError = null;
    const offsetSeconds = data && data.ntp && data.ntp.system_offset_seconds;
    if (typeof offsetSeconds === "number") {
      seq += 1;
      history.push({ seq, t: now, offsetMs: offsetSeconds * 1000, stale: false });
      while (history.length > MAX_HISTORY) history.shift();
      dirty = true;
    }
  } catch (err) {
    lastError = err.name === "AbortError" ? "the request timed out" : err.message;
  } finally {
    clearTimeout(timeout);
  }
}

// One poll at a time: callers that arrive while a poll is running wait for that same poll.
function refresh() {
  if (!inflight) inflight = pollAgent().finally(() => (inflight = null));
  return inflight;
}

// The samples newer than `since` as { ageMs, offsetMs }. Ages (not timestamps) keep the client's clock out of it.
// A client that holds another server run's history (different epoch), or a number from the future, is told to reset.
function historySince(since, clientEpoch) {
  const now = Date.now();
  const reset = String(clientEpoch) !== String(epoch) || !(since <= seq);
  const from = reset ? 0 : since;
  return {
    epoch,
    seq,
    reset,
    samples: history
      .filter((s) => s.seq > from)
      .map((s) => ({ seq: s.seq, ageMs: now - s.t, offsetMs: s.offsetMs, stale: s.stale })),
  };
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// The whole buffer, for inspection ("how much history does the server hold?").
app.get("/api/history", (req, res) => {
  const h = historySince(0, epoch);
  res.set("Cache-Control", "no-store");
  res.json({
    intervalMs: POLL_INTERVAL_MS,
    windowMs: HISTORY_WINDOW_MS,
    capacity: MAX_HISTORY,
    count: h.samples.length,
    oldestAgeMs: h.samples.length ? h.samples[0].ageMs : null,
    epoch,
    seq,
    samples: h.samples,
  });
});

// The latest agent status. With ?since=<seq>&epoch=<epoch> the reply also carries the clock-offset samples recorded
// after that point ({history: {epoch, seq, reset, samples}}); ?since=0 returns the whole buffer. Without `since`
// the reply is the plain agent status, as before.
app.get("/api/status", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!latest || Date.now() - latest.at > STALE_AFTER_MS) {
    await refresh();
  }
  if (!latest || Date.now() - latest.at > STALE_AFTER_MS) {
    res.status(502).json({ error: `could not reach ntp.local agent: ${lastError || "no recent data"}` });
    return;
  }
  if (req.query.since === undefined) {
    res.json(latest.data);
    return;
  }
  const since = Number(req.query.since);
  res.json({ ...latest.data, history: historySince(since, req.query.epoch) });
});

loadHistory();

app.listen(port, () => {
  console.log(`gpsdash listening on port ${port}`);
  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
  setInterval(() => {
    if (dirty) saveHistory();
  }, SAVE_INTERVAL_MS);
});

// systemd stops the service with SIGTERM (a deploy restarts it): save what we have before exiting.
function shutdown() {
  saveHistory();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

module.exports = app;
