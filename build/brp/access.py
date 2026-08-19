"""Getting onto the Parkway, staying fuelled on it, and getting off at the right place.

Three problems the planner has to solve that the Parkway datasets do not answer directly:

1. A rider does not start on the Parkway. They start at a house 10-100 miles away and need
   to know which access point to aim for. The answer is the nearest entry that can actually
   reach their destination -- nearest, not cleverest, because the point of the trip is to
   BE on the Parkway and the ride in is overhead.

2. Fuel range is per-bike, and the Parkway sells no fuel anywhere along its 469 miles.
   Where a rider must come off is a function of their tank, not of an assumed GSA.

3. A journey is not one leg. Home to camp to home again reverses direction, and a campsite
   sells no fuel either -- so the rider leaves camp with exactly what they arrived on.
   Planning each leg from a full tank quietly refuels the bike overnight and produces a
   plan that fails on day two.

Off-Parkway distances here are ESTIMATES. There is no routing engine in this build (the
public ones are unreachable, and a static site that must work with no signal should not
depend on one), so approach and exit legs use straight-line distance times a road factor.
The factor is not invented: it is the median ratio of published road distance to
straight-line distance across the 28 fuel records that carry both numbers. Every figure
derived from it is labelled an estimate, and the device computes the real route at ride
time.
"""
from . import geo

# Median published-road / straight-line ratio across the fuel dataset (n=28). The spread is
# wide (0.15-3.57), so this is a planning estimate and never presented as a distance.
ROAD_FACTOR = 1.36


def approach_mi(start, point):
    """Estimated road miles between an arbitrary point and a point on the Parkway."""
    return geo.haversine(start, point) * ROAD_FACTOR


def access_points(model, net, junctions):
    """Every place a rider can join or leave the Parkway, with the component it sits in.

    These are the published highway crossings plus the closure detour roads plus both
    termini. A crossing strictly inside a severing closure is not one: joining there puts
    you on a stretch you cannot ride out of.
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
    """Rank the places a rider could join the Parkway to reach dest_mp.

    Two orderings, because they answer different questions:

      "soonest"  least road miles before you are on the Parkway. The default: the Parkway
                 miles are the trip, so the ride in is overhead to minimise.
      "shortest" least total miles, approach plus Parkway. Right only when the campsite is
                 the goal and the road is incidental.

    The difference is not academic. From Charlotte to the Cherokee end, "shortest" enters
    at MP 469.1 and rides a tenth of a mile of Parkway -- optimal by distance, useless as a
    ride. "soonest" enters near Asheville and rides 86 miles of it.
    """
    dest_seg = net.segment_at_mp(dest_mp)
    if dest_seg is None:
        raise ValueError(f"MP {dest_mp} is not on open Parkway in 2026")

    measured = []
    for p in access_points(model, net, junctions):
        approach = approach_mi(start, (p["lat"], p["lon"]))
        parkway = abs(dest_mp - p["mp"])
        measured.append({**p, "approach_mi": round(approach, 1),
                         "parkway_mi": round(parkway, 1),
                         "total_mi": round(approach + parkway, 1)})

    key = (lambda r: (r["approach_mi"], r["total_mi"])) if mode == "soonest" \
        else (lambda r: r["total_mi"])
    # An access point in another component cannot reach the destination on the Parkway at
    # all -- the Helene closures severed it into three pieces.
    ranked = sorted((p for p in measured if p["component"] == dest_seg.component), key=key)
    if not ranked:
        return []

    # Why not the nearest entrance of all?
    #
    # From Knoxville, Cherokee is 64 road miles away and Linville Falls is 150. For a stop
    # north of the break the planner has to send the rider on the 150 mile approach, because
    # the south end cannot reach that stop on the Parkway at any distance. That is correct
    # and it looks broken, so the nearer-but-severed entrance travels with the answer and
    # the plan can say so. A rider told the Parkway is severed can move the stop; a rider
    # shown an unexplained 150 mile ride just stops trusting the planner.
    nearer = sorted((p for p in measured
                     if p["component"] != dest_seg.component
                     and p["approach_mi"] < ranked[0]["approach_mi"]),
                    key=lambda r: r["approach_mi"])
    ranked[0]["severed_alternative"] = {
        "mp": nearer[0]["mp"], "name": nearer[0]["name"],
        "approach_mi": nearer[0]["approach_mi"],
        "saved_mi": round(ranked[0]["approach_mi"] - nearer[0]["approach_mi"], 1),
    } if nearer else None
    return ranked[:top_n]


def best_exit_points(model, net, junctions, end_point, from_mp, top_n=3):
    """Where to come off the Parkway when heading for a final destination.

    Mirror image of the entry problem, and it wants the same answer for the same reason:
    the nearest exit to where you are finishing, so the ride off the Parkway is short and
    the Parkway miles run as long as possible.
    """
    seg = net.segment_at_mp(from_mp)
    if seg is None:
        raise ValueError(f"MP {from_mp} is not on open Parkway in 2026")
    ranked = []
    for p in access_points(model, net, junctions):
        if p["component"] != seg.component:
            continue
        ride_out = approach_mi(end_point, (p["lat"], p["lon"]))
        ranked.append({**p, "ride_out_mi": round(ride_out, 1),
                       "parkway_mi": round(abs(p["mp"] - from_mp), 1)})
    ranked.sort(key=lambda r: (r["ride_out_mi"], -r["parkway_mi"]))
    return ranked[:top_n]


def _usable(f, max_detour_mi):
    if f["plan_grade"] not in ("usable", "usable_via_detour", "unconfirmed"):
        return False
    if max_detour_mi is not None and f.get("detour_plan_mi") is not None:
        return f["detour_plan_mi"] <= max_detour_mi
    return True


def exit_reserve_mi(fuel, dest_mp, component=None, max_detour_mi=None):
    """Miles needed to get from a point on the Parkway back to fuel.

    A campsite on the Parkway sells no fuel, and neither does the Parkway. Arriving on
    fumes is a plan that works right up until the morning, so the rider must finish holding
    enough to reach the nearest pump -- in either direction, detour included.
    """
    best = None
    for f in fuel:
        if not _usable(f, max_detour_mi):
            continue
        if component is not None and f.get("component") != component:
            continue
        cost = abs(f["mp"] - dest_mp) + (f.get("detour_plan_mi") or 0.0)
        if best is None or cost < best[0]:
            best = (cost, f)
    if best is None:
        return None, None
    return round(best[0], 1), best[1]


def plan_journey(fuel, waypoints, tank_mi, approach_leg_mi=0.0, reserve_frac=0.0,
                 max_detour_mi=None, component=None, require_exit_fuel=True,
                 start_tank_mi=None, arrive_min_mi=0.0):
    """Fuel for a whole journey, not a single leg.

    `waypoints` is the ordered list of mileposts the rider passes through: where they join
    the Parkway, each overnight, and where they leave it. Direction may reverse between
    them, which is exactly what a round trip does, and an exit passed twice is legitimately
    available twice.

    Greedy furthest-reachable, which is optimal for refuelling to full along a line.

    Reaching a pump costs the detour off the Parkway and back, and both halves burn fuel:
    you arrive having spent the ride out, and leave with a full tank minus the ride back. A
    15-mile detour therefore costs 30 miles of range. That asymmetry is what makes MP 411.8
    Wagon Road Gap a trap rather than a convenience.
    """
    if tank_mi <= 0:
        return {"ok": False, "stops": [], "notes": [], "error": "Set a tank range first."}
    if len(waypoints) < 2:
        return {"ok": False, "stops": [], "notes": [],
                "error": "A journey needs somewhere to start and somewhere to end."}

    # `arrive_min_mi` is how much range the rider wants left when they roll up to a pump.
    #
    # Greedy planning rides every tank to its limit, which minimises stops and is exactly
    # why a real trip reported "cutting it fine -- about 0.8 mi of planning range left".
    # Correct, and useless: nobody rides to a station on eight tenths of a mile.
    #
    # It works by shortening the tank rather than by adding a rule. If a rider will not go
    # below 10 miles, a 200 mile tank is a 190 mile tank for planning, and every leg the
    # greedy loop plans lands with those 10 miles still in it. One subtraction, and the
    # whole existing calculation inherits it.
    buffer_mi = max(0.0, arrive_min_mi)
    planning_range = tank_mi * (1.0 - reserve_frac) - buffer_mi
    if planning_range <= 0:
        return {"ok": False, "stops": [], "notes": [],
                "error": (f"Arriving with {buffer_mi:.0f} mi in hand leaves nothing to ride "
                          f"on from a {tank_mi:.0f} mi tank. Lower the buffer or raise the "
                          f"tank range.")}

    # Lay the journey out as one distance line and place every usable exit at the position
    # where the rider actually passes it.
    marks = []
    pos = 0.0
    waypoint_pos = [0.0]
    for a, b in zip(waypoints, waypoints[1:]):
        lo, hi = (a, b) if b >= a else (b, a)
        for f in fuel:
            if not _usable(f, max_detour_mi):
                continue
            if component is not None and f.get("component") != component:
                continue
            if not (lo <= f["mp"] <= hi):
                continue
            marks.append({
                "mp": f["mp"], "town": f.get("town"), "road": f.get("exit_road"),
                "detour_mi": f.get("detour_plan_mi") or 0.0,
                "grade": f["plan_grade"], "confidence": f.get("confidence"),
                "warning": f.get("warning") or f.get("closure_note") or "",
                "pos": pos + abs(f["mp"] - a),
            })
        pos += abs(b - a)
        waypoint_pos.append(pos)
    marks.sort(key=lambda m: m["pos"])
    journey_mi = pos

    exit_mi, exit_stop = (exit_reserve_mi(fuel, waypoints[-1], component, max_detour_mi)
                          if require_exit_fuel else (None, None))
    target_pos = journey_mi + (exit_mi or 0.0)

    at = 0.0
    remaining = planning_range if start_tank_mi is None else min(start_tank_mi, planning_range)
    stops, notes = [], []

    guard = 0
    while target_pos - at > remaining:
        guard += 1
        if guard > 200:
            return {"ok": False, "stops": stops, "notes": notes,
                    "error": "Could not converge on a fuel plan."}
        reachable = [m for m in marks
                     if m["pos"] > at + 1e-9
                     and (m["pos"] - at) + m["detour_mi"] <= remaining]
        if not reachable:
            ahead = [m for m in marks if m["pos"] > at + 1e-9]
            nxt = ahead[0] if ahead else None
            need = ((nxt["pos"] - at) + nxt["detour_mi"]) if nxt else (target_pos - at)
            where = f"MP {nxt['mp']} ({nxt['town']})" if nxt else "the end of the ride"
            return {
                "ok": False, "stops": stops, "notes": notes,
                "error": (f"Out of range. You need about {need:.0f} mi to reach {where}, but "
                          f"you have about {remaining:.0f} mi. Raise your tank range, allow a "
                          f"longer fuel detour, or shorten the ride."),
                "shortfall_mi": round(need - remaining, 1),
            }
        stop = max(reachable, key=lambda m: m["pos"])
        left = remaining - (stop["pos"] - at) - stop["detour_mi"]
        stops.append({**stop,
                      "arrive_with_mi": round(left, 1),
                      # What is actually in the tank on arrival: the rider thinks in fuel,
                      # not in the abstraction the planner rides on.
                      "arrive_tank_mi": round(left + buffer_mi, 1)})
        at = stop["pos"]
        remaining = planning_range - stop["detour_mi"]   # full tank, minus the ride back

    # Tank state at every waypoint. This is the number that decides whether a rider can
    # leave camp in the morning at all, and it is why the whole journey is simulated at
    # once rather than a leg at a time.
    tank_at = []
    cur, cursor, queue = (planning_range if start_tank_mi is None
                          else min(start_tank_mi, planning_range)), 0.0, list(stops)
    for wp, wpos in zip(waypoints, waypoint_pos):
        while queue and queue[0]["pos"] <= wpos + 1e-9:
            st = queue.pop(0)
            cur = planning_range - st["detour_mi"]
            cursor = st["pos"]
        tank_at.append({"mp": wp, "tank_mi": round(cur - (wpos - cursor) + buffer_mi, 1)})

    if exit_mi is not None and exit_stop is not None:
        notes.append(f"Nearest fuel to where you leave the Parkway is "
                     f"{exit_stop.get('town') or 'the closest pump'} (MP {exit_stop['mp']}), "
                     f"about {exit_mi:.0f} mi away. The plan keeps that much in the tank.")

    return {
        "ok": True, "stops": stops, "notes": notes,
        "exit_reserve_mi": exit_mi,
        "exit_reserve_stop": ({"mp": exit_stop["mp"], "town": exit_stop.get("town")}
                              if exit_stop else None),
        "tank_at": tank_at,
        # Where each waypoint falls along the journey line, so a caller can place a fuel
        # stop on the correct leg. A round trip passes the same milepost twice.
        "waypoint_pos": [round(p, 2) for p in waypoint_pos],
        "arrive_with_mi": round(remaining - (journey_mi - at) + buffer_mi, 1),
        "arrive_min_mi": round(buffer_mi, 1),
        "planning_range_mi": round(planning_range, 1),
        "parkway_mi": round(journey_mi, 1),
        "approach_mi": round(approach_leg_mi, 1),
        "total_mi": round(journey_mi + approach_leg_mi, 1),
    }


def plan_fuel(fuel, access_mp, dest_mp, tank_mi, approach_leg_mi=0.0, reserve_frac=0.0,
              full_at_access=True, max_detour_mi=None, component=None,
              require_exit_fuel=True, arrive_min_mi=0.0):
    """Single-leg convenience wrapper over plan_journey.

    The approach leg does NOT consume range. This dataset maps fuel at Parkway exits and
    nothing else, so it knows nothing about the gas stations between a rider's house and
    the Parkway -- and there are plenty. Charging a 136-mile approach against the tank
    reported "you cannot make it" for trips any rider completes by filling up on the way
    in. The approach produces advice; the Parkway calculation starts at the access point.
    """
    # Same figure plan_journey will use, so the advice below matches the plan.
    planning_range = tank_mi * (1.0 - reserve_frac) - max(0.0, arrive_min_mi)
    notes = []
    if not full_at_access:
        notes.append("Planning as though you join the Parkway on a partial tank.")
    if approach_leg_mi > planning_range:
        notes.append(f"Your ride in is about {approach_leg_mi:.0f} mi, longer than your "
                     f"{planning_range:.0f} mi range, so you will need fuel on the way. This "
                     f"planner only maps fuel at Parkway exits, so top up before you reach "
                     f"MP {access_mp}.")
    elif approach_leg_mi > planning_range * 0.6:
        notes.append(f"Your ride in is about {approach_leg_mi:.0f} mi. Start the Parkway "
                     f"with a full tank — there is no fuel on it anywhere.")

    result = plan_journey(fuel, [access_mp, dest_mp], tank_mi,
                          approach_leg_mi=approach_leg_mi, reserve_frac=reserve_frac,
                          max_detour_mi=max_detour_mi, component=component,
                          require_exit_fuel=require_exit_fuel,
                          arrive_min_mi=arrive_min_mi)
    result["notes"] = notes + result.get("notes", [])
    return result
