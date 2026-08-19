#!/usr/bin/env python3
"""Build the planner data bundle from data/ and write a data-quality report.

Run:  python3 build/derive.py
Out:  data/derived/planner-data.json   single bundle the static page inlines
      data/derived/quality-report.json findings this pass could not resolve

Nothing here touches the network. The deploy stays a single static file with no build
step; this generator runs offline, in the repo, the way v1/build.py did.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from brp import junctions as J
from brp import places as P
from brp import mp as M
from brp import network as N
from brp import stops as S

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
OUT = os.path.join(DATA, "derived")


def loo_accuracy(pts, controls):
    """Held-out milepost accuracy. Interpolating through the knots gives zero residual
    by construction and says nothing, so report leave-one-out instead."""
    from brp import geo
    arc = geo.arc_cumulative(pts)
    errs = []
    for k in range(1, len(controls) - 1):
        sub = [c for j, c in enumerate(controls) if j != k]
        pred = M.MilepostModel(pts, sub).mp_at_arc(controls[k]["arc"])
        errs.append(abs(pred - controls[k]["mp"]))
    return {
        "n_held_out": len(errs),
        "mean_abs_mi": round(sum(errs) / len(errs), 3) if errs else None,
        "max_abs_mi": round(max(errs), 3) if errs else None,
    }


def main():
    os.makedirs(OUT, exist_ok=True)
    model, rejected = M.load(DATA)
    net = N.load(model, DATA)
    jx = J.load(model, DATA)

    campgrounds = S.build_campgrounds(model, net, json.load(open(f"{DATA}/campgrounds.json")))
    osm = P.load_osm(DATA)
    all_places = P.build(model, net, json.load(open(f"{DATA}/campgrounds.json")), osm)
    fuel = S.build_fuel(model, net, json.load(open(f"{DATA}/fuel.json")))
    closures_raw = json.load(open(f"{DATA}/closures.json"))

    bundle = {
        "schema": 2,
        "generated_from": {
            "closures_as_of": closures_raw["as_of"],
            "closures_source": closures_raw["source"],
        },
        "milepost_model": {
            "method": "chord->arc recovery, then monotone piecewise-linear calibration",
            "controls": [{k: v for k, v in c.items() if k != "arc"} for c in model.controls],
            "accuracy": loo_accuracy(model.pts, model.controls),
            "coverage_gaps_mi": model.coverage_gaps(),
        },
        "segments": [s.to_dict() for s in net.segments],
        "segment_geometry": [s.pts for s in net.segments],
        "components": {str(k): v for k, v in net.components.items()},
        "dead_ends": net.spurs,
        "closures": [{k: v for k, v in c.items() if k != "members"} for c in net.closures],
        "campgrounds": campgrounds,
        "fuel": fuel,
        "junctions": jx,
        "junction_coverage": {
            "count": len(jx),
            "mean_spacing_mi": round(469.1 / len(jx), 2),
            "complete": False,
            "note": ("Derived from published fuel-exit lists and closure detours only. "
                     "The Parkway meets many roads that sell no fuel; those crossings "
                     "are absent. OSM relation 55450 is the correct source and was "
                     "unreachable from this build (egress policy blocks overpass-api.de)."),
            "blind_spots": J.unprotected_runs(jx, net)[:10],
        },
        "fuel_gaps": {
            "any_detour": S.fuel_gaps(fuel, net),
            "max_8mi_detour": S.fuel_gaps(fuel, net, max_detour_mi=8),
        },
    }
    with open(f"{OUT}/planner-data.json", "w") as f:
        json.dump(bundle, f, separators=(",", ":"))

    report = {
        "milepost_model": {
            "shipped_model_error_vs_controls_mi": {"mean": 1.85, "max": 3.58},
            "calibrated_leave_one_out_mi": bundle["milepost_model"]["accuracy"],
            "caveat": ("No interior control exists between MP 0 and 177.7, so Virginia "
                       "mileposts are interpolated between the terminus and Meadows of "
                       "Dan. Error there is unmeasured, not zero."),
            "rejected_controls": rejected,
        },
        "fuel_distance_conflicts": [
            {"mp": f["mp"], "confidence": f["confidence"], "town": f["town"],
             "straight_line_mi": f["straight_line_mi"], "published_mi": f["published_mi"],
             "issue": "crow-flies distance exceeds published road distance; "
                      "OSM likely missed a nearer station or the anchor is misplaced"}
            for f in fuel if f["distance_conflict"]
        ],
        "stops_blocked_from_parkway": [
            {"kind": s["kind"], "name": s.get("name") or s.get("town"), "mp": s["mp"],
             "access_class": s["access_class"],
             "closure": s["blocking_closure"]}
            for s in campgrounds + fuel if s["access_class"] != S.ACCESS_EN_ROUTE
        ],
        "parkway_segs_json": ("Superseded. It was cut using the uncalibrated milepost "
                              "model, placing every gate 2-3 mi from the NPS milepost. "
                              "planner-data.json re-cuts from closures.json instead."),
        "va_fuel_anchors": ("All 13 shipped parkway_lat/lon values were exact centerline "
                            "vertices, i.e. generated by walking the uncalibrated model "
                            "rather than surveyed. All 29 anchors are now recomputed "
                            "under the calibrated model."),
    }
    with open(f"{OUT}/quality-report.json", "w") as f:
        json.dump(report, f, indent=1)

    # Browser bundle. Ships the per-vertex milepost array so the client does not have to
    # redo the chord->arc calibration in JavaScript -- the model is decided here, once,
    # and the page consumes its output. Coordinates round to 5 dp (~1.1 m), well under
    # the milepost model's own 0.34 mi resolution.
    r5 = lambda v: round(v, 5)
    browser = {
        "schema": bundle["schema"],
        "as_of": closures_raw["as_of"],
        "closures_source": closures_raw["source"],
        "parkway": [[r5(p[0]), r5(p[1])] for p in model.pts],
        "parkway_mp": [round(model.mp_at_index(i), 3) for i in range(len(model.pts))],
        "segments": bundle["segments"],
        "segment_geometry": [[[r5(p[0]), r5(p[1])] for p in s.pts] for s in net.segments],
        "components": bundle["components"],
        "dead_ends": bundle["dead_ends"],
        "closures": bundle["closures"],
        "campgrounds": campgrounds,
        "places": all_places,
        "places_summary": P.summary(all_places),
        "has_osm": osm is not None,
        "fuel": fuel,
        "junctions": jx,
        "junction_coverage": bundle["junction_coverage"],
        "milepost_accuracy": bundle["milepost_model"]["accuracy"],
        "milepost_coverage_gaps": bundle["milepost_model"]["coverage_gaps_mi"],
    }
    with open(f"{OUT}/browser-data.json", "w") as f:
        json.dump(browser, f, separators=(",", ":"))
    print(f"browser-data.json   {os.path.getsize(f'{OUT}/browser-data.json')/1024:.0f} KB")

    size = os.path.getsize(f"{OUT}/planner-data.json")
    print(f"planner-data.json   {size/1024:.0f} KB")
    print(f"  places {len(all_places)} "
          f"({'with OSM' if osm else 'curated only — run build/fetch_osm.py to expand'})")
    print(f"  segments {len(net.segments)}  components {len(net.components)}  "
          f"campgrounds {len(campgrounds)}  fuel {len(fuel)}  junctions {len(jx)}")
    print(f"  milepost LOO accuracy: {bundle['milepost_model']['accuracy']}")
    print(f"quality-report.json  {len(report['fuel_distance_conflicts'])} distance conflicts, "
          f"{len(report['stops_blocked_from_parkway'])} stops not reachable from the Parkway")


if __name__ == "__main__":
    main()
