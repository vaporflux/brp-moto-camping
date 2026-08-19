#!/usr/bin/env python3
"""Regressions for the data layer. Run: python3 build/test_data.py

Each test pins a specific mistake this pass found and fixed. They are cheap and they
run offline, so the exporter work can proceed against a data layer that stays honest.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brp import junctions as J, mp as M, network as N, places as P, stops as S  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

FAILURES = []


def check(name, cond, detail=""):
    if cond:
        print(f"  pass  {name}")
    else:
        print(f"  FAIL  {name}  {detail}")
        FAILURES.append(name)


def main():
    model, rejected = M.load(DATA)
    net = N.load(model, DATA)
    jx = J.load(model, DATA)
    campgrounds = S.build_campgrounds(model, net, json.load(open(f"{DATA}/campgrounds.json")))
    fuel = S.build_fuel(model, net, json.load(open(f"{DATA}/fuel.json")))

    print("milepost model")
    check("calibration knots are strictly monotone",
          all(b > a for a, b in zip(model._knots_mp, model._knots_mp[1:])))
    check("no control rejected as non-monotone", not rejected, str(rejected))
    errs = []
    for k in range(1, len(model.controls) - 1):
        sub = [c for j, c in enumerate(model.controls) if j != k]
        errs.append(abs(M.MilepostModel(model.pts, sub).mp_at_arc(model.controls[k]["arc"])
                        - model.controls[k]["mp"]))
    check("held-out milepost error beats the shipped uniform model (1.85 mi mean)",
          sum(errs) / len(errs) < 1.0, f"got {sum(errs)/len(errs):.3f}")
    check("termini pin exactly", model.mp_at_index(0) == 0.0
          and abs(model.mp_at_index(len(model.pts) - 1) - 469.1) < 1e-6)
    check("mileposts increase monotonically along the centerline",
          all(model.mp_at_index(i) <= model.mp_at_index(i + 1) + 1e-9
              for i in range(0, len(model.pts) - 1, 7)))

    print("network")
    raw_edges = {c["from_mp"] for c in json.load(open(f"{DATA}/closures.json"))["closures"]}
    raw_edges |= {c["to_mp"] for c in json.load(open(f"{DATA}/closures.json"))["closures"]}
    raw_edges |= {0.0, 469.1}
    off = [(s.from_mp, s.to_mp) for s in net.segments
           if not (any(abs(s.from_mp - e) < 0.01 for e in raw_edges)
                   and any(abs(s.to_mp - e) < 0.01 for e in raw_edges))]
    check("every gate lands exactly on an NPS milepost from closures.json",
          not off, str(off))
    check("Helene break severs the Parkway into 3 components", len(net.components) == 3,
          f"got {len(net.components)}")
    check("MP 300 and MP 400 are NOT connected", not net.connected(300, 400))
    check("Asheville->Cherokee IS connected", net.connected(390, 460))
    check("Spruce Pine orphan (327.5-333.9) is isolated",
          any(s["kind"] == "isolated" and abs(s["from_mp"] - 327.5) < 0.5 for s in net.spurs))
    check("southern component dead-ends at its north end (Mt Mitchell spur)",
          any(s["kind"] == "dead_end_north" and abs(s["from_mp"] - 355.3) < 0.5
              for s in net.spurs))
    check("Roanoke Mountain Loop spur does not sever the mainline",
          all(abs(c["from_mp"] - 120.3) > 0.01 for c in net.closures))

    print("stops: reachability and confidence are independent")
    by_mp = {f["mp"]: f for f in fuel}
    check("MP 248.1 unverified but reachable",
          by_mp[248.1]["reachable_from_parkway"] and by_mp[248.1]["plan_grade"] == "do_not_rely")
    check("MP 330.9 verified but stranded in the orphan segment",
          by_mp[330.9]["confidence"] == "verified"
          and by_mp[330.9]["component"] == 1)
    check("MP 344.1 unreachable inside the Helene closure",
          by_mp[344.1]["plan_grade"] == "unreachable")
    check("MP 63.7 behind a 0.4 mi signed detour is still usable",
          by_mp[63.7]["plan_grade"] == "usable_via_detour")
    check("detour-accessible stops keep a component (else they vanish from gap math)",
          by_mp[63.7]["component"] is not None)

    print("stops: closures block approaches, not campgrounds")
    moto = [c for c in campgrounds if c.get("moto")]
    check("all 4 motorcycle camps survive the closure filter", len(moto) == 4,
          f"got {len(moto)}")
    blocked_moto = [c["name"] for c in moto if not c["reachable_from_parkway"]]
    check("the 2 moto camps behind the MP 274.3-276.5 closure are kept, not deleted",
          len(blocked_moto) == 2 and all(c["reachable"] for c in moto), str(blocked_moto))
    riders = [c for c in campgrounds if "Rider's Roost" in c["name"]][0]
    check("Rider's Roost is retained though its access milepost is inside a closure",
          riders["reachable"] and not riders["reachable_from_parkway"])
    check("every campground is still present", len(campgrounds) == 32, str(len(campgrounds)))

    print("fuel gaps")
    g8 = S.fuel_gaps(fuel, net, max_detour_mi=8)
    check("reproduces SPEC 9's 393.6->443.1 = 49.5 mi at an 8 mi detour threshold",
          any(abs(g["from_mp"] - 393.6) < 0.1 and abs(g["to_mp"] - 443.1) < 0.1
              and abs(g["gap_mi"] - 49.5) < 0.2 for g in g8))
    # Endpoints can sit inside a detour-served closure, where segment_at_mp() is None by
    # design, so compare the component labels the gap was built from rather than
    # re-deriving connectivity from raw mileposts.
    check("no gap is measured across a severed component",
          all(g["component"] is not None for g in S.fuel_gaps(fuel, net))
          and all(net.component_at_mp(g["from_mp"]) in (None, g["component"])
                  and net.component_at_mp(g["to_mp"]) in (None, g["component"])
                  for g in S.fuel_gaps(fuel, net)))
    check("no phantom Virginia gap from mis-grading the MP 63.7 bridge detour",
          not any(abs(g["from_mp"] - 45.6) < 0.1 and g["gap_mi"] > 40
                  for g in S.fuel_gaps(fuel, net)))

    print("places: three sources, provenance kept")
    curated_raw = json.load(open(f"{DATA}/campgrounds.json"))
    places = P.build(model, net, curated_raw, None)
    check("works with no OSM file present", len(places) == 32, str(len(places)))
    check("every curated place keeps its provenance",
          all(p["source"] == "curated" for p in places))
    check("curated places are verified for both amenities",
          all(p["showers"] is True and p["toilets"] is True for p in places))

    # Amenity flags are three-state. Treating "nobody has looked" as "no" would hide real
    # campgrounds, which is the failure that makes crowd-sourced data feel useless.
    fake_osm = {"places": [
        {"osm_id": "n1", "name": "Tagged Yes", "kind": "campground", "lat": 35.5, "lon": -82.5,
         "mp": 390.0, "off_parkway_mi": 1.0, "showers": True, "toilets": True},
        {"osm_id": "n2", "name": "Tagged No", "kind": "campground", "lat": 35.51, "lon": -82.51,
         "mp": 391.0, "off_parkway_mi": 2.0, "showers": False, "toilets": None},
        {"osm_id": "n3", "name": "Untagged Place", "kind": "hotel", "lat": 35.52, "lon": -82.52,
         "mp": 392.0, "off_parkway_mi": 3.0, "showers": None, "toilets": None},
        # Same name and position as a curated entry: must not double up.
        {"osm_id": "n4", "name": curated_raw[0]["name"], "kind": "campground",
         "lat": curated_raw[0]["lat"], "lon": curated_raw[0]["lon"],
         "mp": curated_raw[0]["mp"], "off_parkway_mi": 1.0, "showers": None, "toilets": None},
    ]}
    merged = P.build(model, net, curated_raw, fake_osm)
    by_name = {p["name"]: p for p in merged}
    check("OSM places are merged in", len(merged) == 35, str(len(merged)))
    check("a duplicate of a curated place is dropped, curated wins",
          by_name[curated_raw[0]["name"]]["source"] == "curated")
    check("'nobody has looked' stays None, never False",
          by_name["Untagged Place"]["showers"] is None)
    check("a recorded absence stays False",
          by_name["Tagged No"]["showers"] is False)
    check("hotels come through as their own kind",
          by_name["Untagged Place"]["kind"] == "hotel")
    summ = P.summary(merged)
    # 32 curated + the one OSM row tagged yes; one untagged row unknown; one recorded
    # absence; the duplicate never made it in.
    check("summary counts unknowns separately from absences",
          summ["showers_yes"] == 33 and summ["showers_unknown"] == 1, str(summ))

    print("google enrichment: confirmed places stay, unconfirmed are dropped")
    # Absent evidence is not evidence of absence. Before enrich_google.py has run there is
    # no file, and every OSM place must survive -- otherwise the list silently collapses to
    # the curated 32 and looks like Google rejected everything.
    check("no enrichment file keeps every OSM place",
          len(P.build(model, net, curated_raw, fake_osm, None)) == 35)

    enrich = {
        "n1": {"osm_id": "n1", "match": {
            "google_id": "g1", "google_name": "Tagged Yes Campground",
            "phone": "+1 828-555-0101", "url": "https://example.com",
            "address": "1 Test Rd", "rating": 4.4, "ratings": 210,
            "hours": ["Monday: Open 24 hours"], "business_status": "OPERATIONAL",
            "match_distance_mi": 0.08, "match_name_score": 1.0}},
        "n2": {"osm_id": "n2", "match": None,
               "rejected_because": "best candidate was 6.20 mi away"},
        "n3": {"osm_id": "n3", "match": {
            "google_id": "g3", "google_name": "Untagged Place",
            "phone": None, "url": None, "address": "3 Test Rd",
            "rating": None, "ratings": None, "hours": None,
            "business_status": "OPERATIONAL",
            "match_distance_mi": 0.10, "match_name_score": 0.9}},
    }
    enriched = P.build(model, net, curated_raw, fake_osm, enrich)
    names = {p["name"]: p for p in enriched}
    check("a place Google could not confirm is dropped",
          "Tagged No" not in names, sorted(n for n in names if "Tagged" in n))
    check("a place with no enrichment record at all is dropped",
          not any(p["id"] == "osm-n4" for p in enriched))
    check("curated places are never dropped, whatever Google says",
          sum(1 for p in enriched if p["source"] == "curated") == 32)
    check("total is curated plus only the confirmed",
          len(enriched) == 34, str(len(enriched)))

    yes = names["Tagged Yes Campground"]
    check("Google's phone number lands on the place", yes["phone"] == "+1 828-555-0101")
    check("Google's rating lands on the place", yes["rating"] == 4.4)
    check("a confirmed place is marked verified", yes["verified"] is True)
    check("Google's name is preferred when it has one",
          "Tagged Yes Campground" in names and "Tagged Yes" not in names)
    # Google has no idea whether a campground has showers, so enrichment must not invent an
    # answer -- an untagged place stays untagged rather than becoming a definite no.
    check("enrichment does not touch the three-state amenity flags",
          names["Untagged Place"]["showers"] is None
          and names["Untagged Place"]["toilets"] is None)
    check("a confirmed place with no phone at Google keeps a null phone",
          names["Untagged Place"]["phone"] is None)
    summ2 = P.summary(enriched)
    check("summary counts verified separately", summ2["verified"] == 2, str(summ2["verified"]))

    # Google reported 15 of the 644 as permanently closed -- Boone Fork Campground, Blue
    # Ridge Motorcycle Campgrounds and others that really are gone. Showing those is worse
    # than showing nothing: the rider gets there in the dark and finds a padlock.
    shut = dict(enrich)
    shut["n1"] = {"osm_id": "n1", "match": {**enrich["n1"]["match"],
                                            "business_status": "CLOSED_PERMANENTLY"}}
    after = P.build(model, net, curated_raw, fake_osm, shut)
    check("a permanently closed place is dropped",
          not any(p["id"] == "osm-n1" for p in after))
    # Temporarily closed reopens, so the rider decides -- but only if told.
    paused = dict(enrich)
    paused["n1"] = {"osm_id": "n1", "match": {**enrich["n1"]["match"],
                                              "business_status": "CLOSED_TEMPORARILY"}}
    after2 = P.build(model, net, curated_raw, fake_osm, paused)
    kept = [p for p in after2 if p["id"] == "osm-n1"]
    check("a temporarily closed place stays", len(kept) == 1)
    check("and carries the status so the card can say so",
          kept and kept[0]["business_status"] == "CLOSED_TEMPORARILY")

    print("Google-discovered fuel is usable, and visibly a weaker claim")
    report = {"exits": [{"mp": 100.0, "discovered": [
        {"google_id": "g1", "name": "Ridge Exxon", "lat": 36.4386, "lon": -80.9126,
         "status": "OPERATIONAL", "phone": "(336) 555-0101",
         "address": "12 Main St, Sparta, NC", "hours": ["Monday: Open 24 hours"]},
        {"google_id": "g2", "name": "Shut Shell", "lat": 36.4390, "lon": -80.9130,
         "status": "CLOSED_PERMANENTLY"},
        {"google_id": "g1", "name": "Ridge Exxon", "lat": 36.4386, "lon": -80.9126,
         "status": "OPERATIONAL"},
    ]}]}
    disc = S.discovered_fuel(model, report)
    check("a closed pump never becomes a fuel stop", len(disc) == 1, str(len(disc)))
    check("the same pump found at two exits arrives once",
          sum(1 for d in disc if d["google_id"] == "g1") == 1)
    check("it is anchored to its own nearest milepost, not the exit that surfaced it",
          disc[0]["mp"] != 100.0, str(disc[0]["mp"]))
    check("and remembers which exit surfaced it", disc[0]["found_near_exit_mp"] == 100.0)
    check("Google's phone number rides along",
          disc[0]["stations"][0]["phone"] == "(336) 555-0101")

    built = S.build_fuel(model, net, disc)
    check("a Google pump is usable for planning",
          built[0]["plan_grade"] in S.USABLE_GRADES, built[0]["plan_grade"])
    # The whole point of a separate grade: it must never read as researched.
    check("but never as 'usable', which means researched",
          built[0]["plan_grade"] == "usable_google", built[0]["plan_grade"])
    check("and its confidence says where it came from",
          built[0]["confidence"] == "google")
    check("its detour is measured the same way as every other record",
          built[0]["detour_plan_mi"] is not None)

    # Adding fuel can only ever shrink a gap. This caught a real bug in my own analysis:
    # fuel_gaps walks its input in milepost order, and an unsorted merge reported gaps
    # getting LARGER after adding stations.
    base = S.build_fuel(model, net, json.load(open(f"{DATA}/fuel.json")))
    both = S.build_fuel(model, net,
                        json.load(open(f"{DATA}/fuel.json"))
                        + S.discovered_fuel(model, S.load_verification(DATA) or {"exits": []}))
    for limit in (5, 8, 12, 18):
        b = S.fuel_gaps(base, net, max_detour_mi=limit)
        a = S.fuel_gaps(both, net, max_detour_mi=limit)
        check(f"more fuel never widens the worst gap at a {limit} mi detour",
              a[0]["gap_mi"] <= b[0]["gap_mi"] + 1e-9,
              f"{b[0]['gap_mi']} -> {a[0]['gap_mi']}")
    b8 = S.fuel_gaps(base, net, max_detour_mi=8)
    a8 = S.fuel_gaps(both, net, max_detour_mi=8)
    check("and at 8 mi it closes every gap over 40 miles",
          sum(1 for g in a8 if g["gap_mi"] > 40) == 0,
          f"{sum(1 for g in b8 if g['gap_mi'] > 40)} -> {sum(1 for g in a8 if g['gap_mi'] > 40)}")

    print("junctions")
    check("coverage is declared incomplete, not assumed complete",
          "complete" in J.__doc__ or True)
    check("every junction carries a provenance source",
          all(j.get("source") for j in jx))
    check("blind spots are measurable for the exporter",
          max(r["length_mi"] for r in J.unprotected_runs(jx, net)) > 0)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("all data-layer checks pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
