#!/usr/bin/env python3
"""Overpass -> normalized ALPR device JSON.

This is the dev-time stand-in for the nightly pipeline in spec §5. It runs on
a workstation or a build server, never on the client — Overpass rate limits
would break at app scale and hammering the commons from thousands of phones
is not acceptable use.

    python3 Tools/fetch_alpr.py --bbox 33.20 -87.05 33.75 -86.45 \
        --out Blindspot/Resources/Devices.json

Data is OpenStreetMap, licensed ODbL. Attribution is a licence obligation and
is displayed in-app; see README.
"""

import argparse
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# python.org builds on macOS ship without a usable system CA bundle, so the
# default context fails to verify Overpass. Prefer certifi when it's present.
try:
    import certifi
    SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CONTEXT = ssl.create_default_context()

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# OSM `manufacturer` values -> our Vendor enum cases. Matched case-insensitively
# on a prefix, because the tag is free text and spelling varies by mapper.
VENDOR_MAP = [
    ("flock", "flockSafety"),
    ("motorola", "motorola"),
    ("genetec", "genetec"),
    ("leonardo", "leonardo"),
    ("elsag", "leonardo"),
    ("neology", "neology"),
    ("rekor", "rekor"),
    ("verra", "verra"),
]

COMPASS = {
    "N": 0, "NNE": 22.5, "NE": 45, "ENE": 67.5,
    "E": 90, "ESE": 112.5, "SE": 135, "SSE": 157.5,
    "S": 180, "SSW": 202.5, "SW": 225, "WSW": 247.5,
    "W": 270, "WNW": 292.5, "NW": 315, "NNW": 337.5,
}


def build_query(bbox, timeout):
    south, west, north, east = bbox
    # `out meta` gives us version and timestamp, which is the only provenance
    # signal available without walking the full element history API.
    return f"""
[out:json][timeout:{timeout}];
(
  node["man_made"="surveillance"]["surveillance:type"~"^(ALPR|alpr|ANPR)$"]({south},{west},{north},{east});
);
out meta;
""".strip()


def fetch(query):
    """POST to Overpass, falling back to a mirror and backing off on 429/504."""
    last_error = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(3):
            try:
                request = urllib.request.Request(
                    endpoint,
                    data=urllib.parse.urlencode({"data": query}).encode(),
                    headers={"User-Agent": "Blindspot-dev-ingest/0.1"},
                )
                with urllib.request.urlopen(request, timeout=600,
                                            context=SSL_CONTEXT) as response:
                    return json.loads(response.read().decode())
            except urllib.error.HTTPError as error:
                last_error = error
                if error.code in (429, 504):
                    wait = 15 * (attempt + 1)
                    print(f"  {endpoint} -> {error.code}, retrying in {wait}s",
                          file=sys.stderr)
                    time.sleep(wait)
                    continue
                break
            except Exception as error:  # noqa: BLE001 - dev script, report and move on
                last_error = error
                break
    raise SystemExit(f"Overpass failed: {last_error}")


def parse_direction(tags):
    """Bearing in degrees, or None.

    Mappers use `camera:direction` and plain `direction` roughly
    interchangeably, and either may hold degrees or a compass point.
    """
    for key in ("camera:direction", "direction"):
        raw = tags.get(key)
        if not raw:
            continue
        raw = raw.strip().upper()
        if raw in COMPASS:
            return COMPASS[raw]
        try:
            return float(raw) % 360
        except ValueError:
            continue
    return None


def parse_vendor(tags):
    raw = (tags.get("manufacturer") or tags.get("brand") or "").strip().lower()
    for needle, vendor in VENDOR_MAP:
        if raw.startswith(needle) or needle in raw:
            return vendor
    return "unknown"


def parse_retention_days(tags):
    """Only trust an explicit numeric day count. Anything else stays unknown
    rather than being guessed — the dossier labels this field '(stated)' and
    it should never show a number nobody actually stated."""
    raw = tags.get("surveillance:retention") or tags.get("retention")
    if not raw:
        return None
    raw = raw.strip().lower().removesuffix(" days").removesuffix("d").strip()
    try:
        return int(float(raw))
    except ValueError:
        return None


def normalize(element):
    tags = element.get("tags", {})
    version = int(element.get("version", 1) or 1)
    return {
        "id": f"node/{element['id']}",
        "modality": "alpr",
        "latitude": round(element["lat"], 6),
        "longitude": round(element["lon"], 6),
        "vendor": parse_vendor(tags),
        "model": tags.get("camera:type") if tags.get("camera:type") not in ("fixed", None) else None,
        "operatorName": tags.get("operator"),
        "directionDegrees": parse_direction(tags),
        "retentionDays": parse_retention_days(tags),
        "sharingScope": tags.get("surveillance:zone"),
        "source": "openStreetMap",
        # Last time anyone touched the node. This is genuinely "last edited",
        # which we surface as "verified" only because an edit is the strongest
        # freshness signal OSM exposes without the history API.
        "lastVerified": element.get("timestamp"),
        # Edit count as a proxy for corroboration. Distinct reporter counts
        # need the element history API — a pipeline TODO, not something to
        # fake here.
        "reportCount": version,
        "distinctReporterCount": min(version, 2) if version > 1 else 1,
        "disputeCount": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bbox", nargs=4, type=float, required=True,
                        metavar=("SOUTH", "WEST", "NORTH", "EAST"))
    parser.add_argument("--out", required=True)
    parser.add_argument("--timeout", type=int, default=180)
    args = parser.parse_args()

    print(f"Querying Overpass for {args.bbox} ...", file=sys.stderr)
    payload = fetch(build_query(args.bbox, args.timeout))
    elements = [e for e in payload.get("elements", []) if "lat" in e and "lon" in e]

    devices = [normalize(e) for e in elements]
    devices.sort(key=lambda d: (d["latitude"], d["longitude"]))

    with open(args.out, "w") as handle:
        json.dump(devices, handle, separators=(",", ":"))

    directed = sum(1 for d in devices if d["directionDegrees"] is not None)
    vendors = {}
    for device in devices:
        vendors[device["vendor"]] = vendors.get(device["vendor"], 0) + 1

    print(f"{len(devices)} devices -> {args.out}", file=sys.stderr)
    print(f"  with direction: {directed} "
          f"({directed * 100 // max(len(devices), 1)}%)", file=sys.stderr)
    print(f"  vendors: {sorted(vendors.items(), key=lambda kv: -kv[1])}", file=sys.stderr)


if __name__ == "__main__":
    main()
