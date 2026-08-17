#!/usr/bin/env python3
"""Normalized device JSON -> bundled SQLite pack.

    python3 Tools/build_db.py --in /tmp/us_alpr.json \
        --out Blindspot/Resources/devices.sqlite

Why SQLite and not the JSON file directly: the nationwide set is ~129k
devices / ~42MB of JSON. Decoding that into structs at launch would cost
seconds and hundreds of MB of RSS, and the app only ever needs the handful of
devices inside the current viewport. An indexed table answers that in under a
millisecond and keeps memory flat regardless of dataset size.

This is also the shape the real pipeline wants (spec §5): regional packs the
client downloads. One file per region, swapped without touching app code.

Uses only the SQLite that ships with iOS — no GRDB dependency for a read-only
bbox query. Add GRDB when the exposure log needs writes.
"""

import argparse
import json
import os
import sqlite3
import sys

SCHEMA = """
PRAGMA journal_mode = DELETE;
PRAGMA page_size = 4096;

CREATE TABLE devices (
    id            TEXT PRIMARY KEY,
    modality      TEXT NOT NULL,
    lat           REAL NOT NULL,
    lon           REAL NOT NULL,
    vendor        TEXT NOT NULL,
    model         TEXT,
    operator_name TEXT,
    direction     REAL,
    retention     INTEGER,
    sharing       TEXT,
    source        TEXT NOT NULL,
    verified      TEXT,
    reports       INTEGER NOT NULL DEFAULT 1,
    reporters     INTEGER NOT NULL DEFAULT 1,
    disputes      INTEGER NOT NULL DEFAULT 0
);

-- Viewport queries filter latitude first (the narrower axis for a phone-shaped
-- viewport), then longitude, so a composite index in that order lets SQLite
-- satisfy the whole predicate from the index.
CREATE INDEX idx_devices_latlon ON devices (lat, lon);
"""

COLUMNS = [
    ("id", "id"),
    ("modality", "modality"),
    ("lat", "latitude"),
    ("lon", "longitude"),
    ("vendor", "vendor"),
    ("model", "model"),
    ("operator_name", "operatorName"),
    ("direction", "directionDegrees"),
    ("retention", "retentionDays"),
    ("sharing", "sharingScope"),
    ("source", "source"),
    ("verified", "lastVerified"),
    ("reports", "reportCount"),
    ("reporters", "distinctReporterCount"),
    ("disputes", "disputeCount"),
]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--in", dest="source", required=True)
    parser.add_argument("--out", dest="destination", required=True)
    args = parser.parse_args()

    with open(args.source) as handle:
        devices = json.load(handle)

    if os.path.exists(args.destination):
        os.remove(args.destination)

    connection = sqlite3.connect(args.destination)
    connection.executescript(SCHEMA)

    placeholders = ",".join("?" * len(COLUMNS))
    column_names = ",".join(column for column, _ in COLUMNS)
    connection.executemany(
        f"INSERT OR REPLACE INTO devices ({column_names}) VALUES ({placeholders})",
        [tuple(device.get(key) for _, key in COLUMNS) for device in devices],
    )
    connection.commit()
    connection.execute("VACUUM")
    connection.execute("ANALYZE")
    connection.commit()

    count = connection.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
    connection.close()

    size_mb = os.path.getsize(args.destination) / (1024 * 1024)
    print(f"{count} devices -> {args.destination} ({size_mb:.1f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
