#!/usr/bin/env python3
"""Build a versioned camera pack plus the manifest the app polls.

    python3 Tools/fetch_alpr.py --bbox 24.5 -125.0 49.5 -66.9 --out /tmp/us.json
    python3 Tools/build_db.py --in /tmp/us.json --out /tmp/devices.sqlite
    python3 Tools/publish_pack.py --db /tmp/devices.sqlite --version 2 \
        --base-url https://packs.bestdaylabs.com/blindspot

Emits `devices-v<N>.sqlite` and `manifest.json` into --out-dir. Upload both to
object storage and point `BlindspotPackManifestURL` in Info.plist at the
manifest.

Version is a plain incrementing integer, not a date or a hash: the client's
only question is "is this newer than what I have", and an integer answers it
without any date parsing or timezone edge cases.
"""

import argparse
import json
import os
import shutil
import sqlite3
from datetime import datetime, timezone


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--version", type=int, required=True)
    parser.add_argument("--base-url", required=True,
                        help="Public prefix the pack will be served from")
    parser.add_argument("--out-dir", default="dist")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    filename = f"devices-v{args.version}.sqlite"
    destination = os.path.join(args.out_dir, filename)
    shutil.copyfile(args.db, destination)

    connection = sqlite3.connect(destination)
    count = connection.execute("SELECT COUNT(*) FROM devices").fetchone()[0]
    connection.close()

    manifest = {
        "version": args.version,
        "url": f"{args.base_url.rstrip('/')}/{filename}",
        "bytes": os.path.getsize(destination),
        "deviceCount": count,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    manifest_path = os.path.join(args.out_dir, "manifest.json")
    with open(manifest_path, "w") as handle:
        json.dump(manifest, handle, indent=2)

    print(f"{count} devices, {manifest['bytes'] / 1_048_576:.1f} MB")
    print(f"  {destination}")
    print(f"  {manifest_path}")
    print()
    print("Upload both, then set BlindspotPackManifestURL to:")
    print(f"  {args.base_url.rstrip('/')}/manifest.json")


if __name__ == "__main__":
    main()
