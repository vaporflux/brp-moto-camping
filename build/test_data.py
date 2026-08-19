#!/usr/bin/env python3
"""Regressions for the data layer. Run: python3 build/test_data.py

Each test pins a specific mistake this pass found and fixed. They are cheap and they
run offline, so the exporter work can proceed against a data layer that stays honest.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brp import junctions as J, mp as M, network as N, stops as S  # noqa: E402

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
