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

// ---- The dashboard server: a relay for the agent's history ----------------------------------------------------------
// The ntp agent samples chrony and keeps the last 15 minutes; the dashboard server mirrors it in memory. These tests start
// the real server.js against a fake agent that behaves like the real one (it samples on its own, keeps a history and
// serves it at /history with the same protocol), with short intervals.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (url) => (await fetch(url)).json();

async function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startFakeAgent({ offsetFor = (n) => 0.001 * (n + 1), sampleMs = 50, withHistory = true } = {}) {
  const st = { seq: 0, epoch: Date.now(), samples: [], frozen: false, blackout: false, statusCalls: 0, historyCalls: 0, lastOffsetS: 0 };
  const tick = () => {
    if (st.frozen) return; // the agent itself is down: it neither samples nor answers
    const offsetS = offsetFor(st.seq);
    st.seq += 1;
    st.lastOffsetS = offsetS;
    st.samples.push({ seq: st.seq, t: Date.now(), offsetMs: offsetS * 1000 });
  };
  tick();
  const timer = setInterval(tick, sampleMs);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (st.frozen || st.blackout) return send(503, { error: "simulated outage" });
    if (url.pathname === "/status") {
      st.statusCalls += 1;
      return send(200, { ...STATUS, ntp: { ...STATUS.ntp, system_offset_seconds: st.lastOffsetS } });
    }
    if (url.pathname === "/history" && withHistory) {
      st.historyCalls += 1;
      const since = Number(url.searchParams.get("since") || 0);
      const reset = String(url.searchParams.get("epoch") || "") !== String(st.epoch) || !(since >= 0 && since <= st.seq);
      const from = reset ? 0 : since;
      const now = Date.now();
      return send(200, {
        epoch: st.epoch, seq: st.seq, reset, intervalMs: sampleMs,
        samples: st.samples.filter((s) => s.seq > from).map((s) => ({ seq: s.seq, ageMs: now - s.t, offsetMs: s.offsetMs })),
      });
    }
    send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/status`,
    state: st,
    freeze: (on) => (st.frozen = on), // silent and not sampling: the agent itself is down
    blackout: (on) => (st.blackout = on), // still sampling, but unreachable for a while: a network blip
    restart: () => { // a restart that lost its buffer: a new run, starting from nothing
      st.epoch = Date.now() + 1;
      st.seq = 0;
      st.samples = [];
    },
    close: () => {
      clearInterval(timer);
      server.close();
    },
  };
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
    await sleep(100);
  }
  // stop() sends SIGTERM (as systemd does) and resolves once the process has exited
  const stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill("SIGTERM");
    });
  return { base, stop };
}

const historyOf = (server) => getJson(`${server.base}/api/history`);

// spacing (ms) between consecutive samples of one reply: ages come from the same instant, so their differences are exact
function spacings(samples) {
  return samples.slice(1).map((s, i) => samples[i].ageMs - s.ageMs);
}

test("the server fills its copy from the agent's history on its first poll, including what happened before it started", async () => {
  const agent = await startFakeAgent();
  await sleep(1000); // the agent has been sampling for a second before the dashboard exists
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(15);
    const h = await historyOf(server);
    expect(h.source).toBe("ntp agent");
    expect(h.oldestAgeMs).toBeGreaterThan(900); // older than this server run: it came from the agent
  } finally {
    await server.stop();
    agent.close();
  }
});

test("samples arrive in order without duplicates as the agent keeps sampling", async () => {
  const agent = await startFakeAgent();
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(25);
    const h = await historyOf(server);
    const offsets = h.samples.map((s) => s.offsetMs);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b)); // the fake agent's offsets only grow: oldest first
    expect(new Set(offsets).size).toBe(offsets.length); // no duplicates
    const ages = h.samples.map((s) => s.ageMs);
    expect(ages).toEqual([...ages].sort((a, b) => b - a));
  } finally {
    await server.stop();
    agent.close();
  }
});

test("a restart of the dashboard loses nothing: the series stays continuous across the time it was down", async () => {
  const agent = await startFakeAgent();
  const first = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await historyOf(first)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(10);
  } finally {
    await first.stop();
  }
  await sleep(1500); // the dashboard is down; the agent keeps sampling
  const second = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await historyOf(second)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(40);
    const h = await historyOf(second);
    expect(Math.max(...spacings(h.samples))).toBeLessThan(400); // no hole where the first run was down (that would be ~1500)
  } finally {
    await second.stop();
    agent.close();
  }
});

test("a brief loss of contact is backfilled: no gap once the agent is reachable again", async () => {
  const agent = await startFakeAgent();
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(10);
    agent.blackout(true); // unreachable, but still sampling
    await sleep(1000);
    agent.blackout(false);
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(35);
    const h = await historyOf(server);
    expect(Math.max(...spacings(h.samples))).toBeLessThan(400);
  } finally {
    await server.stop();
    agent.close();
  }
});

test("when the agent itself stops there is a real gap, and no samples are invented inside it", async () => {
  const agent = await startFakeAgent();
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(10);
    agent.freeze(true); // down: neither sampling nor answering
    await sleep(1200);
    agent.freeze(false);
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(20);
    const gaps = spacings((await historyOf(server)).samples).filter((d) => d > 900);
    expect(gaps.length).toBe(1);
    expect(gaps[0]).toBeGreaterThan(1000);
  } finally {
    await server.stop();
    agent.close();
  }
});

test("an agent restart that lost its buffer: the server keeps what it had, appends the new samples in order, no duplicates", async () => {
  const agent = await startFakeAgent();
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(15);
    const before = await historyOf(server);
    agent.restart(); // new run, empty buffer, offsets start again from the beginning
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(before.count + 12);
    const after = await historyOf(server);
    expect(after.epoch).toBe(before.epoch); // browsers need no reset: new samples only ever land at the end
    expect(after.samples[0].offsetMs).toBe(before.samples[0].offsetMs); // what we had is still there
    const ages = after.samples.map((s) => s.ageMs);
    expect(ages).toEqual([...ages].sort((a, b) => b - a)); // in time order
    expect(new Set(ages.map((a) => Math.round(a / 10))).size).toBeGreaterThan(after.count * 0.9); // and not doubled up
  } finally {
    await server.stop();
    agent.close();
  }
});

test("while the agent is unreachable /api/status answers 502 but the copy in memory is still served", async () => {
  const agent = await startFakeAgent();
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(12);
    agent.close();
    await expect.poll(async () => (await fetch(`${server.base}/api/status?since=0&epoch=`)).status, { timeout: 8000 }).toBe(502);
    const body = await getJson(`${server.base}/api/status?since=0&epoch=`);
    expect(body.error).toContain("could not reach ntp.local agent");
    expect(body.history.samples.length).toBeGreaterThanOrEqual(12);
    expect((await getJson(`${server.base}/api/status`)).history).toBeUndefined(); // without ?since the error reply stays small
  } finally {
    await server.stop();
  }
});

test("the agent sees one status request and one history request per interval, however many pages ask", async () => {
  const agent = await startFakeAgent();
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "300" });
  try {
    await expect.poll(async () => (await fetch(`${server.base}/api/status`)).status, { timeout: 8000 }).toBe(200);
    const before = { s: agent.state.statusCalls, h: agent.state.historyCalls };
    const started = Date.now();
    for (let i = 0; i < 40; i++) await fetch(`${server.base}/api/status?since=0`);
    const budget = Math.ceil((Date.now() - started) / 300) + 3;
    expect(agent.state.statusCalls - before.s).toBeLessThanOrEqual(budget);
    expect(agent.state.historyCalls - before.h).toBeLessThanOrEqual(budget);
  } finally {
    await server.stop();
    agent.close();
  }
});

test("with an older agent that has no /history the server falls back to sampling the status itself, in memory", async () => {
  const agent = await startFakeAgent({ withHistory: false });
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(5);
    expect((await historyOf(server)).source).toContain("own samples");
  } finally {
    await server.stop();
    agent.close();
  }
});

test("the server's copy is a ring: it never holds more than the window", async () => {
  const agent = await startFakeAgent();
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HISTORY_WINDOW_MS: "1000" });
  try {
    await expect.poll(async () => (await historyOf(server)).seq, { timeout: 10000 }).toBeGreaterThan(20);
    const h = await historyOf(server);
    expect(h.capacity).toBe(10);
    expect(h.count).toBe(10);
  } finally {
    await server.stop();
    agent.close();
  }
});

test("/api/status without ?since is the plain agent status, as before", async () => {
  const agent = await startFakeAgent();
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100" });
  try {
    await expect.poll(async () => (await fetch(`${server.base}/api/status`)).status, { timeout: 8000 }).toBe(200);
    const body = await getJson(`${server.base}/api/status`);
    expect(body.ntp.stratum).toBe(1);
    expect(body.history).toBeUndefined();
  } finally {
    await server.stop();
    agent.close();
  }
});

test("the dashboard server writes nothing time-based to disk", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpsdash-nodisk-"));
  const agent = await startFakeAgent();
  const server = await startServer({ AGENT_URL: agent.url, POLL_INTERVAL_MS: "100", HOME: dir, XDG_STATE_HOME: dir });
  try {
    await expect.poll(async () => (await historyOf(server)).count, { timeout: 8000 }).toBeGreaterThanOrEqual(15);
    await server.stop(); // a graceful stop: the old design saved a file here
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    await server.stop();
    agent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


// ---- The ntp agent: samples chrony and keeps the history ------------------------------------------------------------
// These run the real agent/server.py with a stub `chronyc` (prints the offset it finds in a file) and an empty stub `gps`
// module, with short intervals. They need python3 and are skipped without it.
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const agentTest = hasPython ? test : test.skip;

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "gpsdash-agent-"));

function makeStubs(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const offsetFile = path.join(dir, "offset");
  fs.writeFileSync(offsetFile, "0.001");
  fs.writeFileSync(
    path.join(bin, "chronyc"),
    `#!/bin/sh\nv=$(cat "${offsetFile}")\n[ "$v" = fail ] && exit 1\necho "C0A80001,gps,1,0,$v,0,0,0,0,0,0,0,0,Normal"\n`,
    { mode: 0o755 }
  );
  fs.writeFileSync(path.join(bin, "gps.py"), "WATCH_ENABLE = 1\nWATCH_JSON = 2\n");
  return { bin, setOffset: (v) => fs.writeFileSync(offsetFile, String(v)) };
}

async function startAgent(dir, env = {}) {
  const stubs = makeStubs(dir);
  const port = await freePort();
  const child = spawn("python3", [path.join(__dirname, "..", "agent", "server.py")], {
    env: {
      ...process.env,
      PATH: `${stubs.bin}:${process.env.PATH}`,
      PYTHONPATH: stubs.bin,
      AGENT_PORT: String(port),
      SAMPLE_INTERVAL_S: "0.1",
      HISTORY_WINDOW_S: "2",
      HISTORY_SAVE_INTERVAL_S: "0.2",
      HOME: dir,
      XDG_STATE_HOME: path.join(dir, "state"),
      ...env,
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch (e) {
      // not up yet
    }
    await sleep(100);
  }
  const stop = (signal = "SIGTERM") =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill(signal);
    });
  return { base, stop, setOffset: stubs.setOffset, history: (q = "") => getJson(`${base}/history${q}`), alive: () => child.exitCode === null && child.signalCode === null };
}

agentTest("the agent samples chrony on its own, oldest first, as ages, in ms", async () => {
  const dir = tempDir();
  const agent = await startAgent(dir);
  try {
    agent.setOffset("0.0025"); // seconds, as chronyc prints it
    await expect.poll(async () => (await agent.history()).count, { timeout: 8000 }).toBeGreaterThanOrEqual(6);
    const h = await agent.history();
    expect(h.intervalMs).toBe(100);
    const ages = h.samples.map((s) => s.ageMs);
    expect(ages).toEqual([...ages].sort((a, b) => b - a));
    expect(ages[ages.length - 1]).toBeLessThan(500); // the newest is fresh
    expect(h.samples[h.samples.length - 1].offsetMs).toBeCloseTo(2.5, 6);
    expect(h.samples.map((s) => s.seq)).toEqual(h.samples.map((_, i) => h.samples[0].seq + i));
  } finally {
    await agent.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

agentTest("the buffer is a ring: it never holds more than the window", async () => {
  const dir = tempDir();
  const agent = await startAgent(dir, { HISTORY_WINDOW_S: "1" }); // 10 samples
  try {
    await expect.poll(async () => (await agent.history()).seq, { timeout: 8000 }).toBeGreaterThan(20);
    const h = await agent.history();
    expect(h.capacity).toBe(10);
    expect(h.count).toBe(10);
    expect(h.samples[0].seq).toBe(h.seq - 9); // the newest ten
  } finally {
    await agent.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

agentTest("/history?since=&epoch= returns only what is new, and resets a reader from another run or the future", async () => {
  const dir = tempDir();
  const agent = await startAgent(dir);
  try {
    await expect.poll(async () => (await agent.history()).count, { timeout: 8000 }).toBeGreaterThanOrEqual(5);
    const all = await agent.history();
    const from = all.seq - 2;
    const partial = await agent.history(`?since=${from}&epoch=${all.epoch}`);
    expect(partial.reset).toBe(false);
    expect(partial.samples.every((s) => s.seq > from)).toBe(true);
    expect(partial.samples.length).toBeGreaterThanOrEqual(2);
    expect((await agent.history(`?since=0&epoch=1`)).reset).toBe(true); // another run
    expect((await agent.history(`?since=999999&epoch=${all.epoch}`)).reset).toBe(true); // from the future
    const junk = await agent.history(`?since=abc&epoch=${all.epoch}`);
    expect(junk.reset).toBe(true);
    expect(junk.samples.length).toBeGreaterThan(0);
    expect((await agent.history(`?since=0&epoch=${all.epoch}`)).reset).toBe(false); // ?since=0 with the right epoch is a full read
  } finally {
    await agent.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

agentTest("when chronyc fails the round is skipped (a gap), the agent stays up and sampling resumes", async () => {
  const dir = tempDir();
  const agent = await startAgent(dir);
  try {
    await expect.poll(async () => (await agent.history()).count, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
    agent.setOffset("fail");
    await sleep(400);
    const during = await agent.history();
    await sleep(600);
    expect((await agent.history()).seq).toBe(during.seq); // nothing was recorded while it failed
    expect(agent.alive()).toBe(true);
    agent.setOffset("0.004");
    await expect.poll(async () => (await agent.history()).seq, { timeout: 8000 }).toBeGreaterThan(during.seq);
    const spans = (await agent.history()).samples;
    const gap = spans[spans.length - 1].ageMs;
    expect(gap).toBeLessThan(600);
  } finally {
    await agent.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

agentTest("the buffer is saved periodically and when the agent is stopped, and comes back after a restart", async () => {
  const dir = tempDir();
  const file = path.join(dir, "keep", "history.json");
  const first = await startAgent(dir, { AGENT_HISTORY_FILE: file });
  try {
    await expect.poll(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).samples.length, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".tmp"))).toEqual([]); // written atomically
    await sleep(500);
  } finally {
    await first.stop(); // SIGTERM, as systemd does on a deploy
  }
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(saved.samples.length).toBeGreaterThanOrEqual(5);
  expect(Object.keys(saved.samples[0]).sort()).toEqual(["offsetMs", "t"]);
  const second = await startAgent(dir, { AGENT_HISTORY_FILE: file });
  try {
    const h = await second.history();
    expect(h.count).toBeGreaterThanOrEqual(Math.min(saved.samples.length, 20)); // everything that was saved is back
    expect(h.samples[0].offsetMs).toBeCloseTo(saved.samples[0].offsetMs, 6);
  } finally {
    await second.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

agentTest("a restarted agent has a new epoch, so readers refetch, and the restored samples are old ones that show as a gap", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  const first = await startAgent(dir, { AGENT_HISTORY_FILE: file });
  await expect.poll(async () => (await first.history()).count, { timeout: 8000 }).toBeGreaterThanOrEqual(5);
  const epoch1 = (await first.history()).epoch;
  await first.stop();
  await sleep(1500); // the agent is down
  const second = await startAgent(dir, { AGENT_HISTORY_FILE: file });
  try {
    const h = await second.history(`?since=1&epoch=${epoch1}`);
    expect(h.epoch).not.toBe(epoch1);
    expect(h.reset).toBe(true);
    expect(h.samples[0].ageMs).toBeGreaterThan(1400); // restored, and older than the time it was down
    const ages = h.samples.map((s) => s.ageMs);
    const jumps = ages.slice(0, -1).map((a, i) => a - ages[i + 1]);
    expect(Math.max(...jumps)).toBeGreaterThan(1000); // the outage is visible as a hole between old and new
  } finally {
    await second.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

agentTest("saved samples are restored however old; invalid or future ones are dropped; the newest fit the capacity", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  const now = Date.now();
  const old = Array.from({ length: 30 }, (_, i) => ({ t: now - 3600000 + i * 100, offsetMs: i })); // an hour old
  const junk = [{ t: "x", offsetMs: 1 }, { t: now - 5000 }, null, { t: now + 3600000, offsetMs: 9 }, { t: now - 4000, offsetMs: NaN }];
  fs.writeFileSync(file, JSON.stringify({ version: 1, samples: [...junk, ...old] }));
  const agent2 = await startAgent(dir, { AGENT_HISTORY_FILE: file, HISTORY_WINDOW_S: "2", SAMPLE_INTERVAL_S: "0.2", HISTORY_SAVE_INTERVAL_S: "3600" }); // capacity 10; no save before we look
  try {
    const h = await agent2.history();
    const restored = h.samples.filter((s) => s.ageMs > 3000000);
    expect(restored.length).toBeLessThanOrEqual(10);
    expect(restored.length).toBeGreaterThan(0);
    expect(restored.map((s) => s.offsetMs)).toEqual(old.slice(30 - restored.length).map((s) => s.offsetMs)); // the newest of them, in order
    expect(h.samples.some((s) => s.offsetMs === 9)).toBe(false); // the future sample
    expect(h.count).toBeLessThanOrEqual(10);
  } finally {
    await agent2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

agentTest("an unreadable or corrupt history file is ignored and replaced", async () => {
  const dir = tempDir();
  const file = path.join(dir, "history.json");
  fs.writeFileSync(file, "{ this is not json");
  const agent = await startAgent(dir, { AGENT_HISTORY_FILE: file });
  try {
    await expect.poll(async () => (await agent.history()).count, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
    await expect.poll(() => { try { return JSON.parse(fs.readFileSync(file, "utf8")).samples.length; } catch (e) { return 0; } }, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
  } finally {
    await agent.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

agentTest("with saving off (AGENT_HISTORY_FILE=off) nothing is written", async () => {
  const dir = tempDir();
  const agent = await startAgent(dir, { AGENT_HISTORY_FILE: "off" });
  await expect.poll(async () => (await agent.history()).count, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
  await sleep(500);
  await agent.stop();
  try {
    expect(fs.existsSync(path.join(dir, "state"))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

agentTest("by default the file lives under the state directory, outside the deploy folder", async () => {
  const dir = tempDir();
  const expected = path.join(dir, "state", "gpsdash-agent", "history.json");
  const agent = await startAgent(dir); // no AGENT_HISTORY_FILE
  try {
    await expect.poll(() => fs.existsSync(expected), { timeout: 8000 }).toBe(true);
    expect(path.relative(path.join(__dirname, ".."), expected).startsWith("..")).toBe(true); // rsync --delete of a deploy cannot touch it
  } finally {
    await agent.stop();
    fs.rmSync(dir, { recursive: true, force: true });
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

// ---- Gaps and a silent source on the graph -------------------------------------------------------------
// Yellow means "no data was arriving from the source". A stretch of 10 s or more with no sample is bridged by a yellow
// line; while the newest sample is over 10 s old the last value is held out to "now" in yellow.
function samplesWithGap() {
  // 30 samples 12-13 minutes ago, then nothing for 11 minutes, then 30 samples up to now
  const before = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, ageMs: 720000 + (29 - i) * 2000, offsetMs: 0.05 }));
  const after = Array.from({ length: 30 }, (_, i) => ({ seq: 31 + i, ageMs: (29 - i) * 2000, offsetMs: 0.1 }));
  return { epoch: 5, seq: 60, reset: true, samples: [...before, ...after] };
}

// a status reply of 502 that still carries the history, as the real server sends while the agent is silent
async function stubOutage(page, history) {
  await page.route("**/api/status*", (route) =>
    route.fulfill({ status: 502, json: { error: "could not reach ntp.local agent: connect ECONNREFUSED", history } })
  );
}

const polylineCount = (page, cls) => page.locator(`#offset-sparkline polyline.${cls}`).count();

test("a gap in the samples is bridged by a solid yellow line and noted; the rest stays grey", async ({ page }) => {
  await stubStatusHistory(page, [samplesWithGap()]);
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("polyline.sparkline-line-gap")).toHaveCount(1);
  await expect(graph.locator("polyline.sparkline-line")).toHaveCount(2); // one run before the gap, one after
  const runs = await page.evaluate(() => [...document.querySelectorAll("#offset-sparkline polyline.sparkline-line")].map((p) => p.getAttribute("points").trim().split(/\s+/).length));
  expect(runs).toEqual([30, 30]);
  await expect(graph.locator(".sparkline-stale-note")).toContainText("Yellow: no data for 11 min");
  await expect(graph.locator("circle.sparkline-dot")).toHaveCount(1); // data is arriving now: the normal dot
  // the look: solid (no dashes) and yellow, the note in the same yellow
  const look = await page.evaluate(() => {
    const line = getComputedStyle(document.querySelector("#offset-sparkline polyline.sparkline-line-gap"));
    const note = getComputedStyle(document.querySelector("#offset-sparkline .sparkline-stale-note"));
    return { stroke: line.stroke, dash: line.strokeDasharray, noteColor: note.color };
  });
  expect(look.dash).toBe("none");
  expect(look.stroke).toBe("rgb(245, 211, 61)");
  expect(look.noteColor).toBe("rgb(245, 211, 61)");
});

test("the bridge joins the last sample before the gap to the first after it", async ({ page }) => {
  await stubStatusHistory(page, [samplesWithGap()]);
  await page.goto("/");
  await expect(page.locator("#offset-sparkline polyline.sparkline-line-gap")).toHaveCount(1);
  const geo = await page.evaluate(() => {
    const pts = (el) => el.getAttribute("points").trim().split(/\s+/).map((p) => p.split(",").map(Number));
    const runs = [...document.querySelectorAll("#offset-sparkline polyline.sparkline-line")].map(pts);
    const bridge = pts(document.querySelector("#offset-sparkline polyline.sparkline-line-gap"));
    return { endOfFirst: runs[0][runs[0].length - 1], startOfSecond: runs[1][0], bridge };
  });
  expect(geo.bridge[0]).toEqual(geo.endOfFirst);
  expect(geo.bridge[1]).toEqual(geo.startOfSecond);
});

test("when the source is silent the last value is held to the right edge in yellow and the note says for how long", async ({ page }) => {
  // the newest sample is 2 minutes old: nothing has arrived since
  const oldSamples = Array.from({ length: 60 }, (_, i) => ({ seq: i + 1, ageMs: 120000 + (59 - i) * 2000, offsetMs: 0.05 }));
  await stubStatusHistory(page, [{ epoch: 5, seq: 60, reset: true, samples: oldSamples }]);
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("polyline.sparkline-line-gap")).toHaveCount(1); // the held line
  await expect(graph.locator("circle.sparkline-dot-stale")).toHaveCount(1);
  await expect(graph.locator("circle.sparkline-dot")).toHaveCount(0);
  await expect(graph.locator(".sparkline-stale-note")).toContainText("No data from ntp.local for 2 min");
  await expect(graph.locator(".sparkline-caption")).toContainText("at the last sample");
  const held = await page.evaluate(() => document.querySelector("#offset-sparkline polyline.sparkline-line-gap").getAttribute("points").trim().split(/\s+/).map((p) => p.split(",").map(Number)));
  expect(held[1][0]).toBeCloseTo(312, 0); // the right edge of the plot (320 wide, 8 padding)
  expect(held[0][1]).toBeCloseTo(held[1][1], 0); // flat: the last known value
  expect(held[0][0]).toBeLessThan(held[1][0]);
});

test("a page opened while the source is silent still draws the graph, with the error banner", async ({ page }) => {
  const oldSamples = Array.from({ length: 40 }, (_, i) => ({ seq: i + 1, ageMs: 90000 + (39 - i) * 2000, offsetMs: 0.05 }));
  await stubOutage(page, { epoch: 5, seq: 40, reset: true, samples: oldSamples });
  await page.goto("/");
  await expect(page.locator("#error-banner")).toBeVisible();
  await expect(page.locator("#error-banner")).toContainText("could not reach ntp.local agent");
  await expect(page.locator("#offset-sparkline polyline.sparkline-line")).toHaveCount(1);
  await expect(page.locator("#offset-sparkline polyline.sparkline-line-gap")).toHaveCount(1);
  await expect(page.locator("#offset-sparkline .sparkline-stale-note")).toContainText("No data from ntp.local");
});

test("when the source resumes the hold turns into a yellow bridge and the dot returns to normal", async ({ page }) => {
  const old = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, ageMs: 120000 + (29 - i) * 2000, offsetMs: 0.05 }));
  await stubStatusHistory(page, [
    { epoch: 5, seq: 30, reset: true, samples: old }, // first poll: silent for 2 minutes
    { epoch: 5, seq: 32, reset: false, samples: [{ seq: 31, ageMs: 2000, offsetMs: 0.1 }, { seq: 32, ageMs: 0, offsetMs: 0.1 }] }, // then data again
  ]);
  await page.goto("/");
  await expect(page.locator("#offset-sparkline .sparkline-stale-note")).toContainText("No data from ntp.local");
  await expect(page.locator("#offset-sparkline .sparkline-stale-note")).toContainText("Yellow: no data for", { timeout: 8000 });
  await expect(page.locator("#offset-sparkline circle.sparkline-dot")).toHaveCount(1);
  await expect(page.locator("#offset-sparkline circle.sparkline-dot-stale")).toHaveCount(0);
});

test("with no gaps nothing is yellow and there is no note", async ({ page }) => {
  await stubStatusHistory(page, [{ epoch: 3, seq: 60, reset: true, samples: samples(60) }]);
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("polyline.sparkline-line")).toHaveCount(1);
  expect(await polylineCount(page, "sparkline-line-gap")).toBe(0);
  await expect(graph.locator(".sparkline-stale-note")).toHaveCount(0);
  await expect(graph.locator("circle.sparkline-dot")).toHaveCount(1);
});

test("the linear time axis also bridges a gap in yellow", async ({ page }) => {
  await stubStatusHistory(page, [samplesWithGap()]);
  await page.goto("/");
  await expect(page.locator("#offset-sparkline polyline.sparkline-line-gap")).toHaveCount(1);
  await page.locator("#toggle-t").click();
  await expect(page.locator("#toggle-t")).toHaveText("Time: linear");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("polyline.sparkline-line-gap")).toHaveCount(1);
  await expect(graph.locator("polyline.sparkline-line")).toHaveCount(2);
  await expect(graph.locator(".sparkline-stale-note")).toContainText("Yellow: no data for 11 min");
});

test("samples the agent restored from its disk are drawn as ordinary data, not yellow", async ({ page }) => {
  // the server no longer marks restored samples: a restart is not "no data from the source"
  await stubStatusHistory(page, [{ epoch: 8, seq: 100, reset: true, samples: samples(100) }]);
  await page.goto("/");
  await expect(page.locator("#offset-sparkline polyline.sparkline-line")).toHaveCount(1);
  expect(await polylineCount(page, "sparkline-line-gap")).toBe(0);
});
