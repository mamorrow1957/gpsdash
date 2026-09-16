#!/usr/bin/env python3
"""Exposes chrony + gpsd status from this host as JSON over HTTP.

Runs on ntp.local. gpsdash polls this to build its dashboard.
"""

import json
import math
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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

PORT = 8081
GPS_TIMEOUT_SECONDS = 3

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
                have_sky = True
    except StopIteration:
        pass
    finally:
        session.close()
    return fix


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


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
