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
import difflib
import json
import math
import os
import re

from . import geo


def _dedupe_key(p):
    """Two records are the same place if the names agree and they are within ~150 m."""
    return (p["name"].strip().lower()[:24], round(p["lat"], 3), round(p["lon"], 3))


def _miles(lat1, lon1, lat2, lon2):
    r = math.radians
    dlat, dlon = r(lat2 - lat1), r(lon2 - lon1)
    h = (math.sin(dlat / 2) ** 2
         + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(dlon / 2) ** 2)
    return 2 * 3958.8 * math.asin(math.sqrt(h))


def _words(name):
    return set(re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower()).split())


def _same_place(name_a, name_b):
    """Do two names, at the same spot, describe the same business?"""
    wa, wb = _words(name_a), _words(name_b)
    if not wa or not wb:
        return False
    short, long_ = (wa, wb) if len(wa) <= len(wb) else (wb, wa)
    if len(short) >= 2 and short <= long_:
        return True
    return difflib.SequenceMatcher(None, (name_a or "").lower(),
                                   (name_b or "").lower()).ratio() >= 0.6


# How close two records must sit before their names are even compared. Wider than the ~150 m
# the rounded key allowed: a curated coordinate taken at the office and an OSM way centroid
# taken over the whole site are routinely a few hundred metres apart on the same campground.
_SAME_SITE_MI = 0.4


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

    # One Google place, one row.
    #
    # OSM often carries a hotel as several ways -- the main building, an annexe, a parking
    # polygon -- each a separate record with its own name and centroid. _dedupe_key() cannot
    # see that, because it compares the OSM names, and those differ. Enrichment then renames
    # every one of them to the same Google name, and the list shows the same hotel two or
    # three times over. Nine Google places arrived as nineteen rows this way.
    #
    # So the Google id decides, and where several OSM records claim the same one, the record
    # whose coordinate sits closest to Google's wins -- that is the one most likely to be the
    # building rather than the car park.
    best_for_google = {}
    if enrichment is not None:
        for op in (osm or {}).get("places", []):
            g = (enrichment.get(op["osm_id"]) or {}).get("match")
            if not g or not g.get("google_id"):
                continue
            gid = g["google_id"]
            cur = best_for_google.get(gid)
            if cur is None or g.get("match_distance_mi", 9e9) < cur[1]:
                best_for_google[gid] = (op["osm_id"], g.get("match_distance_mi", 9e9))
    winners = {osm_id for osm_id, _ in best_for_google.values()}

    for p in (osm or {}).get("places", []):
        key = _dedupe_key(p)
        if key in seen:
            continue          # curated wins: it carries research the OSM row does not

        # Food ships only with Google behind it. Unconditionally -- not merely when an
        # enrichment file happens to exist, which is how the rest of this loop works.
        #
        # A campsite or a hotel from OSM alone is still a usable answer: it is a place with
        # a name and a location, and a rider can ring ahead. A restaurant is not. Half of
        # them have changed hands, changed hours or closed since anyone touched the tag,
        # and an unenriched one offers no phone number, no hours and no rating to check
        # any of that against -- so it is a name on a map that sends somebody hungry down a
        # side road at eight in the evening. Better to show nothing and let the Google
        # search answer it live.
        if p["kind"] == "food" and not ((enrichment or {}).get(p["osm_id"]) or {}).get("match"):
            continue

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
            if g.get("google_id") and p["osm_id"] not in winners:
                continue      # another OSM record is a better fit for this same Google place

        # Curated wins, judged on where the place IS rather than on a rounded key.
        #
        # The rounded-coordinate key misses a curated entry and an OSM way sitting 60 m
        # apart, and it compares OSM's original name -- but enrichment has since renamed the
        # OSM row to whatever Google calls it, so the two names it compares are not the two
        # names that end up on screen. Eight campgrounds shipped twice because of this,
        # including Raccoon Holler and three KOAs.
        final_name = (g or {}).get("google_name") or p["name"]
        if any(_miles(p["lat"], p["lon"], c["lat"], c["lon"]) <= _SAME_SITE_MI
               and _same_place(final_name, c["name"])
               for c in out if c["source"] == "curated"):
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
            # What kind of food, where OSM says so. "Somewhere to eat" is a weaker answer
            # than "barbecue", and the finder searches this.
            "cuisine": p.get("cuisine"),
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
