/* UI: trip state, rendering, map. Everything routing- or GPX-related lives in
 * route.js / gpx.js, which mirror the Python reference implementation under build/.
 * Keep this file about presentation and interaction.
 */
(() => {
  const D = BRP.data;
  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const STORE_KEY = 'brp-trip-v2';
  const state = {
    name: 'Blue Ridge Parkway',
    stops: [],            // ordered; each carries dayBreakAfter
    maxMilesPerDay: 180,
    maxFuelDetourMi: 8,
    tankMi: 200,              // usable miles on a tank. NOT a GSA assumption.
    start: null,              // {lat, lon, label} — where the rider actually begins
    accessMp: null,           // chosen Parkway entry; null = let the planner pick
    finish: 'home',           // 'home' = round trip, 'other' = a different end point
    endPoint: null,           // {lat, lon, label} when finish === 'other'
    stayKind: 'all',          // all | campground | hotel
    stayShowers: false,        // only places TAGGED as having showers
    stayToilets: false,
    stayWithinMi: 15,          // miles off the Parkway
    previewId: null,           // place shown on the map but not yet committed
    googleResults: null,       // live Google Places hits, never persisted
    googleNote: null,          // what the last Google search found, and what got filtered
    roadStatus: null,          // shown while road legs are being fetched
    tab: 'plan',
    filters: { campground: true, fuel: true, motoOnly: false, topOnly: false },
    search: '',
    showClosed: true,
    checklist: {},
    device: 'xt2'
  };

  /* ---- persistence -------------------------------------------------------- */
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        name: state.name, stops: state.stops, maxMilesPerDay: state.maxMilesPerDay,
        maxFuelDetourMi: state.maxFuelDetourMi, checklist: state.checklist,
        device: state.device, tankMi: state.tankMi,
        start: state.start, accessMp: state.accessMp,
        finish: state.finish, endPoint: state.endPoint,
        stayWithinMi: state.stayWithinMi,
        // Cached road geometry rides along with the trip. Routing needs signal; riding
        // does not, so a trip planned at home keeps its real roads in a dead zone.
        roads: Directions.dump()
      }));
    } catch (e) { /* private mode: the trip still works, it just will not persist */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        Directions.seed(saved.roads);
        delete saved.roads;
        Object.assign(state, saved);
      }
    } catch (e) { /* ignore corrupt state rather than trap the user on a broken page */ }
  }

  /* ---- day assembly ------------------------------------------------------- */

  /* Days are the user's explicit breaks. autoSplit() proposes breaks by mileage, but it
   * never overrides one the rider set — where you sleep is a decision about campsites and
   * daylight, not something a mileage heuristic should quietly rewrite. */
  /* The stop list the router actually sees. When a start address is set, the rider's home
   * leads it -- carrying the access point's milepost so Parkway slicing begins at the
   * entry, and the approach distance as its off-Parkway leg. The exported GPX then starts
   * at the house rather than dumping the rider onto the Parkway from nowhere. */
  function routeStops() {
    const trip = itinerary();
    if (!trip || trip.error || !state.start) return state.stops;
    return [{
      id: 'start', mp: trip.chosen.mp, lat: state.start.lat, lon: state.start.lon,
      kind: 'start', name: 'Start', label: state.start.label,
      comment: `Start - ride to MP ${trip.chosen.mp} ${trip.chosen.name}`,
      offParkwayMi: trip.chosen.approachMi, dayBreakAfter: false
    }, ...state.stops];
  }

  function dayGroups() {
    const groups = [];
    let cur = [];
    routeStops().forEach((s, i) => {
      cur.push(s);
      if (s.dayBreakAfter && i < routeStops().length - 1) { groups.push(cur); cur = [s]; }
    });
    if (cur.length) groups.push(cur);
    return groups.filter(g => g.length >= 1);
  }

  /* Fold real road geometry into an exported day.
   *
   * A day built from mileposts alone carries nothing for the legs that leave the Parkway.
   * Where the router has given us roads, this adds shaping points along them and appends
   * the geometry to the track, so the GPX says which way to go instead of leaving it to
   * the device. Budget is respected: off-Parkway points are capped and dropped first if a
   * day is tight, because the Parkway points are the ones that stop an interstate detour.
   */
  function withRoadGeometry(day, trip) {
    if (!trip || trip.error || !day || !day.rtepts) return day;
    const extras = [];
    const trackAdds = [];
    (trip.roadLegs || []).forEach(leg => {
      const road = Directions.peek(leg.from, leg.to);
      if (!road || !road.ok || !road.polyline || road.polyline.length < 3) return;
      trackAdds.push(road.polyline);
      // Name by where the leg is going, not by the leg's sentence: "SP Ride in to M 1"
      // is what a truncated label looks like on the device.
      // safeName strips the period out of "MP 382.5", so name these by what they do.
      const target = leg.stop ? leg.stop.name
                   : leg.id === 'in' ? 'to Parkway' : 'to finish';
      // The ride in and out are ordinary roads the device handles well, so they get a
      // light touch. The hop off the Parkway to a campsite is short, easy to get wrong,
      // and worth spending points on.
      const maxPts = leg.stop ? 6 : 4;
      Router.shapeOffParkway(road.polyline, 3, maxPts).forEach((pt, i) => {
        extras.push({ ...pt, mp: null,
                      legId: leg.id === 'in' || leg.id === 'out' ? leg.id : 'off',
                      stopId: leg.stop ? leg.stop.id : null,
                      name: `SP ${Gpx.safeName(target, 14)} ${i + 1}` });
      });
    });
    if (!extras.length && !trackAdds.length) return day;

    const room = Router.MAX_TOTAL_RTEPT - day.nTotal;
    const kept = extras.slice(0, Math.max(0, room));
    const merged = { ...day };
    if (kept.length) {
      // Travel order is not negotiable. Points for the ride IN belong before the first
      // via; points for a hop off the Parkway belong just before the stop they serve;
      // points for the ride OUT belong at the end. Appending them all -- which an earlier
      // version did whenever the name match missed -- routes the rider to the campground
      // and then back down their own driveway.
      const pts = [...day.rtepts];
      const anchorIndex = leg => {
        // After the start via, not before it: the rider leaves home first, then follows
        // these roads to the Parkway.
        if (leg.legId === 'in') return 1;
        if (leg.legId === 'out') return pts.length;
        const at = pts.findIndex(r => r.type === 'via' && r.id === leg.stopId);
        return at >= 0 ? at : pts.length;
      };
      // Insert from the back so earlier indices stay valid.
      const groups = [...new Set(kept.map(k => k.legId))]
        .map(id => ({ legId: id, stopId: kept.find(k => k.legId === id).stopId,
                      points: kept.filter(k => k.legId === id) }))
        .sort((a, b) => anchorIndex(b) - anchorIndex(a));
      groups.forEach(g => pts.splice(anchorIndex(g), 0, ...g.points));
      merged.rtepts = pts;
      merged.nTotal = pts.length;
      merged.nVia = pts.filter(r => r.type === 'via').length;
    }
    if (trackAdds.length) {
      merged.track = [...day.track];
      trackAdds.forEach(poly => merged.track.push(...poly));
    }
    merged.roadGeometry = trackAdds.length;
    merged.droppedOffParkwayPoints = extras.length - kept.length;
    return merged;
  }

  function buildDays() {
    // Fuel gaps are a property of the whole trip, not of a day (see tripFuelGaps).
    // Each gap is attributed to the day its run begins in.
    const allStops = routeStops();
    const gaps = allStops.length ? Router.tripFuelGaps(allStops, state.maxFuelDetourMi) : [];
    const groups = dayGroups();
    // Consecutive days share their overnight stop, so a gap beginning at that milepost
    // matches both. Assign each gap once, to the earliest day it starts in.
    const claimed = new Set();
    const gapForDay = i => {
      const g = groups[i];
      if (!g || !g.length) return null;
      const lo = Math.min(...g.map(s => s.mp)), hi = Math.max(...g.map(s => s.mp));
      const mine = gaps
        .filter(x => !claimed.has(x) && x.from.mp >= lo - 0.05 && x.from.mp < hi + 0.05)
        .sort((a, b) => b.gapMi - a.gapMi);
      if (!mine.length) return null;
      claimed.add(mine[0]);
      return mine[0];
    };
    return groups.map((stops, i) => {
      if (stops.length < 2) {
        return { index: i + 1, stops, error: 'Needs at least two stops.', routes: [] };
      }
      try {
        const trip = itinerary();
        const routes = Router.splitDay(stops).map(r => withRoadGeometry(r, trip));
        const worst = gapForDay(i);
        const totalMi = routes.reduce((a, r) => a + r.totalMi, 0);
        const warnings = routes.flatMap(r => r.warnings);
        if (totalMi > state.maxMilesPerDay) {
          warnings.unshift({
            level: 'warn',
            text: `${totalMi.toFixed(0)} mi exceeds your ${state.maxMilesPerDay} mi/day limit.`
          });
        }
        if (worst && worst.gapMi > 40) {
          // Only an error if the rider's tank cannot span it. Otherwise it is context.
          const spanned = worst.gapMi <= state.tankMi;
          warnings.unshift({
            level: spanned ? 'info' : 'error',
            text: spanned
              ? `Longest stretch with no reachable fuel is ${worst.gapMi} mi `
                + `(MP ${worst.from.mp.toFixed(1)} → ${worst.to.mp.toFixed(1)}). Your `
                + `${state.tankMi} mi tank covers it.`
              : `${worst.gapMi} mi with no fuel inside a ${state.maxFuelDetourMi} mi detour `
                + `(MP ${worst.from.mp.toFixed(1)} → ${worst.to.mp.toFixed(1)}), and your `
                + `${state.tankMi} mi tank does not span it. Carry fuel or raise the detour limit.`
          });
        } else if (worst && worst.gapMi > 25) {
          warnings.unshift({
            level: 'warn',
            text: `Longest fuel gap ${worst.gapMi} mi (MP ${worst.from.mp.toFixed(1)} → `
                + `${worst.to.mp.toFixed(1)}).`
          });
        }
        return { index: i + 1, stops, routes, totalMi, warnings, worstGap: worst };
      } catch (e) {
        return { index: i + 1, stops, error: e.message, routes: [] };
      }
    });
  }

  /* The journey as the rider experiences it: home, then an entry onto the Parkway, then
   * the stops, with fuel worked out from their bike's range rather than assumed.
   *
   * Returns null until there is enough to compute — a start and at least one stop. */
  function itinerary() {
    if (!state.start || !state.stops.length) return null;
    const startLL = [state.start.lat, state.start.lon];
    const dest = state.stops[state.stops.length - 1];

    let options = [];
    try {
      // Always "soonest": the point of the trip is to be ON the Parkway, so the ride in
      // is overhead. Ranking by total distance can enter a hundred yards from the
      // campsite and ride no Parkway at all.
      options = Access.bestAccessPoints(startLL, state.stops[0].mp, 4, 'soonest');
    } catch (e) {
      return { error: e.message };
    }
    if (!options.length) {
      return { error: 'No Parkway access point can reach that campsite in 2026 — the '
                    + 'Helene closures have the Parkway in three disconnected pieces.' };
    }
    const chosen = (state.accessMp != null
      && options.find(o => Math.abs(o.mp - state.accessMp) < 0.05)) || options[0];

    // Where the ride finishes. Round trip goes home; otherwise a place they name. Either
    // way the rider stays on the Parkway until the nearest exit to that end point, so the
    // Parkway miles run as long as they can.
    const endLL = state.finish === 'other' && state.endPoint
      ? [state.endPoint.lat, state.endPoint.lon]
      : startLL;
    const shortLabel = t => String(t).split(',').slice(0, 2).join(',').trim();
    const endLabel = state.finish === 'other' && state.endPoint
      ? shortLabel(state.endPoint.label) : `home (${shortLabel(state.start.label)})`;
    let exitPoint = null;
    try {
      exitPoint = Access.bestExitPoints(endLL, dest.mp, 1)[0] || null;
    } catch (e) { exitPoint = null; }

    const component = BRP.componentForStop(state.stops[0]);
    const waypoints = [chosen.mp, ...state.stops.map(st => st.mp)];
    if (exitPoint) waypoints.push(exitPoint.mp);

    const fuel = Access.planJourney({
      waypoints, tankMi: state.tankMi, approachLegMi: chosen.approachMi,
      maxDetourMi: state.maxFuelDetourMi, component
    });

    const allNearest = Access.accessPoints()
      .map(p => ({ ...p, d: Access.approachMi(startLL, [p.lat, p.lon]) }))
      .sort((a, b) => a.d - b.d)[0];
    const severedNote = allNearest && allNearest.component !== chosen.component
      ? `Closer Parkway access exists at MP ${allNearest.mp}, but Hurricane Helene closures `
      + `mean that stretch cannot reach your campsite. This entry is the nearest one that `
      + `connects.`
      : null;

    // The legs a router has to answer for. Each is [from, to, label].
    const roadLegs = [];
    roadLegs.push({ id: 'in', from: [state.start.lat, state.start.lon],
                    to: [chosen.lat, chosen.lon],
                    label: `Ride in to MP ${chosen.mp}` });
    state.stops.forEach(st => {
      // Only stops that actually sit off the Parkway need a hop; one at MP 0.2 does not.
      if ((st.offParkwayMi || 0) < 0.3) return;
      const [plat, plon] = BRP.coordAtMp(st.mp);
      roadLegs.push({ id: `off-${st.id}`, from: [plat, plon], to: [st.lat, st.lon],
                      label: `Off the Parkway to ${st.name}`, stop: st });
    });
    if (exitPoint) {
      roadLegs.push({ id: 'out', from: [exitPoint.lat, exitPoint.lon], to: endLL,
                      label: `Ride out to ${endLabel}` });
    }

    return { chosen, options, fuel, dest, severedNote, exitPoint, endLabel, roadLegs,
             approachMi: chosen.approachMi,
             parkwayMi: fuel.parkwayMi != null ? fuel.parkwayMi : Math.abs(dest.mp - chosen.mp) };
  }

  function autoSplit() {
    state.stops.forEach(s => { s.dayBreakAfter = false; });
    let acc = 0;
    for (let i = 0; i < state.stops.length - 1; i++) {
      const a = state.stops[i], b = state.stops[i + 1];
      acc += Math.abs(b.mp - a.mp) + (a.offParkwayMi || 0) + (b.offParkwayMi || 0);
      if (acc >= state.maxMilesPerDay && i < state.stops.length - 2) {
        b.dayBreakAfter = true; acc = 0;
      }
    }
    render();
  }

  /* ---- stop list mutation -------------------------------------------------- */
  /* Insert at the milepost-ordered position rather than re-sorting the list. Sorting
   * would silently undo a manual reorder every time another stop is added, and manual
   * order is meaningful — an out-and-back up the Mt Mitchell spur is deliberately not in
   * milepost order. */
  function addStop(stop) {
    if (state.stops.some(s => s.id === stop.id)) return;
    const entry = { ...stop, dayBreakAfter: false };
    let at = state.stops.findIndex(s => s.mp > stop.mp);
    if (at === -1) at = state.stops.length;
    state.stops.splice(at, 0, entry);
    render();
  }
  const removeStop = i => { state.stops.splice(i, 1); render(); };
  function moveStop(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= state.stops.length) return;
    [state.stops[i], state.stops[j]] = [state.stops[j], state.stops[i]];
    render();
  }

  /* ---- rendering: plan ----------------------------------------------------- */
  /* The Plan tab answers one question: I am here, I want to camp there, what do I do?
   *
   * Two inputs and an itinerary. Everything the planner works out -- which access point,
   * where to buy fuel, how far each day runs -- is shown as a result, never as a choice
   * to make. An earlier version exposed access-point rankings and made the rider click
   * fuel stops onto the trip; that put the machinery in front of the answer.
   */
  function renderPlan() {
    const pane = $('#pane-plan');
    pane.textContent = '';
    pane.append(fieldStart(), fieldDestination(), fieldLimits(), fieldFinish());
    pane.append(sectionItinerary());
  }

  /* ---- input 1: where you start ------------------------------------------------- */
  function fieldStart() {
    const sec = el('div', 'section');
    sec.append(stepHead('1', 'Starting from'));

    if (state.start) {
      const row = el('div', 'picked');
      const body = el('div', 's-body');
      body.append(el('div', 's-name', state.start.label));
      row.append(body);
      const clear = el('button', 'icon-btn danger', '\u2715');
      clear.title = 'Change starting point';
      clear.onclick = () => { state.start = null; state.accessMp = null; render(); };
      row.append(clear);
      sec.append(row);
      return sec;
    }

    const row = el('div', 'btn-row');
    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Your address or town';
    input.setAttribute('aria-label', 'Starting address');
    const go = el('button', 'btn sm', 'Find');
    go.style.flex = '0 0 auto';
    row.append(input, go);
    sec.append(row);

    const status = el('div', 'tiny');
    status.style.marginTop = '7px';
    const results = el('div');
    sec.append(status, results);

    const setStart = place => {
      state.start = { lat: place.lat, lon: place.lon, label: place.label };
      state.accessMp = null;
      render();
    };
    const lookup = async () => {
      const q = input.value.trim();
      if (!q) return;
      results.textContent = '';
      status.textContent = 'Looking up\u2026';
      try {
        const hits = await Geocode.search(q);
        status.textContent = '';
        if (!hits.length) { status.textContent = 'Nothing found. Try a town name.'; return; }
        if (hits.length === 1) { setStart(hits[0]); return; }
        hits.forEach(h => {
          const b = el('button', 'row');
          const body = el('div', 'body');
          body.append(el('div', 'name', h.label.split(',').slice(0, 2).join(',')));
          body.append(el('div', 'meta', h.label));
          b.append(body);
          b.onclick = () => setStart(h);
          results.append(b);
        });
      } catch (e) {
        status.textContent = 'Address lookup needs a connection. With no signal, tap the map '
                           + 'to drop a pin, or type coordinates as "lat, lon".';
      }
    };
    go.onclick = lookup;
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } };

    const alt = el('div', 'btn-row');
    alt.style.marginTop = '8px';
    const here = el('button', 'btn sm ghost', 'Use my location');
    here.onclick = () => {
      if (!navigator.geolocation) { status.textContent = 'This browser has no location access.'; return; }
      status.textContent = 'Getting your location\u2026';
      navigator.geolocation.getCurrentPosition(
        pos => setStart({ lat: pos.coords.latitude, lon: pos.coords.longitude,
                          label: `${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}` }),
        () => { status.textContent = 'Location denied or unavailable.'; },
        { timeout: 10000 });
    };
    alt.append(here);
    sec.append(alt);
    return sec;
  }

  /* ---- input 2: where you are staying -------------------------------------------
   *
   * Three sources feed this list and they are not interchangeable, so the row says which
   * one it came from. Curated entries are researched and verified; OSM entries are wide
   * but patchily tagged; Google entries are live and disappear when the signal does.
   *
   * Amenity filters are strict about a subtlety that matters: OSM records "has showers",
   * "no showers", and "nobody has said". Treating the third as "no" hides real campgrounds,
   * so filtering on showers keeps only places actually tagged yes, and everything else
   * shows its amenities as unknown rather than absent.
   */
  function fieldDestination() {
    const sec = el('div', 'section');
    sec.append(stepHead('2', 'Staying at'));

    state.stops.forEach((st, i) => {
      const row = el('div', 'picked');
      const body = el('div', 's-body');
      body.append(el('div', 's-name',
        `${st.name}${state.stops.length > 1 ? `  \u00b7  night ${i + 1}` : ''}`));
      body.append(el('div', 's-meta',
        `MP ${st.mp.toFixed(1)}${st.label ? ' \u00b7 ' + st.label : ''}`));
      row.append(body);
      const del = el('button', 'icon-btn danger', '\u2715');
      del.title = 'Remove this stop';
      del.onclick = () => removeStop(i);
      row.append(del);
      sec.append(row);
    });

    if (state.stops.length && !state.addingStop) {
      const more = el('button', 'btn sm ghost', '+ Add another night');
      more.style.marginTop = '8px';
      more.onclick = () => { state.addingStop = true; render(); };
      sec.append(more);
      return sec;
    }

    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Search by name, town or milepost\u2026';
    input.setAttribute('aria-label', 'Search places to stay');
    input.value = state.destQuery || '';
    sec.append(input);

    const kindRow = el('div', 'chip-row');
    kindRow.style.margin = '9px 0 6px';
    for (const [key, label] of [['all', 'Anywhere'], ['campground', 'Campgrounds'],
                                ['hotel', 'Hotels & motels']]) {
      const c = el('button', `chip${state.stayKind === key ? ' on' : ''}`, label);
      c.onclick = () => { state.stayKind = key; render(); };
      kindRow.append(c);
    }
    sec.append(kindRow);

    const amenityRow = el('div', 'chip-row');
    amenityRow.style.marginBottom = '6px';
    for (const [key, label, hint] of [
      ['stayShowers', 'Has showers', 'Only places recorded as having showers'],
      ['stayToilets', 'Has toilets', 'Only places recorded as having toilets']
    ]) {
      const c = el('button', `chip${state[key] ? ' on' : ''}`, label);
      c.title = hint;
      c.onclick = () => { state[key] = !state[key]; render(); };
      amenityRow.append(c);
    }
    sec.append(amenityRow);

    const distRow = el('div', 'chip-row');
    for (const mi of [2, 5, 10, 15, 999]) {
      const label = mi === 999 ? 'Any distance' : `Within ${mi} mi`;
      const c = el('button', `chip${state.stayWithinMi === mi ? ' on' : ''}`, label);
      c.title = 'Straight-line distance from the Parkway';
      c.onclick = () => { state.stayWithinMi = mi; render(); };
      distRow.append(c);
    }
    sec.append(distRow);

    const count = el('div', 'tiny');
    count.style.marginTop = '8px';
    const list = el('div', 'scroller');
    sec.append(count, list);

    const matches = () => {
      const q = (state.destQuery || '').trim().toLowerCase();
      const pool = [...(D.places || []), ...(state.googleResults || [])];
      return pool
        .filter(c => !state.stops.some(st => st.id === c.id))
        .filter(c => state.stayKind === 'all' || c.kind === state.stayKind)
        .filter(c => !state.stayShowers || c.showers === true)
        .filter(c => !state.stayToilets || c.toilets === true)
        .filter(c => (c.off_parkway_mi ?? 0) <= state.stayWithinMi)
        .filter(c => !q || c.name.toLowerCase().includes(q)
                        || String(c.mp).includes(q)
                        || (c.address || '').toLowerCase().includes(q)
                        || (c.food || '').toLowerCase().includes(q)
                        || (c.access || '').toLowerCase().includes(q));
    };

    const draw = () => {
      list.textContent = '';
      const rows = matches();
      const total = (D.places || []).length + (state.googleResults || []).length;
      count.textContent = `${rows.length} of ${total} places`
        + (D.has_osm ? '' : ' \u00b7 curated list only, run build/fetch_osm.py to widen it');
      if (!rows.length) {
        list.append(el('div', 'empty', 'Nothing matches. Loosen a filter, or widen the '
                                     + 'distance.'));
        return;
      }
      rows.slice(0, 300).forEach(c => {
        const b = el('button', 'row');
        b.append(el('div', 'mp', c.mp != null ? `MP ${c.mp.toFixed(0)}` : ''));
        const body = el('div', 'body');
        body.append(el('div', 'name', c.name));
        body.append(el('div', 'meta', [
          c.price, c.season, c.address,
          c.off_parkway_mi != null ? `${c.off_parkway_mi} mi off` : null
        ].filter(Boolean).join(' \u00b7 ')));
        const badges = el('div', 'badges');
        if (c.kind === 'hotel') badges.append(el('span', 'badge info', 'Lodging'));
        if (c.moto) badges.append(el('span', 'badge moto', 'Moto camp'));
        if (c.tier === 'top') badges.append(el('span', 'badge ok', 'Top pick'));
        if (c.showers === true) badges.append(el('span', 'badge ok', 'Showers'));
        else if (c.showers === false) badges.append(el('span', 'badge danger', 'No showers'));
        else badges.append(el('span', 'badge warn', 'Showers unknown'));
        if (c.source === 'osm') badges.append(el('span', 'badge', 'OSM'));
        if (c.source === 'google') badges.append(el('span', 'badge', 'Google'));
        if (badges.childElementCount) body.append(badges);
        b.append(body);
        if (state.previewId === c.id) b.classList.add('sel');
        // Tapping shows it ON THE MAP. The detail belongs where the rider is looking at
        // the location, not stacked in a sidebar where it pushes the list around and gets
        // lost. Committing is still a second, deliberate action, taken in the popup.
        b.onclick = () => { state.previewId = c.id; render(); previewOnMap(c); };
        list.append(b);
      });
    };
    input.oninput = e => { state.destQuery = e.target.value; draw(); };
    draw();

    sec.append(googleSearchRow());
    return sec;
  }

  /* The detail a list row cannot carry. Rendered into the map popup, anchored to the
   * place itself, so the rider reads it while looking at where it is. */
  function previewCard(c) {
    const card = el('div', 'preview');
    const head = el('div', 'preview-head');
    head.append(el('div', 's-name', c.name));
    head.append(el('div', 's-meta', [
      c.mp != null ? `Milepost ${c.mp.toFixed(1)}` : null,
      c.off_parkway_mi != null
        ? (c.off_parkway_mi < 0.3 ? 'right on the Parkway'
                                  : `${c.off_parkway_mi} mi off the Parkway`)
        : null,
      c.state
    ].filter(Boolean).join(' \u00b7 ')));
    card.append(head);

    const facts = [
      ['Price', c.price], ['Season', c.season], ['Address', c.address],
      ['Showers', c.showers === true ? 'Yes' : c.showers === false ? 'No'
                 : 'Not recorded — nobody has said either way'],
      ['Toilets', c.toilets === true ? 'Yes' : c.toilets === false ? 'No'
                 : 'Not recorded'],
      ['Getting in', c.access], ['Why it works', c.standout],
      ['Watch out', c.watchout], ['Food', c.food], ['Phone', c.phone]
    ].filter(([, v]) => v);
    const dl = el('dl', 'facts');
    facts.forEach(([k, v]) => {
      dl.append(el('dt', null, k));
      dl.append(el('dd', null, String(v)));
    });
    // The detail scrolls; the name above it and the buttons below it do not. On a phone
    // the map pane is under 400px tall, and a card that overflows it hides exactly the two
    // things the rider needs: what this place is, and how to say yes.
    const body = el('div', 'preview-body');
    body.append(dl);
    card.append(body);

    if (c.blocking_closure) {
      body.append(el('div', 'alert warn',
        `The Parkway is closed at MP ${c.mp.toFixed(1)} — ${c.blocking_closure.reason}. `
        + `You can still get here, but not straight off the Parkway.`));
    }
    body.append(el('div', 'tiny',
      c.source === 'curated' ? 'Researched and verified for this planner.'
      : c.source === 'osm' ? 'From OpenStreetMap. Details may be incomplete.'
      : 'From Google, this session only.'));

    const row = el('div', 'btn-row');
    row.style.marginTop = '10px';
    // Either button ends the decision, so the popup and its marker go with it. Leaving
    // an answered popup open on the map is clutter the rider has to dismiss by hand.
    const dismiss = () => {
      if (map) map.closePopup();
      if (layers.preview) layers.preview.clearLayers();
      state.previewId = null;
    };
    const add = el('button', 'btn primary', 'Stay here');
    add.onclick = () => {
      const stop = BRP.placeStop(c);
      dismiss();
      state.destQuery = '';
      state.addingStop = false;
      addStop(stop);
    };
    const shut = el('button', 'btn ghost', 'Not this one');
    shut.onclick = () => { dismiss(); render(); };
    row.append(add, shut);
    if (c.url) {
      const link = el('a', 'tiny');
      link.href = c.url; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = 'Open their website';
      link.style.cssText = 'display:block;margin-top:8px;color:var(--sky)';
      body.append(link);
    }
    card.append(row);
    return card;
  }

  function previewOnMap(c) {
    if (!map) return;
    // Not animated: Leaflet's popup auto-pan measures against the map's current position,
    // and while a setView animation is still running that position is stale -- so the
    // popup opens off the top of a short mobile map pane and the name is never seen.
    map.setView([c.lat, c.lon], Math.max(map.getZoom(), 11), { animate: false });
    layers.preview.clearLayers();
    // The full card goes in the popup as a live DOM node, so its buttons work and the
    // rider decides while looking at the location rather than at a sidebar.
    L.marker([c.lat, c.lon], { icon: dot('#e0a33e', 20) })
      .bindPopup(previewCard(c), {
        className: 'place-popup', maxWidth: 330, minWidth: 260,
        autoPan: true, autoPanPadding: [16, 16], keepInView: true, closeButton: true
      })
      .addTo(layers.preview)
      .openPopup();
    // Show how far off the Parkway it actually sits -- the thing a milepost hides.
    if (c.mp != null && (c.off_parkway_mi || 0) >= 0.3) {
      const [plat, plon] = BRP.coordAtMp(c.mp);
      L.polyline([[plat, plon], [c.lat, c.lon]],
                 { color: '#e0a33e', weight: 2, dashArray: '3 5', opacity: .9 })
        .addTo(layers.preview);
    }
  }

  /* Live Google Places lookup. Optional by design: it needs signal and a configured key,
   * and the rest of the planner does not. Results are session-only -- Google's terms
   * restrict retaining Places content, so nothing is written to localStorage or the
   * bundle. */
  function googleSearchRow() {
    const wrap = el('div');
    wrap.style.marginTop = '10px';
    const row = el('div', 'btn-row');
    const btn = el('button', 'btn sm ghost', 'Also search Google near this stretch');
    const status = el('div', 'tiny');
    status.style.marginTop = '6px';
    if (state.googleNote) status.textContent = state.googleNote;
    row.append(btn);
    if (state.googleResults) {
      const clear = el('button', 'btn sm ghost', 'Clear Google results');
      clear.onclick = () => { state.googleResults = null; state.googleNote = null; render(); };
      row.append(clear);
    }
    wrap.append(row, status);
    const hint = el('div', 'tiny');
    hint.style.marginTop = '4px';
    hint.textContent = 'Searches the Parkway nearest the middle of the map — pan the map to '
                     + 'look somewhere else.';
    wrap.append(hint);

    btn.onclick = async () => {
      // Anchor on the PARKWAY, near whatever the rider is looking at.
      //
      // This previously searched around the start address when no stop was picked yet,
      // which for a rider 90 miles away returned their own town's hotels -- every one of
      // which the "within N mi of the Parkway" filter then discarded. The button said
      // "near the Parkway" and searched nowhere near it, and the failure was silent.
      const centre = map ? map.getCenter() : null;
      const seed = state.stops.length
        ? BRP.coordAtMp(state.stops[state.stops.length - 1].mp)
        : centre ? [centre.lat, centre.lng]
        : state.start ? [state.start.lat, state.start.lon] : null;
      if (!seed) { status.textContent = 'Set a starting point first.'; return; }
      const near = BRP.nearestVertex(seed[0], seed[1]);
      const [lat, lon] = BRP.coordAtMp(near.mp);
      status.textContent = 'Searching Google\u2026';
      try {
        const type = state.stayKind === 'campground' ? 'campground' : 'lodging';
        const radius = Math.min(state.stayWithinMi, 25) * 1609;
        const res = await fetch(`/api/places?lat=${lat}&lon=${lon}`
                              + `&radius_m=${Math.round(radius)}&type=${type}`);
        const data = await res.json();
        if (!res.ok) { status.textContent = data.error || 'Google search failed.'; return; }
        const hits = (data.places || []).map(g => {
          const n = BRP.nearestVertex(g.lat, g.lon);
          return { ...g, id: `google-${g.id}`,
                   kind: type === 'campground' ? 'campground' : 'hotel',
                   mp: n.mp, off_parkway_mi: Math.round(n.distance * 100) / 100,
                   showers: null, toilets: null };
        }).sort((a, b) => a.off_parkway_mi - b.off_parkway_mi);
        state.googleResults = hits;
        // Say what the filters swallowed. A search that returns twenty results and shows
        // none looks broken, and looking broken is worse than being empty.
        const shown = hits.filter(h => h.off_parkway_mi <= state.stayWithinMi).length;
        state.googleNote = hits.length === 0
          ? 'Google found nothing there. Pan the map somewhere else and try again.'
          : shown === hits.length
          ? `Google found ${hits.length}, all within ${state.stayWithinMi} mi of the Parkway.`
          : `Google found ${hits.length}, but only ${shown} are within ${state.stayWithinMi} mi `
            + `of the Parkway. The nearest is ${hits[0].off_parkway_mi} mi off — widen the `
            + `distance filter to see the rest.`;
        render();
      } catch (e) {
        status.textContent = 'Google search needs a connection. Everything already listed '
                           + 'works offline.';
      }
    };
    return wrap;
  }

  /* ---- input 3: how you ride ---------------------------------------------------- */
  function fieldLimits() {
    const sec = el('div', 'section');
    sec.append(stepHead('3', 'How you ride'));

    const mk = (key, label, min, max, hint) => {
      const lab = el('label', 'field');
      lab.append(el('span', null, label));
      const inp = el('input');
      inp.type = 'number'; inp.min = min; inp.max = max; inp.value = state[key];
      inp.setAttribute('aria-label', label);
      inp.onchange = e => {
        const v = +e.target.value;
        if (!isNaN(v) && v >= min && v <= max) { state[key] = v; render(); }
        else { e.target.value = state[key]; }
      };
      lab.append(inp);
      if (hint) lab.append(el('span', 'tiny', hint));
      return lab;
    };

    const rowA = el('div', 'field-row');
    rowA.append(mk('tankMi', 'Miles on a tank', 20, 600));
    rowA.append(mk('maxMilesPerDay', 'Max miles / day', 20, 600));
    sec.append(rowA);
    const rowB = el('div', 'field-row');
    rowB.append(mk('maxFuelDetourMi', 'Furthest you will ride off the Parkway for fuel',
                   1, 30));
    sec.append(rowB);
    sec.append(el('p', 'tiny',
      'There is no fuel anywhere on the Parkway itself, so the detour limit decides which '
      + 'exits count. Raising it past 18 mi is what opens up MP 411.8 and closes the '
      + '49.5 mi Asheville-to-Balsam gap — at 36 mi of round trip.'));
    return sec;
  }

  /* ---- input 4: where the ride ends --------------------------------------------- */
  function fieldFinish() {
    const sec = el('div', 'section');
    sec.append(stepHead('4', 'Finishing at'));

    const chips = el('div', 'chip-row');
    for (const [key, label] of [['home', 'Back home (round trip)'],
                                ['other', 'Somewhere else']]) {
      const c = el('button', `chip${state.finish === key ? ' on' : ''}`, label);
      c.onclick = () => { state.finish = key; render(); };
      chips.append(c);
    }
    sec.append(chips);

    if (state.finish === 'other') {
      if (state.endPoint) {
        const row = el('div', 'picked');
        row.style.marginTop = '9px';
        const body = el('div', 's-body');
        body.append(el('div', 's-name', state.endPoint.label));
        row.append(body);
        const clear = el('button', 'icon-btn danger', '\u2715');
        clear.title = 'Change';
        clear.onclick = () => { state.endPoint = null; render(); };
        row.append(clear);
        sec.append(row);
      } else {
        const row = el('div', 'btn-row');
        row.style.marginTop = '9px';
        const input = el('input');
        input.type = 'text';
        input.placeholder = 'Address or town to finish at';
        input.setAttribute('aria-label', 'Finishing address');
        const go = el('button', 'btn sm', 'Find');
        go.style.flex = '0 0 auto';
        row.append(input, go);
        sec.append(row);
        const status = el('div', 'tiny');
        status.style.marginTop = '6px';
        sec.append(status);
        const lookup = async () => {
          const q = input.value.trim();
          if (!q) return;
          status.textContent = 'Looking up\u2026';
          try {
            const hits = await Geocode.search(q);
            if (!hits.length) { status.textContent = 'Nothing found.'; return; }
            state.endPoint = { lat: hits[0].lat, lon: hits[0].lon, label: hits[0].label };
            render();
          } catch (e) {
            status.textContent = 'Address lookup needs a connection. Type coordinates as '
                               + '"lat, lon" instead.';
          }
        };
        go.onclick = lookup;
        input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } };
      }
    }
    sec.append(el('p', 'tiny',
      'You stay on the Parkway until the nearest exit to wherever you are finishing, so '
      + 'the Parkway miles run as long as they can.'));
    return sec;
  }

  function stepHead(n, title) {
    const h = el('h2', 'step-head');
    const badge = el('span', 'step-num', n);
    h.append(badge, document.createTextNode(title));
    return h;
  }

  /* ---- the answer --------------------------------------------------------------- */
  function sectionItinerary() {
    const wrap = document.createDocumentFragment();
    if (!state.start || !state.stops.length) {
      const hint = el('div', 'empty');
      hint.append(el('p', null, !state.start
        ? 'Add where you are starting from, then pick a campground.'
        : 'Now pick where you are camping.'));
      wrap.append(hint);
      return wrap;
    }

    const trip = itinerary();
    const sec = el('div', 'section');
    sec.append(el('h2', null, 'Your ride'));
    if (!trip || trip.error) {
      sec.append(el('div', 'alert error', (trip && trip.error) || 'Could not plan this trip.'));
      wrap.append(sec);
      return wrap;
    }
    const c = trip.chosen, f = trip.fuel;

    // With no safety percentage held back, a plan can technically "work" while arriving
    // on fumes. Saying "no fuel stop needed" next to "arrive with 3 mi" is the kind of
    // true-but-dangerous pairing that strands people, so a thin margin is stated as the
    // headline rather than left in the detail line.
    const THIN_MI = 20;
    const thin = f.ok && !f.stops.length && f.arriveWithMi < THIN_MI;
    const summary = el('div', `alert ${thin ? 'warn' : 'ok'}`);
    let fuelLine;
    if (!f.ok) fuelLine = '';
    else if (f.stops.length) {
      fuelLine = `${f.stops.length} fuel stop${f.stops.length > 1 ? 's' : ''} on the way.`;
    } else if (thin) {
      fuelLine = `It fits on one tank, but only just — you arrive with about `
               + `${f.arriveWithMi} mi left. Fill up before MP ${c.mp}, or raise how far `
               + `you will ride off the Parkway for fuel.`;
    } else {
      fuelLine = `No fuel stop needed — you arrive with about ${f.arriveWithMi} mi to spare.`;
    }
    const rideOut = trip.exitPoint ? trip.exitPoint.rideOutMi : 0;
    summary.textContent = `~${c.approachMi} mi in, ${trip.parkwayMi} mi on the Parkway`
                        + (rideOut ? `, ~${rideOut} mi out` : '')
                        + `. ${fuelLine}`;
    sec.append(summary);
    if (trip.severedNote) sec.append(el('div', 'alert warn', trip.severedNote));
    wrap.append(sec);

    // The itinerary as a numbered list of things that happen, in order.
    const steps = el('div', 'day');
    steps.append(stepRow('HOME', state.start.label,
                         `Ride ~${c.approachMi} mi to the Parkway`));
    steps.append(stepRow(`MP ${c.mp}`, `Get on the Parkway — ${c.name}`,
                         'Closest entry from where you are starting'));
    if (f.ok) {
      f.stops.forEach(stop => {
        // Greedy planning rides each tank to its limit, which minimises stops but can
        // arrive on fumes. Say that plainly rather than printing a small number and
        // leaving the rider to notice.
        const tight = stop.arriveWithMi < 15;
        const detail = [
          stop.detourMi ? `${stop.detourMi} mi off the Parkway` : 'right at the exit',
          tight ? `cutting it fine — about ${stop.arriveWithMi} mi of planning range left`
                : `about ${stop.arriveWithMi} mi of range still in hand`
        ].join(' \u00b7 ');
        steps.append(stepRow(`MP ${stop.mp}`,
          `Fuel — ${[stop.road, stop.town].filter(Boolean).join(', ')}`,
          detail, (tight || stop.grade === 'unconfirmed') ? 'warn' : null));
      });
    }
    // Tank state at each waypoint comes from the journey simulation, so the figure shown
    // at camp is what the rider actually has for the morning -- campsites sell no fuel.
    const tankAt = (f.tankAt || []).reduce((m, t) => {
      (m[t.mp.toFixed(1)] = m[t.mp.toFixed(1)] || []).push(t.tankMi); return m;
    }, {});
    const takeTank = mp => {
      const k = mp.toFixed(1);
      return tankAt[k] && tankAt[k].length ? tankAt[k].shift() : null;
    };
    takeTank(c.mp);   // the entry waypoint

    state.stops.forEach((st, i) => {
      const t = takeTank(st.mp);
      const last = i === state.stops.length - 1;
      const detail = [
        last && !trip.exitPoint ? 'Arrive' : (last ? 'Camp here' : `Overnight ${i + 1}`),
        t != null ? `about ${t} mi of fuel in the tank` : null
      ].filter(Boolean).join(' \u00b7 ');
      steps.append(stepRow(`MP ${st.mp.toFixed(1)}`, st.name, detail, 'ok'));
    });

    // Leaving the Parkway, and the ride to wherever the trip finishes.
    if (trip.exitPoint) {
      const t = takeTank(trip.exitPoint.mp);
      steps.append(stepRow(`MP ${trip.exitPoint.mp}`,
        `Leave the Parkway — ${trip.exitPoint.name}`,
        [`${trip.exitPoint.parkwayMi} mi of Parkway from camp`,
         t != null ? `about ${t} mi of fuel left` : null].filter(Boolean).join(' \u00b7 ')));
      steps.append(stepRow('FINISH', trip.endLabel,
        `Ride ~${trip.exitPoint.rideOutMi} mi from the Parkway to here`, 'ok'));
    }
    wrap.append(steps);

    wrap.append(sectionDirections(trip));

    if (!f.ok) {
      const bad = el('div', 'section');
      bad.append(el('div', 'alert error', f.error));
      wrap.append(bad);
    } else {
      const notes = el('div', 'section');
      (f.notes || []).forEach(n => notes.append(el('div', 'alert warn', n)));
      buildDays().forEach(day => {
        (day.warnings || []).forEach(w => notes.append(el('div', `alert ${w.level}`, w.text)));
      });
      if (state.stops.length > 1) {
        notes.append(el('p', 'tiny', 'Each campground you add becomes an overnight.'));
      }
      if (notes.childElementCount) wrap.append(notes);
    }
    return wrap;
  }

  /* Directions for the whole trip, in order, with nothing gated behind a button.
   *
   * The Parkway legs need no router -- between junctions it has no alternatives -- so they
   * are written from the milepost model: which way to turn on joining, how far, and which
   * fuel exits pass on the way. The off-Parkway legs come from the routing service. A
   * rider reading top to bottom gets one continuous set of instructions from their door to
   * the campsite and back, which is the point.
   */
  function sectionDirections(trip) {
    const sec = el('div', 'section');
    sec.append(el('h2', null, 'Directions'));

    if (state.roadStatus) {
      sec.append(el('div', 'alert info', state.roadStatus));
    }

    const legs = trip.roadLegs || [];
    const failed = legs.filter(l => { const r = Directions.peek(l.from, l.to); return r && !r.ok; });

    // Interleave: ride in, then Parkway to each stop, the hop off to it, and out again.
    const seq = [];
    const legFor = id => legs.find(l => l.id === id);
    seq.push({ kind: 'road', leg: legFor('in') });
    let atMp = trip.chosen.mp;
    state.stops.forEach(st => {
      seq.push({ kind: 'parkway', from: atMp, to: st.mp, arriveAt: st });
      const off = legFor(`off-${st.id}`);
      if (off) seq.push({ kind: 'road', leg: off });
      atMp = st.mp;
    });
    if (trip.exitPoint) {
      // Name only, no milepost: the summary and the arrival line both prefix one, and
      // "Continue to MP 382.5 — MP 382.5 — US 70" is what happens when both do.
      seq.push({ kind: 'parkway', from: atMp, to: trip.exitPoint.mp,
                 arriveAt: { name: trip.exitPoint.name }, isExit: true });
      seq.push({ kind: 'road', leg: legFor('out') });
    }

    let n = 0;
    seq.forEach(item => {
      if (item.kind === 'parkway') {
        sec.append(parkwayLeg(++n, item, trip));
        return;
      }
      if (!item.leg) return;
      sec.append(roadLeg(++n, item.leg));
    });

    if (failed.length) {
      const box = el('div', 'alert warn');
      const first = Directions.peek(failed[0].from, failed[0].to);
      box.textContent = (first.hint || first.error || 'Road directions could not be fetched.')
        + ' Those legs show as straight-line estimates, and the exported GPX has no geometry '
        + 'for them — your device will pick its own way.';
      sec.append(box);
      const retry = el('button', 'btn sm ghost', 'Try the road directions again');
      retry.style.marginTop = '8px';
      retry.onclick = async () => {
        retry.disabled = true;
        // A failure is cached so a dead endpoint is not hammered; retrying has to clear it.
        failed.forEach(l => Directions.forget(l.from, l.to));
        await ensureRoads(trip);
      };
      sec.append(retry);
    }
    return sec;
  }

  /* A Parkway leg, written from the milepost model rather than fetched. */
  function parkwayLeg(n, item, trip) {
    const card = el('details', 'turns');
    card.open = true;
    const dist = Math.abs(item.to - item.from);
    const heading = item.to >= item.from ? 'south' : 'north';
    const sum = el('summary');
    sum.append(el('span', 's-name',
      `${n}. ${item.isExit ? 'Ride the Parkway to your exit at' : 'Ride the Parkway to'} `
      + `${item.arriveAt.name}`));
    sum.append(el('span', 's-meta', `${dist.toFixed(1)} mi \u00b7 MP ${item.from.toFixed(1)} `
      + `\u2192 ${item.to.toFixed(1)}`));
    card.append(sum);

    const ol = el('ol', 'turn-list');
    const join = el('li');
    join.append(document.createTextNode(
      `Join the Blue Ridge Parkway at MP ${item.from.toFixed(1)} and head ${heading}.`));
    ol.append(join);

    // Fuel and closures the rider passes, in travel order -- the two things that matter on
    // a road with no turns.
    const lo = Math.min(item.from, item.to), hi = Math.max(item.from, item.to);
    const passing = (trip.fuel.stops || []).filter(f => f.mp >= lo && f.mp <= hi);
    passing.sort((a, b) => heading === 'south' ? a.mp - b.mp : b.mp - a.mp);
    passing.forEach(f => {
      const li = el('li');
      li.append(document.createTextNode(
        `MP ${f.mp} — leave the Parkway for fuel at ${[f.road, f.town].filter(Boolean).join(', ')}`
        + `${f.detourMi ? ` (${f.detourMi} mi off, then back on)` : ''}.`));
      li.style.color = 'var(--warn)';
      ol.append(li);
    });
    (D.closures || []).filter(c => c.to_mp >= lo && c.from_mp <= hi).forEach(c => {
      const li = el('li');
      li.append(document.createTextNode(
        `MP ${c.from_mp}–${c.to_mp} — ${c.reason}. `
        + (c.detour ? `Follow the signed detour: ${c.detour}.` : 'No detour; the Parkway is severed here.')));
      li.style.color = 'var(--danger)';
      ol.append(li);
    });

    const arrive = el('li');
    arrive.append(document.createTextNode(item.isExit
      ? `Leave the Parkway at MP ${item.to.toFixed(1)} — ${item.arriveAt.name}.`
      : `Continue to MP ${item.to.toFixed(1)} — ${item.arriveAt.name}.`));
    ol.append(arrive);
    card.append(ol);
    return card;
  }

  /* An off-Parkway leg, from the routing service. */
  function roadLeg(n, leg) {
    const road = Directions.peek(leg.from, leg.to);
    const card = el('details', 'turns');
    card.open = true;
    const sum = el('summary');
    sum.append(el('span', 's-name', `${n}. ${leg.label}`));
    sum.append(el('span', 's-meta', road && road.ok
      ? `${road.distance_mi} mi \u00b7 about ${road.duration_min} min`
      : road ? 'no road route — straight-line estimate' : 'working it out\u2026'));
    card.append(sum);
    if (road && road.ok) {
      const ol = el('ol', 'turn-list');
      (road.legs || []).forEach(l => (l.steps || []).forEach(st => {
        const li = el('li');
        li.append(document.createTextNode(st.text));
        if (st.distance_mi) li.append(el('span', 'turn-dist', `${st.distance_mi} mi`));
        ol.append(li);
      }));
      card.append(ol.childElementCount ? ol
        : el('p', 'tiny', 'No turn list came back for this leg.'));
    } else {
      card.append(el('p', 'tiny', road
        ? 'No road route for this leg yet.'
        : 'Fetching the roads for this leg\u2026'));
    }
    return card;
  }

  function stepRow(marker, title, detail, level) {
    const node = el('div', 'stop');
    node.append(el('div', 'grip', marker));
    const body = el('div', 's-body');
    const name = el('div', 's-name', title);
    if (level === 'ok') name.style.color = 'var(--ok)';
    if (level === 'warn') name.style.color = 'var(--warn)';
    body.append(name);
    if (detail) body.append(el('div', 's-meta', detail));
    node.append(body);
    return node;
  }

  /* ---- rendering: browse --------------------------------------------------- */
  function renderBrowse() {
    const pane = $('#pane-browse');
    pane.textContent = '';

    const ctrl = el('div', 'section');
    const search = el('input');
    search.type = 'text'; search.placeholder = 'Search name, town, milepost…';
    search.value = state.search;
    search.oninput = e => { state.search = e.target.value; renderBrowse(); };
    ctrl.append(search);
    const chips = el('div', 'chip-row');
    chips.style.marginTop = '9px';
    for (const [key, label] of [['campground', 'Campgrounds'], ['fuel', 'Fuel'],
                                ['motoOnly', 'Moto camps'], ['topOnly', 'Top picks']]) {
      const c = el('button', `chip${state.filters[key] ? ' on' : ''}`, label);
      c.onclick = () => { state.filters[key] = !state.filters[key]; renderBrowse(); };
      chips.append(c);
    }
    ctrl.append(chips);
    pane.append(ctrl);

    const q = state.search.trim().toLowerCase();
    const match = t => !q || String(t).toLowerCase().includes(q);
    const list = el('div');

    if (state.filters.campground) {
      D.campgrounds
        .filter(c => !state.filters.motoOnly || c.moto)
        .filter(c => !state.filters.topOnly || c.tier === 'top')
        .filter(c => match(c.name) || match(c.mp) || match(c.access))
        .forEach(c => list.append(stopRow(BRP.asStop(c), c)));
    }
    if (state.filters.fuel && !state.filters.motoOnly) {
      D.fuel
        .filter(f => !state.filters.topOnly)
        .filter(f => match(f.town) || match(f.exit_road) || match(f.mp))
        .forEach(f => list.append(stopRow(BRP.asStop(f), f)));
    }
    const rows = [...list.children];
    rows.sort((a, b) => +a.dataset.mp - +b.dataset.mp).forEach(r => list.append(r));
    if (!rows.length) list.append(el('div', 'empty', 'Nothing matches those filters.'));
    pane.append(list);
  }

  /* Badges carry the two independent axes side by side. Confidence answers "does a pump
   * exist"; reachability answers "can I get there in 2026". SPEC 8 requires that an
   * unverified stop cannot be silently relied on, so it is never merged into one score. */
  function stopRow(stop, rec) {
    const node = el('button', 'row');
    node.dataset.mp = stop.mp;
    node.append(el('div', 'mp', `MP ${stop.mp.toFixed(1)}`));
    const body = el('div', 'body');
    body.append(el('div', 'name', stop.name));
    const bits = [];
    if (rec.kind === 'fuel') {
      bits.push(rec.town);
      if (rec.detour_plan_mi) bits.push(`${rec.detour_plan_mi} mi off`);
    } else {
      bits.push(rec.price, rec.season);
      if (rec.off_parkway_mi) bits.push(`${rec.off_parkway_mi} mi off`);
    }
    body.append(el('div', 'meta', bits.filter(Boolean).join(' · ')));

    const badges = el('div', 'badges');
    const add = (cls, text, title) => {
      const b = el('span', `badge ${cls}`, text);
      if (title) b.title = title;
      badges.append(b);
    };
    if (rec.kind === 'fuel') {
      const grade = {
        usable: ['ok', 'Fuel'], usable_via_detour: ['info', 'Via detour'],
        unconfirmed: ['warn', 'Unconfirmed'], do_not_rely: ['danger', 'Do not rely'],
        unreachable: ['danger', 'Unreachable']
      }[rec.plan_grade] || ['warn', rec.plan_grade];
      add(grade[0], grade[1], rec.warning || rec.closure_note || '');
      if (rec.confidence !== 'verified') add('warn', rec.confidence);
      if (rec.distance_conflict) {
        add('warn', 'distance?', 'Published and mapped station distances disagree for this exit.');
      }
    } else {
      if (rec.moto) add('moto', 'Moto camp');
      if (rec.tier === 'top') add('ok', 'Top pick');
      if (!rec.reachable_from_parkway) {
        add('info', 'Off-Parkway access',
            rec.blocking_closure ? `Parkway closed here: ${rec.blocking_closure.reason}` : '');
      }
    }
    body.append(badges);
    node.append(body);
    node.onclick = () => { addStop(stop); flyTo(stop); };
    return node;
  }

  /* ---- rendering: export --------------------------------------------------- */
  function renderExport() {
    const pane = $('#pane-export');
    pane.textContent = '';
    const days = buildDays();

    if (!state.stops.length) {
      pane.append(el('div', 'empty', 'Build a trip first.'));
      return;
    }

    days.forEach(day => {
      const card = el('div', 'day');
      const head = el('header');
      head.append(el('div', 'day-name', `Day ${day.index}`));
      card.append(head);
      if (day.error) {
        card.append(el('div', 'alert error', day.error));
        pane.append(card);
        return;
      }
      day.routes.forEach((route, k) => {
        const suffix = day.routes.length > 1 ? String.fromCharCode(97 + k) : '';
        const prefix = `BRP D${day.index}${suffix} `;
        const label = dayLabel(day, 30 - prefix.length);
        const routeName = Gpx.safeName(prefix + label);
        const xml = Gpx.exportRoute(route, routeName);
        const problems = Gpx.validate(xml);

        const block = el('div', 'stop');
        const body = el('div', 's-body');
        body.append(el('div', 's-name', routeName));
        body.append(el('div', 's-meta',
          `${route.nTotal}/${Router.MAX_TOTAL_RTEPT} pts · ${route.nVia}/${Router.MAX_VIA_RTEPT} via · `
          + `${route.track.length} trkpt · max gap ${route.maxUnprotectedSpanMi} mi`));
        block.append(body);
        card.append(block);

        if (problems.length) {
          // SPEC 8: enforced, not warned. A file that fails validation is not offered.
          problems.forEach(p => card.append(el('div', 'alert error', `${p.check}: ${p.detail}`)));
        } else {
          const btns = el('div', 'btn-row');
          btns.style.padding = '9px 12px';
          const dl = (text, content, fname) => {
            const b = el('button', 'btn sm', text);
            b.onclick = () => download(fname, content);
            return b;
          };
          btns.append(dl('Route + track', xml,
            Gpx.filename('BRP', day.index + suffix, label)));
          btns.append(dl('Track only', Gpx.exportTrackOnly(route, routeName),
            Gpx.filename('BRP', day.index + suffix, label, '-track')));
          btns.append(dl('Waypoints', Gpx.exportWaypointsOnly(route, routeName),
            Gpx.filename('BRP', day.index + suffix, label, '-wpt')));
          card.append(btns);
        }
      });
      pane.append(card);
    });

    const share = el('div', 'section');
    share.append(el('h2', null, 'Share this trip'));
    share.append(el('p', 'tiny', 'JSON round-trips the whole plan — send it to the group.'));
    const btns = el('div', 'btn-row');
    const exp = el('button', 'btn sm ghost', 'Export JSON');
    exp.onclick = () => download(`${Gpx.safeName(state.name, 40) || 'brp-trip'}.json`,
      JSON.stringify({ name: state.name, stops: state.stops,
                       maxMilesPerDay: state.maxMilesPerDay,
                       maxFuelDetourMi: state.maxFuelDetourMi }, null, 1));
    const imp = el('button', 'btn sm ghost', 'Import JSON');
    imp.onclick = () => $('#importer').click();
    btns.append(exp, imp);
    share.append(btns);
    pane.append(share);

    pane.append(deviceHelper(), riderChecklist());
  }

  /* SPEC 6: he does not know which device he has, and the transfer paths differ in ways
   * that matter. This identifies it from the menus, with no computer involved. */
  function deviceHelper() {
    const sec = el('div', 'section');
    sec.append(el('h2', null, 'Device'));
    const sel = el('select');
    const DEVICES = {
      xt: ['Garmin zumo XT', 'Menus offer "Trip Planner"',
           'Internal storage → GPX folder, or SD card → \\Garmin\\GPX\\. Then Trip Planner → Import.'],
      xt2: ['Garmin zumo XT2', 'Has Collections, pairs with the Tread app',
            'Internal or SD → GPX folder at root. Do NOT use the Tread app — its cloud sync '
            + 'discards shaping points and silently converts routes over 62 points to tracks.'],
      nav6: ['BMW Navigator VI', 'Menus offer "Trip Planner" (rebadged zumo 595)',
             '\\Garmin\\GPX\\. Prefer the SD card — routes imported from internal storage are '
             + 'destroyed by "Delete route".'],
      crn: ['BMW ConnectedRide Navigator', 'Menus offer "Route import" and mention anchor points',
            'USB-C → the folder named Routes (not GPX). Then Routes → Options → Route import; '
            + 'choose anchor points for shaping, waypoints for named stops. Needs firmware '
            + '20240819-V1.0.4 or newer. Invisible to all Garmin software.']
    };
    for (const [k, v] of Object.entries(DEVICES)) sel.append(new Option(v[0], k));
    sel.value = state.device;
    const out = el('div', 'muted');
    out.style.marginTop = '9px';
    const show = () => {
      out.textContent = '';
      const d = DEVICES[sel.value];
      if (!d) return;
      out.append(el('div', 'tiny', `Identify by: ${d[1]}`));
      const p = el('p', 'muted', d[2]);
      p.style.marginTop = '6px';
      out.append(p);
      const prof = Router.profile;
      const budget = el('p', 'tiny',
        `Point budget in use: ${prof.total} total, ${prof.via} via. ${prof.note}`);
      budget.style.marginTop = '8px';
      out.append(budget);
    };
    sel.onchange = () => { state.device = sel.value; render(); };
    sec.append(sel, out);
    show();
    return sec;
  }

  /* SPEC 7: the file cannot control any of these, and every one of them can undo the
   * shaping points. It belongs next to the download button, not in a manual. */
  function riderChecklist() {
    const sec = el('div', 'section');
    sec.append(el('h2', null, 'Set these on the device'));
    sec.append(el('p', 'tiny', 'The GPX file cannot control any of these, and each one can override your route.'));
    const items = [
      'Vehicle profile Motorcycle, route preference Faster Time',
      'All avoidances OFF — they fight the shaping points',
      'Off-route recalculation OFF or Prompted',
      'Traffic rerouting OFF',
      'Allow U-turns ON',
      'Only one navigable map enabled',
      'Load the track as well as the route, in a contrasting colour',
      'At "select next destination", always pick the first entry'
    ];
    items.forEach((text, i) => {
      const lab = el('label', 'check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = !!state.checklist[i];
      box.onchange = () => { state.checklist[i] = box.checked; save(); };
      lab.append(box, el('span', null, text));
      sec.append(lab);
    });
    return sec;
  }

  /* ---- rendering: notes ---------------------------------------------------- */
  function renderNotes() {
    const pane = $('#pane-notes');
    pane.textContent = '';
    const acc = D.milepost_accuracy;
    const sections = [
      ['Closures', `From the NPS road-closure page, as of ${D.as_of}. These change — re-check `
        + `before you ride. The Parkway is in ${Object.keys(D.components).length} disconnected `
        + `pieces this year; the planner refuses to route between them rather than quietly `
        + `bridging a gate.`],
      ['Mileposts', `Calibrated against control points; held-out accuracy is `
        + `${acc.mean_abs_mi} mi mean, ${acc.max_abs_mi} mi worst. Good enough to place a pin, `
        + `not good enough to print on a sign. There is no control point between MP 0 and `
        + `177.7, so Virginia mileposts are interpolated and their error is unmeasured.`],
      ['Fuel', `Confidence says whether a pump exists. Reachability says whether you can get `
        + `there in 2026. They are shown separately because every combination occurs — `
        + `MP 248.1 is on every official exit list with no verifiable station, and MP 330.9 `
        + `is a verified station stranded inside a closed segment.`],
      ['Junction coverage', `${D.junction_coverage.count} known crossings, about one every `
        + `${D.junction_coverage.mean_spacing_mi} mi. This is not the complete set — it is the `
        + `crossings the source data knows about. Between known junctions, point spacing bounds `
        + `how far the device could shortcut, it does not prevent it. Each exported day shows `
        + `its own worst-case gap.`],
      ['Offline', `The page, the data and the GPX export all work with no connection. Only the `
        + `background map tiles need signal — the Parkway, closures and your stops still draw `
        + `without them.`]
    ];
    sections.forEach(([h, body]) => {
      const s = el('div', 'section');
      s.append(el('h2', null, h));
      s.append(el('p', 'muted', body));
      pane.append(s);
    });
    const src = el('div', 'section');
    src.append(el('h2', null, 'Source'));
    const a = el('a', null, D.closures_source);
    a.href = D.closures_source; a.target = '_blank'; a.rel = 'noopener';
    a.style.color = 'var(--sky)'; a.style.fontSize = '11px'; a.style.wordBreak = 'break-all';
    src.append(a);
    pane.append(src);
  }

  /* ---- map ----------------------------------------------------------------- */
  let map, layers = {};
  function initMap() {
    map = L.map('map', { zoomControl: true, attributionControl: true })
      .setView([36.5, -80.8], 7);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '© OpenStreetMap'
    }).addTo(map);

    layers.parkway = L.layerGroup().addTo(map);
    D.segment_geometry.forEach((geom, i) => {
      const seg = D.segments[i];
      L.polyline(geom, { color: '#5b93b8', weight: 4, opacity: .9 })
        .bindPopup(`<h3>Parkway open</h3>MP ${seg.from_mp}–${seg.to_mp} · ${seg.length_mi} mi`)
        .addTo(layers.parkway);
    });
    layers.closed = L.layerGroup().addTo(map);
    D.closures.forEach(c => {
      const a = BRP.coordAtMp(c.from_mp), b = BRP.coordAtMp(c.to_mp);
      const i0 = BRP.indexAtMp(c.from_mp), i1 = BRP.indexAtMp(c.to_mp);
      const geom = [a, ...D.parkway.slice(i0, i1 + 1), b];
      L.polyline(geom, { color: '#c8552f', weight: 4, opacity: .95, dashArray: '7 6' })
        .bindPopup(`<h3>Closed · MP ${c.from_mp}–${c.to_mp}</h3>${c.reason}` +
                   (c.detour ? `<br><br>Detour: ${c.detour}` : '<br><br>No detour — this severs the Parkway.'))
        .addTo(layers.closed);
    });

    layers.stops = L.layerGroup().addTo(map);
    layers.route = L.layerGroup().addTo(map);
    layers.preview = L.layerGroup().addTo(map);

    map.on('click', e => {
      const name = prompt('Name this stop:', 'Custom stop');
      if (name) addStop(BRP.customStop(e.latlng.lat, e.latlng.lng, name));
    });
    drawMarkers();
  }

  function dot(color, size = 11) {
    return L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<div class="pin" style="width:${size}px;height:${size}px;background:${color}"></div>`
    });
  }

  function drawMarkers() {
    layers.stops.clearLayers();
    const COL = { top: '#e0a33e', solid: '#7fa35c', backup: '#8d9683', moto: '#c8552f',
                  hotel: '#5b93b8' };
    if (state.filters.campground) {
      (D.places || []).forEach(c => {
        const col = c.kind === 'hotel' ? COL.hotel
                  : c.moto ? COL.moto : (COL[c.tier] || COL.solid);
        // A bare dot tells a rider nothing, so every marker carries its name on hover and
        // its detail on click -- the same card the list shows.
        L.marker([c.lat, c.lon], { icon: dot(col, c.source === 'curated' ? 12 : 9) })
          .bindTooltip(`${c.name}${c.mp != null ? ` — MP ${c.mp.toFixed(1)}` : ''}`,
                       { direction: 'top' })
          .on('click', () => {
            state.previewId = c.id;
            state.tab = 'plan';
            state.addingStop = true;
            render();
            previewOnMap(c);
          })
          .addTo(layers.stops);
      });
    }
    if (state.filters.fuel) {
      D.fuel.forEach(f => {
        const col = { usable: '#5b93b8', usable_via_detour: '#5b93b8', unconfirmed: '#e0a33e',
                      do_not_rely: '#c8552f', unreachable: '#6b6b6b' }[f.plan_grade] || '#5b93b8';
        L.marker([f.parkway_lat, f.parkway_lon], { icon: dot(col, 9) })
          .bindPopup(`<h3>FUEL ${f.exit_road}</h3>MP ${f.mp} · ${f.town}<br>` +
                     `${f.plan_grade.replace(/_/g, ' ')}${f.warning ? '<br><br>' + f.warning : ''}` +
                     `${f.closure_note ? '<br><br>' + f.closure_note : ''}`)
          .on('click', () => addStop(BRP.asStop(f)))
          .addTo(layers.stops);
      });
    }
  }

  function drawRoute() {
    layers.route.clearLayers();

    // Off-Parkway legs: solid where a router has given us real roads, dashed where it
    // has not. The distinction is the point -- a dashed line is an estimate and must never
    // read as turn-by-turn.
    const trip = itinerary();
    if (trip && !trip.error && state.start) {
      (trip.roadLegs || []).forEach(leg => {
        const road = Directions.peek(leg.from, leg.to);
        if (road && road.ok && road.polyline && road.polyline.length > 1) {
          L.polyline(road.polyline, { color: '#7fa35c', weight: 4, opacity: .95 })
            .bindTooltip(`${leg.label} — ${road.distance_mi} mi by road`, { sticky: true })
            .addTo(layers.route);
        } else {
          L.polyline([leg.from, leg.to],
                     { color: '#a9b39c', weight: 2, opacity: .7, dashArray: '4 7' })
            .bindTooltip(`${leg.label} — straight-line estimate, not a road route`,
                         { sticky: true })
            .addTo(layers.route);
        }
      });
      L.marker([state.start.lat, state.start.lon], { icon: dot('#eef0e8', 13) })
        .bindTooltip(state.start.label, { direction: 'top' })
        .addTo(layers.route);
    }

    buildDays().forEach(day => {
      (day.routes || []).forEach(r => {
        if (r.track.length) {
          L.polyline(r.track, { color: '#e0a33e', weight: 5, opacity: .95 }).addTo(layers.route);
        }
        r.rtepts.filter(p => p.type === 'via').forEach(p => {
          L.marker([p.lat, p.lon], { icon: dot('#eef0e8', 14) })
            .bindTooltip(p.name, { direction: 'top' }).addTo(layers.route);
        });
      });
    });
  }

  /* Short place label for route and file names. Stop names run long ("FUEL US 276,
   * Wagon Road Gap"); the 30-char ASCII limit then truncates mid-word. */
  function placeLabel(stop) {
    const raw = stop.kind === 'fuel' || /^FUEL/.test(stop.name)
      ? (stop.label || stop.name).split(/[\/(]/)[0]
      : stop.name;
    const cleaned = raw
      .replace(/\b(Campground|Camping|Resort|Rec Area|Recreation Area|Holiday|Journey|KOA|NPS|USFS|Park|Lodge)\b/gi, '')
      .replace(/\s+/g, ' ').trim();
    // Trim to a word boundary so a name never ends mid-word once the 30-char route-name
    // limit bites ("Mount Pis"). Compare against the sanitised full name, not the raw
    // one — punctuation that safeName strips would otherwise read as truncation and
    // lop off a word that actually fit.
    const full = Gpx.safeName(cleaned, 999);
    const short = Gpx.safeName(cleaned, 15);
    const trimmed = short.length < full.length && /\s/.test(short)
      ? short.slice(0, short.lastIndexOf(' '))
      : short;
    return trimmed.trim() || 'stop';
  }

  /* Fit "<from>-<to>" into whatever the 30-char route-name cap leaves after the prefix,
   * splitting the budget between the two ends. Letting the cap do the trimming instead
   * chops the second name mid-word ("Lake Powhatan-Mount Pis"). */
  function dayLabel(day, budget = 23) {
    const a = placeLabel(day.stops[0]);
    const b = placeLabel(day.stops[day.stops.length - 1]);
    if (a.length + b.length + 1 <= budget) return `${a}-${b}`;
    const half = Math.floor((budget - 1) / 2);
    const clip = (t, n) => {
      if (t.length <= n) return t;
      const cut = t.slice(0, n);
      return (/\s/.test(cut) ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trim() || cut.trim();
    };
    // Give any slack one end does not use to the other.
    const aFit = a.length <= half ? a : clip(a, Math.max(half, budget - 1 - b.length));
    const bFit = clip(b, budget - 1 - aFit.length);
    return `${aFit}-${bFit}`;
  }

  const flyTo = s => map && map.setView([s.lat, s.lon], Math.max(map.getZoom(), 11));

  /* ---- misc ---------------------------------------------------------------- */
  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/gpx+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* Fetch the road legs as soon as the trip is complete enough to have them.
   *
   * These were behind a "Get road directions" button, which is a step in the way of
   * something always needed: a trip is not planned until the rider knows which roads get
   * them to the Parkway and off it again.
   *
   * Safe to call on every render. Directions.fetchLeg is cached on rounded endpoints, so
   * adjusting a tank size or a filter refetches nothing, and a failure is cached too so a
   * dead endpoint is not hammered. Only genuinely new legs cost a request.
   */
  let roadsInFlight = false;
  async function ensureRoads(trip) {
    if (roadsInFlight || !trip || trip.error) return;
    const missing = (trip.roadLegs || []).filter(l => !Directions.peek(l.from, l.to));
    if (!missing.length) return;
    roadsInFlight = true;
    state.roadStatus = `Working out the roads (${missing.length} leg`
                     + `${missing.length > 1 ? 's' : ''})…`;
    renderActiveTab();
    try {
      for (const leg of missing) await Directions.fetchLeg(leg.from, leg.to);
    } finally {
      roadsInFlight = false;
      state.roadStatus = null;
      render();
    }
  }

  function render() {
    save();
    Router.setProfile(state.device === 'xt2' ? 'xt2' : 'universal');
    $('#pane-plan').hidden = state.tab !== 'plan';
    $('#pane-browse').hidden = state.tab !== 'browse';
    $('#pane-export').hidden = state.tab !== 'export';
    $('#pane-notes').hidden = state.tab !== 'notes';
    document.querySelectorAll('.tabs button').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
    renderActiveTab();
    if (map) { drawMarkers(); drawRoute(); }
    if (state.start && state.stops.length) {
      const trip = itinerary();
      if (trip && !trip.error) ensureRoads(trip);
    }
  }

  function renderActiveTab() {
    if (state.tab === 'plan') renderPlan();
    if (state.tab === 'browse') renderBrowse();
    if (state.tab === 'export') renderExport();
    if (state.tab === 'notes') renderNotes();
  }

  function init() {
    load();
    document.querySelectorAll('.tabs button').forEach(b => {
      b.onclick = () => { state.tab = b.dataset.tab; render(); };
    });
    $('#importer').onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          Object.assign(state, JSON.parse(reader.result));
          render();
        } catch (err) { alert('That file is not a BRP trip JSON.'); }
      };
      reader.readAsText(file);
    };
    $('#asof').textContent = `Closures as of ${D.as_of}`;
    initMap();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
