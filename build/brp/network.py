"""Parkway connectivity: which stretches are open, which are actually reachable.

The planner's hardest constraint is not distance, it is that the 2026 Parkway is not
one road. Hurricane Helene severed it into disconnected components, and a stop being
"open" says nothing about whether a rider can get to it from where the trip starts.

Two ideas the shipped data conflates and this module separates:

  segment  -- a maximal run of open Parkway, with real endpoints
  component -- a set of segments a rider can move between WITHOUT leaving the Parkway,
               or by following a signed detour that closures.json documents

A closure with a signed detour still links the segments on either side; the rider
leaves the road and comes back. A closure with detour=null severs them outright.
"""
import json


class Segment:
    def __init__(self, idx, pts, from_mp, to_mp):
        self.idx = idx
        self.pts = pts
        self.from_mp = from_mp
        self.to_mp = to_mp
        self.component = None
        # A segment can end because the road ends (terminus) or because a closure cut
        # it (severed). Only the second kind makes a dead end.
        self.north_end = "terminus"
        self.south_end = "terminus"

    @property
    def dead_end_north(self):
        return self.north_end == "severed"

    @property
    def dead_end_south(self):
        return self.south_end == "severed"

    @property
    def length_mi(self):
        return self.to_mp - self.from_mp

    def to_dict(self):
        return {
            "idx": self.idx, "from_mp": round(self.from_mp, 2),
            "to_mp": round(self.to_mp, 2), "length_mi": round(self.length_mi, 2),
            "component": self.component,
            "north_end": self.north_end, "south_end": self.south_end,
            "dead_end_north": self.dead_end_north,
            "dead_end_south": self.dead_end_south,
            "n_points": len(self.pts),
        }


class Network:
    def __init__(self, segments, closures, components, spurs):
        self.segments = segments
        self.closures = closures
        self.components = components
        self.spurs = spurs

    def segment_at_mp(self, mp):
        for s in self.segments:
            if s.from_mp - 1e-9 <= mp <= s.to_mp + 1e-9:
                return s
        return None

    def is_open(self, mp):
        return self.segment_at_mp(mp) is not None

    def component_at_mp(self, mp):
        s = self.segment_at_mp(mp)
        return s.component if s else None

    def connected(self, mp_a, mp_b):
        """Can a rider get from one milepost to the other without an undocumented
        off-Parkway transit?"""
        ca, cb = self.component_at_mp(mp_a), self.component_at_mp(mp_b)
        return ca is not None and ca == cb

    def blocking_closures(self, mp_a, mp_b):
        """Closures strictly between two mileposts, in travel order."""
        lo, hi = min(mp_a, mp_b), max(mp_a, mp_b)
        return [c for c in self.closures if c["to_mp"] > lo and c["from_mp"] < hi]


def _severs(closure):
    """A closure with no documented detour breaks the Parkway in two."""
    return not closure.get("detour")


def build(model, closures_raw, mainline_tolerance=2.0):
    """Cut the centerline at NPS closure mileposts under a calibrated model.

    The shipped parkway_segs.json was cut using the uncalibrated milepost model, which
    places every gate 2-3 mi from where NPS says it is. Since closures.json carries
    real NPS mileposts, the correct move is to re-cut from those numbers rather than
    inherit the old geometry's error.
    """
    pts = model.pts

    # closures.json lists spur roads too (the Roanoke Mountain Loop). Anything that is
    # not a real interval on the mainline must not cut the centerline.
    mainline = [c for c in closures_raw["closures"]
                if c["to_mp"] - c["from_mp"] >= 0.25]

    merged = []
    for c in sorted(mainline, key=lambda c: c["from_mp"]):
        if merged and c["from_mp"] <= merged[-1]["to_mp"] + 1e-6:
            prev = merged[-1]
            prev["to_mp"] = max(prev["to_mp"], c["to_mp"])
            prev["members"].append(c)
        else:
            merged.append({"from_mp": c["from_mp"], "to_mp": c["to_mp"], "members": [c]})

    # An interval severs only if every closure composing it lacks a documented detour.
    for m in merged:
        m["severs"] = all(_severs(c) for c in m["members"])
        m["detour"] = next((c["detour"] for c in m["members"] if c.get("detour")), None)
        m["reason"] = "; ".join(sorted({c["reason"] for c in m["members"]}))

    bounds = [0.0]
    for m in merged:
        bounds += [m["from_mp"], m["to_mp"]]
    bounds.append(model.OFFICIAL_LENGTH if hasattr(model, "OFFICIAL_LENGTH") else 469.1)

    segments = []
    for k in range(0, len(bounds) - 1, 2):
        a, b = bounds[k], bounds[k + 1]
        if b - a <= 0.05:
            continue
        i0, i1 = model.index_at_mp(a), model.index_at_mp(b)
        geom = [list(model.coord_at_mp(a))] + [list(p) for p in pts[i0:i1 + 1]] \
            + [list(model.coord_at_mp(b))]
        segments.append(Segment(len(segments), geom, a, b))

    # Label each segment end by what terminates it.
    for j, s in enumerate(segments):
        if j > 0:
            gap = merged[j - 1]
            s.north_end = "severed" if gap["severs"] else "detour"
        if j < len(segments) - 1:
            gap = merged[j]
            s.south_end = "severed" if gap["severs"] else "detour"

    comp = 0
    for j, s in enumerate(segments):
        if j > 0 and segments[j - 1].south_end == "severed":
            comp += 1
        s.component = comp

    components = {}
    for s in segments:
        c = components.setdefault(s.component, {"segments": [], "from_mp": s.from_mp,
                                                "to_mp": s.to_mp, "length_mi": 0.0})
        c["segments"].append(s.idx)
        c["from_mp"] = min(c["from_mp"], s.from_mp)
        c["to_mp"] = max(c["to_mp"], s.to_mp)
        c["length_mi"] += s.length_mi

    spurs = _find_spurs(segments, components)
    return Network(segments, merged, components, spurs)


def _find_spurs(segments, components):
    """A spur is a dead-ended stretch: rideable, but it does not lead anywhere.

    Riding one is an out-and-back, so its mileage counts twice against the day and
    against fuel range. The planner must never treat a spur as through-route.
    """
    spurs = []
    for cid, c in components.items():
        members = [s for s in segments if s.component == cid]
        north_dead = members[0].dead_end_north
        south_dead = members[-1].dead_end_south
        if north_dead and south_dead:
            kind = "isolated"
        elif north_dead:
            kind = "dead_end_north"
        elif south_dead:
            kind = "dead_end_south"
        else:
            continue
        spurs.append({
            "component": cid, "kind": kind,
            "from_mp": round(c["from_mp"], 2), "to_mp": round(c["to_mp"], 2),
            "length_mi": round(c["length_mi"], 2),
        })
    return spurs


def load(model, data_dir):
    return build(model, json.load(open(f"{data_dir}/closures.json")))
