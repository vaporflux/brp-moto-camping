# GPX Reference — annotated target output

One file per riding day. Route + track + waypoints. See SPEC.md §5 for the reasoning.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="BRP Trip Planner"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xmlns:gpxx="http://www.garmin.com/xmlschemas/GpxExtensions/v3"
     xmlns:trp="http://www.garmin.com/xmlschemas/TripExtensions/v1"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd
       http://www.garmin.com/xmlschemas/GpxExtensions/v3 http://www8.garmin.com/xmlschemas/GpxExtensionsv3.xsd
       http://www.garmin.com/xmlschemas/TripExtensions/v1 http://www.garmin.com/xmlschemas/TripExtensionsv1.xsd">

  <metadata><name>BRP Day 3 - Asheville to Boone</name></metadata>

  <!-- (A) One <wpt> per NAMED stop, at the same coords as its <rtept> below.
       Lands in Where To? > Saved. This is what makes the device keep YOUR name
       instead of substituting a map-database name, and lets the rider re-navigate
       to a single stop after a detour without reloading the day. -->
  <wpt lat="35.5951000" lon="-82.5515000">
    <name>FUEL Asheville US70</name>
    <cmt>MP 382.5 - last fuel before the gap</cmt>
    <sym>Gas Station</sym>
    <type>user</type>
    <extensions>
      <gpxx:WaypointExtension>
        <gpxx:DisplayMode>SymbolAndName</gpxx:DisplayMode>
      </gpxx:WaypointExtension>
    </extensions>
  </wpt>

  <rte>
    <name>BRP D3 Asheville-Boone</name>
    <extensions>
      <!-- (B) The only two routing prefs that cross into the device. -->
      <trp:Trip>
        <trp:TransportationMode>Motorcycling</trp:TransportationMode>
      </trp:Trip>
      <gpxx:RouteExtension>
        <gpxx:IsAutoNamed>false</gpxx:IsAutoNamed>
        <gpxx:DisplayColor>Magenta</gpxx:DisplayColor>
      </gpxx:RouteExtension>
    </extensions>

    <!-- (C) VIA POINT - announced stop. Orange flag, turn list, ETA.
         Counts against the ~29 limit. Use ONLY for real stops:
         start, end, fuel, campground, lunch. Budget <= 25. -->
    <rtept lat="35.5951000" lon="-82.5515000">
      <name>FUEL Asheville US70</name>
      <sym>Gas Station</sym>
      <extensions>
        <trp:ViaPoint>
          <trp:CalculationMode>FasterTime</trp:CalculationMode>
          <trp:ElevationMode>Standard</trp:ElevationMode>
        </trp:ViaPoint>
        <!-- Null map handle: stops the device renaming this point. -->
        <gpxx:RoutePointExtension>
          <gpxx:Subclass>000000000000FFFFFFFFFFFFFFFFFFFFFFFF</gpxx:Subclass>
        </gpxx:RoutePointExtension>
      </extensions>
    </rtept>

    <!-- (D) SHAPING POINT - silent. Empty element. Does NOT count against the
         via limit. This one sits 0.25 mi PAST the US-74A junction, ON the
         Parkway, so the router physically cannot take the ramp.
         Place: one every ~5 mi, plus one just past every highway crossing. -->
    <rtept lat="35.5806000" lon="-82.3961000">
      <name>SP MP 384.9</name>
      <extensions>
        <trp:ShapingPoint />
        <gpxx:RoutePointExtension>
          <gpxx:Subclass>000000000000FFFFFFFFFFFFFFFFFFFFFFFF</gpxx:Subclass>
        </gpxx:RoutePointExtension>
      </extensions>
    </rtept>

    <!-- ... more shaping points ... then the day's end via point ... -->
  </rte>

  <!-- (E) The safety net. Immutable - the device cannot recalculate a track.
       Contrasting color so the rider sees instantly if the magenta route has
       wandered off. If the route goes wrong at 8am, he follows this.
       Keep <= 10,000 trkpt. -->
  <trk>
    <name>BRP D3 Asheville-Boone (track)</name>
    <extensions>
      <gpxx:TrackExtension>
        <gpxx:DisplayColor>Blue</gpxx:DisplayColor>
      </gpxx:TrackExtension>
    </extensions>
    <trkseg>
      <trkpt lat="35.5951000" lon="-82.5515000" />
      <trkpt lat="35.5942100" lon="-82.5498300" />
      <!-- dense polyline sliced from data/parkway.json -->
    </trkseg>
  </trk>
</gpx>
```

## Do NOT emit

- `<gpxx:rpt>` ghost points — discarded on recalculation, the classic trap
- `<time>` on rtepts — noise
- `AdventurousLevel` or TripExtensions **v2** — the XT and XT2 don't understand them
- More than one `<rte>` per file

## Validation checklist for the exporter's unit tests

- [ ] Total `<rtept>` ≤ 50
- [ ] `<rtept>` carrying `trp:ViaPoint` ≤ 25
- [ ] Every `<rtept>` has either `trp:ViaPoint` or `trp:ShapingPoint` — never neither (bare rtept defaults to via)
- [ ] `<trkpt>` ≤ 10,000
- [ ] Route name ASCII, ≤ 30 chars, no punctuation beyond `-` `_`
- [ ] File parses against the GPX 1.1 schema
- [ ] UTF-8, no BOM
- [ ] A `<wpt>` exists for every via point, at identical coordinates
- [ ] No shaping point falls within 100 m of a junction node
- [ ] No point falls inside a closed Parkway segment from data/closures.json
