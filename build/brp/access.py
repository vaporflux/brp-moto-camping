"""Getting onto the Parkway, and staying fuelled once you are.

Two problems the planner did not previously solve:

1. A rider does not start on the Parkway. They start at a house 10-100 miles away and
   need to know which access point to aim for. The naive answer -- nearest on-ramp -- is
   often wrong: if you live north of the Parkway and your campsite is at MP 400, the
   nearest access is MP 0 and it costs you 400 Parkway miles. The right answer minimises
   the WHOLE journey, approach plus Parkway, which is what best_access_points does.

2. Fuel range is per-bike. SPEC 2.4 frames the constraint around a GSA's ~300 mile tank,
   but the constraint is really "how far can THIS rider go between fill-ups", and the
   Parkway itself sells no fuel at all. plan_fuel takes the rider's number and works out
   where they must stop, or proves they cannot make it.

Off-Parkway distances here are ESTIMATES. There is no routing engine in this build (the
public ones are unreachable and a static site should not depend on one anyway), so
approach legs use straight-line distance times a road factor. The factor is not invented:
it is the median ratio of published road distance to straight-line distance across the 28
fuel records that carry both numbers. Every figure derived from it is labelled as an
estimate, and the device computes the real road route at ride time.
"""
from . import geo

# Median published-road / straight-line ratio across the fuel dataset (n=28). The spread
# is wide (0.15-3.57), so this is a planning estimate and never presented as a distance.
ROAD_FACTOR = 1.36


def approach_mi(start, point):
    """Estimated road miles from an arbitrary start to a point on the Parkway."""
    return geo.haversine(start, point) * ROAD_FACTOR


def access_points(model, net, junctions):
    """Every place a rider can join the Parkway, with the component it lands them in.

    These are the 29 published highway crossings plus the closure detour roads plus both
    termini. A crossing inside a severing closure is not an access point -- joining there
    puts you on a stretch you cannot ride out of.
    """
    pts = []
    for j in junctions:
        seg = net.segment_at_mp(j["mp"])
        if seg is None:
            continue
        pts.append({"mp": j["mp"], "name": j["road"], "lat": j["lat"], "lon": j["lon"],
                    "component": seg.component, "source": j["source"]})
    for mp, name in ((0.0, "Rockfish Gap (northern terminus)"),
                     (469.1, "Cherokee US 441 (southern terminus)")):
        seg = net.segment_at_mp(mp)
        if seg is None or any(abs(p["mp"] - mp) < 0.2 for p in pts):
            continue
        lat, lon = model.coord_at_mp(mp)
        pts.append({"mp": mp, "name": name, "lat": lat, "lon": lon,
                    "component": seg.component, "source": "terminus"})
    pts.sort(key=lambda p: p["mp"])
    return pts


def best_access_points(model, net, junctions, start, dest_mp, top_n=3, mode="soonest"):
    """Rank the places a rider could join the Parkway.

    Two orderings, because they answer different questions and the difference is large:

      "soonest"  -- least road miles before you are on the Parkway. This is the default,
                    because someone planning a Parkway trip wants to BE on the Parkway;
                    the ride in is overhead to be minimised, and the Parkway miles are
                    the point of the trip.
      "shortest" -- least total miles, approach plus Parkway. This is what you want when
                    the Parkway is incidental and the campsite is the goal.

    The difference is not academic. From Charlotte to the Cherokee end, "shortest" enters
    at MP 469.1 and rides one tenth of a mile of Parkway -- technically optimal, useless
    as a ride. "soonest" enters near Asheville and rides 80 miles of it.

    Returns several rather than one: the numbers are estimates, and a rider may prefer
    another for reasons this cannot see -- a road they like, a town they want breakfast in.
    """
    dest_seg = net.segment_at_mp(dest_mp)
    if dest_seg is None:
        raise ValueError(f"MP {dest_mp} is not on open Parkway in 2026")

    ranked = []
    for p in access_points(model, net, junctions):
        # An access point in another component cannot reach the destination on the
        # Parkway at all -- the Helene closures severed it into three pieces.
        if p["component"] != dest_seg.component:
            continue
        approach = approach_mi(start, (p["lat"], p["lon"]))
        parkway = abs(dest_mp - p["mp"])
        ranked.append({**p, "approach_mi": round(approach, 1),
                       "parkway_mi": round(parkway, 1),
                       "total_mi": round(approach + parkway, 1)})
    key = (lambda r: (r["approach_mi"], r["total_mi"])) if mode == "soonest" \
        else (lambda r: r["total_mi"])
    ranked.sort(key=key)
    return ranked[:top_n]


def _usable(f, max_detour_mi):
    if f["plan_grade"] not in ("usable", "usable_via_detour", "unconfirmed"):
        return False
    if max_detour_mi is not None and f.get("detour_plan_mi") is not None:
        return f["detour_plan_mi"] <= max_detour_mi
    return True


def plan_fuel(fuel, access_mp, dest_mp, tank_mi, approach_leg_mi=0.0,
              reserve_frac=0.10, full_at_access=True, max_detour_mi=None, component=None):
    """Where this rider must stop for fuel, given the range of their bike.

    Greedy furthest-reachable, which is optimal for refuelling to full along a line: at
    every step, ride as far as you can still reach a pump from, and fill there.

    Reaching a pump costs the detour off the Parkway and back, and both halves burn fuel.
    You arrive at the station having spent the ride out, and leave with a full tank minus
    the ride back -- so a 15-mile detour costs 30 miles of range, not 15. That asymmetry
    is exactly what makes MP 411.8 Wagon Road Gap a trap rather than a convenience.

    The approach leg does NOT consume range. This dataset maps fuel at Parkway exits and
    nothing else, so it knows nothing about the gas stations between a rider's house and
    the Parkway -- and there are plenty. Charging a 136-mile approach against the tank
    would report "you cannot make it" for a trip any rider completes by filling up on the
    way in. Instead the approach produces advice, and the Parkway calculation starts at
    the access point with a full tank.

    Returns the stops, and on failure the specific gap that cannot be crossed.
    """
    if tank_mi <= 0:
        return {"ok": False, "stops": [], "error": "Set a tank range first."}

    planning_range = tank_mi * (1.0 - reserve_frac)
    forward = dest_mp >= access_mp
    direction = 1 if forward else -1

    exits = []
    for f in fuel:
        if not _usable(f, max_detour_mi):
            continue
        if component is not None and f.get("component") != component:
            continue
        between = (access_mp <= f["mp"] <= dest_mp) if forward else (dest_mp <= f["mp"] <= access_mp)
        if not between:
            continue
        exits.append({
            "mp": f["mp"], "town": f.get("town"), "road": f.get("exit_road"),
            "detour_mi": f.get("detour_plan_mi") or 0.0,
            "grade": f["plan_grade"], "confidence": f.get("confidence"),
            "pos": direction * (f["mp"] - access_mp),
        })
    exits.sort(key=lambda e: e["pos"])

    dest_pos = abs(dest_mp - access_mp)
    pos = 0.0
    remaining = planning_range
    stops, notes = [], []

    if not full_at_access:
        notes.append("Planning as though you join the Parkway on a partial tank.")
    if approach_leg_mi > planning_range:
        notes.append(f"Your ride in is about {approach_leg_mi:.0f} mi, longer than your "
                     f"{planning_range:.0f} mi range, so you will need fuel on the way. "
                     f"This planner only maps fuel at Parkway exits, so top up before you "
                     f"reach MP {access_mp}.")
    elif approach_leg_mi > planning_range * 0.6:
        notes.append(f"Your ride in is about {approach_leg_mi:.0f} mi. Start the Parkway "
                     f"with a full tank — there is no fuel on it anywhere.")

    guard = 0
    while dest_pos - pos > remaining:
        guard += 1
        if guard > 100:
            return {"ok": False, "stops": stops, "error": "Could not converge on a fuel plan."}
        reachable = [e for e in exits
                     if e["pos"] > pos + 1e-9
                     and (e["pos"] - pos) + e["detour_mi"] <= remaining]
        if not reachable:
            ahead = [e for e in exits if e["pos"] > pos + 1e-9]
            nxt = ahead[0] if ahead else None
            need = ((nxt["pos"] - pos) + nxt["detour_mi"]) if nxt else (dest_pos - pos)
            where = (f"MP {nxt['mp']} ({nxt['town']})" if nxt else "the destination")
            return {
                "ok": False, "stops": stops,
                "error": (f"Out of range. From here you need about {need:.0f} mi to reach "
                          f"{where}, but you only have {remaining:.0f} mi of planning "
                          f"range. Carry fuel, raise your tank range, or accept a longer "
                          f"detour."),
                "shortfall_mi": round(need - remaining, 1),
            }
        stop = max(reachable, key=lambda e: e["pos"])
        stops.append({**stop, "arrive_with_mi": round(remaining - (stop["pos"] - pos) - stop["detour_mi"], 1)})
        pos = stop["pos"]
        # Full tank, minus the ride back out to the Parkway.
        remaining = planning_range - stop["detour_mi"]

    return {
        "ok": True, "stops": stops, "notes": notes,
        "arrive_with_mi": round(remaining - (dest_pos - pos), 1),
        "planning_range_mi": round(planning_range, 1),
        "parkway_mi": round(dest_pos, 1),
        "approach_mi": round(approach_leg_mi, 1),
        "total_mi": round(dest_pos + approach_leg_mi, 1),
    }
