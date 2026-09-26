const { test, expect } = require("@playwright/test");

test("loads the dashboard page", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toHaveText("gpsdash");
});

test("health endpoint responds ok", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toEqual({ status: "ok" });
});

test("serves the favicon files", async ({ request }) => {
  const svg = await request.get("/favicon.svg");
  expect(svg.ok()).toBeTruthy();
  expect(svg.headers()["content-type"]).toContain("image/svg+xml");
  const ico = await request.get("/favicon.ico");
  expect(ico.ok()).toBeTruthy();
});

// ---- Clock offset graph -------------------------------------------------------------------
// /api/status is stubbed with synthetic data (fake coordinates), so these tests never touch the real agent.
const STATUS = {
  gps: { mode: 3, satellites_used: 8, satellites_visible: 12, lat: 1.5, lon: 2.5, alt_m: 100, hdop: 1.0, satellites: [] },
  ntp: {
    reference_id: "47505300",
    reference_name: "GPS",
    stratum: 1,
    system_offset_seconds: 0.00002,
    last_offset_seconds: 0.000001,
    frequency_ppm: 1,
    root_delay_seconds: 0.001,
    root_dispersion_seconds: 0.001,
    leap_status: "Normal",
  },
  sources: [],
};

async function stubStatus(page, offsetSeconds, satellites) {
  const gps = satellites
    ? {
        ...STATUS.gps,
        satellites,
        satellites_visible: satellites.length,
        satellites_used: satellites.filter((sat) => sat.used).length,
      }
    : STATUS.gps;
  // Like the real server: the reply carries the offset history, here a single sample (a reset each time, so it never piles up).
  const history = { epoch: 1, seq: 1, reset: true, samples: [{ seq: 1, ageMs: 0, offsetMs: offsetSeconds * 1000 }] };
  await page.route("**/api/status*", (route) =>
    route.fulfill({ json: { ...STATUS, gps, ntp: { ...STATUS.ntp, system_offset_seconds: offsetSeconds }, history } })
  );
}

test("offset graph defaults to a linear value axis and a log time axis over 15 minutes", async ({ page }) => {
  await stubStatus(page, 0.00002); // 20 µs
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("svg")).toBeVisible();
  await expect(page.locator("#toggle-y")).toHaveText("Value: linear");
  await expect(page.locator("#toggle-y")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#toggle-t")).toHaveText("Time: log");
  await expect(page.locator("#toggle-t")).toHaveAttribute("aria-pressed", "true");
  await expect(graph.locator("text", { hasText: "-15m" })).toBeVisible();
  await expect(graph.locator("text", { hasText: "now" })).toBeVisible();
  await expect(graph.locator("text", { hasText: "µs" })).toHaveCount(0); // linear ticks carry no unit
  await expect(graph.locator(".sparkline-caption")).toContainText("20.0 µs now");
});

test("value toggle switches to a symmetric-log axis and the choice survives a reload", async ({ page }) => {
  await stubStatus(page, 0.00002); // 20 µs
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("svg")).toBeVisible();
  await page.locator("#toggle-y").click();
  await expect(page.locator("#toggle-y")).toHaveText("Value: log");
  await expect(page.locator("#toggle-y")).toHaveAttribute("aria-pressed", "true");
  await expect(graph.locator("text", { hasText: "+100µs" })).toBeVisible();
  await expect(graph.locator("text", { hasText: "-100µs" })).toBeVisible();
  await page.reload();
  await expect(page.locator("#toggle-y")).toHaveText("Value: log");
  await expect(page.locator("#toggle-t")).toHaveText("Time: log");
});

test("the log value axis follows the size of the offset (a few ms zooms out to decades of ms)", async ({ page }) => {
  await stubStatus(page, 0.0031); // 3.1 ms
  await page.goto("/");
  await expect(page.locator("#offset-sparkline svg")).toBeVisible();
  await page.locator("#toggle-y").click();
  await expect(page.locator("#offset-sparkline text", { hasText: "+10ms" })).toBeVisible();
  await expect(page.locator("#offset-sparkline .sparkline-caption")).toContainText("3.1 ms now");
});

test("time toggle switches to the linear (fill left to right) axis and the choice survives a reload", async ({ page }) => {
  await stubStatus(page, 0.00002);
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("text", { hasText: "-15m" })).toBeVisible();
  await page.locator("#toggle-t").click();
  await expect(page.locator("#toggle-t")).toHaveText("Time: linear");
  await expect(graph.locator("text", { hasText: "-15m" })).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#toggle-t")).toHaveText("Time: linear");
  await expect(page.locator("#toggle-y")).toHaveText("Value: linear");
});

test("the graph keeps 15 minutes of samples", async ({ page }) => {
  await stubStatus(page, 0.00002);
  await page.goto("/");
  await expect(page.locator("#offset-sparkline svg")).toBeVisible();
  const cap = await page.evaluate(() => ({ max: MAX_OFFSET_HISTORY, windowMs: OFFSET_HISTORY_WINDOW_MS, poll: POLL_INTERVAL_MS }));
  expect(cap).toEqual({ max: 450, windowMs: 15 * 60 * 1000, poll: 2000 });
});

// ---- Sky view ---------------------------------------------------------------------------------
// gpsd reports satellites it has no position for as az 0 / el -999. They must not be drawn off the canvas, and the
// legend must add up to every satellite in the list.
const SKY_SATELLITES = [
  { prn: 5, az: 77, el: 21, ss: 33, used: true, gnssid: 0, svid: 5 },
  { prn: 15, az: 48, el: 69, ss: 27, used: true, gnssid: 0, svid: 15 },
  { prn: 27, az: 318, el: 12, ss: 25, used: false, gnssid: 0, svid: 27 }, // above the horizon, heard, not used
  { prn: 46, az: 201, el: 43, ss: 0, used: false, gnssid: 1, svid: 133 }, // SBAS, above the horizon, no signal
  { prn: 30, az: 100, el: -5, ss: 0, used: false, gnssid: 0, svid: 30 }, // below the horizon
  { prn: 193, az: 0, el: -999, ss: 0, used: false, gnssid: 5, svid: 1 }, // QZSS, gpsd's "no position"
  { prn: 197, az: 0, el: -999, ss: 0, used: false, gnssid: 5, svid: 4 },
  { prn: 199, az: null, el: null, ss: null, used: false, gnssid: 5, svid: 6 }, // position missing entirely
];

test("sky view legend accounts for every satellite and only plots ones that have a position", async ({ page }) => {
  await stubStatus(page, 0.00002, SKY_SATELLITES);
  await page.goto("/");
  const sky = page.locator("#sky-plot");
  await expect(sky.locator(".sky-svg")).toBeVisible();
  const legend = sky.locator(".legend-states");
  await expect(legend).toContainText("Used (2)");
  await expect(legend).toContainText("Not used (1)");
  await expect(legend).toContainText("No signal (1)");
  await expect(legend).toContainText("Below horizon (1)");
  await expect(legend).toContainText("No position (3)");
  // 2 + 1 + 1 + 1 + 3 = 8 = every satellite in the list
  await expect(sky.locator(".sky-dot-used")).toHaveCount(2);
  await expect(sky.locator(".sky-dot-unused")).toHaveCount(1);
  await expect(sky.locator(".sky-dot-nosignal")).toHaveCount(1);
  await expect(sky.locator(".sky-note")).toContainText("No position reported: QZSS 193, 197, 199");
  await expect(sky.locator(".sky-note")).toContainText("Below the horizon: GPS 30");
});

test("every plotted satellite dot lies inside the sky view canvas", async ({ page }) => {
  await stubStatus(page, 0.00002, SKY_SATELLITES);
  await page.goto("/");
  await expect(page.locator("#sky-plot .sky-svg")).toBeVisible();
  const outside = await page.evaluate(() => {
    const svg = document.querySelector("#sky-plot .sky-svg");
    const vb = svg.viewBox.baseVal;
    return [...svg.querySelectorAll("[class^='sky-dot']")]
      .map((c) => ({ x: +c.getAttribute("cx"), y: +c.getAttribute("cy") }))
      .filter((d) => d.x < 0 || d.x > vb.width || d.y < 0 || d.y > vb.height).length;
  });
  expect(outside).toBe(0);
});

test("sky view omits the extra legend items when every satellite has a position and a signal", async ({ page }) => {
  await stubStatus(page, 0.00002, SKY_SATELLITES.slice(0, 3));
  await page.goto("/");
  const legend = page.locator("#sky-plot .legend-states");
  await expect(legend).toContainText("Used (2)");
  await expect(legend).toContainText("Not used (1)");
  await expect(legend).not.toContainText("No signal");
  await expect(legend).not.toContainText("No position");
  await expect(page.locator("#sky-plot .sky-note")).toHaveCount(0);
});

// ---- Constellations -----------------------------------------------------------------------
test("sky view summarises used/listed satellites per constellation and names them in the notes", async ({ page }) => {
  await stubStatus(page, 0.00002, SKY_SATELLITES);
  await page.goto("/");
  const row = page.locator("#sky-plot .legend-constellations");
  await expect(row).toContainText("GPS 2/4"); // 5, 15 used; 27 not used; 30 below the horizon
  await expect(row).toContainText("SBAS 0/1");
  await expect(row).toContainText("QZSS 0/3");
});

const SHAPE_SATELLITES = [
  { prn: 5, az: 10, el: 60, ss: 30, used: true, gnssid: 0, svid: 5 }, // GPS
  { prn: 46, az: 100, el: 40, ss: 0, used: false, gnssid: 1, svid: 133 }, // SBAS
  { prn: 301, az: 160, el: 50, ss: 28, used: true, gnssid: 2, svid: 1 }, // Galileo
  { prn: 161, az: 220, el: 30, ss: 27, used: true, gnssid: 3, svid: 1 }, // BeiDou
  { prn: 194, az: 280, el: 20, ss: 22, used: false, gnssid: 5, svid: 2 }, // QZSS
  { prn: 70, az: 330, el: 45, ss: 26, used: true, gnssid: 6, svid: 5 }, // GLONASS
];

test("each constellation gets its own shape AND colour, and a tooltip naming it", async ({ page }) => {
  await stubStatus(page, 0.00002, SHAPE_SATELLITES);
  await page.goto("/");
  await expect(page.locator("#sky-plot .sky-svg")).toBeVisible();
  const marks = await page.evaluate(() => {
    const out = {};
    for (const m of document.querySelectorAll("#sky-plot .sky-svg [class^='sky-dot']")) {
      const title = m.querySelector("title").textContent;
      const vertices = m.tagName === "polygon" ? m.getAttribute("points").trim().split(/\s+/).length : null;
      out[title.split(" · ")[0]] = { tag: m.tagName, vertices, colour: m.style.getPropertyValue("--sat"), state: m.getAttribute("class"), title };
    }
    return out;
  });
  // shape identifies the constellation...
  expect(marks.GPS).toMatchObject({ tag: "circle" });
  expect(marks.SBAS).toMatchObject({ tag: "rect" });
  expect(marks.QZSS).toMatchObject({ tag: "polygon", vertices: 4 }); // diamond
  expect(marks.GLONASS).toMatchObject({ tag: "polygon", vertices: 3 }); // triangle
  expect(marks.Galileo).toMatchObject({ tag: "polygon", vertices: 3 }); // inverted triangle
  expect(marks.BeiDou).toMatchObject({ tag: "polygon", vertices: 6 }); // hexagon
  // ...and so does colour: six constellations -> six distinct colours
  expect(new Set(Object.values(marks).map((m) => m.colour)).size).toBe(6);
  expect(marks.GPS.colour).toBe("#3987e5");
  expect(marks.SBAS.colour).toBe("#f0e442");
  expect(marks.QZSS.colour).toBe("#cc79a7");
  // state is carried by the fill style, not the colour or shape
  expect(marks.GPS.state).toBe("sky-dot-used");
  expect(marks.SBAS.state).toBe("sky-dot-nosignal");
  expect(marks.QZSS.state).toBe("sky-dot-unused");
  expect(marks.SBAS.title).toContain("PRN 46 (sv 133)");
  expect(marks.GPS.title).not.toContain("(sv"); // svid equals PRN for GPS
});

test("without constellation data (older agent) the sky view falls back to plain PRNs and circles", async ({ page }) => {
  const legacy = SKY_SATELLITES.map(({ gnssid, svid, ...rest }) => rest);
  await stubStatus(page, 0.00002, legacy);
  await page.goto("/");
  const sky = page.locator("#sky-plot");
  await expect(sky.locator(".sky-svg")).toBeVisible();
  await expect(sky.locator(".legend-constellations")).toHaveCount(0);
  await expect(sky.locator(".sky-note")).toContainText("No position reported: PRN 193, 197, 199");
  const tags = await page.evaluate(() => [...document.querySelectorAll("#sky-plot .sky-svg [class^='sky-dot']")].map((m) => m.tagName));
  expect([...new Set(tags)]).toEqual(["circle"]);
});

// ---- Server-side offset history -----------------------------------------------------------------
// These start the real server.js against a small fake agent, with a short poll interval, so the ring buffer, the
// since/epoch protocol and the agent-load behaviour can be checked without real hardware.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function startFakeAgent(offsetFor) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    const n = calls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ...STATUS, ntp: { ...STATUS.ntp, system_offset_seconds: offsetFor(n) } }));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/status`, calls: () => calls, close: () => server.close() })
    )
  );
}

async function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn("node", ["server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), HISTORY_FILE: "", ...env }, // persistence is off unless a test sets HISTORY_FILE
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch (e) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // stop() sends SIGTERM (as systemd does) and resolves once the process has exited
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  return { base, stop };
}

const getJson = async (url) => (await fetch(url)).json();

test("the server records one clock-offset sample per poll and reports them oldest first", async () => {
  const agent = await startFakeAgent((n) => 0.001 * (n + 1)); // 1 ms, 2 ms, 3 ms ...
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await getJson(`${server.base}/api/history`)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(5);
    const h = await getJson(`${server.base}/api/history`);
    expect(h.intervalMs).toBe(100);
    expect(h.capacity).toBe(9000); // 15 minutes at one sample per 100 ms
    const offsets = h.samples.map((s) => s.offsetMs);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b)); // oldest first (the fake agent's offsets only grow)
    const ages = h.samples.map((s) => s.ageMs);
    expect(ages).toEqual([...ages].sort((a, b) => b - a)); // oldest = largest age
    expect(h.oldestAgeMs).toBe(ages[0]);
  } finally {
    server.stop();
    agent.close();
  }
});

test("the history is a ring buffer: it never holds more than the window and drops the oldest", async () => {
  const agent = await startFakeAgent((n) => 0.001 * (n + 1));
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HISTORY_WINDOW_MS: "1000" });
  try {
    await expect.poll(async () => (await getJson(`${server.base}/api/history`)).seq, { timeout: 10000 }).toBeGreaterThan(15);
    const h = await getJson(`${server.base}/api/history`);
    expect(h.capacity).toBe(10);
    expect(h.count).toBe(10);
    const seqs = h.samples.map((s) => s.seq);
    expect(seqs[seqs.length - 1] - seqs[0]).toBe(9); // ten consecutive samples, the newest ones
    expect(seqs[0]).toBeGreaterThan(1); // the earliest have been dropped
  } finally {
    server.stop();
    agent.close();
  }
});

test("/api/status?since returns only newer samples, and tells a client with another epoch to reset", async () => {
  const agent = await startFakeAgent((n) => 0.001 * (n + 1));
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await getJson(`${server.base}/api/history`)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(4);
    // a first-time client (no epoch): everything, flagged as a reset
    const first = (await getJson(`${server.base}/api/status?since=0&epoch=`)).history;
    expect(first.reset).toBe(true);
    expect(first.samples.length).toBeGreaterThanOrEqual(4);
    // a returning client: only what is newer than what it holds
    await expect.poll(async () => (await getJson(`${server.base}/api/history`)).seq, { timeout: 8000 }).toBeGreaterThan(first.seq);
    const next = (await getJson(`${server.base}/api/status?since=${first.seq}&epoch=${first.epoch}`)).history;
    expect(next.reset).toBe(false);
    expect(next.samples.length).toBeGreaterThan(0);
    expect(next.samples.every((s) => s.seq > first.seq)).toBe(true);
    // a client from another server run, or one holding a number from the future, must reset
    const otherRun = (await getJson(`${server.base}/api/status?since=${first.seq}&epoch=12345`)).history;
    expect(otherRun.reset).toBe(true);
    expect(otherRun.samples.length).toBeGreaterThanOrEqual(first.samples.length);
    const future = (await getJson(`${server.base}/api/status?since=999999&epoch=${first.epoch}`)).history;
    expect(future.reset).toBe(true);
  } finally {
    server.stop();
    agent.close();
  }
});

test("/api/status without ?since is the plain agent status, as before", async () => {
  const agent = await startFakeAgent(() => 0.00002);
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await fetch(`${server.base}/api/status`)).status, { timeout: 8000 }).toBe(200);
    const body = await getJson(`${server.base}/api/status`);
    expect(body.ntp.stratum).toBe(1);
    expect(body.history).toBeUndefined();
  } finally {
    server.stop();
    agent.close();
  }
});

test("the agent sees about one request per interval, however many pages ask for the status", async () => {
  const agent = await startFakeAgent(() => 0.00002);
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "300" });
  try {
    await expect.poll(async () => (await fetch(`${server.base}/api/status`)).status, { timeout: 8000 }).toBe(200);
    const before = agent.calls();
    const started = Date.now();
    for (let i = 0; i < 40; i++) await fetch(`${server.base}/api/status?since=0`);
    const elapsed = Date.now() - started;
    const extra = agent.calls() - before;
    // 40 page requests must not turn into 40 agent requests: only the background polls (plus slack) reach it
    expect(extra).toBeLessThanOrEqual(Math.ceil(elapsed / 300) + 2);
    expect(extra).toBeLessThan(15);
  } finally {
    server.stop();
    agent.close();
  }
});

test("when the agent is unreachable /api/status answers 502 with a clear message and no history builds up", async () => {
  const server = await startServer({ AGENT_URL: `http://127.0.0.1:${await freePort()}/status`, POLL_INTERVAL_MS: "100" });
  try {
    const res = await fetch(`${server.base}/api/status?since=0`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("could not reach ntp.local agent");
    expect((await getJson(`${server.base}/api/history`)).count).toBe(0);
  } finally {
    server.stop();
  }
});

// ---- The page uses the server's history ------------------------------------------------------------
// Serves a fixed list of responses to /api/status (the last one repeats) and records the URLs the page asked for.
async function stubStatusHistory(page, histories) {
  const urls = [];
  await page.route("**/api/status*", (route) => {
    const i = Math.min(urls.length, histories.length - 1);
    urls.push(route.request().url());
    route.fulfill({ json: { ...STATUS, history: histories[i] } });
  });
  return urls;
}

function samples(n, fromSeq = 1, offsetMs = 0.02) {
  // n samples two seconds apart, the newest 0 ms old
  return Array.from({ length: n }, (_, i) => ({ seq: fromSeq + i, ageMs: (n - 1 - i) * 2000, offsetMs }));
}

const plotted = (page) =>
  page.evaluate(() => {
    const line = document.querySelector("#offset-sparkline polyline");
    return line ? line.getAttribute("points").trim().split(/\s+/).length : 0;
  });

test("the graph is filled from the server's history as soon as the page loads", async ({ page }) => {
  await stubStatusHistory(page, [{ epoch: 7, seq: 450, reset: true, samples: samples(450) }]);
  await page.goto("/");
  await expect.poll(() => plotted(page)).toBe(450);
  await expect(page.locator("#offset-sparkline text", { hasText: "-15m" })).toBeVisible();
});

test("later polls ask only for what is new, quoting the epoch they were given", async ({ page }) => {
  const urls = await stubStatusHistory(page, [{ epoch: 7, seq: 450, reset: true, samples: samples(450) }]);
  await page.goto("/");
  await expect.poll(() => urls.length, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  expect(urls[0]).toContain("since=0");
  expect(urls[1]).toContain("since=450");
  expect(urls[1]).toContain("epoch=7");
});

test("a reset from the server (it restarted) makes the page drop what it had", async ({ page }) => {
  await stubStatusHistory(page, [
    { epoch: 1, seq: 10, reset: true, samples: samples(10) },
    { epoch: 2, seq: 3, reset: true, samples: samples(3) },
  ]);
  await page.goto("/");
  await expect.poll(() => plotted(page)).toBe(10);
  await expect.poll(() => plotted(page), { timeout: 8000 }).toBe(3);
});

// ---- Saving the history to disk -------------------------------------------------------------------------
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gpsdash-history-"));

async function historyOf(server) {
  return getJson(`${server.base}/api/history`);
}

test("the history is saved to disk periodically, atomically, with the samples and their timestamps", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  const agent = await startFakeAgent((n) => 0.001 * (n + 1));
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HISTORY_FILE: file, HISTORY_SAVE_INTERVAL_MS: "200" });
  try {
    await expect.poll(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).samples.length, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.samples[0]).toEqual({ t: expect.any(Number), offsetMs: expect.any(Number) });
    expect(fs.readdirSync(dir)).toEqual(["history.json"]); // no temporary file left behind
  } finally {
    await server.stop();
    agent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a graceful stop saves the latest samples even when the save interval is long", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  const agent = await startFakeAgent((n) => 0.001 * (n + 1));
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HISTORY_FILE: file, HISTORY_SAVE_INTERVAL_MS: "600000" });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(4);
    expect(fs.existsSync(file)).toBe(false); // the periodic save has not fired yet
    const held = (await historyOf(server)).count;
    await server.stop(); // SIGTERM, like `systemctl restart` during a deploy
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.samples.length).toBeGreaterThanOrEqual(held);
  } finally {
    await server.stop();
    agent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart restores the history with correct ages, and clients are told to reset", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  const agent = await startFakeAgent((n) => 0.001 * (n + 1));
  const first = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HISTORY_FILE: file });
  let before;
  try {
    await expect.poll(async () => (await historyOf(first)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(5);
    before = await historyOf(first);
  } finally {
    await first.stop();
    agent.close();
  }
  // second run: the agent is unreachable, so everything it holds must have come from the file
  const down = await freePort();
  const second = await startServer({ AGENT_URL: `http://127.0.0.1:${down}/status`, POLL_INTERVAL_MS: "100", HISTORY_FILE: file });
  try {
    const after = await historyOf(second);
    expect(after.count).toBeGreaterThanOrEqual(before.count);
    expect(after.epoch).not.toBe(before.epoch);
    expect(after.samples.slice(0, 3).map((s) => s.offsetMs)).toEqual(before.samples.slice(0, 3).map((s) => s.offsetMs));
    // the samples are older now by roughly the time that passed, not reset to "just now"
    expect(after.oldestAgeMs).toBeGreaterThan(before.oldestAgeMs);
    // a page that held the first run's history is told to drop it and take the restored one
    const status = await fetch(`${second.base}/api/status?since=${before.seq}&epoch=${before.epoch}`);
    expect(status.status).toBe(502); // agent is down, but the history is served from /api/history
    const seeded = await getJson(`${second.base}/api/history`);
    expect(seeded.count).toBe(after.count);
  } finally {
    await second.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("old saved samples are still loaded and flagged stale; invalid or future-stamped ones are dropped", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  const now = Date.now();
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      samples: [
        { t: now - 2 * 60 * 60 * 1000, offsetMs: 1 }, // two hours old: kept (the graph stays populated after an outage)
        { t: now - 90 * 60 * 1000, offsetMs: 2 },
        { t: now - 80 * 60 * 1000, offsetMs: 3 },
        { t: now + 10 * 60 * 1000, offsetMs: 9 }, // ten minutes in the future: a stepped clock, dropped
        { t: "not a number", offsetMs: 9 },
        null,
      ],
    })
  );
  const server = await startServer({ AGENT_URL: `http://127.0.0.1:${await freePort()}/status`, POLL_INTERVAL_MS: "100", HISTORY_FILE: file });
  try {
    const h = await historyOf(server);
    expect(h.samples.map((s) => s.offsetMs)).toEqual([1, 2, 3]); // oldest first
    expect(h.samples.every((s) => s.stale === true)).toBe(true); // the newest is 80 minutes old
    expect(h.oldestAgeMs).toBeGreaterThan(119 * 60 * 1000);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart that only took a moment is not flagged stale; live samples never are", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ version: 1, samples: [1, 2, 3].map((i) => ({ t: now - (4 - i) * 2000 - 3000, offsetMs: i })) }));
  const agent = await startFakeAgent(() => 0.005);
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HISTORY_FILE: file });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(6);
    const h = await historyOf(server);
    expect(h.samples.every((s) => s.stale === false)).toBe(true); // newest saved sample was seconds old: within HISTORY_STALE_AFTER_MS
  } finally {
    await server.stop();
    agent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restored samples are stale, samples recorded after the restart are not, and the cutoff is configurable", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ version: 1, samples: [1, 2, 3].map((i) => ({ t: now - 10 * 60 * 1000 + i * 2000, offsetMs: i })) }));
  const agent = await startFakeAgent(() => 0.005);
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HISTORY_FILE: file });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(6);
    const h = await historyOf(server);
    const flags = h.samples.map((s) => s.stale);
    expect(flags.slice(0, 3)).toEqual([true, true, true]); // from before the restart (10 minutes old)
    expect(flags.slice(3).every((f) => f === false)).toBe(true); // recorded by this run
    // and the plain status call carries the same flags
    const status = await getJson(`${server.base}/api/status?since=0`);
    expect(status.history.samples.slice(0, 3).every((s) => s.stale === true)).toBe(true);
  } finally {
    await server.stop();
    agent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("when more samples were saved than the buffer holds, the newest ones are kept", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ version: 1, samples: Array.from({ length: 25 }, (_, i) => ({ t: now - (25 - i) * 60 * 1000, offsetMs: i })) }));
  const server = await startServer({ AGENT_URL: `http://127.0.0.1:${await freePort()}/status`, POLL_INTERVAL_MS: "100", HISTORY_WINDOW_MS: "1000", HISTORY_FILE: file });
  try {
    const h = await historyOf(server);
    expect(h.capacity).toBe(10);
    expect(h.samples.map((s) => s.offsetMs)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  } finally {
    await server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt history file is ignored: the server starts empty and still works", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  fs.writeFileSync(file, "{ this is not json");
  const agent = await startFakeAgent(() => 0.00002);
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HISTORY_FILE: file, HISTORY_SAVE_INTERVAL_MS: "200" });
  try {
    expect((await fetch(`${server.base}/api/health`)).ok).toBe(true);
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
    // and the next save replaces the garbage with a valid file
    await expect.poll(() => { try { return JSON.parse(fs.readFileSync(file, "utf8")).samples.length; } catch (e) { return 0; } }, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
  } finally {
    await server.stop();
    agent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("persistence can be switched off: nothing is written", async () => {
  const dir = tempDir();
  const agent = await startFakeAgent(() => 0.00002);
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HISTORY_FILE: "off", HISTORY_SAVE_INTERVAL_MS: "100", HOME: dir, XDG_STATE_HOME: dir });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(4);
    await server.stop();
    expect(fs.readdirSync(dir)).toEqual([]); // not even the default location was used
  } finally {
    await server.stop();
    agent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("by default the history goes to the service user's state directory, outside the app folder", async () => {
  const dir = tempDir();
  const agent = await startFakeAgent(() => 0.00002);
  const env = { AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HISTORY_SAVE_INTERVAL_MS: "100", XDG_STATE_HOME: dir };
  const server = await startServer({ ...env, HISTORY_FILE: undefined });
  // startServer forces HISTORY_FILE "" (off); this test wants the default, so start one by hand
  await server.stop();
  const port = await freePort();
  const child = spawn("node", ["server.js"], { cwd: path.join(__dirname, ".."), env: { ...process.env, ...env, PORT: String(port), HISTORY_FILE: undefined }, stdio: "ignore" });
  try {
    const expected = path.join(dir, "gpsdash", "history.json");
    await expect.poll(() => fs.existsSync(expected), { timeout: 8000 }).toBe(true);
    expect(path.relative(path.join(__dirname, ".."), expected).startsWith("..")).toBe(true); // not inside the checkout / deploy target
  } finally {
    child.kill("SIGTERM");
    agent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Stale (restored) data on the graph ---------------------------------------------------------------------
function staleThenLive(staleN, staleNewestAgeMs, liveN) {
  const stale = Array.from({ length: staleN }, (_, i) => ({ seq: i + 1, ageMs: staleNewestAgeMs + (staleN - 1 - i) * 2000, offsetMs: 0.05, stale: true }));
  const live = Array.from({ length: liveN }, (_, i) => ({ seq: staleN + i + 1, ageMs: (liveN - 1 - i) * 2000, offsetMs: 0.1, stale: false }));
  return { epoch: 5, seq: staleN + liveN, reset: true, samples: [...stale, ...live] };
}

const polyPoints = (page, cls) =>
  page.evaluate((c) => {
    const el = document.querySelector(`#offset-sparkline polyline.${c}`);
    return el ? el.getAttribute("points").trim().split(/\s+/).map((p) => p.split(",").map(Number)) : null;
  }, cls);

test("restored (stale) samples are drawn as a solid yellow line of their own, with a restart marker and a note", async ({ page }) => {
  await stubStatusHistory(page, [staleThenLive(300, 2 * 60 * 60 * 1000, 30)]); // saved 2 hours ago, then 1 minute of live data
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("polyline.sparkline-line-stale")).toHaveCount(1);
  await expect(graph.locator("polyline.sparkline-line")).toHaveCount(1);
  expect((await polyPoints(page, "sparkline-line-stale")).length).toBe(300);
  expect((await polyPoints(page, "sparkline-line")).length).toBe(30);
  await expect(graph.locator("line.sparkline-break")).toHaveCount(1);
  await expect(graph.locator(".sparkline-stale-note")).toContainText("Yellow line: saved before the server restarted");
  await expect(graph.locator(".sparkline-stale-note")).toContainText("nothing recorded for 1 h 5"); // ~1 h 59 min
  // the look: a solid line (no dashes) in yellow, and the note in the same yellow
  const look = await page.evaluate(() => {
    const line = getComputedStyle(document.querySelector("#offset-sparkline polyline.sparkline-line-stale"));
    const note = getComputedStyle(document.querySelector("#offset-sparkline .sparkline-stale-note"));
    return { stroke: line.stroke, dash: line.strokeDasharray, noteColor: note.color };
  });
  expect(look.dash).toBe("none");
  expect(look.stroke).toBe("rgb(245, 211, 61)");
  expect(look.noteColor).toBe("rgb(245, 211, 61)");
  await expect(graph.locator("circle.sparkline-dot")).toHaveCount(1); // the newest sample is live
});

test("a long outage is drawn as a short gap: stale block left of the marker, live data right of it, all on the axis", async ({ page }) => {
  await stubStatusHistory(page, [staleThenLive(300, 2 * 60 * 60 * 1000, 30)]);
  await page.goto("/");
  await expect(page.locator("#offset-sparkline polyline.sparkline-line-stale")).toHaveCount(1);
  const stale = await polyPoints(page, "sparkline-line-stale");
  const live = await polyPoints(page, "sparkline-line");
  const breakX = await page.evaluate(() => +document.querySelector("#offset-sparkline line.sparkline-break").getAttribute("x1"));
  const staleXs = stale.map((p) => p[0]);
  const liveXs = live.map((p) => p[0]);
  expect(Math.min(...staleXs)).toBeGreaterThanOrEqual(46); // inside the plot area (left padding 46)
  expect(Math.max(...staleXs)).toBeLessThan(breakX);
  expect(breakX).toBeLessThan(Math.min(...liveXs));
});

test("with no fresh sample yet the graph shows only the saved data and says it is waiting", async ({ page }) => {
  await stubStatusHistory(page, [staleThenLive(100, 5 * 60 * 1000, 0)]); // everything saved, newest 5 minutes old
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("polyline.sparkline-line-stale")).toHaveCount(1);
  await expect(graph.locator("polyline.sparkline-line")).toHaveCount(0);
  await expect(graph.locator("line.sparkline-break")).toHaveCount(0);
  await expect(graph.locator("circle.sparkline-dot-stale")).toHaveCount(1);
  await expect(graph.locator(".sparkline-stale-note")).toContainText("Waiting for fresh data");
  await expect(graph.locator(".sparkline-caption")).toContainText("at the last saved sample");
});

test("without stale samples nothing is yellow and there is no marker or note", async ({ page }) => {
  await stubStatusHistory(page, [{ epoch: 3, seq: 60, reset: true, samples: samples(60) }]);
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("polyline.sparkline-line")).toHaveCount(1);
  await expect(graph.locator("polyline.sparkline-line-stale")).toHaveCount(0);
  await expect(graph.locator("line.sparkline-break")).toHaveCount(0);
  await expect(graph.locator(".sparkline-stale-note")).toHaveCount(0);
});

test("the linear time axis also shows the stale block in yellow, with the marker between the two", async ({ page }) => {
  await stubStatusHistory(page, [staleThenLive(200, 30 * 60 * 1000, 40)]);
  await page.goto("/");
  await expect(page.locator("#offset-sparkline polyline.sparkline-line-stale")).toHaveCount(1);
  await page.locator("#toggle-t").click();
  await expect(page.locator("#toggle-t")).toHaveText("Time: linear");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("polyline.sparkline-line-stale")).toHaveCount(1);
  await expect(graph.locator("polyline.sparkline-line")).toHaveCount(1);
  await expect(graph.locator("line.sparkline-break")).toHaveCount(1);
  const stale = await polyPoints(page, "sparkline-line-stale");
  const live = await polyPoints(page, "sparkline-line");
  expect(Math.max(...stale.map((p) => p[0]))).toBeLessThan(Math.min(...live.map((p) => p[0])));
});

test("when fresh data pushes the saved samples out, the yellow line and the note go away", async ({ page }) => {
  // the server drops the stale samples from its buffer as live ones arrive; a reset response carries only what is left
  await stubStatusHistory(page, [
    staleThenLive(50, 60 * 60 * 1000, 10),
    { epoch: 5, seq: 90, reset: true, samples: samples(60, 31) },
  ]);
  await page.goto("/");
  await expect(page.locator("#offset-sparkline polyline.sparkline-line-stale")).toHaveCount(1);
  await expect(page.locator("#offset-sparkline polyline.sparkline-line-stale")).toHaveCount(0, { timeout: 8000 });
  await expect(page.locator("#offset-sparkline .sparkline-stale-note")).toHaveCount(0);
});
