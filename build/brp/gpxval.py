"""Validate exported GPX against the checklist in GPX-REFERENCE.md.

Written before the exporter and run over its output, because "enforced not just warned"
(SPEC 8) is only true if something actually fails. Every check here maps to a line in
GPX-REFERENCE.md's validation checklist or its "Do NOT emit" list.

Scope note: full XSD validation needs the Topografix and Garmin schema files, which are
fetched over the network and are not available offline. This does structural validation
-- well-formedness, required namespaces, required elements, element placement -- which
catches everything the checklist names except literal schema conformance.
"""
import re
import xml.etree.ElementTree as ET

NS = {
    "gpx": "http://www.topografix.com/GPX/1/1",
    "gpxx": "http://www.garmin.com/xmlschemas/GpxExtensions/v3",
    "trp": "http://www.garmin.com/xmlschemas/TripExtensions/v1",
}
MAX_TOTAL_RTEPT = 50
MAX_VIA_RTEPT = 25
MAX_TRKPT = 10000
MAX_NAME_LEN = 30
NAME_RE = re.compile(r"^[A-Za-z0-9 _-]+$")
JUNCTION_CLEARANCE_M = 100


class Finding:
    def __init__(self, level, check, detail):
        self.level, self.check, self.detail = level, check, detail

    def __repr__(self):
        return f"[{self.level}] {self.check}: {self.detail}"


def validate(xml_text, net=None, junctions=None, model=None):
    """Returns a list of Findings. Any level='error' means do not ship the file."""
    out = []

    def err(check, detail):
        out.append(Finding("error", check, detail))

    def warn(check, detail):
        out.append(Finding("warn", check, detail))

    if xml_text.startswith("﻿"):
        err("no BOM", "file begins with a UTF-8 BOM")
    if not xml_text.startswith("<?xml"):
        err("xml declaration", "missing XML declaration")

    try:
        root = ET.fromstring(xml_text.encode("utf-8"))
    except ET.ParseError as e:
        err("well-formed XML", str(e))
        return out

    if root.tag != f"{{{NS['gpx']}}}gpx":
        err("GPX 1.1 root", f"root is {root.tag}")
    if root.get("version") != "1.1":
        err("GPX 1.1 root", f"version={root.get('version')}")

    for want in ("gpxx", "trp"):
        if NS[want] not in xml_text:
            err("required namespaces", f"{want} namespace absent")

    rtes = root.findall("gpx:rte", NS)
    if len(rtes) > 1:
        err("one rte per file", f"found {len(rtes)}")

    # -- forbidden constructs (GPX-REFERENCE "Do NOT emit") --------------------------
    if root.findall(f".//{{{NS['gpxx']}}}rpt"):
        err("no gpxx:rpt ghost points",
            "gpxx:rpt present -- discarded on recalculation, the classic trap")
    if "TripExtensions/v2" in xml_text:
        err("TripExtensions v1 only", "v2 namespace present; XT and XT2 do not read it")
    if "AdventurousLevel" in xml_text:
        err("no AdventurousLevel", "present; not understood by the target devices")

    rtepts = []
    for rte in rtes:
        rtepts.extend(rte.findall("gpx:rtept", NS))
    if any(p.find("gpx:time", NS) is not None for p in rtepts):
        warn("no time on rtepts", "rtept carries <time>")

    # -- point budget ----------------------------------------------------------------
    vias, shapings, untyped = [], [], []
    for p in rtepts:
        ext = p.find("gpx:extensions", NS)
        has_via = ext is not None and ext.find("trp:ViaPoint", NS) is not None
        has_shape = ext is not None and ext.find("trp:ShapingPoint", NS) is not None
        if has_via and has_shape:
            err("point typed once", "rtept carries both ViaPoint and ShapingPoint")
        elif has_via:
            vias.append(p)
        elif has_shape:
            shapings.append(p)
        else:
            untyped.append(p)

    if untyped:
        err("every rtept is typed",
            f"{len(untyped)} bare rtept(s) -- a bare rtept DEFAULTS TO A VIA POINT")
    if len(rtepts) > MAX_TOTAL_RTEPT:
        err("total rtept <= 50", f"{len(rtepts)}")
    if len(vias) > MAX_VIA_RTEPT:
        err("via rtept <= 25", f"{len(vias)}")

    trkpts = root.findall(".//gpx:trkpt", NS)
    if len(trkpts) > MAX_TRKPT:
        err("trkpt <= 10000", f"{len(trkpts)}")

    # -- naming ----------------------------------------------------------------------
    for rte in rtes:
        nm = rte.find("gpx:name", NS)
        name = nm.text if nm is not None else ""
        if not name:
            err("route name present", "missing")
            continue
        if len(name) > MAX_NAME_LEN:
            err("route name <= 30 chars", f"{len(name)}: {name!r}")
        if not NAME_RE.match(name):
            err("route name ASCII, only - and _",
                f"{name!r} contains disallowed characters")

    # -- waypoint parity -------------------------------------------------------------
    wpts = root.findall("gpx:wpt", NS)
    wpt_at = {(round(float(w.get("lat")), 5), round(float(w.get("lon")), 5)) for w in wpts}
    for p in vias:
        key = (round(float(p.get("lat")), 5), round(float(p.get("lon")), 5))
        if key not in wpt_at:
            nm = p.find("gpx:name", NS)
            err("a wpt exists for every via point",
                f"no wpt at {key} for via {nm.text if nm is not None else '?'!r}")

    # -- geography -------------------------------------------------------------------
    if net is not None and model is not None:
        from . import geo
        for p in rtepts:
            lat, lon = float(p.get("lat")), float(p.get("lon"))
            i, off = geo.nearest_vertex(model.pts, lat, lon)
            # Only points ON the Parkway are subject to the closure test. A campground
            # or gas station is legitimately off the road and its milepost is an access
            # point, not a location.
            if off > 0.25:
                continue
            if not net.is_open(model.mp_at_index(i)):
                nm = p.find("gpx:name", NS)
                err("no point inside a closed segment",
                    f"{nm.text if nm is not None else '?'} at MP "
                    f"{model.mp_at_index(i):.1f} is inside a closure")

    if junctions is not None:
        from . import geo
        for p in shapings:
            lat, lon = float(p.get("lat")), float(p.get("lon"))
            for j in junctions:
                d_m = geo.haversine((lat, lon), (j["lat"], j["lon"])) * 1609.344
                if d_m < JUNCTION_CLEARANCE_M:
                    nm = p.find("gpx:name", NS)
                    err("shaping points clear junctions by 100 m",
                        f"{nm.text if nm is not None else '?'} is {d_m:.0f} m from "
                        f"{j['road']} -- ambiguous snapping")
                    break

    return out


def errors(findings):
    return [f for f in findings if f.level == "error"]
