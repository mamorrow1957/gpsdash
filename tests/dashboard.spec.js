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
