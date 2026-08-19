"""One place list from three sources of very different trustworthiness.

The planner needs somewhere to sleep. Three sources can supply that, and they are not
interchangeable, so the merge keeps their provenance rather than flattening it:

  curated  the 32 researched campgrounds in data/campgrounds.json. Fact-checked, every one
           verified for hot showers and flush toilets, with access notes and a milepost.
           Small, but nothing else here is this good.
  osm      data/osm_places.json, pulled once by build/fetch_osm.py. Wide coverage, baked in,
           works with no signal. Amenity tagging is patchy.
  google   two roles. Live, the page searches it through api/places.mjs when there is
           signal. At build time, build/enrich_google.py looks up each OSM place by name
           and location and writes data/google_enrichment.json, which this merge folds in.

OSM and Google are complements, not rivals, and the split matters. OSM says WHAT EXISTS
and WHERE ON THE PARKWAY it sits -- and the milepost is the part that makes the planner
work, because Google has no concept of one. But OSM is thin on everything else: 43% of its
places carry a phone number and 39% carry nothing beyond a name. Google is the reverse:
rich detail, but a nearby search caps at 20 results, so it can never enumerate a 469 mile
corridor.

So when an enrichment file is present, an OSM place must be CONFIRMED BY GOOGLE to survive.
The rest are dropped. A name and a dot on a map is not something a rider can plan a night
around, and forty places you can phone beat six hundred you cannot. Curated places are
never dropped -- they were verified by hand, which outranks any API.

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


def build(model, net, curated, osm=None, enrichment=None):
    """Unified place list.

    `osm` may be None -- the app must work before fetch_osm.py has run.
    `enrichment` may be None -- it must also work before enrich_google.py has run, in which
    case every OSM place is kept unenriched rather than the list collapsing to the curated
    32. Absent evidence is not evidence of absence: "we have not asked Google yet" must not
    look the same as "Google says this does not exist".
    """
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
        g = None
        if enrichment is not None:
            rec = enrichment.get(p["osm_id"])
            g = (rec or {}).get("match")
            if not g:
                continue      # Google could not confirm it exists; it does not ship
            # A campground Google reports as permanently closed is worse than no entry at
            # all: the rider rides there, in the dark, at the end of a long day, and finds
            # a padlock. Temporarily closed is different -- those reopen -- so those stay,
            # carrying the status so the card can say so.
            if g.get("business_status") == "CLOSED_PERMANENTLY":
                continue
        seen.add(key)
        seg = net.segment_at_mp(p["mp"])
        out.append({
            "id": f"osm-{p['osm_id']}",
            "name": (g or {}).get("google_name") or p["name"],
            "kind": p["kind"],
            "lat": p["lat"], "lon": p["lon"],
            "mp": p["mp"],
            "off_parkway_mi": p["off_parkway_mi"],
            "component": seg.component if seg else None,
            # Google knows nothing about showers or toilets, so OSM's three-state answer
            # stands unchanged. Enrichment fills contact details, not amenities.
            "showers": p.get("showers"),
            "toilets": p.get("toilets"),
            "source": "osm",
            # Google's value where OSM is blank, OSM's where Google is.
            "phone": (g or {}).get("phone") or p.get("phone"),
            "url": (g or {}).get("url") or p.get("website"),
            "address": (g or {}).get("address"),
            "rating": (g or {}).get("rating"),
            "ratings": (g or {}).get("ratings"),
            "hours": (g or {}).get("hours"),
            "business_status": (g or {}).get("business_status"),
            "google_id": (g or {}).get("google_id"),
            "verified": bool(g),
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


def load_enrichment(data_dir):
    """osm_id -> record from build/enrich_google.py, or None if it has never run."""
    path = os.path.join(data_dir, "google_enrichment.json")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        return {r["osm_id"]: r for r in json.load(f).get("records", [])}


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
        "verified": sum(1 for p in places if p.get("verified")),
        "closed_temporarily": sum(1 for p in places
                                  if p.get("business_status") == "CLOSED_TEMPORARILY"),
        "with_phone": sum(1 for p in places if p.get("phone")),
        "with_url": sum(1 for p in places if p.get("url")),
    }
