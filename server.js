const express = require("express");
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
      history.push({ seq, t: now, offsetMs: offsetSeconds * 1000 });
      while (history.length > MAX_HISTORY) history.shift();
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
    samples: history.filter((s) => s.seq > from).map((s) => ({ seq: s.seq, ageMs: now - s.t, offsetMs: s.offsetMs })),
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

app.listen(port, () => {
  console.log(`gpsdash listening on port ${port}`);
  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
});

module.exports = app;
