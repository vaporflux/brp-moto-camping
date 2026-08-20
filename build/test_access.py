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

    # The top-off is an instruction given before the rider joins, not a stop on the
    # Parkway, so every entry in `stops` is a stop the tank forced. This helper stays as a
    # guard: if a top-off ever leaks back into the stop list, these counts catch it.
    def forced(plan):
        return [x for x in plan["stops"] if not x.get("top_off")]

    print("fuel planning scales with the bike, not a hardcoded GSA")
    runs = {t: A.plan_fuel(fuel, 382.5, 469.1, t, approach_leg_mi=40, component=2,
                           max_detour_mi=8) for t in (300, 200, 120, 80)}
    check("all four tanks produce a workable plan", all(r["ok"] for r in runs.values()))
    counts = [len(forced(runs[t])) for t in (300, 200, 120, 80)]
    check("a smaller tank never needs fewer stops", counts == sorted(counts), str(counts))
    check("a 300 mi tank needs no stop beyond the top-off on an 87 mi run", counts[0] == 0)
    check("an 80 mi tank does need stops", counts[-1] >= 1)
    check("every plan tells the rider to fill up before joining",
          all(r.get("top_off") for r in runs.values()))
    check("and it is pinned to the access point, not to a pump on the Parkway",
          all(r["top_off"]["access_mp"] == 382.5 for r in runs.values()),
          str([r["top_off"]["access_mp"] for r in runs.values()]))
    check("it is not a stop, so it costs no detour and no Parkway miles",
          all(not any(x.get("top_off") for x in r["stops"]) for r in runs.values()))
    check("the advice says there is no fuel on the Parkway",
          all(any("no fuel on the Parkway" in n for n in r["notes"])
              for r in runs.values()))
    # No abstract safety percentage by default: "miles on a tank" is already a rider's
    # conservative real-world figure, and the exit-fuel rule below provides a concrete
    # margin -- enough range at camp to reach the next pump -- which is worth more than a
    # round number held back. The parameter still exists for anyone who wants one.
    check("by default the full tank is planning range",
          abs(runs[200]["planning_range_mi"] - 200.0) < 0.01,
          str(runs[200]["planning_range_mi"]))
    held = A.plan_fuel(fuel, 382.5, 469.1, 200, component=2, max_detour_mi=8,
                       reserve_frac=0.10)
    check("an explicit reserve is still honoured",
          abs(held["planning_range_mi"] - 180.0) < 0.01, str(held["planning_range_mi"]))

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

    print("arriving with enough fuel to get back out")
    need, where = A.exit_reserve_mi(fuel, 408.6, 2, 8)
    check("a Parkway campsite knows how far the nearest pump is",
          need is not None and need > 0, str(need))
    check("it picks the cheapest way back to fuel, either direction",
          where["mp"] == 393.6, str(where and where["mp"]))
    # A tank that only just reaches camp must be rejected: arriving empty at a campsite
    # with no fuel for 18 miles is not a plan.
    bare = A.plan_fuel(fuel, 382.5, 408.6, 32, component=2, max_detour_mi=8,
                       require_exit_fuel=False)
    guarded = A.plan_fuel(fuel, 382.5, 408.6, 32, component=2, max_detour_mi=8)
    check("without the rule, a just-barely tank looks fine", bare["ok"])
    check("with the rule, the same tank is caught",
          not guarded["ok"] or len(forced(guarded)) > len(forced(bare)),
          f"bare {bare['ok']}/{len(bare['stops'])} guarded {guarded['ok']}/{len(guarded['stops'])}")
    roomy = A.plan_fuel(fuel, 382.5, 408.6, 200, component=2, max_detour_mi=8)
    check("a roomy tank needs no stop beyond the top-off",
          roomy["ok"] and not forced(roomy))
    check("the plan says what the withheld range is for",
          any("keeps that much in the tank" in n for n in roomy["notes"]),
          str(roomy["notes"]))

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

    print("a journey is simulated end to end, not leg by leg")
    # A campsite sells no fuel: the rider leaves camp with exactly what they arrived on.
    # Planning each leg from a full tank refuels the bike overnight and produces a plan
    # that fails on the way home.
    rt = A.plan_journey(fuel, [382.5, 443.1, 382.5], 200, component=2, max_detour_mi=8)
    check("a round trip plans as one journey", rt["ok"])
    check("its distance counts both directions",
          abs(rt["parkway_mi"] - 2 * (443.1 - 382.5)) < 0.2, str(rt["parkway_mi"]))
    tanks = [t["tank_mi"] for t in rt["tank_at"]]
    check("the tank is tracked at every waypoint", len(tanks) == 3, str(tanks))
    check("the tank falls across the overnight rather than refilling",
          tanks[0] > tanks[1] > tanks[2], str(tanks))
    thin = A.plan_journey(fuel, [382.5, 443.1, 382.5], 130, component=2, max_detour_mi=8)
    per_leg = A.plan_journey(fuel, [382.5, 443.1], 130, component=2, max_detour_mi=8)
    check("planning one leg at a time hides what the return costs",
          len(per_leg["stops"]) <= len(thin["stops"]),
          f"leg {len(per_leg['stops'])} vs journey {len(thin['stops'])}")

    print("choosing where to come off the Parkway")
    home = charlotte_pt()
    outs = A.best_exit_points(model, net, jx, home, 443.1)
    check("exit points are ranked by how short the ride off is",
          [o["ride_out_mi"] for o in outs] == sorted(o["ride_out_mi"] for o in outs))
    check("exits stay in the same component as the rider",
          all(o["component"] == net.segment_at_mp(443.1).component for o in outs))

    print("a severed Parkway explains itself")
    # Knoxville sits closer to the Cherokee end than to anywhere else on the Parkway, but
    # the Helene closures put Cherokee in a different component. For a stop north of the
    # break the planner must send the rider the long way round, and it has to say why.
    KNOX = (35.9606, -83.9207)
    north = A.best_access_points(model, net, jx, KNOX, 317.4, top_n=1)[0]
    south = A.best_access_points(model, net, jx, KNOX, 382.6, top_n=1)[0]
    check("a stop north of the break enters north of it",
          north["mp"] == 317.5, str(north["mp"]))
    check("even though the ride in is far longer",
          north["approach_mi"] > 140, str(north["approach_mi"]))
    check("the nearer entrance it could not use is named",
          north["severed_alternative"] and north["severed_alternative"]["mp"] == 469.1,
          str(north["severed_alternative"]))
    check("and how much it would have saved",
          north["severed_alternative"]["saved_mi"] > 80,
          str(north["severed_alternative"]))
    check("a stop south of the break does use Cherokee",
          south["mp"] == 469.1, str(south["mp"]))
    check("and carries no explanation, because none is owed",
          south["severed_alternative"] is None, str(south["severed_alternative"]))

    print("arriving with fuel still in the tank")
    # The trip that prompted this: greedy planning routed a rider into a station on 0.8 mi
    # of range. Correct arithmetic, useless advice.
    wp = [291.8, 13.7, 291.8]
    bare = A.plan_journey(fuel, wp, tank_mi=200, max_detour_mi=8, component=0)
    # Not pinned to an exact figure: the fuel set grows as verification runs, and the
    # claim is about the shape of greedy planning, not about one number.
    check("the top-off is advice, not an entry in the stop list",
          bare.get("top_off") and not any(x.get("top_off") for x in bare["stops"]))
    check("with no buffer, a stop is reached on less than the default 10 mi",
          min(s["arrive_tank_mi"] for s in forced(bare)) < 10,
          str(min(s["arrive_tank_mi"] for s in forced(bare))))

    for want in (10, 25, 50):
        got = A.plan_journey(fuel, wp, tank_mi=200, max_detour_mi=8, component=0,
                             arrive_min_mi=want)
        check(f"a {want} mi buffer is honoured at every stop",
              got["ok"] and all(s["arrive_tank_mi"] >= want - 0.05 for s in forced(got)),
              str([s["arrive_tank_mi"] for s in forced(got)]))

    ten = A.plan_journey(fuel, wp, tank_mi=200, max_detour_mi=8, component=0,
                         arrive_min_mi=10)
    fifty = A.plan_journey(fuel, wp, tank_mi=200, max_detour_mi=8, component=0,
                           arrive_min_mi=50)
    # More buffer means less usable tank, which means more stops. Never fewer.
    check("a bigger buffer never means fewer stops",
          len(bare["stops"]) <= len(ten["stops"]) <= len(fifty["stops"]),
          f"{len(bare['stops'])} -> {len(ten['stops'])} -> {len(fifty['stops'])}")
    check("the buffer is reported back", ten["arrive_min_mi"] == 10.0)
    check("the tank figure at camp includes it",
          ten["tank_at"][1]["tank_mi"] >= 10)
    # A buffer that swallows the tank is a contradiction, not a plan.
    absurd = A.plan_journey(fuel, wp, tank_mi=200, max_detour_mi=8, component=0,
                            arrive_min_mi=200)
    check("a buffer as big as the tank is refused, with a reason",
          not absurd["ok"] and "nothing to ride" in absurd["error"], str(absurd.get("error")))

    print("a round trip puts fuel stops on the leg they belong to")
    # Abingdon to Devils Backbone and home: 556 mi of Parkway, entering and leaving at
    # MP 291.8 and camping at MP 13.7. Its two fuel stops fall at mile 186 and mile 378 --
    # one outbound, one homeward. Rendered as a flat list they read as two stops twelve
    # miles apart, and they hid the fact that there IS fuel after camp.
    rt = A.plan_journey(fuel, [291.8, 13.7, 291.8], tank_mi=200,
                        max_detour_mi=8, component=0)
    check("the round trip plans", rt["ok"], rt.get("error"))
    check("it measures both directions", abs(rt["parkway_mi"] - 556.2) < 1,
          str(rt["parkway_mi"]))
    check("waypoint positions are reported", len(rt["waypoint_pos"]) == 3,
          str(rt.get("waypoint_pos")))
    camp_pos = rt["waypoint_pos"][1]
    outbound = [s for s in rt["stops"] if s["pos"] <= camp_pos]
    homeward = [s for s in rt["stops"] if s["pos"] > camp_pos]
    check("one fuel stop is on the way out", len(outbound) == 1, str(len(outbound)))
    check("and one is on the way home", len(homeward) == 1, str(len(homeward)))
    # Same milepost region, 193 miles apart in riding. Ordering by milepost would put them
    # side by side; ordering by journey position keeps them where they happen.
    check("they are far apart in riding, not in milepost",
          homeward[0]["pos"] - outbound[0]["pos"] > 150,
          f"{outbound[0]['pos']:.1f} -> {homeward[0]['pos']:.1f}")
    check("the rider leaves camp on what they arrived with, then refuels",
          rt["tank_at"][1]["tank_mi"] < 200 and rt["tank_at"][2]["tank_mi"] > 0,
          str(rt["tank_at"]))

    print("greedy picks the furthest reachable pump")
    # Greedy is the right rule once the tank is a known quantity, which is true from the
    # top-off onward and not before it. So the claim is about the leg AFTER the top-off:
    # from there, on a full tank, nothing reachable should have been ridden past.
    if plan["ok"] and plan["stops"]:
        first = plan["stops"][0]
        skipped = [f for f in fuel
                   if A._usable(f, 8) and f.get("component") == 0
                   and first["mp"] < f["mp"] <= 200.0
                   and (f["mp"] - 0.0) + (f.get("detour_plan_mi") or 0)
                       <= plan["planning_range_mi"]]
        check("no reachable pump was passed by on the first leg", not skipped,
              str([f["mp"] for f in skipped]))
    # The named fallback is for a rider who reaches the Parkway low anyway. It is the
    # nearest mapped pump to the access point, measured the way exit fuel is.
    check("the fallback pump is the nearest one to where you join",
          plan["top_off"]["nearest_mi"]
          == A.exit_reserve_mi(fuel, 0.0, 0, 8)[0],
          str(plan["top_off"]))
    without = A.plan_fuel(fuel, 0.0, 200.0, 90, component=0, max_detour_mi=8, top_off=False)
    check("it can be switched off", without["ok"] and not without.get("top_off"))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: {FAILURES}")
        return 1
    print("all access and fuel-planning checks pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
