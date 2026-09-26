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

async function stubStatus(page, offsetSeconds) {
  await page.route("**/api/status", (route) =>
    route.fulfill({ json: { ...STATUS, ntp: { ...STATUS.ntp, system_offset_seconds: offsetSeconds } } })
  );
}

test("offset graph defaults to log scales with decade ticks and a 15 minute time axis", async ({ page }) => {
  await stubStatus(page, 0.00002); // 20 µs
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("svg")).toBeVisible();
  await expect(page.locator("#toggle-y")).toHaveText("Value: log");
  await expect(page.locator("#toggle-t")).toHaveText("Time: log");
  await expect(graph.locator("text", { hasText: "+100µs" })).toBeVisible();
  await expect(graph.locator("text", { hasText: "-100µs" })).toBeVisible();
  await expect(graph.locator("text", { hasText: "-15m" })).toBeVisible();
  await expect(graph.locator("text", { hasText: "now" })).toBeVisible();
  await expect(graph.locator(".sparkline-caption")).toContainText("20.0 µs now");
});

test("the value axis follows the size of the offset (a few ms zooms out to decades of ms)", async ({ page }) => {
  await stubStatus(page, 0.0031); // 3.1 ms
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("text", { hasText: "+10ms" })).toBeVisible();
  await expect(graph.locator(".sparkline-caption")).toContainText("3.1 ms now");
});

test("value toggle switches to a linear axis and the choice survives a reload", async ({ page }) => {
  await stubStatus(page, 0.0031);
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("svg")).toBeVisible();
  await page.locator("#toggle-y").click();
  await expect(page.locator("#toggle-y")).toHaveText("Value: linear");
  await expect(page.locator("#toggle-y")).toHaveAttribute("aria-pressed", "false");
  await expect(graph.locator("text", { hasText: "µs" })).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#toggle-y")).toHaveText("Value: linear");
  await expect(page.locator("#toggle-t")).toHaveText("Time: log");
});

test("time toggle switches to the linear (fill left to right) axis", async ({ page }) => {
  await stubStatus(page, 0.00002);
  await page.goto("/");
  const graph = page.locator("#offset-sparkline");
  await expect(graph.locator("text", { hasText: "-15m" })).toBeVisible();
  await page.locator("#toggle-t").click();
  await expect(page.locator("#toggle-t")).toHaveText("Time: linear");
  await expect(graph.locator("text", { hasText: "-15m" })).toHaveCount(0);
});

test("the graph keeps 15 minutes of samples", async ({ page }) => {
  await stubStatus(page, 0.00002);
  await page.goto("/");
  await expect(page.locator("#offset-sparkline svg")).toBeVisible();
  const cap = await page.evaluate(() => ({ max: MAX_OFFSET_HISTORY, windowMs: OFFSET_HISTORY_WINDOW_MS, poll: POLL_INTERVAL_MS }));
  expect(cap).toEqual({ max: 450, windowMs: 15 * 60 * 1000, poll: 2000 });
});
