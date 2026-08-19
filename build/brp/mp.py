"""Milepost model: maps position along the centerline to a Blue Ridge Parkway milepost.

Why this exists
---------------
data/parkway.json is OSM relation 55450, distance-resampled to ~0.17 mi spacing and
measuring 451.74 mi against an official route length of 469.1 mi. The obvious fix --
scale everything by 469.1/451.74 -- is what produced the mileposts in the shipped
datasets, and it is wrong in a way that matters: it assumes the 17.4 mi deficit is
spread evenly, when in fact it concentrates in curves.

Measured against 8 independent control points (campgrounds whose geocoded position is
within 0.5 mi of the centerline, so their published access milepost pins a real place),
the uniform model runs 0.8-3.6 mi long, always in the same direction. A closure gate
placed 3 mi from where the data says it is will route a rider into it.

This module corrects in two stages: chord->arc recovery (physics, no fitting), then
monotone piecewise-linear calibration through the control points (empirical).
"""
import bisect
import json

from . import geo

OFFICIAL_LENGTH_MI = 469.1


class MilepostModel:
    def __init__(self, pts, controls):
        """controls: list of {'arc': <unscaled cumulative>, 'mp': <true milepost>, ...}"""
        self.pts = pts
        self.arc = geo.arc_cumulative(pts)
        self._knots_arc = [c["arc"] for c in controls]
        self._knots_mp = [c["mp"] for c in controls]
        self.controls = controls

    def mp_at_index(self, i):
        return self.mp_at_arc(self.arc[i])

    def mp_at_arc(self, a):
        """Monotone piecewise-linear interpolation between calibration knots."""
        ka, km = self._knots_arc, self._knots_mp
        if a <= ka[0]:
            return km[0]
        if a >= ka[-1]:
            return km[-1]
        j = bisect.bisect_right(ka, a) - 1
        span = ka[j + 1] - ka[j]
        if span <= 0:
            return km[j]
        return km[j] + (km[j + 1] - km[j]) * (a - ka[j]) / span

    def index_at_mp(self, target):
        """Nearest vertex index to a given milepost."""
        lo, hi = 0, len(self.arc) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if self.mp_at_index(mid) < target:
                lo = mid + 1
            else:
                hi = mid
        return lo

    def coord_at_mp(self, target):
        """Interpolated (lat, lon) at a milepost -- does not snap to a vertex."""
        i = self.index_at_mp(target)
        if i == 0:
            return tuple(self.pts[0])
        a, b = self.pts[i - 1], self.pts[i]
        ma, mb = self.mp_at_index(i - 1), self.mp_at_index(i)
        if mb - ma <= 0:
            return tuple(b)
        f = max(0.0, min(1.0, (target - ma) / (mb - ma)))
        return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)

    def residuals(self):
        return [
            {"name": c.get("name"), "published_mp": c["mp"],
             "model_mp": round(self.mp_at_arc(c["arc"]), 3),
             "residual": round(self.mp_at_arc(c["arc"]) - c["mp"], 3)}
            for c in self.controls
        ]

    def coverage_gaps(self, max_gap=40.0):
        """Milepost ranges with no nearby control point -- error is extrapolated there."""
        gaps = []
        for a, b in zip(self._knots_mp, self._knots_mp[1:]):
            if b - a > max_gap:
                gaps.append([round(a, 1), round(b, 1)])
        return gaps


def derive_controls(pts, campgrounds, max_offset_mi=0.5):
    """Independent calibration controls.

    A campground's geocoded lat/lon comes from address research, not from the
    centerline model, so it is independent evidence. When the campground sits within
    max_offset_mi of the road, its published access milepost effectively labels the
    nearest centerline vertex. The two termini are exact by construction.
    """
    arc = geo.arc_cumulative(pts)
    controls = [{"name": "Northern terminus (Rockfish Gap)", "arc": arc[0], "mp": 0.0,
                 "source": "terminus", "offset_mi": 0.0}]
    for c in campgrounds:
        i, d = geo.nearest_vertex(pts, c["lat"], c["lon"])
        if d <= max_offset_mi:
            controls.append({
                "name": c["name"], "arc": arc[i], "mp": float(c["mp"]),
                "source": "campground_geocode", "offset_mi": round(d, 3),
            })
    controls.append({"name": "Southern terminus (Cherokee)", "arc": arc[-1],
                     "mp": OFFICIAL_LENGTH_MI, "source": "terminus", "offset_mi": 0.0})

    controls.sort(key=lambda c: c["arc"])
    # Enforce strict monotonicity; a control that inverts against its neighbours is
    # bad data and must not become a knot.
    kept, rejected = [controls[0]], []
    for c in controls[1:]:
        if c["arc"] > kept[-1]["arc"] and c["mp"] > kept[-1]["mp"]:
            kept.append(c)
        else:
            rejected.append(c)
    return kept, rejected


def load(data_dir):
    pts = json.load(open(f"{data_dir}/parkway.json"))
    cgs = json.load(open(f"{data_dir}/campgrounds.json"))
    controls, rejected = derive_controls(pts, cgs)
    return MilepostModel(pts, controls), rejected
