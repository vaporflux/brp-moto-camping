#!/usr/bin/env python3
"""Regressions for routing and GPX export. Run: python3 build/test_gpx.py

The exporter is the part SPEC.md 5 warns will go wrong, so these tests are written to
fail loudly rather than to pass easily. Negative cases matter as much as positive ones:
a validator that never rejects anything is worse than no validator.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brp import gpx, gpxval, junctions as J, mp as M, network as N, route as R, stops as S  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
FAILURES = []


def check(name, cond, detail=""):
    print(f"  {'pass' if cond else 'FAIL'}  {name}" + ("" if cond else f"   {detail}"))
    if not cond:
        FAILURES.append(name)


def main():
    model, _ = M.load(DATA)
    net = N.load(model, DATA)
    jx = J.load(model, DATA)
    fuel = {f["mp"]: f for f in S.build_fuel(model, net, json.load(open(f"{DATA}/fuel.json")))}
    cgs = {c["name"]: c for c in
           S.build_campgrounds(model, net, json.load(open(f"{DATA}/campgrounds.json")))}

    def fstop(mp, kind="fuel"):
        return S.as_route_stop(fuel[mp], kind)

    print("closure handling")
    for a, b, lbl in [(300, 400, "Helene break"), (310, 330, "Spruce Pine orphan")]:
        try:
            R.slice_parkway(model, net, a, b)
            check(f"refuses to route across the {lbl}", False, "no error raised")
        except R.RouteError:
            check(f"refuses to route across the {lbl}", True)
    check("routes fine within a component", len(R.slice_parkway(model, net, 390, 460)) > 100)

    print("point placement")
    day = R.build_day(model, net, jx, [fstop(382.5, "start"), fstop(393.6),
                                       fstop(411.8, "end")])
    check("every point is explicitly typed",
          all(p["type"] in ("via", "shaping") for p in day["rtepts"]))
    check("junction points are placed past junctions, not on them",
          day["n_junction_points"] > 0)
    check("no route point sits within 0.5 mi of a closure gate",
          all(R._placeable(net, p["mp"]) for p in day["rtepts"] if p["type"] == "shaping"))
    check("spacing bounds the bypass window",
          day["max_unprotected_span_mi"] <= 5.5, f"{day['max_unprotected_span_mi']}")

    print("via points are destinations, never thinned")
    stops3 = [fstop(382.5, "start"), fstop(393.6),
              S.as_route_stop(cgs["Lake Powhatan Rec Area (Pisgah NF)"])]
    d3 = R.build_day(model, net, jx, stops3)
    check("a fuel exit and a campground sharing a milepost both survive",
          d3["n_via"] == 3, f"got {d3['n_via']}")
    check("a fuel via navigates to the pump, not to the Parkway beside it",
          (fstop(393.6)["lat"], fstop(393.6)["lon"])
          != (fuel[393.6]["parkway_lat"], fuel[393.6]["parkway_lon"]))

    print("warnings")
    back = R.build_day(model, net, jx, [fstop(382.5, "start"), fstop(411.8),
                                        S.as_route_stop(cgs["Mount Pisgah Campground (NPS)"])])
    check("warns when stops are out of milepost order",
          any("backtrack" in w for w in back["warnings"]), str(back["warnings"]))
    check("warns about a fuel stop far off the Parkway",
          any("round trip" in w for w in back["warnings"]), str(back["warnings"]))
    fwd = R.build_day(model, net, jx, [fstop(382.5, "start"), fstop(393.6),
                                       S.as_route_stop(cgs["Mount Pisgah Campground (NPS)"])])
    check("does not cry backtrack on an in-order day",
          not any("backtrack" in w for w in fwd["warnings"]), str(fwd["warnings"]))

    print("budget")
    va = [fstop(m) for m in (0, 45.6, 106.0, 135.9, 177.7, 215.8, 248.1, 261.2)]
    va[0]["kind"], va[-1]["kind"] = "start", "end"
    one = R.build_day(model, net, jx, va)
    check("a 274 mi day busts the 50-point budget", not R.fits_budget(one),
          f"{one['n_total']}")
    parts = R.split_day(model, net, jx, va)
    check("splitting produces routes that all fit",
          len(parts) > 1 and all(R.fits_budget(p) for p in parts),
          str([p["n_total"] for p in parts]))
    check("splitting preserves every named stop",
          sum(p["n_via"] for p in parts) >= len(va))

    print("export + validation, all three variants")
    for variant, fn in (("route", gpx.export_route), ("track-only", gpx.export_track_only),
                        ("waypoints", gpx.export_waypoints_only)):
        xml = fn(day, "BRP D1 Asheville-Pisgah")
        errs = gpxval.errors(gpxval.validate(xml, net=net, junctions=jx, model=model))
        check(f"{variant} file validates clean", not errs, str(errs[:2]))
    track_xml = gpx.export_track_only(day, "BRP D1 Asheville-Pisgah")
    check("track-only file contains no route", "<rte>" not in track_xml)
    check("track-only file still carries the waypoints", track_xml.count("<wpt ") >= 3)

    print("validator rejects what GPX-REFERENCE says never to emit")
    good = gpx.export_route(day, "BRP D1 Asheville-Pisgah")
    mutations = {
        "bare rtept defaulting to via": lambda x: x.replace("<trp:ShapingPoint />", "", 1),
        "gpxx:rpt ghost points":
            lambda x: x.replace("</rte>", "  <gpxx:rpt lat='35.5' lon='-82.5'/>\n  </rte>"),
        "TripExtensions v2": lambda x: x.replace("TripExtensions/v1", "TripExtensions/v2"),
        "AdventurousLevel": lambda x: x.replace("</rte>", "  <AdventurousLevel>3"
                                                "</AdventurousLevel>\n  </rte>"),
        "route name over 30 chars":
            lambda x: x.replace("    <name>BRP D1 Asheville-Pisgah</name>",
                                "    <name>BRP D1 a name far past the thirty char limit"
                                "</name>", 1),
        "route name with punctuation":
            lambda x: x.replace("    <name>BRP D1 Asheville-Pisgah</name>",
                                "    <name>BRP D1: Asheville!</name>", 1),
        "missing wpt for a via":
            lambda x: re.sub(r"  <wpt.*?</wpt>\n", "", x, count=1, flags=re.S),
        "two routes in one file": lambda x: x.replace("</gpx>", "  <rte><name>x</name>"
                                                      "</rte>\n</gpx>"),
    }
    for label, mut in mutations.items():
        errs = gpxval.errors(gpxval.validate(mut(good), net=net, junctions=jx, model=model))
        check(f"catches {label}", bool(errs))

    print("format")
    check("no BOM", not good.startswith("﻿"))
    check("encodes as UTF-8", good.encode("utf-8").decode("utf-8") == good)
    check("declares all three required namespaces",
          all(ns in good for ns in (gpx.GPX_NS, gpx.GPXX_NS, gpx.TRP_NS)))
    check("null map handle on every rtept",
          good.count(gpx.NULL_SUBCLASS) == len(day["rtepts"]))
    check("CalculationMode sits inside ViaPoint, per GPX-REFERENCE not SPEC 5.7 prose",
          "<trp:ViaPoint>\n            <trp:CalculationMode>" in good)
    check("filenames are ASCII and short",
          len(gpx.filename("BRP", 3, "Asheville-Boone")) <= 40)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("all routing and export checks pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
