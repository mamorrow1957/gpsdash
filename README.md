# gpsdash

Status dashboard for `ntp.local`, a Raspberry Pi 4 running chrony and gpsd, disciplined by an Uputronics GPS/RTC Expansion Board (a u-blox M8 receiver on the header UART at 115200 baud) and the board's once-per-second pulse on GPIO 18 (`pps-gpio`, exposed as `/dev/pps-gps`). chrony takes the second from the serial data (`refclock SHM 0 refid GPS ... noselect`) and the exact edge from the pulse (`refclock PPS /dev/pps-gps refid PPS lock GPS prefer`), so it reports stratum 1 with the clock within a few microseconds of GPS time. The board's hardware clock (RV-3028) keeps the time across restarts. Before 2026-10-02 the receiver was a USB u-blox 7 puck without PPS (serial time only, about ±100 ms).

## What it is

Two pieces:
- **Dashboard** (this repo's root) — an Express app that polls the agent on `ntp.local` and serves a live status page.
- **Agent** (`agent/`) — a small Python HTTP service that runs on `ntp.local` itself, exposing chrony tracking/sources and gpsd fix data as JSON.

## What the page shows

- **GPS** — fix type, satellites used/visible, position, altitude, and a **Quality** line from HDOP (lower is better) with the usual six titles: Ideal (under 1, blue dot), Excellent (under 2) and Good (under 5) in green, Moderate (under 10) yellow, Fair (under 20) orange, Poor red.
- **NTP** — the reference chrony is using, system offset, leap status and a **GPS-disciplined** light. It is on when either the `PPS` or the `GPS` source is the one chrony has selected, and says which.
- **Sky view** — every satellite gpsd reports, one shape per constellation (GPS, SBAS, GLONASS, …) in the constellation's colour; solid = used in the fix, translucent = not used, dashed ring = no signal. Satellites below the horizon or without a position are counted in the legend but not plotted.
- **Clock offset** — the last 15 minutes of offset, with `Value` and `Time` toggles (log or linear; defaults linear value, log time; remembered per browser). The log value axis goes down to 100 ns. Yellow marks time with no data (see below).
- **Sources** — chrony's sources, `PPS` first, then `GPS`, then the network servers in chrony's order (the sort is display-only). chrony's states are worded in plain English (selected, blended in, backup, not used, rejected, too jittery, unusable) with a hover explanation. With the board, `GPS` reads "label only (by design)": it is `noselect` and only tells PPS which second each pulse belongs to. A network server shows its reverse-DNS name when the dashboard server finds one (looked up in the background, cached for an hour, misses for ten minutes, plain hostname characters only); the IP address is in the hover text and is the fallback. The table's numbers update in place so a hover tooltip survives the redraws.

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

By default the server polls `http://ntp.local:8081/status`. If Node cannot reach it by that name (`.local` names can resolve to IPv6 first and give a 502), set `AGENT_URL` to the agent's IP address, for example `AGENT_URL=http://<agent-ip>:8081/status npm start`.

## Testing

Tests use [Playwright](https://playwright.dev/) and run against a locally started server.

```bash
npm ci
npx playwright install --with-deps chromium
npm test
```

## Configuration

The dashboard server reads these environment variables (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on (the systemd unit sets `80`). |
| `AGENT_URL` | `http://ntp.local:8081/status` | The ntp.local status agent. |
| `AGENT_HISTORY_URL` | `AGENT_URL` with `/status` replaced by `/history` | Where the agent serves its clock-offset history. |
| `POLL_INTERVAL_MS` | `2000` | How often the server polls the agent. It is the only thing that talks to the agent: `/api/status` serves the cached poll. |
| `HISTORY_WINDOW_MS` | `900000` (15 min) | Size of the server's in-memory copy of the history (window / interval samples). |
| `RDNS_OVERRIDE` | unset | JSON `{"ip": "name"}` used instead of reverse DNS for the Sources table. For tests. |

The agent (`agent/server.py`) reads:

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_PORT` | `8081` | Port to listen on. |
| `SAMPLE_INTERVAL_S` | `2` | How often it reads the clock offset from chrony. |
| `HISTORY_WINDOW_S` | `900` (15 min) | How much history it keeps (window / interval samples). |
| `AGENT_HISTORY_FILE` | `~/.local/state/gpsdash-agent/history.json` | Where the buffer is saved. `""` or `off` disables saving. Must be **outside** the agent folder: the deploy job runs `rsync --delete` into it. |
| `HISTORY_SAVE_INTERVAL_S` | `30` | How often the buffer is saved (it is also saved when the agent is stopped). |

### Offset history

The **ntp agent owns the history**. It samples chrony every 2 seconds, keeps the last 15 minutes in a ring buffer, saves it to its own disk (every 30 seconds and on SIGTERM) and reloads it at start. So a restart or a deploy of the agent, of the dashboard, or of both never leaves the graph empty: the graph always starts with the last 15 minutes. Samples that were taken before a restart are restored however old they are, so the time the agent was down shows up as a gap.

The **dashboard server is a relay**. Every poll it fetches the agent's status (for the panels) and the history it has not seen yet (`GET /history?since=<seq>&epoch=<epoch>` on the agent; samples carry ages, so the two hosts' clocks are never mixed) and keeps a copy **in memory only**; nothing time-based is written to disk on the dashboard host. A restarted dashboard refills from the agent on its first poll, with no gap. The copy also lets a page opened while the agent is unreachable still draw the past. Against an older agent that has no `/history`, the server falls back to sampling the status itself.

`GET /api/history` shows what the dashboard server holds; `GET /api/status?since=<seq>&epoch=<epoch>` returns the status plus the samples newer than `seq` (the page uses this to fetch only what is new).

**Yellow means no data was arriving from the source (the ntp agent).** A stretch of 10 seconds or more with no sample is bridged by a solid yellow line, and while the newest sample is more than 10 seconds old (the agent has gone quiet) the last known value is held out to the right edge in yellow, with a note saying for how long. When data resumes the held line becomes a bridge over the gap, and the note reads "Yellow: no data for ...". A page opened while the agent is unreachable still draws the graph: the server's error reply carries the history. A gap the dashboard itself caused (it was restarted) is filled from the agent, so it is not yellow.

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
