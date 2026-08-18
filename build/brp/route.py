"""Slice the Parkway between stops, and decide where route points go.

SPEC.md 4 is right that no router is needed on the Parkway itself: between junctions
there are no alternatives, so the centerline sliced between two mileposts IS the route.
This module does that slicing and then solves the harder problem -- which points to
actually emit, under a 50-point budget, so the device cannot shortcut.

Why the spec's flat "one shaping point every ~5 miles" rule is not what we implement
-----------------------------------------------------------------------------------
Garmin guarantees the route passes through every shaping and via point. So the device
cannot wander off gradually; it can only cut a corner by leaving the Parkway and
rejoining it BETWEEN two consecutive route points. That takes two junctions inside the
same interval. A 45 mph Parkway loses the time race against a parallel US highway often
enough that this is the realistic failure, not a hypothetical one.

Two consequences:

  * A point placed just PAST a junction makes that exit geometrically impossible. Known
    junctions are worth far more per point than evenly spaced filler.
  * Where junctions are unknown -- and our junction data is admittedly partial -- a
    spacing of S bounds the bypass at S miles of Parkway. That is a bound, not a
    guarantee, and the export reports it as such.

So: spend the budget on known junctions first, then fill to S.
"""
from . import geo

JUNCTION_OFFSET_MI = 0.25   # SPEC 5.5: 0.2-0.3 mi PAST the junction, on the departing leg
MIN_POINT_SPACING_MI = 0.5  # below this, points crowd and the device renames them
# Keep route points clear of closure gates. A point sitting on a barricade is a bad
# instruction however the milepost model rounds, and the model itself is only good to
# ~0.34 mi, so a point placed exactly at a boundary can land on either side of it.
CLOSURE_CLEARANCE_MI = 0.5
MAX_TOTAL_RTEPT = 50        # BMW ConnectedRide Navigator total-route-point cap
MAX_VIA_RTEPT = 25          # under the 29-30 via cap on zumo XT / 595 / Navigator VI
MAX_TRKPT = 10000


class RouteError(Exception):
    pass


def slice_parkway(model, net, mp_a, mp_b):
    """Centerline points from mp_a to mp_b, in travel order.

    Refuses rather than silently bridging a severing closure -- SPEC 8 requires the
    planner to refuse a closed route, and a route that quietly jumps a gate is worse
    than an error message.
    """
    if not net.connected(mp_a, mp_b):
        blocking = [c for c in net.closures
                    if c["severs"] and min(mp_a, mp_b) < c["to_mp"]
                    and c["from_mp"] < max(mp_a, mp_b)]
        raise RouteError(
            f"MP {mp_a:.1f} and MP {mp_b:.1f} are not connected on the 2026 Parkway: "
            + "; ".join(f"MP {c['from_mp']}-{c['to_mp']} ({c['reason']})" for c in blocking))

    lo, hi = min(mp_a, mp_b), max(mp_a, mp_b)
    i0, i1 = model.index_at_mp(lo), model.index_at_mp(hi)
    pts = [list(model.coord_at_mp(lo))] + [list(p) for p in model.pts[i0:i1 + 1]] \
        + [list(model.coord_at_mp(hi))]
    # Drop any closed stretch this leg spans. A detour-served closure is a real gap in
    # the geometry: the rider leaves the road, so the track must not draw through it.
    kept = []
    for p in pts:
        i, _ = geo.nearest_vertex(model.pts, p[0], p[1])
        if net.is_open(model.mp_at_index(i)):
            kept.append(p)
    if mp_b < mp_a:
        kept.reverse()
    return kept


def _placeable(net, mp, clearance=CLOSURE_CLEARANCE_MI):
    """True if a route point at this milepost is safely inside open Parkway."""
    seg = net.segment_at_mp(mp)
    if seg is None:
        return False
    return (mp - seg.from_mp) >= clearance and (seg.to_mp - mp) >= clearance


def _dedupe(points, min_gap=MIN_POINT_SPACING_MI):
    """Thin shaping points that crowd their neighbour. Never drop a via point.

    Via points are destinations, and two of them can share an access milepost while
    sitting miles apart on the ground -- a fuel exit and a campground reached from the
    same junction. Deduping by milepost would silently delete one of the day's real
    stops, so only shaping points are ever removed.
    """
    out = []
    for p in points:
        if p["type"] == "via":
            while out and out[-1]["type"] == "shaping" \
                    and abs(p["mp"] - out[-1]["mp"]) < min_gap:
                out.pop()
            out.append(p)
            continue
        if out and abs(p["mp"] - out[-1]["mp"]) < min_gap:
            continue
        out.append(p)
    return out


def place_leg_points(model, net, junctions, mp_a, mp_b, spacing_mi=5.0):
    """Shaping points for one leg, junction-first then filled to spacing_mi."""
    forward = mp_b >= mp_a
    lo, hi = min(mp_a, mp_b), max(mp_a, mp_b)
    direction = 1 if forward else -1

    pts = []
    for j in junctions:
        if not (lo < j["mp"] < hi):
            continue
        at = j["mp"] + direction * JUNCTION_OFFSET_MI
        if not (lo < at < hi) or not _placeable(net, at):
            # A junction can sit inside a closure, or so close to a gate that the point
            # past it would land on the barricade. Push it further into open road; give
            # up if there is no room, rather than emit a point at the gate.
            moved = False
            for extra in (0.5, 1.0, 1.5):
                cand = j["mp"] + direction * (JUNCTION_OFFSET_MI + extra)
                if lo < cand < hi and _placeable(net, cand):
                    at, moved = cand, True
                    break
            if not moved:
                continue
        lat, lon = model.coord_at_mp(at)
        pts.append({"mp": at, "lat": lat, "lon": lon, "type": "shaping",
                    "reason": f"past {j['road']}", "junction": True})

    # Fill so no interval exceeds spacing_mi. Bounds the bypass where junctions are
    # unknown; see the module docstring.
    anchors = sorted([lo, hi] + [p["mp"] for p in pts])
    for a, b in zip(anchors, anchors[1:]):
        span = b - a
        if span <= spacing_mi:
            continue
        n = int(span // spacing_mi)
        for k in range(1, n + 1):
            at = a + span * k / (n + 1)
            if not _placeable(net, at):
                continue
            lat, lon = model.coord_at_mp(at)
            pts.append({"mp": at, "lat": lat, "lon": lon, "type": "shaping",
                        "reason": "spacing", "junction": False})

    pts.sort(key=lambda p: p["mp"], reverse=not forward)
    return pts


def build_day(model, net, junctions, stops, spacing_mi=5.0):
    """Assemble one day's route points and track.

    stops: ordered dicts with lat, lon, name, mp, and kind. Each becomes a via point --
    they are the announced stops, and SPEC 5.2 is explicit that a bare rtept defaults to
    a via, so nothing is left untyped.
    """
    if len(stops) < 2:
        raise RouteError("a day needs at least a start and an end")

    rtepts = [{"mp": stops[0]["mp"], "lat": stops[0]["lat"], "lon": stops[0]["lon"],
               "type": "via", "name": stops[0]["name"], "kind": stops[0].get("kind"),
               "reason": "day start"}]
    track = []
    parkway_mi = 0.0
    detour_mi = 0.0

    for a, b in zip(stops, stops[1:]):
        leg = place_leg_points(model, net, junctions, a["mp"], b["mp"], spacing_mi)
        rtepts.extend(leg)
        rtepts.append({"mp": b["mp"], "lat": b["lat"], "lon": b["lon"], "type": "via",
                       "name": b["name"], "kind": b.get("kind"), "reason": "stop"})
        seg = slice_parkway(model, net, a["mp"], b["mp"])
        if track and seg and track[-1] == seg[0]:
            seg = seg[1:]
        track.extend(seg)
        parkway_mi += abs(b["mp"] - a["mp"])
        detour_mi += a.get("off_parkway_mi", 0.0) + b.get("off_parkway_mi", 0.0)

    rtepts = _dedupe(rtepts)
    track = _thin_track(track, MAX_TRKPT)

    warnings = []
    # Backtracking is legal -- the Mt Mitchell spur is an out-and-back by definition --
    # but an unintended reversal is easy to create by adding a stop in the wrong order,
    # and on the road it reads as the route "going the wrong way".
    legs = list(zip(stops, stops[1:]))
    signs = {1 if b["mp"] > a["mp"] else -1 for a, b in legs if a["mp"] != b["mp"]}
    if len(signs) > 1:
        reversals = [f"{a['name']} (MP {a['mp']}) -> {b['name']} (MP {b['mp']})"
                     for a, b in legs if b["mp"] < a["mp"]]
        warnings.append("stops are not in milepost order; the day backtracks: "
                        + "; ".join(reversals))
    big = [s for s in stops if s.get("off_parkway_mi", 0) >= 10]
    for s in big:
        warnings.append(f"{s['name']} is {s['off_parkway_mi']:.0f} mi off the Parkway "
                        f"-- roughly {s['off_parkway_mi'] * 2:.0f} mi round trip")

    return {
        "warnings": warnings,
        "rtepts": rtepts,
        "track": track,
        "parkway_mi": round(parkway_mi, 1),
        "detour_mi": round(detour_mi, 1),
        "total_mi": round(parkway_mi + detour_mi, 1),
        "n_total": len(rtepts),
        "n_via": sum(1 for p in rtepts if p["type"] == "via"),
        "n_junction_points": sum(1 for p in rtepts if p.get("junction")),
        "max_unprotected_span_mi": _max_span(rtepts),
    }


def _max_span(rtepts):
    """Longest gap between consecutive route points -- the bypass bound for this day."""
    if len(rtepts) < 2:
        return 0.0
    return round(max(abs(b["mp"] - a["mp"]) for a, b in zip(rtepts, rtepts[1:])), 2)


def _thin_track(track, limit):
    if len(track) <= limit:
        return track
    step = len(track) / limit
    out = [track[int(i * step)] for i in range(limit - 1)]
    out.append(track[-1])
    return out


def fits_budget(day):
    return day["n_total"] <= MAX_TOTAL_RTEPT and day["n_via"] <= MAX_VIA_RTEPT


def split_day(model, net, junctions, stops, spacing_mi=5.0):
    """Split a day that busts the budget into consecutive routes that fit.

    SPEC 5.4 is explicit: split rather than thin the shaping points. Thinning trades a
    hard cap for a silent increase in bypass risk, which is the failure this whole
    exporter exists to prevent.
    """
    day = build_day(model, net, junctions, stops, spacing_mi)
    if fits_budget(day):
        return [day]
    if len(stops) < 3:
        raise RouteError(
            f"cannot split: {day['n_total']} points between two stops. Add an "
            f"intermediate stop or shorten the day.")
    mid = len(stops) // 2
    return (split_day(model, net, junctions, stops[:mid + 1], spacing_mi)
            + split_day(model, net, junctions, stops[mid:], spacing_mi))
