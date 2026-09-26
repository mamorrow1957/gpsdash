#!/usr/bin/env python3
"""Exposes chrony + gpsd status from this host as JSON over HTTP.

Runs on ntp.local. gpsdash polls /status for the panels and reads /history (the last 15 minutes of clock-offset
samples, kept here so a restart of gpsdash never loses them) to draw the graph.
"""

import json
import math
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import gps

# WGS84 ellipsoid constants
_WGS84_A = 6378137.0
_WGS84_F = 1 / 298.257223563
_WGS84_E2 = _WGS84_F * (2 - _WGS84_F)


def ecef_to_geodetic(x, y, z):
    """Converts ECEF coordinates (meters) to WGS84 lat/lon (degrees) and altitude (meters).

    This receiver's gpsd session reports valid ecefx/y/z but leaves lat/lon/altHAE
    at their zero-initialized default (a UBX message-configuration quirk), so we
    derive position from ECEF instead of trusting gpsd's own conversion.
    """
    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1 - _WGS84_E2))
    for _ in range(5):
        sin_lat = math.sin(lat)
        n = _WGS84_A / math.sqrt(1 - _WGS84_E2 * sin_lat * sin_lat)
        alt = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1 - _WGS84_E2 * n / (n + alt)))
    sin_lat = math.sin(lat)
    n = _WGS84_A / math.sqrt(1 - _WGS84_E2 * sin_lat * sin_lat)
    alt = p / math.cos(lat) - n
    return math.degrees(lat), math.degrees(lon), alt

PORT = int(os.environ.get("AGENT_PORT", "8081"))
GPS_TIMEOUT_SECONDS = 3

# Clock-offset history: the agent samples chrony every SAMPLE_INTERVAL_S and keeps the last HISTORY_WINDOW_S in a ring
# buffer, saved to disk so a restart or a deploy does not empty it. gpsdash reads it from /history, so it always has the
# last 15 minutes, whatever restarted. (chronyc takes ~8 ms; the gpsd session behind /status is what takes ~1 s.)
SAMPLE_INTERVAL_S = float(os.environ.get("SAMPLE_INTERVAL_S", "2"))
HISTORY_WINDOW_S = float(os.environ.get("HISTORY_WINDOW_S", "900"))
HISTORY_CAPACITY = max(1, round(HISTORY_WINDOW_S / SAMPLE_INTERVAL_S))
SAVE_INTERVAL_S = float(os.environ.get("HISTORY_SAVE_INTERVAL_S", "30"))

CHRONY_SOURCE_MODES = {"^": "server", "=": "peer", "#": "local"}
CHRONY_SOURCE_STATES = {
    "*": "selected",
    "+": "combined",
    "-": "not_combined",
    "x": "rejected",
    "~": "too_variable",
    "?": "unusable",
}


def get_chrony_tracking():
    out = subprocess.run(
        ["chronyc", "-c", "tracking"], capture_output=True, text=True, check=True
    ).stdout.strip()
    fields = out.split(",")
    return {
        "reference_id": fields[0],
        "reference_name": fields[1],
        "stratum": int(fields[2]),
        "system_offset_seconds": float(fields[4]),
        "last_offset_seconds": float(fields[5]),
        "frequency_ppm": float(fields[7]),
        "root_delay_seconds": float(fields[10]),
        "root_dispersion_seconds": float(fields[11]),
        "leap_status": fields[13],
    }


def get_chrony_sources():
    out = subprocess.run(
        ["chronyc", "-c", "sources"], capture_output=True, text=True, check=True
    ).stdout.strip()
    sources = []
    for line in out.splitlines():
        f = line.split(",")
        sources.append(
            {
                "mode": CHRONY_SOURCE_MODES.get(f[0], f[0]),
                "state": CHRONY_SOURCE_STATES.get(f[1], f[1]),
                "name": f[2],
                "stratum": int(f[3]),
                "reach_octal": f[5],
                "last_rx_seconds": int(f[6]),
                "adjusted_offset_seconds": float(f[7]),
                "estimated_error_seconds": float(f[9]),
            }
        )
    return sources


def get_gps_fix():
    session = gps.gps(mode=gps.WATCH_ENABLE | gps.WATCH_JSON)
    fix = {"mode": 0, "satellites_used": 0, "satellites_visible": 0}
    have_tpv = have_sky = False
    try:
        start = __import__("time").monotonic()
        while __import__("time").monotonic() - start < GPS_TIMEOUT_SECONDS and not (
            have_tpv and have_sky
        ):
            report = session.next()
            if report["class"] == "TPV":
                fix["mode"] = getattr(report, "mode", 0)
                ecef = (
                    getattr(report, "ecefx", None),
                    getattr(report, "ecefy", None),
                    getattr(report, "ecefz", None),
                )
                if all(v is not None for v in ecef):
                    lat, lon, alt = ecef_to_geodetic(*ecef)
                    fix["lat"], fix["lon"], fix["alt_m"] = lat, lon, alt
                else:
                    fix["lat"] = getattr(report, "lat", None)
                    fix["lon"] = getattr(report, "lon", None)
                    fix["alt_m"] = getattr(report, "altHAE", None)
                have_tpv = True
            elif report["class"] == "SKY":
                sats = getattr(report, "satellites", [])
                fix["satellites_visible"] = len(sats)
                fix["satellites_used"] = sum(1 for s in sats if s.get("used"))
                fix["hdop"] = getattr(report, "hdop", None)
                fix["satellites"] = [
                    {
                        "prn": s.get("PRN"),
                        "az": s.get("az"),
                        "el": s.get("el"),
                        "ss": s.get("ss"),
                        "used": bool(s.get("used")),
                        # constellation (gpsd gnssid: 0 GPS, 1 SBAS, 2 Galileo, 3 BeiDou, 4 IMES, 5 QZSS, 6 GLONASS,
                        # 7 NavIC) and the satellite number within it; None on older gpsd versions
                        "gnssid": s.get("gnssid"),
                        "svid": s.get("svid"),
                    }
                    for s in sats
                ]
                have_sky = True
    except StopIteration:
        pass
    finally:
        session.close()
    return fix


def history_file_path():
    """Where the buffer is saved. Outside the deploy folder (agent/deploy.sh runs rsync --delete into it).
    AGENT_HISTORY_FILE overrides; "" or "off" turns saving off."""
    configured = os.environ.get("AGENT_HISTORY_FILE")
    if configured in ("", "off"):
        return None
    if configured:
        return configured
    state_home = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(state_home, "gpsdash-agent", "history.json")


class History:
    """Ring buffer of clock-offset samples. Times are this host's clock (GPS-disciplined); readers get ages."""

    def __init__(self, capacity, path):
        self.capacity = capacity
        self.path = path
        self.lock = threading.Lock()
        self.samples = deque(maxlen=capacity)  # (seq, t_ms, offset_ms), oldest first
        self.seq = 0
        self.epoch = int(time.time() * 1000)  # identifies this run: a reader holding another epoch must start over
        self.dirty = False
        self.save_error_logged = False

    def add(self, offset_ms, t_ms=None):
        with self.lock:
            self.seq += 1
            self.samples.append((self.seq, t_ms if t_ms is not None else time.time() * 1000, offset_ms))
            self.dirty = True

    def since(self, since, epoch):
        """The samples newer than `since` (as ages). A reader from another run, or with a number from the future, resets."""
        now_ms = time.time() * 1000
        with self.lock:
            reset = str(epoch) != str(self.epoch) or not (0 <= since <= self.seq)
            start = 0 if reset else since
            return {
                "epoch": self.epoch,
                "seq": self.seq,
                "reset": reset,
                "intervalMs": SAMPLE_INTERVAL_S * 1000,
                "windowMs": HISTORY_WINDOW_S * 1000,
                "capacity": self.capacity,
                "count": len(self.samples),
                "samples": [
                    {"seq": q, "ageMs": now_ms - t, "offsetMs": v} for (q, t, v) in self.samples if q > start
                ],
            }

    def load(self):
        """Restore the saved samples, however old (the gap since they were taken shows up as a gap). Invalid samples and
        ones stamped in the future (a clock that was stepped) are dropped; the capacity keeps the newest."""
        if not self.path:
            print("history saving is off", flush=True)
            return
        try:
            with open(self.path) as f:
                saved = json.load(f)
        except FileNotFoundError:
            print(f"no saved history yet ({self.path})", flush=True)
            return
        except Exception as e:
            print(f"ignoring unreadable history file {self.path}: {e}", flush=True)
            return
        now_ms = time.time() * 1000
        raw = saved.get("samples") if isinstance(saved, dict) else None
        good = []
        for x in raw if isinstance(raw, list) else []:
            try:
                t, v = float(x["t"]), float(x["offsetMs"])
            except Exception:
                continue
            if math.isfinite(t) and math.isfinite(v) and t <= now_ms + 5000:
                good.append((t, v))
        good.sort()
        for t, v in good[-self.capacity :]:
            self.add(v, t)
        self.dirty = False
        if good:
            print(f"restored {min(len(good), self.capacity)} history samples from {self.path} "
                  f"(newest {round((now_ms - good[-1][0]) / 1000)} s old)", flush=True)
        else:
            print(f"saved history in {self.path} was empty", flush=True)

    def save(self):
        """Written to a temporary file and renamed into place, so a crash mid-write never leaves a half-written file."""
        if not self.path:
            return
        tmp = f"{self.path}.{os.getpid()}.tmp"
        try:
            with self.lock:
                body = json.dumps({
                    "version": 1,
                    "savedAt": time.time() * 1000,
                    "windowMs": HISTORY_WINDOW_S * 1000,
                    "intervalMs": SAMPLE_INTERVAL_S * 1000,
                    "samples": [{"t": t, "offsetMs": v} for (_, t, v) in self.samples],
                })
                self.dirty = False
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            with open(tmp, "w") as f:
                f.write(body)
            os.replace(tmp, self.path)
        except Exception as e:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            if not self.save_error_logged:
                print(f"could not save history to {self.path}: {e}", flush=True)
            self.save_error_logged = True


history = History(HISTORY_CAPACITY, history_file_path())


def sampler_loop():
    """Take one offset reading per interval. If chrony cannot be read the round is skipped (a gap gpsdash will show)."""
    while True:
        started = time.monotonic()
        try:
            history.add(get_chrony_tracking()["system_offset_seconds"] * 1000)
        except Exception:
            pass
        time.sleep(max(0.0, SAMPLE_INTERVAL_S - (time.monotonic() - started)))


def saver_loop():
    while True:
        time.sleep(SAVE_INTERVAL_S)
        if history.dirty:
            history.save()


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"status": "ok"})
        elif urlparse(self.path).path == "/history":
            q = parse_qs(urlparse(self.path).query)
            try:
                since = int(q.get("since", ["0"])[0])
            except ValueError:
                since = -1  # not a number: treated like a reader from the future, so it resets
            self._json(200, history.since(since, q.get("epoch", [""])[0]))
        elif self.path == "/status":
            try:
                self._json(
                    200,
                    {
                        "gps": get_gps_fix(),
                        "ntp": get_chrony_tracking(),
                        "sources": get_chrony_sources(),
                    },
                )
            except Exception as e:
                self._json(500, {"error": str(e)})
        else:
            self._json(404, {"error": "not found"})

    def log_message(self, format, *args):
        pass


def _shutdown(signum, frame):
    # systemd stops the service with SIGTERM (a deploy restarts it): save what we have before exiting
    history.save()
    sys.exit(0)


if __name__ == "__main__":
    history.load()
    threading.Thread(target=sampler_loop, daemon=True).start()
    threading.Thread(target=saver_loop, daemon=True).start()
    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
