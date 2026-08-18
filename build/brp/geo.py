"""Geodesy and Parkway centerline geometry."""
import math

R_MI = 3958.7614


def haversine(a, b):
    """Great-circle distance in miles between (lat, lon) pairs."""
    la1, lo1, la2, lo2 = map(math.radians, [a[0], a[1], b[0], b[1]])
    h = (math.sin((la2 - la1) / 2) ** 2
         + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2)
    return 2 * R_MI * math.asin(math.sqrt(h))


def bearing(a, b):
    la1, la2 = math.radians(a[0]), math.radians(b[0])
    dlo = math.radians(b[1] - a[1])
    return math.atan2(
        math.sin(dlo) * math.cos(la2),
        math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dlo),
    )


def turn_angles(pts):
    """Absolute heading change (radians) at each segment, index-aligned to segments."""
    n = len(pts) - 1
    turn = [0.0] * n
    for i in range(n - 1):
        d = bearing(pts[i], pts[i + 1])
        e = bearing(pts[i + 1], pts[i + 2])
        turn[i] = abs((e - d + math.pi) % (2 * math.pi) - math.pi)
    return turn


def _arc_factor(theta, cap=math.radians(120)):
    """Chord->arc correction for a chord subtending heading change theta.

    The centerline was distance-resampled at ~0.17 mi, so each stored segment is a
    chord across a curve. arc = chord * (t/2)/sin(t/2). Recovers ~5 mi of the 17 mi
    deficit; the rest is handled by control-point calibration.
    """
    theta = min(theta, cap)
    return 1.0 if theta < 1e-9 else (theta / 2) / math.sin(theta / 2)


def arc_cumulative(pts):
    """Cumulative arc-corrected distance (miles) at each vertex. Unscaled."""
    seg = [haversine(pts[i - 1], pts[i]) for i in range(1, len(pts))]
    turn = turn_angles(pts)
    cum = [0.0]
    for i, s in enumerate(seg):
        t = (turn[i - 1] + turn[i]) / 2 if 0 < i < len(seg) - 1 else turn[i]
        cum.append(cum[-1] + s * _arc_factor(t))
    return cum


def nearest_vertex(pts, lat, lon):
    """Index of the closest centerline vertex, and its distance in miles."""
    best_i, best_d = 0, float("inf")
    for i, p in enumerate(pts):
        d = haversine((lat, lon), p)
        if d < best_d:
            best_i, best_d = i, d
    return best_i, best_d
