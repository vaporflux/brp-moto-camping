"""GPX 1.1 export for Garmin and BMW motorcycle navigators.

Target format is GPX-REFERENCE.md; the reasoning is SPEC.md 5. The single idea that
governs everything here: a GPX route is not a path. It is a list of points plus two
hints, and the device recomputes the roads between them using its own settings. So the
exporter's whole job is to place points such that the Parkway is the only thing the
device can compute.

Encoding decisions that follow from that:

  * Geometry is carried by SHAPING points, never gpxx:rpt ghost points. Ghost points
    reproduce the line perfectly on import and are discarded the moment anything
    triggers a recalculation.
  * Every rtept is explicitly typed. A bare rtept defaults to a via point, which is how
    plain exports blow past the ~29 via cap and get silently fragmented.
  * A <trk> ships alongside the <rte> in a contrasting colour. Tracks cannot be
    recalculated, so if the magenta route leaves the blue track the rider can see it
    happen and follow the track instead.

One deliberate divergence from SPEC 5.7's prose: it says to set trp:CalculationMode
alongside trp:TransportationMode at route level. TripExtensions v1 puts CalculationMode
inside each trp:ViaPoint, which is what GPX-REFERENCE.md's example actually does. The
reference is right and the prose is not, so the reference wins.
"""
import re
from xml.sax.saxutils import escape

GPX_NS = "http://www.topografix.com/GPX/1/1"
GPXX_NS = "http://www.garmin.com/xmlschemas/GpxExtensions/v3"
TRP_NS = "http://www.garmin.com/xmlschemas/TripExtensions/v1"
XSI_NS = "http://www.w3.org/2001/XMLSchema-instance"

# The null map handle. Without it the device substitutes map-database names for yours,
# which is how "FUEL Asheville US70" becomes "US-70" overnight.
NULL_SUBCLASS = "000000000000FFFFFFFFFFFFFFFFFFFFFFFF"

SYMBOLS = {
    "fuel": "Gas Station",
    "campground": "Campground",
    "town": "City (Small)",
    "food": "Restaurant",
    "start": "Flag, Green",
    "end": "Flag, Red",
}


def safe_name(text, limit=30):
    """ASCII, <= limit chars, no punctuation beyond - and _ (GPX-REFERENCE checklist)."""
    ascii_only = text.encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9 _-]", " ", ascii_only)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:limit].strip()


def _wpt(p):
    sym = SYMBOLS.get(p.get("kind"), "Flag, Blue")
    cmt = p.get("comment") or ""
    lines = [f'  <wpt lat="{p["lat"]:.7f}" lon="{p["lon"]:.7f}">',
             f"    <name>{escape(safe_name(p['name']))}</name>"]
    if cmt:
        lines.append(f"    <cmt>{escape(cmt)}</cmt>")
    lines += [f"    <sym>{sym}</sym>",
              "    <type>user</type>",
              "    <extensions>",
              f'      <gpxx:WaypointExtension xmlns:gpxx="{GPXX_NS}">',
              "        <gpxx:DisplayMode>SymbolAndName</gpxx:DisplayMode>",
              "      </gpxx:WaypointExtension>",
              "    </extensions>",
              "  </wpt>"]
    return "\n".join(lines)


def _rtept(p):
    lines = [f'      <rtept lat="{p["lat"]:.7f}" lon="{p["lon"]:.7f}">']
    if p.get("name"):
        lines.append(f"        <name>{escape(safe_name(p['name']))}</name>")
    if p["type"] == "via":
        sym = SYMBOLS.get(p.get("kind"), "Flag, Blue")
        lines.append(f"        <sym>{sym}</sym>")
    lines.append("        <extensions>")
    if p["type"] == "via":
        lines += ["          <trp:ViaPoint>",
                  "            <trp:CalculationMode>FasterTime</trp:CalculationMode>",
                  "            <trp:ElevationMode>Standard</trp:ElevationMode>",
                  "          </trp:ViaPoint>"]
    else:
        lines.append("          <trp:ShapingPoint />")
    lines += ["          <gpxx:RoutePointExtension>",
              f"            <gpxx:Subclass>{NULL_SUBCLASS}</gpxx:Subclass>",
              "          </gpxx:RoutePointExtension>",
              "        </extensions>",
              "      </rtept>"]
    return "\n".join(lines)


def _header(title):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<gpx version="1.1" creator="BRP Trip Planner"\n'
        f'     xmlns="{GPX_NS}"\n'
        f'     xmlns:xsi="{XSI_NS}"\n'
        f'     xmlns:gpxx="{GPXX_NS}"\n'
        f'     xmlns:trp="{TRP_NS}"\n'
        f'     xsi:schemaLocation="{GPX_NS} {GPX_NS}/gpx.xsd\n'
        f'       {GPXX_NS} http://www8.garmin.com/xmlschemas/GpxExtensionsv3.xsd\n'
        f'       {TRP_NS} http://www8.garmin.com/xmlschemas/TripExtensionsv1.xsd">\n'
        f"  <metadata><name>{escape(title)}</name></metadata>"
    )


def _track(name, points, colour="Blue"):
    body = "\n".join(f'        <trkpt lat="{p[0]:.7f}" lon="{p[1]:.7f}" />'
                     for p in points)
    return ("  <trk>\n"
            f"    <name>{escape(safe_name(name + ' track', 40))}</name>\n"
            "    <extensions>\n"
            "      <gpxx:TrackExtension>\n"
            f"        <gpxx:DisplayColor>{colour}</gpxx:DisplayColor>\n"
            "      </gpxx:TrackExtension>\n"
            "    </extensions>\n"
            "    <trkseg>\n" + body + "\n    </trkseg>\n"
            "  </trk>")


def export_route(day, route_name, title=None):
    """Route + track + waypoints. The everyday file, works on all four candidate devices."""
    name = safe_name(route_name)
    vias = [p for p in day["rtepts"] if p["type"] == "via"]
    parts = [_header(title or route_name)]
    parts += [_wpt(p) for p in vias]
    parts.append("  <rte>")
    parts.append(f"    <name>{escape(name)}</name>")
    parts += ["    <extensions>",
              "      <trp:Trip>",
              "        <trp:TransportationMode>Motorcycling</trp:TransportationMode>",
              "      </trp:Trip>",
              "      <gpxx:RouteExtension>",
              "        <gpxx:IsAutoNamed>false</gpxx:IsAutoNamed>",
              "        <gpxx:DisplayColor>Magenta</gpxx:DisplayColor>",
              "      </gpxx:RouteExtension>",
              "    </extensions>"]
    parts.append("    <rtept-block>")
    parts[-1] = "\n".join(_rtept(p) for p in day["rtepts"])
    parts.append("  </rte>")
    parts.append(_track(name, day["track"]))
    parts.append("</gpx>\n")
    return "\n".join(parts)


def export_track_only(day, route_name, title=None):
    """Track + waypoints, no route. The universal fallback.

    Cannot be recalculated because there is nothing to recalculate, imports on
    everything, and can be converted to a route on the device if the rider wants one.
    """
    name = safe_name(route_name)
    vias = [p for p in day["rtepts"] if p["type"] == "via"]
    parts = [_header((title or route_name) + " (track)")]
    parts += [_wpt(p) for p in vias]
    parts.append(_track(name, day["track"]))
    parts.append("</gpx>\n")
    return "\n".join(parts)


def export_waypoints_only(day, route_name, title=None):
    """Named stops only. For anyone in the group on a phone app instead of a Garmin."""
    vias = [p for p in day["rtepts"] if p["type"] == "via"]
    parts = [_header((title or route_name) + " (waypoints)")]
    parts += [_wpt(p) for p in vias]
    parts.append("</gpx>\n")
    return "\n".join(parts)


def filename(prefix, day_no, label, suffix=""):
    base = safe_name(f"{prefix}-D{day_no}-{label}", 30).replace(" ", "-")
    return f"{base}{suffix}.gpx"
