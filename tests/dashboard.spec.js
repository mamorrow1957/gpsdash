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
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { ...STATUS, gps, ntp: { ...STATUS.ntp, system_offset_seconds: offsetSeconds } } })
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
