#!/usr/bin/env python3
"""Verify every OSM place against Google, and keep only the ones Google confirms.

    export GOOGLE_MAPS_API_KEY=AIza...
    python3 build/enrich_google.py --limit 20      # trial run, 20 requests
    python3 build/enrich_google.py                 # the whole list

OpenStreetMap says WHAT EXISTS and WHERE ON THE PARKWAY it sits -- a name, a coordinate,
and from that a milepost. It is patchy on everything else: of 644 places, 43% carry a phone
number and 39% carry nothing at all beyond a name. "Budget Inn, MP 0.0" is not a place you
can plan a night around.

Google is the opposite. It has the phone number, the website, the rating and the hours, but
it caps a nearby search at 20 results, so it can never enumerate a 469 mile corridor. It
answers "tell me about this place", not "list every place".

So this asks Google about each OSM place by name and location. A place Google confirms
gets its details. A place Google cannot find is dropped from the app entirely -- the
planner would rather show forty places you can actually call than six hundred you cannot.

MATCHING IS THE WHOLE PROBLEM. A text search for "Mountain View Campground" near a
coordinate will happily return a different Mountain View Campground forty miles away, or a
gas station with a similar name. Attaching the wrong phone number to a campsite is worse
than showing no phone number, because the rider believes it. So a result must clear BOTH a
name-similarity bar and a distance bar to count as a match, and every accepted match
records why it was accepted so a bad rule can be audited later.

BILLING. One Text Search request per place. Contact and rating fields put those requests in
Google's most expensive Text Search tier, so a full run over 644 places is a real, if
modest, charge -- check your own quota cap before starting. The run is resumable: it
checkpoints after every place, so an interrupted run costs nothing to resume and never pays
twice for the same place.

TERMS. Google's Places policy restricts how long their content may be retained; place IDs
may be cached indefinitely, the content generally may not. Baking this into a committed
data file is a deliberate choice made for a private planner used by its author and his
friends, and it is worth re-reading Google's current terms before making it public.
"""
import argparse
import difflib
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SRC = os.path.join(DATA, "osm_places.json")
OUT = os.path.join(DATA, "google_enrichment.json")

ENDPOINT = "https://places.googleapis.com/v1/places:searchText"
FIELDS = ",".join([
    "places.id", "places.displayName", "places.location", "places.formattedAddress",
    "places.nationalPhoneNumber", "places.websiteUri", "places.rating",
    "places.userRatingCount", "places.primaryType", "places.businessStatus",
    "places.regularOpeningHours.weekdayDescriptions",
])

# How far a Google result may sit from the OSM coordinate and still be the same place.
# OSM nodes are hand-placed and Google's centroid is its own; a quarter mile of daylight
# between them is ordinary, a mile is not.
MAX_MATCH_MI = 1.0
# How alike the names must read once the boilerplate is stripped.
MIN_NAME_RATIO = 0.62

# Words that carry no identifying weight. "Sherando Lake Campground" and "Sherando Lake
# Rec Area" are the same place; "Fancy Gap KOA" and "Floyd KOA" are not, and dropping the
# brand word is what makes the second pair score apart instead of together.
NOISE = re.compile(
    r"\b(campground|camping|campsite|camp|rv|park|resort|holiday|journey|hotel|motel|inn|"
    r"lodge|lodging|hostel|cabins?|cottages?|suites|the|at|of|and|&)\b", re.I)


def norm(name):
    s = NOISE.sub(" ", (name or "").lower())
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def name_ratio(a, b):
    """How alike two names read once boilerplate is stripped.

    Three ways to agree, in order of confidence:

    1. Substring. "Sherando Lake" inside "Sherando Lake Recreation Area". Guarded on
       length, or "Lake" would match every lake in Virginia.
    2. Every word of the shorter name appears in the longer one. This is the case that
       actually dominates: OSM tends to carry the long official name and Google a short
       trading name, so "Fancy Gap KOA Journey" and "Fancy Gap / Blue Ridge Parkway KOA
       Journey" are the same campground even though a character-by-character ratio scores
       them 0.58 and throws the match away.
    3. Otherwise, plain sequence similarity.

    What this canNOT do is separate sibling franchises. "Floyd / Blue Ridge Parkway KOA"
    against "Fancy Gap / Blue Ridge Parkway KOA" scores 0.83 on shared words alone, and
    "Asheville East KOA" against "Asheville West KOA" scores 0.94. Names simply do not
    carry that signal. DISTANCE does -- those pairs sit 34 and 11 miles apart, so only one
    is ever a candidate -- and best_match() refuses outright when two plausible names do
    land close together. Read this score as "is this the same KIND of thing at this spot",
    not as proof of identity.
    """
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    if len(na) >= 5 and (na in nb or nb in na):
        return 1.0
    ta, tb = set(na.split()), set(nb.split())
    short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
    if len(short) >= 2 and short <= long_:
        return 1.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


def miles(lat1, lon1, lat2, lon2):
    r = math.radians
    dlat, dlon = r(lat2 - lat1), r(lon2 - lon1)
    h = (math.sin(dlat / 2) ** 2
         + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(dlon / 2) ** 2)
    return 2 * 3958.8 * math.asin(math.sqrt(h))


def search(key, place, timeout=30):
    """One Text Search, biased to the place's own coordinate."""
    body = {
        "textQuery": place["name"],
        "maxResultCount": 5,
        "locationBias": {
            "circle": {
                "center": {"latitude": place["lat"], "longitude": place["lon"]},
                "radius": 3000.0,
            }
        },
    }
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": FIELDS,
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def best_match(place, results):
    """The closest result that clears both bars, or None with the reason it failed."""
    scored = []
    for g in results:
        loc = g.get("location") or {}
        glat, glon = loc.get("latitude"), loc.get("longitude")
        if glat is None or glon is None:
            continue
        gname = (g.get("displayName") or {}).get("text") or ""
        d = miles(place["lat"], place["lon"], glat, glon)
        ratio = name_ratio(place["name"], gname)
        scored.append((d, ratio, gname, g))

    if not scored:
        return None, "google returned no result with a location"

    ok = [s for s in scored if s[0] <= MAX_MATCH_MI and s[1] >= MIN_NAME_RATIO]
    if not ok:
        near = min(scored, key=lambda s: s[0])
        return None, (f"best candidate {near[2]!r} was {near[0]:.2f} mi away "
                      f"with name score {near[1]:.2f}")
    # Among those that clear both bars, prefer the strongest name, then the nearest.
    ok.sort(key=lambda s: (-s[1], s[0]))

    # Refuse to guess between two plausible candidates.
    #
    # Name similarity cannot separate sibling franchises: "Fancy Gap / Blue Ridge Parkway
    # KOA" and "Floyd / Blue Ridge Parkway KOA" score 0.83 against each other, and
    # "Asheville East KOA" against "Asheville West KOA" scores 0.94. Distance normally
    # settles it -- those pairs are 34 and 11 miles apart, so only one is ever a candidate.
    # When two DO land close together with near-identical names, there is no signal left to
    # choose with, and picking the marginally better one would attach a phone number that
    # might belong to the other. Unmatched is the honest answer.
    if len(ok) > 1:
        (d0, r0, n0, _), (d1, r1, n1, _) = ok[0], ok[1]
        if abs(r0 - r1) < 0.08 and abs(d0 - d1) < 0.25 and norm(n0) != norm(n1):
            return None, (f"ambiguous: {n0!r} ({d0:.2f} mi, {r0:.2f}) and "
                          f"{n1!r} ({d1:.2f} mi, {r1:.2f}) are equally plausible")

    d, ratio, gname, g = ok[0]
    return {
        "google_id": g.get("id"),
        "google_name": gname,
        "match_distance_mi": round(d, 3),
        "match_name_score": round(ratio, 3),
        "lat": g["location"]["latitude"],
        "lon": g["location"]["longitude"],
        "address": g.get("formattedAddress"),
        "phone": g.get("nationalPhoneNumber"),
        "url": g.get("websiteUri"),
        "rating": g.get("rating"),
        "ratings": g.get("userRatingCount"),
        "primary_type": g.get("primaryType"),
        "business_status": g.get("businessStatus"),
        "hours": (g.get("regularOpeningHours") or {}).get("weekdayDescriptions"),
    }, None


def load_checkpoint():
    if not os.path.exists(OUT):
        return {}
    with open(OUT) as f:
        return {r["osm_id"]: r for r in json.load(f).get("records", [])}


def save(records):
    matched = [r for r in records.values() if r.get("match")]
    with open(OUT, "w") as f:
        json.dump({
            "source": "Google Places API (New), Text Search",
            "count": len(records),
            "matched": len(matched),
            "max_match_mi": MAX_MATCH_MI,
            "min_name_ratio": MIN_NAME_RATIO,
            "records": sorted(records.values(), key=lambda r: r["osm_id"]),
        }, f, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="stop after this many NEW lookups")
    ap.add_argument("--sleep", type=float, default=0.12,
                    help="seconds between requests (default 0.12)")
    ap.add_argument("--redo", action="store_true",
                    help="ignore the checkpoint and look everything up again")
    args = ap.parse_args()

    key = os.environ.get("GOOGLE_MAPS_API_KEY") or os.environ.get("GOOGLE_PLACES_API_KEY")
    if not key:
        raise SystemExit(
            "No API key. Set one first:\n"
            "  export GOOGLE_MAPS_API_KEY=AIza...\n"
            "Use the same key the deployed app uses, and make sure the Places API (New) is "
            "enabled for it. Nothing was requested and nothing was written.")

    if not os.path.exists(SRC):
        raise SystemExit(f"{SRC} not found. Run build/fetch_osm.py first.")
    with open(SRC) as f:
        places = json.load(f)["places"]

    done = {} if args.redo else load_checkpoint()
    todo = [p for p in places if p["osm_id"] not in done]
    if args.limit:
        todo = todo[:args.limit]

    print(f"{len(places)} OSM places, {len(done)} already looked up, {len(todo)} to do.")
    if not todo:
        print("Nothing to do. Delete data/google_enrichment.json or pass --redo to start over.")
        return 0
    print(f"That is {len(todo)} billable Google Text Search requests. "
          f"Ctrl-C is safe -- progress is saved after every place.\n")

    records = dict(done)
    failures = 0
    try:
        for i, p in enumerate(todo, 1):
            try:
                payload = search(key, p)
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[:300]
                if e.code in (429, 503):
                    print(f"  rate limited ({e.code}); waiting 30s")
                    time.sleep(30)
                    try:
                        payload = search(key, p)
                    except Exception as e2:
                        print(f"  STOPPING: {type(e2).__name__}: {e2}")
                        break
                else:
                    print(f"  STOPPING at {p['name']!r}: HTTP {e.code}\n  {detail}")
                    break
            except Exception as e:
                print(f"  STOPPING at {p['name']!r}: {type(e).__name__}: {e}")
                break

            match, why = best_match(p, payload.get("places", []))
            records[p["osm_id"]] = {
                "osm_id": p["osm_id"], "osm_name": p["name"],
                "match": match, "rejected_because": why,
            }
            if match is None:
                failures += 1
            if i % 10 == 0 or i == len(todo):
                save(records)
                kept = sum(1 for r in records.values() if r.get("match"))
                print(f"  {i}/{len(todo)}   matched {kept}   unmatched "
                      f"{len(records) - kept}", flush=True)
            time.sleep(args.sleep)
    except KeyboardInterrupt:
        print("\ninterrupted")

    save(records)
    matched = [r for r in records.values() if r.get("match")]
    unmatched = [r for r in records.values() if not r.get("match")]
    with_phone = sum(1 for r in matched if r["match"].get("phone"))
    with_url = sum(1 for r in matched if r["match"].get("url"))

    print(f"\nwrote {OUT}")
    print(f"  {len(records)} looked up")
    print(f"  {len(matched)} matched      -> these stay in the app")
    print(f"  {len(unmatched)} unmatched  -> these get dropped")
    print(f"  of the matched: {with_phone} have a phone, {with_url} have a website")
    if unmatched:
        print("\n  a few Google could not confirm:")
        for r in unmatched[:8]:
            print(f"    {r['osm_name'][:38]:38s}  {r['rejected_because']}")
    print("\nNext: python3 build/derive.py && python3 build/build_app.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
