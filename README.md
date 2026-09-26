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

## Configuration

The server reads these environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on (the systemd unit sets `80`). |
| `AGENT_URL` | `http://ntp.local:8081/status` | The ntp.local status agent. |
| `POLL_INTERVAL_MS` | `2000` | How often the server polls the agent. It is the only thing that talks to the agent: `/api/status` serves the cached poll. |
| `HISTORY_WINDOW_MS` | `900000` (15 min) | How much clock-offset history the server keeps (window / interval samples). |
| `HISTORY_FILE` | `~/.local/state/gpsdash/history.json` | Where the history is saved. `""` or `off` disables saving. Must be **outside** the app folder: the deploy job runs `rsync --delete` into it. |
| `HISTORY_SAVE_INTERVAL_MS` | `30000` | How often the history is saved (it is also saved when the service stops). |

### Offset history

The server keeps the last 15 minutes of clock-offset samples in memory and saves them to `HISTORY_FILE`, so a page reload, a new tab, a service restart or a deploy does not empty the graph. `GET /api/history` shows what the server holds; `GET /api/status?since=<seq>&epoch=<epoch>` returns the status plus the samples newer than `seq` (the page uses this to fetch only what is new).

After a restart the saved samples are loaded however old they are, so the graph stays populated, and they are drawn as ordinary data.

**Yellow means no data was arriving from the source.** A stretch of 10 seconds or more with no sample is bridged by a solid yellow line, and while the newest sample is more than 10 seconds old (the ntp agent has gone quiet) the last known value is held out to the right edge in yellow, with a note saying for how long. When data resumes the held line becomes a bridge over the gap, and the note reads "Yellow: no data for ...". A page opened while the agent is unreachable still draws the graph: the server's error reply carries the history.

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
