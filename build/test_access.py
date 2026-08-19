#!/usr/bin/env python3
"""Regressions for access-point choice and per-bike fuel planning.
Run: python3 build/test_access.py
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from brp import access as A, junctions as J, mp as M, network as N, stops as S  # noqa: E402

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
    fuel = S.build_fuel(model, net, json.load(open(f"{DATA}/fuel.json")))
    cgs = {c["name"]: c for c in
           S.build_campgrounds(model, net, json.load(open(f"{DATA}/campgrounds.json")))}

    def charlotte_pt():
        return (35.2271, -80.8431)

    print("access points")
    pts = A.access_points(model, net, jx)
    check("every access point is on open Parkway",
          all(net.segment_at_mp(p["mp"]) is not None for p in pts))
    # Strictly inside, not on the boundary. A gate milepost belongs to the open side:
    # MP 317.5 Linville Falls is both the last exit before the Helene closure and the
    # closure's first milepost, and it is exactly where a southbound rider must fill up.
    check("none sits strictly inside a severing closure",
          not any(any(c["severs"] and c["from_mp"] < p["mp"] < c["to_mp"]
                      for c in net.closures) for p in pts))
    check("both termini are usable entries",
          any(p["mp"] == 0.0 for p in pts) and any(abs(p["mp"] - 469.1) < 0.2 for p in pts))

    print("access mode: a Parkway trip should ride the Parkway")
    cherokee = 469.0
    soonest = A.best_access_points(model, net, jx, charlotte_pt(), cherokee, 3, "soonest")[0]
    shortest = A.best_access_points(model, net, jx, charlotte_pt(), cherokee, 3, "shortest")[0]
    check("'shortest' really does minimise total miles",
          shortest["total_mi"] <= soonest["total_mi"] + 1e-6)
    check("'shortest' can collapse the ride to almost no Parkway",
          shortest["parkway_mi"] < 1.0, f"{shortest['parkway_mi']} mi")
    check("'soonest' is the default and keeps the Parkway miles",
          soonest["parkway_mi"] > 50, f"{soonest['parkway_mi']} mi")
    check("'soonest' minimises the ride in, not the total",
          soonest["approach_mi"] <= shortest["approach_mi"] + 1e-6)
    default = A.best_access_points(model, net, jx, charlotte_pt(), cherokee)[0]
    check("the default ordering is 'soonest'", default["mp"] == soonest["mp"])

    print("access choice beats the naive nearest on-ramp")
    charlotte = (35.2271, -80.8431)
    pisgah = cgs["Mount Pisgah Campground (NPS)"]["mp"]
    ranked = A.best_access_points(model, net, jx, charlotte, pisgah, 3, "shortest")
    best = ranked[0]
    nearest = min(pts, key=lambda p: A.approach_mi(charlotte, (p["lat"], p["lon"])))
    naive = A.approach_mi(charlotte, (nearest["lat"], nearest["lon"])) + abs(pisgah - nearest["mp"])
    check("total journey beats nearest-on-ramp by a wide margin",
          best["total_mi"] < naive - 50, f"best {best['total_mi']} vs naive {naive:.0f}")
    check("'shortest' results are ordered by total journey",
          [r["total_mi"] for r in ranked] == sorted(r["total_mi"] for r in ranked))
    soon = A.best_access_points(model, net, jx, charlotte, pisgah, 3, "soonest")
    check("'soonest' results are ordered by ride-in distance",
          [r["approach_mi"] for r in soon] == sorted(r["approach_mi"] for r in soon))
    check("total is approach plus Parkway",
          all(abs(r["total_mi"] - (r["approach_mi"] + r["parkway_mi"])) < 0.11 for r in ranked))

    print("access choice respects the severed Parkway")
    orphan_dest = 330.9   # inside the Spruce Pine orphan component
    orphan_rank = A.best_access_points(model, net, jx, charlotte, orphan_dest)
    check("only same-component access points are offered",
          all(r["component"] == net.segment_at_mp(orphan_dest).component for r in orphan_rank))
    try:
        A.best_access_points(model, net, jx, charlotte, 340.0)   # inside a Helene closure
        check("a destination inside a closure is rejected", False, "no error raised")
    except ValueError:
        check("a destination inside a closure is rejected", True)

    print("fuel planning scales with the bike, not a hardcoded GSA")
    runs = {t: A.plan_fuel(fuel, 382.5, 469.1, t, approach_leg_mi=40, component=2,
                           max_detour_mi=8) for t in (300, 200, 120, 80)}
    check("all four tanks produce a workable plan", all(r["ok"] for r in runs.values()))
    counts = [len(runs[t]["stops"]) for t in (300, 200, 120, 80)]
    check("a smaller tank never needs fewer stops", counts == sorted(counts), str(counts))
    check("a 300 mi tank needs no stop on an 87 mi run", counts[0] == 0)
    check("an 80 mi tank does need stops", counts[-1] >= 1)
    check("the reserve is withheld from the planning range",
          abs(runs[200]["planning_range_mi"] - 180.0) < 0.01)

    print("the approach leg is advice, not a fuel constraint")
    # This dataset maps fuel at Parkway exits only. A 137 mi ride in from Charlotte passes
    # dozens of unmapped gas stations, so charging it against the tank reported "you
    # cannot make it" for trips any rider completes by filling up on the way.
    far = A.plan_fuel(fuel, 393.6, 408.6, 60, approach_leg_mi=137, component=2,
                      max_detour_mi=8)
    check("a long approach does not fail a short Parkway run", far["ok"],
          far.get("error", ""))
    check("the Parkway distance is reported separately from the approach",
          far["parkway_mi"] == 15.0 and far["approach_mi"] == 137.0,
          f"parkway {far.get('parkway_mi')} approach {far.get('approach_mi')}")
    check("a long approach still produces a warning note",
          any("fuel on the way" in n for n in far["notes"]), str(far["notes"]))
    near = A.plan_fuel(fuel, 393.6, 408.6, 60, approach_leg_mi=5, component=2,
                       max_detour_mi=8)
    check("a short approach produces no such note",
          not any("fuel on the way" in n for n in near["notes"]), str(near["notes"]))

    print("fuel planning refuses rather than guessing")
    # Long Parkway run, small tank, and the only mid-gap exit excluded by detour limit.
    tiny = A.plan_fuel(fuel, 393.6, 469.1, 40, component=2, max_detour_mi=8)
    check("an unreachable plan fails explicitly", not tiny["ok"])
    check("the failure explains the shortfall in miles",
          "shortfall_mi" in tiny or "range" in tiny["error"])
    check("zero tank is rejected", not A.plan_fuel(fuel, 382.5, 469.1, 0)["ok"])

    print("a detour burns range in both directions")
    # Leaving a pump that sits D miles off the Parkway, the rider has a full tank minus
    # the ride back. So arriving at the destination they should hold
    #   planning_range - D - (remaining Parkway miles after the stop).
    plan = A.plan_fuel(fuel, 0.0, 200.0, 90, component=0, max_detour_mi=8)
    check("a mid-Virginia run needs at least one stop", plan["ok"] and len(plan["stops"]) >= 1)
    if plan["ok"] and plan["stops"]:
        last = plan["stops"][-1]
        expected = plan["planning_range_mi"] - last["detour_mi"] - (200.0 - last["pos"])
        check("arrival range charges the ride back out of the detour",
              abs(plan["arrive_with_mi"] - expected) < 0.05,
              f"got {plan['arrive_with_mi']} expected {expected:.1f}")
        check("the stop actually carries a detour cost", last["detour_mi"] > 0)

    print("greedy picks the furthest reachable pump")
    if plan["ok"] and plan["stops"]:
        first = plan["stops"][0]
        skipped = [f for f in fuel
                   if A._usable(f, 8) and f.get("component") == 0
                   and first["mp"] < f["mp"] <= 200.0
                   and (f["mp"] - 0.0) + (f.get("detour_plan_mi") or 0) <= plan["planning_range_mi"]]
        check("no reachable pump was passed by on the first leg", not skipped,
              str([f["mp"] for f in skipped]))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("all access and fuel-planning checks pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
