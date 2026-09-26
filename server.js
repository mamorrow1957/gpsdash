const express = require("express");
const path = require("path");

const app = express();
const port = process.env.PORT || 3000;
const agentUrl = process.env.AGENT_URL || "http://ntp.local:8081/status";
const agentHistoryUrl = process.env.AGENT_HISTORY_URL || agentUrl.replace(/\/status\/?$/, "/history");
const agentTimeoutMs = 5000;

// The ntp agent owns the clock-offset history (it samples chrony every 2 s and keeps the last 15 minutes, saved to its own
// disk). This server only RELAYS it: every poll it asks the agent for the status (for the panels) and for the history it
// has not seen yet, and keeps a copy IN MEMORY (nothing time-based is written to disk here). A restart of this server
// therefore loses nothing: it refills from the agent on its first poll, including the time it was down. The in-memory
// copy is what lets a page opened while the agent is down still draw the past, with the outage marked.
// /api/status serves the cached poll, so the agent (each /status request opens a gpsd session, ~1 s) sees one request
// per interval however many pages are open. All of these can be overridden through the environment (tests use short ones).
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 2000;
const HISTORY_WINDOW_MS = Number(process.env.HISTORY_WINDOW_MS) || 15 * 60 * 1000;
const MAX_HISTORY = Math.max(1, Math.round(HISTORY_WINDOW_MS / POLL_INTERVAL_MS));
const CACHE_MAX_AGE_MS = 3 * POLL_INTERVAL_MS;

const epoch = Date.now(); // identifies this server run: a browser holding an older epoch must discard its history
let seq = 0; // number of samples ever mirrored; each gets the next number (this is the browsers' sequence, not the agent's)
const history = []; // { seq, t (ms since epoch, this server's clock), offsetMs }, oldest first, at most MAX_HISTORY entries
let agentEpoch = null; // the agent run our copy is in step with, and the newest agent sample number we hold
let agentSeq = 0;
let agentHasHistory = null; // null = not known yet, false = an older agent without /history (see syncHistory)
let latest = null; // { at, data } from the last successful status poll
let lastError = "no data from the agent yet";
let inflight = null;

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), agentTimeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`agent responded with ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

function addSample(t, offsetMs) {
  seq += 1;
  history.push({ seq, t, offsetMs });
  while (history.length > MAX_HISTORY) history.shift();
}

// Append the agent's samples that are newer than what we hold. The agent sends ages, so its clock and ours never mix. When
// the agent restarted (a new epoch) it sends its whole buffer again: the part we already hold is dropped, so nothing is
// duplicated or inserted out of order (browsers only ever receive new samples at the end).
function mergeAgentHistory(h) {
  const now = Date.now();
  const newest = history.length ? history[history.length - 1].t : -Infinity;
  const incoming = h.samples.map((s) => ({ t: now - s.ageMs, offsetMs: s.offsetMs })).sort((a, b) => a.t - b.t);
  const tolerance = (h.intervalMs || POLL_INTERVAL_MS) / 2; // the agent's sample spacing; absorbs the jitter of converting ages
  for (const s of incoming) {
    if (s.t > newest + tolerance) addSample(s.t, s.offsetMs);
  }
  agentEpoch = h.epoch;
  agentSeq = h.seq;
}

async function syncHistory(status) {
  if (agentHasHistory !== false) {
    try {
      const h = await fetchJson(`${agentHistoryUrl}?since=${agentSeq}&epoch=${agentEpoch === null ? "" : agentEpoch}`);
      agentHasHistory = true;
      mergeAgentHistory(h);
      return;
    } catch (err) {
      if (err.status !== 404) return; // a hiccup: the next poll asks again from the same point, so nothing is missed
      agentHasHistory = false;
    }
  }
  // An agent without /history (older code, for instance while both are being deployed): keep our own samples from the
  // status, in memory, as before.
  const offsetSeconds = status && status.ntp && status.ntp.system_offset_seconds;
  if (typeof offsetSeconds === "number") addSample(Date.now(), offsetSeconds * 1000);
}

async function pollAgent() {
  try {
    const data = await fetchJson(agentUrl);
    latest = { at: Date.now(), data };
    lastError = null;
    await syncHistory(data);
  } catch (err) {
    lastError = err.name === "AbortError" ? "the request timed out" : err.message;
  }
}

// One poll at a time: callers that arrive while a poll is running wait for that same poll.
function refresh() {
  if (!inflight) inflight = pollAgent().finally(() => (inflight = null));
  return inflight;
}

// The samples newer than `since` as { ageMs, offsetMs }. Ages (not timestamps) keep the browser's clock out of it.
// A browser that holds another server run's history (different epoch), or a number from the future, is told to reset.
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

// The whole in-memory copy, for inspection ("how much history does the server hold?").
app.get("/api/history", (req, res) => {
  const h = historySince(0, epoch);
  res.set("Cache-Control", "no-store");
  res.json({
    intervalMs: POLL_INTERVAL_MS,
    windowMs: HISTORY_WINDOW_MS,
    capacity: MAX_HISTORY,
    count: h.samples.length,
    oldestAgeMs: h.samples.length ? h.samples[0].ageMs : null,
    source: agentHasHistory === false ? "own samples (agent has no /history)" : "ntp agent",
    epoch,
    seq,
    samples: h.samples,
  });
});

// The latest agent status. With ?since=<seq>&epoch=<epoch> the reply also carries the clock-offset samples recorded
// after that point ({history: {epoch, seq, reset, samples}}); ?since=0 returns the whole copy. Without `since` the reply
// is the plain agent status, as before. While the agent is unreachable the 502 reply carries `history` too.
app.get("/api/status", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!latest || Date.now() - latest.at > CACHE_MAX_AGE_MS) {
    await refresh();
  }
  if (!latest || Date.now() - latest.at > CACHE_MAX_AGE_MS) {
    // The history is still worth sending: the page draws what it has and marks the stretch with no data.
    const body = { error: `could not reach ntp.local agent: ${lastError || "no recent data"}` };
    if (req.query.since !== undefined) body.history = historySince(Number(req.query.since), req.query.epoch);
    res.status(502).json(body);
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
