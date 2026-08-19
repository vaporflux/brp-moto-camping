"""Where the Parkway meets another road -- the input SPEC.md 5.5 assumes and data/ lacks.

SPEC.md 5.5 makes junction knowledge the core of the GPX exporter: a mandatory shaping
point 0.2-0.3 mi past every crossing with a US or state highway. Nothing in data/ lists
those crossings. The intended source was OSM relation 55450, which this build cannot
reach (overpass-api.de is blocked by egress policy), so this module assembles what the
repo does know and is explicit about what it does not.

Coverage is PARTIAL and the exporter must treat it that way. fuel.json's exit roads are
genuine highway crossings drawn from two published exit lists, but they are the subset
of crossings that have fuel -- the Parkway meets many roads that sell no gasoline. Any
design that assumes this list is complete will leave real junctions unprotected.

The mitigation lives in the exporter, not here. See spacing_requirement().
"""
import json
import re

SOURCE_PUBLISHED_EXIT = "published_exit_list"
SOURCE_CLOSURE_DETOUR = "closure_detour"


def build(model, fuel_raw, closures_raw):
    out = []
    for f in fuel_raw:
        mp = float(f["mp"])
        lat, lon = model.coord_at_mp(mp)
        out.append({
            "mp": mp,
            "road": f["exit_road"],
            "side": f.get("direction"),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "source": SOURCE_PUBLISHED_EXIT,
            "has_fuel": bool(f.get("stations")),
        })

    for c in closures_raw["closures"]:
        if not c.get("detour"):
            continue
        # closures.json describes a detour in prose ("Signed, MP 269.8-276.5 via US 221/US
        # 421"). Using that whole sentence as a road name reads badly everywhere it
        # surfaces, so pull the highway designations out of it.
        roads = re.findall(r"\b(?:US|NC|VA|I)[- ]?\d+\b", c["detour"])
        label = (" / ".join(dict.fromkeys(roads)) + " detour") if roads else "signed detour"
        out.append({
            "mp": float(c["from_mp"]),
            "road": label,
            "side": None,
            "lat": round(model.coord_at_mp(c["from_mp"])[0], 6),
            "lon": round(model.coord_at_mp(c["from_mp"])[1], 6),
            "source": SOURCE_CLOSURE_DETOUR,
            "has_fuel": False,
        })

    out.sort(key=lambda j: j["mp"])
    deduped = []
    for j in out:
        if deduped and abs(j["mp"] - deduped[-1]["mp"]) < 0.15:
            continue
        deduped.append(j)
    return deduped


def unprotected_runs(junctions, net):
    """Stretches of open Parkway with no known junction.

    Long runs here are not evidence the road is junction-free -- they are the blind
    spots in this dataset, and they are where shaping-point spacing has to do the work
    alone.
    """
    runs = []
    for cid, comp in sorted(net.components.items()):
        marks = [comp["from_mp"]] + \
                [j["mp"] for j in junctions if comp["from_mp"] <= j["mp"] <= comp["to_mp"]] + \
                [comp["to_mp"]]
        for a, b in zip(marks, marks[1:]):
            if b - a > 0.1:
                runs.append({"component": cid, "from_mp": round(a, 1),
                             "to_mp": round(b, 1), "length_mi": round(b - a, 1)})
    return sorted(runs, key=lambda r: -r["length_mi"])


def spacing_requirement(max_bypass_mi=5.0):
    """Shaping-point spacing that bounds the damage an unknown junction can do.

    The threat is not drift. Garmin guarantees the route passes through every shaping
    and via point, so the device can only cut a corner by leaving the Parkway and
    rejoining it BETWEEN two consecutive route points -- which needs two junctions in
    the same interval. A 45 mph Parkway loses that race against a parallel US highway
    often enough that this is the realistic failure, not a hypothetical one.

    Two consequences the spec's flat "one every ~5 miles" rule misses:

      * A point placed just PAST a junction makes the exit geometrically impossible, so
        known junctions are worth far more per point than evenly spaced filler.
      * Where junctions are unknown, spacing S bounds the bypass at S miles of Parkway.
        Tightening S buys a smaller worst case, not certainty.

    So: spend points on known junctions first, then fill to S. Returns the fill spacing.
    """
    return max_bypass_mi


def load(model, data_dir):
    return build(model,
                 json.load(open(f"{data_dir}/fuel.json")),
                 json.load(open(f"{data_dir}/closures.json")))
