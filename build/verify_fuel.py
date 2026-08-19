#!/usr/bin/env python3
"""Check every fuel exit against Google: does the pump exist, and is it open?

    export GOOGLE_MAPS_API_KEY=AIza...
    python3 build/verify_fuel.py --limit 5      # trial, 5 requests
    python3 build/verify_fuel.py                # all 29 exits

WHY THIS MATTERS MORE THAN THE LODGING CHECK. A wrong campground costs an hour and a
phone call. A wrong fuel stop strands a bike on a road with no fuel for 469 miles, at
the end of a tank, usually in the dark. The rider cannot verify it in advance and cannot
recover from it afterwards. So this is the dataset where being confidently wrong is worst,
and the one worth spending requests on.

WHY NEARBY SEARCH AND NOT ONE LOOKUP PER STATION. There are 29 exits carrying 80-odd
stations between them, and looking each one up by name would confirm only what we already
believe. A nearby search around each exit costs 29 requests instead of 80, and it does
something the per-station lookup cannot: it finds pumps we never recorded. Coverage
improves as a side effect of verification.

WHAT GETS CHECKED, per exit:

  confirmed     our station matched a Google gas station at the same spot, OPERATIONAL.
                Google's hours, phone and brand overwrite ours, because ours were mostly
                blank and never dated.
  closed        matched, but Google says CLOSED_PERMANENTLY or CLOSED_TEMPORARILY. This is
                the finding that justifies the whole exercise.
  unconfirmed   we list it, Google has no gas station within MATCH_MI of it. Not proof it
                is gone -- rural coverage is imperfect -- so it is flagged, not deleted.
  discovered    Google has a gas station here that we never recorded.

Nothing is deleted and no grade is rewritten. This writes a report; deciding what the
planner does with it is a separate, reviewable step. A fuel dataset should not silently
change under a rider who has already planned against it.

TERMS. Same caveat as build/enrich_google.py: Google's Places policy restricts retaining
their content. Place ids may be cached indefinitely, content generally may not.
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brp import mp as M  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SRC = os.path.join(DATA, "fuel.json")
OUT = os.path.join(DATA, "fuel_verification.json")

ENDPOINT = "https://places.googleapis.com/v1/places:searchNearby"
FIELDS = ",".join([
    "places.id", "places.displayName", "places.location", "places.formattedAddress",
    "places.nationalPhoneNumber", "places.businessStatus", "places.primaryType",
    "places.rating", "places.userRatingCount",
    "places.regularOpeningHours.weekdayDescriptions",
    "places.regularOpeningHours.openNow",
])

# A filling station is a small thing in a big landscape. Two records 400 m apart at a
# highway exit are the same pump under different names ("Exxon" vs "Exxon Travel Center");
# two records a mile apart are two businesses.
MATCH_MI = 0.25
MIN_NAME_RATIO = 0.55

# Search radius around the cluster of stations we already know about, in miles. Wide enough
# to catch a pump we missed on the same road, tight enough not to drag in the next town.
PAD_MI = 2.0
MIN_RADIUS_MI = 1.5
MAX_RADIUS_MI = 9.0


def norm(name):
    s = re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def name_ratio(a, b):
    """Brand-led, because that is how fuel is actually named.

    "Exxon" against "Exxon Travel Center" is one pump. Station names are short and
    brand-dominated, so a shared leading word carries more weight here than it would for a
    campground, and the distance bar is correspondingly tight.
    """
    na, nb = norm(a), norm(b)
    if not na or not nb:
        return 0.0
    ta, tb = set(na.split()), set(nb.split())
    if ta & tb:
        short, long_ = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
        if short <= long_:
            return 1.0
    return difflib.SequenceMatcher(None, na, nb).ratio()


def miles(a, b):
    r = math.radians
    dlat, dlon = r(b[0] - a[0]), r(b[1] - a[1])
    h = (math.sin(dlat / 2) ** 2
         + math.cos(r(a[0])) * math.cos(r(b[0])) * math.sin(dlon / 2) ** 2)
    return 2 * 3958.8 * math.asin(math.sqrt(h))


def search_area(exit_rec, model=None):
    """Where to centre the search, and how wide.

    Centred on the stations we already believe in rather than on the Parkway itself: the
    exit road runs for miles and the pumps cluster at its far end, so a circle drawn from
    the Parkway either misses them or has to be so wide it pulls in the next town.

    Sixteen of the 29 exits carry no parkway_lat at all, and MP 248.1 carries no stations
    either -- so the milepost model provides the fallback coordinate. That exit is the one
    with nothing recorded to confirm, which makes it the one where discovery matters most.
    """
    stations = [s for s in exit_rec.get("stations", [])
                if s.get("lat") is not None and s.get("lon") is not None]
    if not stations:
        if "parkway_lat" in exit_rec and exit_rec["parkway_lat"] is not None:
            centre = (exit_rec["parkway_lat"], exit_rec["parkway_lon"])
        elif model is not None:
            centre = tuple(model.coord_at_mp(float(exit_rec["mp"])))
        else:
            raise ValueError(f"MP {exit_rec['mp']} has no coordinate and no model to ask")
        # Nothing recorded here to anchor on, so cast wider: this is discovery, not checking.
        return centre, MAX_RADIUS_MI
    lat = sum(s["lat"] for s in stations) / len(stations)
    lon = sum(s["lon"] for s in stations) / len(stations)
    spread = max(miles((lat, lon), (s["lat"], s["lon"])) for s in stations)
    return (lat, lon), max(MIN_RADIUS_MI, min(MAX_RADIUS_MI, spread + PAD_MI))


def search(key, centre, radius_mi, timeout=30):
    body = {
        "includedTypes": ["gas_station"],
        "maxResultCount": 20,
        "locationRestriction": {
            "circle": {"center": {"latitude": centre[0], "longitude": centre[1]},
                       "radius": round(radius_mi * 1609.344, 1)},
        },
    }
    req = urllib.request.Request(
        ENDPOINT, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": key,
                 "X-Goog-FieldMask": FIELDS})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _relift(simple):
    """Turn a stored, simplified place back into the Google shape reconcile() expects.

    The report keeps places flattened for readability. --tighten needs to feed the earlier
    pass's finds back through the same matcher as the new ones, and one shared code path
    beats two that can disagree.
    """
    return {
        "id": simple.get("google_id"),
        "displayName": {"text": simple.get("name") or ""},
        "location": {"latitude": simple.get("lat"), "longitude": simple.get("lon")},
        "formattedAddress": simple.get("address"),
        "nationalPhoneNumber": simple.get("phone"),
        "businessStatus": simple.get("status"),
        "rating": simple.get("rating"), "userRatingCount": simple.get("ratings"),
        "regularOpeningHours": ({"weekdayDescriptions": simple["hours"]}
                                if simple.get("hours") else None),
    }


def simplify(g):
    loc = g.get("location") or {}
    return {
        "google_id": g.get("id"),
        "name": (g.get("displayName") or {}).get("text") or "",
        "lat": loc.get("latitude"), "lon": loc.get("longitude"),
        "address": g.get("formattedAddress"),
        "phone": g.get("nationalPhoneNumber"),
        "status": g.get("businessStatus"),
        "rating": g.get("rating"), "ratings": g.get("userRatingCount"),
        "hours": (g.get("regularOpeningHours") or {}).get("weekdayDescriptions"),
    }


def reconcile(exit_rec, google_places):
    """Line our stations up against Google's, and say what happened to each."""
    goog = [simplify(g) for g in google_places]
    goog = [g for g in goog if g["lat"] is not None and g["lon"] is not None]
    used = set()
    stations, closed = [], []

    for s in exit_rec.get("stations", []):
        if s.get("lat") is None:
            stations.append({**s, "verify": "no coordinate to check"})
            continue
        cands = []
        for i, g in enumerate(goog):
            d = miles((s["lat"], s["lon"]), (g["lat"], g["lon"]))
            if d <= MATCH_MI:
                cands.append((name_ratio(s.get("name") or s.get("brand") or "", g["name"]),
                              -d, i, g, d))
        cands = [c for c in cands if c[0] >= MIN_NAME_RATIO]
        if not cands:
            stations.append({**s, "verify": "unconfirmed", "google": None})
            continue
        cands.sort(reverse=True)
        ratio, _, i, g, d = cands[0]
        used.add(i)
        open_ = g["status"] in (None, "OPERATIONAL")
        stations.append({
            **s, "verify": "confirmed" if open_ else "closed",
            "match_mi": round(d, 3), "match_name_score": round(ratio, 2), "google": g,
        })
        if not open_:
            closed.append({"ours": s.get("name"), "google": g["name"], "status": g["status"]})

    discovered = [g for i, g in enumerate(goog)
                  if i not in used and g["status"] in (None, "OPERATIONAL")]
    return stations, closed, discovered


def load_checkpoint():
    if not os.path.exists(OUT):
        return {}
    with open(OUT) as f:
        return {str(r["mp"]): r for r in json.load(f).get("exits", [])}


def save(records):
    exits = sorted(records.values(), key=lambda r: r["mp"])
    tally = {"confirmed": 0, "closed": 0, "unconfirmed": 0, "discovered": 0}
    for e in exits:
        for s in e.get("stations", []):
            v = s.get("verify")
            if v in tally:
                tally[v] += 1
        tally["discovered"] += len(e.get("discovered", []))
    with open(OUT, "w") as f:
        json.dump({
            "source": "Google Places API (New), Nearby Search, includedTypes=[gas_station]",
            "match_mi": MATCH_MI, "min_name_ratio": MIN_NAME_RATIO,
            "exits_checked": len(exits), "tally": tally, "exits": exits,
        }, f, indent=1)
    return tally


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="stop after this many NEW exits")
    ap.add_argument("--sleep", type=float, default=0.15)
    ap.add_argument("--redo", action="store_true", help="ignore the checkpoint")
    ap.add_argument("--tighten", action="store_true",
                    help="re-search only the exits whose first pass hit Google's "
                         "20-result cap, at half the radius, and merge the findings in")
    args = ap.parse_args()

    key = os.environ.get("GOOGLE_MAPS_API_KEY") or os.environ.get("GOOGLE_PLACES_API_KEY")
    if not key:
        raise SystemExit("No API key. export GOOGLE_MAPS_API_KEY=AIza...  Nothing was done.")
    if key.strip() in ("PASTE_KEY_HERE", "AIza...") or len(key.strip()) < 20:
        raise SystemExit(f"That is a placeholder, not a key: {key.strip()[:20]!r}")

    with open(SRC) as f:
        fuel = json.load(f)
    model, _ = M.load(DATA)
    done = {} if args.redo else load_checkpoint()

    if args.tighten:
        # A capped exit told us nothing about what it did NOT return.
        #
        # Nearby Search stops at 20 results. Eight exits hit that ceiling, which means two
        # things at once: the discovery count there is a floor rather than a total, and a
        # station of ours that came back "unconfirmed" may simply have been crowded out by
        # nineteen others Google ranked higher. Absence of evidence, from a truncated list,
        # is not evidence of absence.
        #
        # Halving the radius shrinks the field so the cap stops biting. Results merge into
        # the existing record rather than replacing it, so nothing found the first time is
        # lost by looking again more closely.
        capped = [f for f in fuel
                  if done.get(str(f["mp"]), {}).get("google_returned", 0) >= 20]
        if not capped:
            print("No exit hit the 20-result cap. Nothing to tighten.")
            return 0
        todo = capped
    else:
        todo = [f for f in fuel if str(f["mp"]) not in done]
    if args.limit:
        todo = todo[:args.limit]

    print(f"{len(fuel)} fuel exits, {len(done)} already checked, {len(todo)} to do.")
    if not todo:
        print("Nothing to do. Pass --redo to start over.")
        return 0
    if args.tighten:
        print("Re-searching only the exits that hit Google's 20-result cap, at half the "
              "radius.\nFindings merge into what is already there; nothing is discarded.")
    print(f"That is {len(todo)} billable Nearby Search requests.\n")

    records = dict(done)
    for i, ex in enumerate(todo, 1):
        centre, radius = search_area(ex, model)
        prior = records.get(str(ex["mp"])) if args.tighten else None
        if args.tighten:
            radius = max(0.8, round(prior["searched"]["radius_mi"] / 2, 2))
        try:
            payload = search(key, centre, radius)
        except urllib.error.HTTPError as e:
            print(f"  STOPPING at MP {ex['mp']}: HTTP {e.code}\n"
                  f"  {e.read().decode('utf-8', 'replace')[:300]}")
            break
        except Exception as e:
            print(f"  STOPPING at MP {ex['mp']}: {type(e).__name__}: {e}")
            break

        places = payload.get("places", [])
        if prior:
            # Rebuild the earlier pass's Google results from the record -- every place it
            # saw is either attached to one of our stations or sitting in `discovered` --
            # and reconcile against the union, so a tighter look only ever adds.
            earlier = [s["google"] for s in prior.get("stations", []) if s.get("google")]
            earlier += prior.get("discovered", [])
            have = {g.get("google_id") for g in earlier}
            merged = [g for g in places if g.get("id") not in have]
            places = merged + [_relift(g) for g in earlier]
        stations, closed, discovered = reconcile(ex, places)
        records[str(ex["mp"])] = {
            "mp": ex["mp"], "town": ex.get("town"), "exit_road": ex.get("exit_road"),
            "our_confidence": ex.get("confidence"),
            "searched": {"lat": round(centre[0], 5), "lon": round(centre[1], 5),
                         "radius_mi": round(radius, 2)},
            "google_returned": len(payload.get("places", [])),
            "capped": len(payload.get("places", [])) >= 20,
            "stations": stations, "closed": closed, "discovered": discovered,
        }
        gained = (len(discovered) - len(prior.get("discovered", []))) if prior else None
        flag = "  <-- CLOSED" if closed else (
            f"  (+{gained} more)" if gained else "")
        print(f"  {i}/{len(todo)}  MP {ex['mp']:<6} {(ex.get('town') or '')[:22]:<22} "
              f"{len(stations)} ours, {len(discovered)} new{flag}", flush=True)
        save(records)
        time.sleep(args.sleep)

    tally = save(records)
    print(f"\nwrote {OUT}")
    print(f"  exits checked : {len(records)} of {len(fuel)}")
    print(f"  confirmed     : {tally['confirmed']} stations open, per Google")
    print(f"  CLOSED        : {tally['closed']}")
    print(f"  unconfirmed   : {tally['unconfirmed']} (we list them, Google has nothing there)")
    print(f"  discovered    : {tally['discovered']} pumps we never recorded")

    shut = [(e["mp"], c) for e in records.values() for c in e.get("closed", [])]
    if shut:
        print("\n  stations Google says are closed:")
        for mp, c in shut:
            print(f"    MP {mp:<7} {str(c['ours'])[:26]:<26} {c['status']}")
    unc = [(e["mp"], s) for e in records.values() for s in e.get("stations", [])
           if s.get("verify") == "unconfirmed"]
    if unc:
        print(f"\n  {len(unc)} we list that Google could not find "
              f"(flagged, not deleted -- rural coverage is patchy):")
        for mp, s in unc[:10]:
            print(f"    MP {mp:<7} {str(s.get('name'))[:34]}")

    print("\nNothing in data/fuel.json was changed. Review the report, then decide.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
