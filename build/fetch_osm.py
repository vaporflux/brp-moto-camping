#!/usr/bin/env python3
"""Pull campgrounds and lodging near the Parkway from OpenStreetMap, once, offline-forever.

    python3 build/fetch_osm.py            # writes data/osm_places.json
    python3 build/fetch_osm.py --radius 25
    python3 build/fetch_osm.py --raw saved-overpass.json   # already downloaded

Why this and not a live API: the result is baked into the page, so it keeps working in a
gap with no signal. No key, no per-request cost, and the ODbL licence permits
redistribution as long as OpenStreetMap is credited (the page does, in the map attribution
and the Notes tab).

This is the offline tier. Google Places fills gaps live, on demand, through api/places.js
when there IS signal -- see app/README.md.

NOTE on what has and has not been exercised. The parsing, milepost placement, distance
filtering and three-state amenity handling have all run against a real Overpass response
(2,849 elements, fetched by hand and fed in with --raw). The HTTP path -- the mirror list
and its retries -- has not: `overpass-api.de` is blocked by the egress policy where this
was written. So a live run may still surprise you, but what it does with the answer will
not. If Overpass is busy, it retries the public mirrors in turn.
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

# A bounding box around the centerline, not a buffer around it.
#
# The obvious query is `around` on the ways of relation 55450, and it is more precise -- but
# a 25 mi buffer over 2,689 centerline points needs more than 2 GB and Overpass kills it:
#   "runtime error: Query run out of memory using about 2048 MB of RAM."
# A tag-filtered bounding box is indexed and cheap. It drags in every hotel in Roanoke,
# Knoxville and Charlotte as well, but that costs nothing here: main() measures each result
# against the real centerline and drops whatever falls outside --radius. The precision comes
# from that check, so it does not have to come from Overpass.
# Food is deliberately amenity=restaurant|fast_food only. A rider asking "where can I eat"
# wants a meal, and on this road that is as likely to be a barbecue shack as a restaurant,
# so fast_food is in. cafe, bar, pub and ice_cream are not: they are places to stop rather
# than places to eat, they outnumber the real options several times over along a tourist
# road, and including them buries the handful of answers in a list nobody can read.
QUERY = """
[out:json][timeout:{timeout}];
(
  node({s},{w},{n},{e})["tourism"~"^(camp_site|caravan_site|hotel|motel|hostel)$"];
  way({s},{w},{n},{e})["tourism"~"^(camp_site|caravan_site|hotel|motel|hostel)$"];
  node({s},{w},{n},{e})["amenity"~"^(restaurant|fast_food)$"]["name"];
  way({s},{w},{n},{e})["amenity"~"^(restaurant|fast_food)$"]["name"];
);
out center tags;
"""

KIND = {
    "camp_site": "campground",
    "caravan_site": "campground",
    "hotel": "hotel",
    "motel": "hotel",
    "hostel": "hotel",
    # amenity=, not tourism=
    "restaurant": "food",
    "fast_food": "food",
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


def bbox(model, radius_mi):
    """The centerline's extent, padded by the search radius.

    Latitude is ~69 mi per degree everywhere; longitude shrinks with latitude, so the
    padding uses the widest (lowest-latitude) row to stay generous rather than clip.
    """
    lats = [p[0] for p in model.pts]
    lons = [p[1] for p in model.pts]
    pad_lat = radius_mi / 69.0
    pad_lon = radius_mi / (69.0 * math.cos(math.radians(max(abs(min(lats)), abs(max(lats))))))
    return (min(lats) - pad_lat, min(lons) - pad_lon,
            max(lats) + pad_lat, max(lons) + pad_lon)


def fetch(box, timeout):
    body = QUERY.format(s=f"{box[0]:.4f}", w=f"{box[1]:.4f}",
                        n=f"{box[2]:.4f}", e=f"{box[3]:.4f}", timeout=timeout)
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
    ap.add_argument("--raw", metavar="PATH",
                    help="process a previously downloaded Overpass response instead of "
                         "querying. For when this machine cannot reach Overpass but "
                         "another one can -- the parsing, milepost placement and "
                         "three-state amenity handling are identical either way.")
    args = ap.parse_args()

    model, _ = M.load(DATA)

    if args.raw:
        print(f"Reading a saved Overpass response from {args.raw}…")
        with open(args.raw) as f:
            payload = json.load(f)
    else:
        box = bbox(model, args.radius)
        print(f"Fetching camp sites and lodging within {args.radius} mi of the Parkway…")
        print(f"  bounding box {box[0]:.3f},{box[1]:.3f} to {box[2]:.3f},{box[3]:.3f}")
        payload = fetch(box, args.timeout)

    # Overpass reports a failed query as HTTP 200 with an empty element list and a remark.
    # Treating that as "no results" would quietly write an empty file, so name it instead.
    remark = (payload.get("remark") or "").strip()
    elements = payload.get("elements", [])
    if remark and not elements:
        raise SystemExit(
            f"Overpass refused the query: {remark}\n"
            "Nothing was written. If this is a memory error, lower --radius and retry.")
    print(f"  {len(elements)} raw elements")
    if remark:
        print(f"  NOTE: Overpass also said: {remark}")
    if not elements:
        raise SystemExit("Overpass returned nothing. Not overwriting the existing file.")

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
            "kind": KIND.get(tags.get("tourism") or tags.get("amenity"), "other"),
            "osm_tourism": tags.get("tourism"),
            "osm_amenity": tags.get("amenity"),
            # What kind of food, when OSM says. "Somewhere to eat" is a weaker answer than
            # "barbecue", and the finder already searches this field.
            "cuisine": tags.get("cuisine"),
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
