"""One place list from three sources of very different trustworthiness.

The planner needs somewhere to sleep. Three sources can supply that, and they are not
interchangeable, so the merge keeps their provenance rather than flattening it:

  curated  the 32 researched campgrounds in data/campgrounds.json. Fact-checked, every one
           verified for hot showers and flush toilets, with access notes and a milepost.
           Small, but nothing else here is this good.
  osm      data/osm_places.json, pulled once by build/fetch_osm.py. Wide coverage, baked in,
           works with no signal. Amenity tagging is patchy.
  google   fetched live by the page through api/places.js when there is signal. Best
           coverage, costs money per request, and cannot be cached under Google's terms --
           so it never lands in this file and never ships in the bundle.

The amenity flags are deliberately THREE-STATE. True means someone recorded it, False means
someone recorded its absence, None means nobody has looked. A filter that treats None as
False hides real campgrounds, which is exactly the failure that makes crowd-sourced data
feel useless.
"""
import json
import os

from . import geo


def _dedupe_key(p):
    """Two records are the same place if the names agree and they are within ~150 m."""
    return (p["name"].strip().lower()[:24], round(p["lat"], 3), round(p["lon"], 3))


def build(model, net, curated, osm=None):
    """Unified place list. `osm` may be None -- the app must work before fetch_osm has run."""
    out = []

    for c in curated:
        i, off = geo.nearest_vertex(model.pts, c["lat"], c["lon"])
        seg = net.segment_at_mp(c["mp"])
        out.append({
            "id": f"camp-{c['id']}",
            "name": c["name"],
            "kind": "campground",
            "lat": c["lat"], "lon": c["lon"],
            "mp": float(c["mp"]),
            "off_parkway_mi": round(off, 2),
            "component": seg.component if seg else None,
            # Every curated entry was verified for both. That is the whole point of the
            # dataset and the reason it is only 32 long.
            "showers": True,
            "toilets": True,
            "source": "curated",
            "moto": bool(c.get("moto")),
            "tier": c.get("tier"),
            "price": c.get("price"),
            "season": c.get("season"),
            "phone": c.get("phone"),
            "url": c.get("url"),
            "access": c.get("access"),
            "standout": c.get("standout"),
            "watchout": c.get("watchout"),
            "food": c.get("food"),
            "state": c.get("state"),
        })

    seen = {_dedupe_key(p) for p in out}
    for p in (osm or {}).get("places", []):
        key = _dedupe_key(p)
        if key in seen:
            continue          # curated wins: it carries research the OSM row does not
        seen.add(key)
        seg = net.segment_at_mp(p["mp"])
        out.append({
            "id": f"osm-{p['osm_id']}",
            "name": p["name"],
            "kind": p["kind"],
            "lat": p["lat"], "lon": p["lon"],
            "mp": p["mp"],
            "off_parkway_mi": p["off_parkway_mi"],
            "component": seg.component if seg else None,
            "showers": p.get("showers"),
            "toilets": p.get("toilets"),
            "source": "osm",
            "phone": p.get("phone"),
            "url": p.get("website"),
            "fee": p.get("fee"),
        })

    out.sort(key=lambda p: (p["mp"], p["name"]))
    return out


def load_osm(data_dir):
    path = os.path.join(data_dir, "osm_places.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return json.load(f)


def summary(places):
    from collections import Counter
    return {
        "total": len(places),
        "by_kind": dict(Counter(p["kind"] for p in places)),
        "by_source": dict(Counter(p["source"] for p in places)),
        "showers_yes": sum(1 for p in places if p["showers"] is True),
        "showers_unknown": sum(1 for p in places if p["showers"] is None),
        "within_5mi": sum(1 for p in places if p["off_parkway_mi"] <= 5),
        "within_15mi": sum(1 for p in places if p["off_parkway_mi"] <= 15),
    }
