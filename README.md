# gpsdash

Status dashboard for `ntp.local`, a Raspberry Pi running chrony with a USB GPS receiver attached. Note: the GPS is not currently disciplining chrony (no PPS signal available from this receiver, so its timing jitter is too high for chrony to select it over network NTP sources) — the dashboard shows this honestly rather than implying GPS-disciplined time.

## What it is

Two pieces:
- **Dashboard** (this repo's root) — an Express app that polls the agent on `ntp.local` and serves a live status page.
- **Agent** (`agent/`) — a small Python HTTP service that runs on `ntp.local` itself, exposing chrony tracking/sources and gpsd fix data as JSON.

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
  deploy.sh            — Installs deps and restarts the gpsdash service (on gpsdash.local)
  gpsdash.service       — Reference systemd unit (install once manually)
agent/
  server.py             — chrony + gpsd JSON exporter (runs on ntp.local)
  deploy.sh             — Syncs and restarts the agent service (on ntp.local)
  gpsdash-agent.service — Reference systemd unit (install once manually)
.gitlab-ci.yml         — CI: run tests (Docker/node:20), deploy dashboard + agent on main
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

Two CI deploy jobs run automatically on pushes to `main`, each on a self-hosted runner living on its target host:

- `deploy-dashboard` syncs the checkout to `/home/michael/gpsdash` on gpsdash.local, installs production dependencies, and restarts the `gpsdash` systemd service.
- `deploy-agent` syncs `agent/` to `/home/michael/gpsdash-agent` on ntp.local and restarts the `gpsdash-agent` systemd service.

One-time server setup (not handled by CI):

```bash
# On gpsdash.local
sudo cp scripts/gpsdash.service /etc/systemd/system/gpsdash.service
sudo systemctl daemon-reload
sudo systemctl enable --now gpsdash

# On ntp.local
sudo cp agent/gpsdash-agent.service /etc/systemd/system/gpsdash-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now gpsdash-agent
```

To deploy manually, run `scripts/deploy.sh` (dashboard) or `agent/deploy.sh` (agent) from a checkout of this repo on the relevant server — each syncs itself into place and restarts its service.

## CI/CD

| Branch | Test | Deploy |
|--------|------|--------|
| `main` | ✓    | ✓      |
| `dev`  | ✓    | —      |
