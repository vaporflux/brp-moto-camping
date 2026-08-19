#!/usr/bin/env python3
"""Pull campgrounds and lodging near the Parkway from OpenStreetMap, once, offline-forever.

    python3 build/fetch_osm.py            # writes data/osm_places.json
    python3 build/fetch_osm.py --radius 25

Why this and not a live API: the result is baked into the page, so it keeps working in a
gap with no signal. No key, no per-request cost, and the ODbL licence permits
redistribution as long as OpenStreetMap is credited (the page does, in the map attribution
and the Notes tab).

This is the offline tier. Google Places fills gaps live, on demand, through api/places.js
when there IS signal -- see app/README.md.

NOTE: this script could not be exercised where it was written. `overpass-api.de` is blocked
by that environment's egress policy, so the query below is unverified against a live
server. It validates whatever it receives and refuses to write nonsense, but the first run
is yours. If Overpass is busy, it retries the public mirrors in turn.
"""
import argparse
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brp import geo, mp as M  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "osm_places.json")

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]

# BRP is OSM relation 55450. Querying "around" its ways is far cheaper and far more precise
# than a bounding box, which would drag in every hotel in Roanoke, Asheville and Charlotte.
QUERY = """
[out:json][timeout:{timeout}];
rel({relation});
way(r)->.pw;
(
  node(around.pw:{metres})["tourism"~"^(camp_site|caravan_site|hotel|motel|hostel)$"];
  way(around.pw:{metres})["tourism"~"^(camp_site|caravan_site|hotel|motel|hostel)$"];
);
out center tags;
"""

KIND = {
    "camp_site": "campground",
    "caravan_site": "campground",
    "hotel": "hotel",
    "motel": "hotel",
    "hostel": "hotel",
}


def tri(tags, key):
    """OSM amenity tags are three-state, and conflating them is the mistake to avoid.

    'yes' means someone recorded it. 'no' means someone recorded its absence. Missing means
    nobody has looked -- which is NOT the same as 'no', and a filter that treats it that way
    hides real campgrounds.
    """
    v = (tags.get(key) or "").strip().lower()
    if v in ("yes", "true", "1"):
        return True
    if v in ("no", "false", "0"):
        return False
    return None


def fetch(relation, metres, timeout):
    body = QUERY.format(relation=relation, metres=metres, timeout=timeout)
    data = urllib.parse.urlencode({"data": body}).encode()
    last = None
    for url in ENDPOINTS:
        for attempt in range(3):
            try:
                print(f"  querying {urllib.parse.urlparse(url).netloc} "
                      f"(attempt {attempt + 1})…", flush=True)
                req = urllib.request.Request(
                    url, data=data,
                    headers={"User-Agent": "brp-moto-camping/2 (trip planner, one-off build)"})
                with urllib.request.urlopen(req, timeout=timeout + 30) as r:
                    return json.loads(r.read().decode("utf-8"))
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
                last = e
                wait = 5 * (attempt + 1)
                print(f"    {type(e).__name__}: {e} — waiting {wait}s", flush=True)
                time.sleep(wait)
    raise SystemExit(
        f"Could not reach any Overpass mirror. Last error: {last}\n"
        "Overpass is frequently busy; try again in a few minutes. Nothing was written.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--radius", type=float, default=25.0,
                    help="miles from the Parkway centerline to include (default 25)")
    ap.add_argument("--relation", type=int, default=55450)
    ap.add_argument("--timeout", type=int, default=240)
    args = ap.parse_args()

    metres = int(args.radius * 1609.344)
    print(f"Fetching camp sites and lodging within {args.radius} mi of the Parkway…")
    payload = fetch(args.relation, metres, args.timeout)
    elements = payload.get("elements", [])
    print(f"  {len(elements)} raw elements")
    if not elements:
        raise SystemExit("Overpass returned nothing. Not overwriting the existing file.")

    model, _ = M.load(DATA)

    places, skipped = [], 0
    for e in elements:
        tags = e.get("tags") or {}
        name = (tags.get("name") or "").strip()
        if not name:
            skipped += 1          # unnamed nodes are unusable as a destination
            continue
        centre = e.get("center") or e
        lat, lon = centre.get("lat"), centre.get("lon")
        if lat is None or lon is None:
            skipped += 1
            continue
        i, off = geo.nearest_vertex(model.pts, lat, lon)
        if off > args.radius:
            skipped += 1
            continue
        places.append({
            "osm_id": f"{e['type'][0]}{e['id']}",
            "name": name,
            "kind": KIND.get(tags.get("tourism"), "other"),
            "osm_tourism": tags.get("tourism"),
            "lat": round(lat, 6), "lon": round(lon, 6),
            "mp": round(model.mp_at_index(i), 2),
            "off_parkway_mi": round(off, 2),
            "showers": tri(tags, "shower"),
            "toilets": tri(tags, "toilets"),
            "drinking_water": tri(tags, "drinking_water"),
            "fee": tags.get("fee"),
            "phone": tags.get("phone") or tags.get("contact:phone"),
            "website": tags.get("website") or tags.get("contact:website"),
            "source": "osm",
        })

    places.sort(key=lambda p: (p["mp"], p["name"]))
    from collections import Counter
    by_kind = Counter(p["kind"] for p in places)
    with_showers = sum(1 for p in places if p["showers"] is True)
    unknown_showers = sum(1 for p in places if p["showers"] is None)

    with open(OUT, "w") as f:
        json.dump({
            "source": "OpenStreetMap via Overpass, ODbL",
            "relation": args.relation,
            "radius_mi": args.radius,
            "count": len(places),
            "places": places,
        }, f, separators=(",", ":"))

    print(f"\nwrote {OUT}")
    print(f"  {len(places)} places kept, {skipped} skipped (unnamed, unplaceable, or too far)")
    print(f"  by kind: {dict(by_kind)}")
    print(f"  showers tagged yes: {with_showers}   not tagged at all: {unknown_showers}")
    print("\nOSM amenity tagging is patchy. 'Not tagged' is not the same as 'no showers',")
    print("and the planner shows those as unknown rather than filtering them away.")
    print("\nNext: python3 build/derive.py && python3 build/build_app.py")


if __name__ == "__main__":
    main()
