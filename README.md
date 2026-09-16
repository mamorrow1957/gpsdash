# gpsdash

Status dashboard for `ntp.local`, a GPS-disciplined stratum-1 NTP server.

## What it is

An Express app that polls `ntp.local` for GPS fix status and NTP/chrony sync health (stratum, offset, jitter, satellite count, etc.) and serves it as a live dashboard.

## Project layout

```
server.js            — Express app entry point
public/
  index.html          — Dashboard UI shell
  style.css
  dashboard.js         — Frontend polling/render logic
tests/
  dashboard.spec.js    — Playwright end-to-end tests
scripts/
  deploy.sh            — Installs deps and restarts the gpsdash service
  gpsdash.service       — Reference systemd unit (install once manually)
.gitlab-ci.yml         — CI: run tests (Docker/node:20), deploy on main
```

## Development

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Testing

Tests use [Playwright](https://playwright.dev/) and run against a locally started server.

```bash
npm ci
npx playwright install --with-deps chromium
npm test
```

## Deployment

The `deploy` CI job runs automatically on pushes to `main`. It syncs the tested checkout to `/home/michael/gpsdash` on the server, installs production dependencies, and restarts the `gpsdash` systemd service.

One-time server setup (not handled by CI):

```bash
sudo cp scripts/gpsdash.service /etc/systemd/system/gpsdash.service
sudo systemctl daemon-reload
sudo systemctl enable --now gpsdash
```

To deploy manually, run `scripts/deploy.sh` from a checkout of this repo on the server — it syncs itself to `/home/michael/gpsdash` and restarts the service.

## CI/CD

| Branch | Test | Deploy |
|--------|------|--------|
| `main` | ✓    | ✓      |
| `dev`  | ✓    | —      |
