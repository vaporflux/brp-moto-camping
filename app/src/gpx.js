/* GPX 1.1 export. Mirrors build/brp/gpx.py and build/brp/gpxval.py.
 *
 * A GPX route is not a path. It is a list of points plus two hints, and the device
 * recomputes the roads between them using its own settings. Everything here follows from
 * that: geometry rides on SHAPING points (gpxx:rpt ghost points are discarded the moment
 * anything recalculates), every rtept is explicitly typed (a bare rtept defaults to a via
 * point), and a <trk> ships alongside in a contrasting colour so the rider can see
 * instantly if the route has wandered.
 */
const Gpx = (() => {
  const GPX_NS = 'http://www.topografix.com/GPX/1/1';
  const GPXX_NS = 'http://www.garmin.com/xmlschemas/GpxExtensions/v3';
  const TRP_NS = 'http://www.garmin.com/xmlschemas/TripExtensions/v1';
  const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
  // Null map handle: stops the device substituting map-database names for yours.
  const NULL_SUBCLASS = '000000000000FFFFFFFFFFFFFFFFFFFFFFFF';

  const SYMBOLS = {
    fuel: 'Gas Station', campground: 'Campground', town: 'City (Small)',
    start: 'Flag, Green', end: 'Flag, Red', pin: 'Flag, Blue'
  };

  const esc = s => String(s).replace(/[<>&'"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

  /* ASCII, <= limit chars, no punctuation beyond - and _ (GPX-REFERENCE checklist). */
  function safeName(text, limit = 30) {
    return String(text).normalize('NFKD').replace(/[^\x00-\x7F]/g, '')
      .replace(/[^A-Za-z0-9 _-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit).trim();
  }

  const header = title =>
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="BRP Trip Planner"\n' +
    `     xmlns="${GPX_NS}"\n     xmlns:xsi="${XSI_NS}"\n` +
    `     xmlns:gpxx="${GPXX_NS}"\n     xmlns:trp="${TRP_NS}"\n` +
    `     xsi:schemaLocation="${GPX_NS} ${GPX_NS}/gpx.xsd\n` +
    `       ${GPXX_NS} http://www8.garmin.com/xmlschemas/GpxExtensionsv3.xsd\n` +
    `       ${TRP_NS} http://www8.garmin.com/xmlschemas/TripExtensionsv1.xsd">\n` +
    `  <metadata><name>${esc(title)}</name></metadata>`;

  function wpt(p) {
    const sym = SYMBOLS[p.kind] || 'Flag, Blue';
    const cmt = p.comment || '';
    return [
      `  <wpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`,
      `    <name>${esc(safeName(p.name))}</name>`,
      ...(cmt ? [`    <cmt>${esc(String(cmt).slice(0, 200))}</cmt>`] : []),
      `    <sym>${sym}</sym>`, '    <type>user</type>', '    <extensions>',
      `      <gpxx:WaypointExtension xmlns:gpxx="${GPXX_NS}">`,
      '        <gpxx:DisplayMode>SymbolAndName</gpxx:DisplayMode>',
      '      </gpxx:WaypointExtension>', '    </extensions>', '  </wpt>'
    ].join('\n');
  }

  function rtept(p) {
    const lines = [`      <rtept lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">`];
    if (p.name) lines.push(`        <name>${esc(safeName(p.name))}</name>`);
    if (p.type === 'via') lines.push(`        <sym>${SYMBOLS[p.kind] || 'Flag, Blue'}</sym>`);
    lines.push('        <extensions>');
    if (p.type === 'via') {
      lines.push('          <trp:ViaPoint>',
                 '            <trp:CalculationMode>FasterTime</trp:CalculationMode>',
                 '            <trp:ElevationMode>Standard</trp:ElevationMode>',
                 '          </trp:ViaPoint>');
    } else {
      lines.push('          <trp:ShapingPoint />');
    }
    lines.push('          <gpxx:RoutePointExtension>',
               `            <gpxx:Subclass>${NULL_SUBCLASS}</gpxx:Subclass>`,
               '          </gpxx:RoutePointExtension>',
               '        </extensions>', '      </rtept>');
    return lines.join('\n');
  }

  /* One <trkseg> per continuous run.
   *
   * A ride off the Parkway and back is genuinely discontinuous from the Parkway line, and
   * GPX has segments for exactly that. Flattening them into one <trkseg> draws a straight
   * line from wherever the Parkway ended to wherever the road leg started -- on the device
   * as well as on the map. */
  const trk = (name, runs, colour = 'Blue') => {
    const segs = (Array.isArray(runs[0]?.[0]) ? runs : [runs]).filter(r => r && r.length > 1);
    return ['  <trk>', `    <name>${esc(safeName(name + ' track', 40))}</name>`,
      '    <extensions>', '      <gpxx:TrackExtension>',
      `        <gpxx:DisplayColor>${colour}</gpxx:DisplayColor>`,
      '      </gpxx:TrackExtension>', '    </extensions>',
      ...segs.map(seg => ['    <trkseg>',
        seg.map(p => `        <trkpt lat="${p[0].toFixed(7)}" lon="${p[1].toFixed(7)}" />`).join('\n'),
        '    </trkseg>'].join('\n')),
      '  </trk>'].join('\n');
  };

  function exportRoute(day, routeName, title) {
    const name = safeName(routeName);
    const vias = day.rtepts.filter(p => p.type === 'via');
    return [
      header(title || routeName), ...vias.map(wpt), '  <rte>',
      `    <name>${esc(name)}</name>`, '    <extensions>', '      <trp:Trip>',
      '        <trp:TransportationMode>Motorcycling</trp:TransportationMode>',
      '      </trp:Trip>', '      <gpxx:RouteExtension>',
      '        <gpxx:IsAutoNamed>false</gpxx:IsAutoNamed>',
      '        <gpxx:DisplayColor>Magenta</gpxx:DisplayColor>',
      '      </gpxx:RouteExtension>', '    </extensions>',
      day.rtepts.map(rtept).join('\n'), '  </rte>', trk(name, day.trackSegments || day.track), '</gpx>\n'
    ].join('\n');
  }

  /* Track + waypoints, no route. Cannot be recalculated because there is nothing to
   * recalculate; imports everywhere; convertible to a route on-device. */
  function exportTrackOnly(day, routeName, title) {
    const name = safeName(routeName);
    return [header((title || routeName) + ' (track)'),
            ...day.rtepts.filter(p => p.type === 'via').map(wpt),
            trk(name, day.trackSegments || day.track), '</gpx>\n'].join('\n');
  }

  function exportWaypointsOnly(day, routeName, title) {
    return [header((title || routeName) + ' (waypoints)'),
            ...day.rtepts.filter(p => p.type === 'via').map(wpt), '</gpx>\n'].join('\n');
  }

  /* ---- validation ----------------------------------------------------------------
   * SPEC 8 asks for the point budget "enforced not just warned". The page runs this over
   * every file before offering it, and refuses the download if anything errors. */
  function validate(xmlText) {
    const out = [];
    const err = (check, detail) => out.push({ level: 'error', check, detail });

    if (xmlText.charCodeAt(0) === 0xFEFF) err('no BOM', 'file begins with a UTF-8 BOM');
    let doc;
    try {
      doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    } catch (e) { err('well-formed XML', String(e)); return out; }
    if (doc.querySelector('parsererror')) {
      err('well-formed XML', doc.querySelector('parsererror').textContent.slice(0, 120));
      return out;
    }

    const rtes = [...doc.getElementsByTagNameNS(GPX_NS, 'rte')];
    if (rtes.length > 1) err('one rte per file', `found ${rtes.length}`);
    if (doc.getElementsByTagNameNS(GPXX_NS, 'rpt').length) {
      err('no gpxx:rpt ghost points', 'discarded on recalculation — the classic trap');
    }
    if (xmlText.includes('TripExtensions/v2')) err('TripExtensions v1 only', 'v2 namespace present');
    if (xmlText.includes('AdventurousLevel')) err('no AdventurousLevel', 'not understood by target devices');

    const rtepts = [...doc.getElementsByTagNameNS(GPX_NS, 'rtept')];
    const vias = [], untyped = [];
    for (const p of rtepts) {
      const hasVia = p.getElementsByTagNameNS(TRP_NS, 'ViaPoint').length > 0;
      const hasShape = p.getElementsByTagNameNS(TRP_NS, 'ShapingPoint').length > 0;
      if (hasVia && hasShape) err('point typed once', 'carries both ViaPoint and ShapingPoint');
      else if (hasVia) vias.push(p);
      else if (!hasShape) untyped.push(p);
    }
    if (untyped.length) {
      err('every rtept is typed',
          `${untyped.length} bare rtept(s) — a bare rtept DEFAULTS TO A VIA POINT`);
    }
    if (rtepts.length > Router.MAX_TOTAL_RTEPT) err('total rtept <= 50', `${rtepts.length}`);
    if (vias.length > Router.MAX_VIA_RTEPT) err('via rtept <= 25', `${vias.length}`);
    const trkpts = doc.getElementsByTagNameNS(GPX_NS, 'trkpt');
    if (trkpts.length > 10000) err('trkpt <= 10000', `${trkpts.length}`);

    for (const rte of rtes) {
      const nm = rte.getElementsByTagNameNS(GPX_NS, 'name')[0];
      const name = nm ? nm.textContent : '';
      if (!name) { err('route name present', 'missing'); continue; }
      if (name.length > 30) err('route name <= 30 chars', `${name.length}: ${name}`);
      if (!/^[A-Za-z0-9 _-]+$/.test(name)) err('route name ASCII, only - and _', name);
    }

    const wptKeys = new Set([...doc.getElementsByTagNameNS(GPX_NS, 'wpt')].map(
      w => `${(+w.getAttribute('lat')).toFixed(5)},${(+w.getAttribute('lon')).toFixed(5)}`));
    for (const p of vias) {
      const key = `${(+p.getAttribute('lat')).toFixed(5)},${(+p.getAttribute('lon')).toFixed(5)}`;
      if (!wptKeys.has(key)) {
        const nm = p.getElementsByTagNameNS(GPX_NS, 'name')[0];
        err('a wpt exists for every via point', `none for ${nm ? nm.textContent : key}`);
      }
    }

    // Only points ON the Parkway are subject to the closure test. A campground or pump is
    // legitimately off the road; its milepost is an access point, not a location.
    for (const p of rtepts) {
      const lat = +p.getAttribute('lat'), lon = +p.getAttribute('lon');
      const near = BRP.nearestVertex(lat, lon);
      if (near.distance > 0.25) continue;
      if (!BRP.isOpen(near.mp)) {
        const nm = p.getElementsByTagNameNS(GPX_NS, 'name')[0];
        err('no point inside a closed segment',
            `${nm ? nm.textContent : '?'} at MP ${near.mp.toFixed(1)}`);
      }
    }
    return out;
  }

  const filename = (prefix, dayNo, label, suffix = '') =>
    `${safeName(`${prefix}-D${dayNo}-${label}`, 30).replace(/ /g, '-')}${suffix}.gpx`;

  return { exportRoute, exportTrackOnly, exportWaypointsOnly, validate, filename, safeName };
})();
