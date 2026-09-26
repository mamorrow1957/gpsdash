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
    env: { ...process.env, PORT: String(port), ...env },
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
  return { base, stop: () => child.kill() };
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
