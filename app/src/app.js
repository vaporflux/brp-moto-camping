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
    maxFuelDetourMi: 8,
    // How much range the rider wants left when they arrive at a pump. Greedy planning
    // rides every tank to its limit, which is how a real trip produced "cutting it fine
    // -- about 0.8 mi of planning range left". Ten miles is the default because nobody
    // rides to a station on less.
    arriveMinMi: 10,
    // The Parkway's limit is 45 mph and much of it is 35, so a rider used to interstates
    // badly underestimates how long it takes. 469 miles at 40 mph is nearly twelve hours
    // of riding before a single overlook. Defaults are deliberately honest rather than
    // flattering.
    startTime: '09:00',
    // Day one leaves from a house; every morning after leaves from a campsite, and those
    // are rarely the same hour. Breaking camp takes longer than closing a front door.
    campTime: '09:00',
    parkwayMph: 40,
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
    filters: { motoOnly: false, topOnly: false },
    // Which shapes are drawn. Toggled from the map key, and remembered -- a rider looking
    // for somewhere to sleep does not want 283 fuel pins in the way, and vice versa.
    mapShow: { camp: true, moto: true, hotel: true, food: true, fuel: true },
    // Live GPS. Remembered, but never auto-started unless the browser already holds the
    // permission -- a location prompt on page load, before the rider has asked for
    // anything, is how an app gets its location permission denied for good.
    gps: false,
    gpsFollow: true,
    search: '',
    showClosed: true,
    browseKind: 'all',         // Browse filters are independent of the trip being planned
    browseShowers: false,
    browseToilets: false,
    browseWithinMi: 15,
    browseGoogle: null,
    browseNote: null,
    // Open on a desktop, where there is room beside the map; collapsed on a phone, where
    // an open key covers the whole 42vh map pane and hides the thing it is explaining.
    // Either way the rider's own choice is remembered from then on.
    legendOpen: typeof window !== 'undefined' && window.innerWidth > 860,
    pinMode: false,            // map taps only place a pin when the rider asks for it
    mapView: 'split',          // phone only: split | map | list
    checklist: {},
    device: 'xt2'
  };

  /* ---- persistence -------------------------------------------------------- */
  /* Set once, on the way out, by "Start a new trip".
   *
   * Clearing storage and reloading is not enough on its own: renders are triggered from
   * async work (the road lookups finish, their `finally` calls render, render calls save)
   * and one of those can land between the delete and the reload, writing the trip straight
   * back. The first attempt at this looked like the button did nothing at all. */
  let wiped = false;

  function save() {
    if (wiped) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        name: state.name, stops: state.stops, arriveMinMi: state.arriveMinMi,
        maxFuelDetourMi: state.maxFuelDetourMi, checklist: state.checklist,
        device: state.device, tankMi: state.tankMi,
        startTime: state.startTime, campTime: state.campTime,
        parkwayMph: state.parkwayMph,
        start: state.start, accessMp: state.accessMp,
        finish: state.finish, endPoint: state.endPoint,
        stayWithinMi: state.stayWithinMi,
        // Display preferences, so the app stops re-teaching the rider what it already told
        // them. pinMode is deliberately NOT saved: a pending map tap should not survive a
        // reload and hijack the next touch.
        legendOpen: state.legendOpen, filters: state.filters,
        mapShow: state.mapShow, gps: state.gps, gpsFollow: state.gpsFollow,
        browseKind: state.browseKind, browseWithinMi: state.browseWithinMi,
        browseShowers: state.browseShowers, browseToilets: state.browseToilets,
        stayKind: state.stayKind, stayShowers: state.stayShowers,
        stayToilets: state.stayToilets,
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
        // Stops saved before the overnight flag was reachable all carry false, and that
        // false was never a decision -- there was no control to make it with. Derive it
        // from what the place is, once, and leave anything the rider has since chosen.
        state.stops.forEach(st => {
          if (st.nightChosen) return;
          st.dayBreakAfter = sleepsHere(st);
        });
      }
    } catch (e) { /* ignore corrupt state rather than trap the user on a broken page */ }
  }

  /* ---- day assembly ------------------------------------------------------- */

  /* Days are the user's explicit breaks. Nothing proposes them by mileage, because it
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
    (trip.roadLegs || []).forEach(leg => {
      const road = Directions.peek(leg.from, leg.to);
      if (!road || !road.ok || !road.polyline || road.polyline.length < 3) return;
      const target = leg.stop ? leg.stop.name
                   : leg.id === 'in' ? 'to Parkway' : 'to finish';
      const maxPts = leg.stop ? 6 : 4;
      Router.shapeOffParkway(road.polyline, 3, maxPts).forEach((pt, i) => {
        extras.push({ ...pt, mp: null,
                      legId: leg.id === 'in' || leg.id === 'out' ? leg.id : 'off',
                      stopId: leg.stop ? leg.stop.id : null,
                      name: `SP ${Gpx.safeName(target, 14)} ${i + 1}` });
      });
    });

    const segments = trackSegmentsFor(day, trip);
    if (!extras.length && !segments) return day;

    const room = Router.MAX_TOTAL_RTEPT - day.nTotal;
    const kept = extras.slice(0, Math.max(0, room));
    const merged = { ...day };
    if (kept.length) {
      const pts = [...day.rtepts];
      const anchorIndex = leg => {
        if (leg.legId === 'in') return 1;
        if (leg.legId === 'out') return pts.length;
        const at = pts.findIndex(r => r.type === 'via' && r.id === leg.stopId);
        return at >= 0 ? at : pts.length;
      };
      const groups = [...new Set(kept.map(k => k.legId))]
        .map(id => ({ legId: id, stopId: kept.find(k => k.legId === id).stopId,
                      points: kept.filter(k => k.legId === id) }))
        .sort((a, b) => anchorIndex(b) - anchorIndex(a));
      groups.forEach(g => pts.splice(anchorIndex(g), 0, ...g.points));
      merged.rtepts = pts;
      merged.nTotal = pts.length;
      merged.nVia = pts.filter(r => r.type === 'via').length;
    }
    if (segments) {
      merged.trackSegments = segments;
      merged.track = segments.flat();
    }
    merged.droppedOffParkwayPoints = extras.length - kept.length;
    return merged;
  }

  /* The day's geometry as ORDERED, SEPARATE segments.
   *
   * These used to be concatenated into one array: the Parkway slice, then every road
   * polyline appended on the end. Drawn as a single line that jumps from the last Parkway
   * point back to the rider's front door and across the map again for each road leg --
   * the crisscross. The exported GPX track had the same break in it.
   *
   * They are separate because they genuinely are separate: a rider leaves the Parkway,
   * rides some roads, and rejoins. GPX has <trkseg> for exactly this, and Leaflet wants
   * one polyline per continuous run.
   */
  function trackSegmentsFor(day, trip) {
    const roadFor = id => {
      const leg = (trip.roadLegs || []).find(l => l.id === id);
      if (!leg) return null;
      const r = Directions.peek(leg.from, leg.to);
      return r && r.ok && r.polyline && r.polyline.length > 1 ? r.polyline : null;
    };

    const segs = [];
    const stops = day.stops || [];
    if (!stops.length) return null;

    if (stops[0] && stops[0].id === 'start') {
      const approach = roadFor('in');
      if (approach) segs.push(approach);
    }
    for (let i = 0; i < stops.length - 1; i++) {
      try {
        const slice = Router.sliceParkway(stops[i].mp, stops[i + 1].mp);
        if (slice.length > 1) segs.push(slice);
      } catch (e) { /* severed: the planner already refused, nothing to draw */ }
      const hop = roadFor(`off-${stops[i + 1].id}`);
      if (hop) { segs.push(hop); segs.push([...hop].reverse()); }
    }
    // The ride back to the exit point, and off the Parkway to the finish. Only on the
    // last day, and only once -- this leg was previously missing from the track entirely.
    const isLastDay = stops[stops.length - 1] === state.stops[state.stops.length - 1];
    if (isLastDay && trip.exitPoint) {
      try {
        const slice = Router.sliceParkway(stops[stops.length - 1].mp, trip.exitPoint.mp);
        if (slice.length > 1) segs.push(slice);
      } catch (e) { /* nothing to draw */ }
      const out = roadFor('out');
      if (out) segs.push(out);
    }
    return segs.length ? segs : null;
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
        // A day-length warning used to live here, comparing totalMi against a "max miles
        // per day" the rider set. That field is gone, and rather than invent a threshold
        // to keep the warning alive, the warning went with it -- the day's mileage is
        // still on the day itself for anyone who wants to judge it.
        const warnings = routes.flatMap(r => r.warnings);
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
      arriveMinMi: state.arriveMinMi,
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
      // And back again. This leg did not exist: the trip rode off to a campsite and then
      // simply resumed from its milepost, so leaving camp had no directions, no minutes and
      // no miles -- on a stop six miles down a mountain road, twice over.
      roadLegs.push({ id: `back-${st.id}`, from: [st.lat, st.lon], to: [plat, plon],
                      label: `Back to the Parkway from ${st.name}`, stop: st,
                      returning: true });
    });
    if (exitPoint) {
      roadLegs.push({ id: 'out', from: [exitPoint.lat, exitPoint.lon], to: endLL,
                      label: `Ride out to ${endLabel}` });
    }

    return { chosen, options, fuel, dest, severedNote, exitPoint, endLabel, roadLegs,
             approachMi: chosen.approachMi,
             parkwayMi: fuel.parkwayMi != null ? fuel.parkwayMi : Math.abs(dest.mp - chosen.mp) };
  }

  /* ---- stop list mutation -------------------------------------------------- */
  /* Insert at the milepost-ordered position rather than re-sorting the list. Sorting
   * would silently undo a manual reorder every time another stop is added, and manual
   * order is meaningful — an out-and-back up the Mt Mitchell spur is deliberately not in
   * milepost order. */
  /* Does the rider sleep here?
   *
   * A campsite or a hotel is somewhere you stay the night, so the ride on from it starts
   * the next morning. A meal or a pump is not. This used to be hardcoded false for every
   * stop with no way to change it, which meant the overnight never happened: a two-day trip
   * was timed as one very long day, and buildDays() never split the GPX either.
   */
  const sleepsHere = stop => stop.kind !== 'food' && stop.kind !== 'fuel';

  function addStop(stop) {
    if (state.stops.some(s => s.id === stop.id)) return;
    const entry = { ...stop, dayBreakAfter: sleepsHere(stop), nightChosen: false };
    let at = state.stops.findIndex(s => s.mp > stop.mp);
    if (at === -1) at = state.stops.length;
    state.stops.splice(at, 0, entry);
    render();
  }
  const removeStop = i => { state.stops.splice(i, 1); render(); };

  /* Move a stop up or down the running order.
   *
   * addStop drops a new stop into milepost order, which is the right guess and only a
   * guess. A rider who finds somewhere to eat forty miles past their campsite still wants
   * lunch before they make camp, and on a round trip milepost order means nothing at all --
   * the same milepost is passed twice, in opposite directions.
   *
   * Nothing downstream needs sorting: itinerary() already reads state.stops as a sequence
   * (the first picks the access point, the last picks the exit) and planJourney lays the
   * whole thing out as one distance line whichever way the mileposts run. So the reorder
   * is a swap, and render() rebuilds the plan, the fuel, the clock and the map from it.
   */
  function moveStop(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= state.stops.length) return;
    const [moved] = state.stops.splice(i, 1);
    state.stops.splice(j, 0, moved);
    render();
  }
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
    const pin = el('button', `btn sm ${state.pinMode ? 'primary' : 'ghost'}`,
                   state.pinMode ? 'Now tap the map\u2026' : 'Drop a pin on the map');
    pin.onclick = () => { state.pinMode = !state.pinMode; render(); };
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
    alt.append(pin, here);
    sec.append(alt);
    return sec;
  }

  /* ---- the place finder, shared by Plan step 2 and Browse -----------------------
   *
   * These were two different things doing one job. Plan step 2 could filter by kind,
   * amenity and distance off the Parkway, search 478 enriched places and call Google;
   * Browse could show curated campgrounds and fuel with four checkboxes and no search
   * worth the name. A rider who learned one had learned nothing about the other.
   *
   * One implementation now, pointed at two sets of state keys. They stay independent on
   * purpose -- narrowing Browse to hotels in Asheville should not quietly rewrite the trip
   * being planned next door -- but they behave identically, which is the part that matters.
   *
   * Browse gets one thing Plan does not: fuel. Planning picks fuel stops for you, so
   * offering the list there would be noise. Looking up where the pumps are is exactly what
   * Browse is for.
   */
  const FINDER = {
    plan: { kind: 'stayKind', showers: 'stayShowers', toilets: 'stayToilets',
            within: 'stayWithinMi', query: 'destQuery',
            google: 'googleResults', note: 'googleNote', fuel: false },
    browse: { kind: 'browseKind', showers: 'browseShowers', toilets: 'browseToilets',
              within: 'browseWithinMi', query: 'search',
              google: 'browseGoogle', note: 'browseNote', fuel: true }
  };

  const finderKinds = f => [
    ['all', 'Anywhere'], ['campground', 'Campgrounds'], ['koa', 'KOA'],
    ['hotel', 'Hotels & motels'], ['food', 'Food'],
    ...(f.fuel ? [['fuel', 'Fuel']] : [])
  ];

  /* Everything the finder can show, already deduped and in milepost order. */
  /* What to say when the list comes back empty.
   *
   * One function rather than a copy in each list. The copies were identical, and one of
   * them read a variable that only existed in the other's scope -- which threw, and a
   * ReferenceError inside a render takes the whole tab down. Picking Food in the Plan tab
   * showed a blank page, because Food is simply the easiest way to produce an empty list.
   */
  function emptyNote(f) {
    const noFoodYet = state[f.kind] === 'food'
                   && !(D.places || []).some(c => c.kind === 'food');
    return el('div', 'empty', noFoodYet
      ? 'Food comes from Google rather than the offline list — places to eat change hands '
      + 'and hours far too often to be worth baking in. Tap the search below and they will '
      + 'appear here and on the map.'
      : 'Nothing matches. Loosen a filter, or widen the distance.');
  }

  function finderPool(f) {
    if (state[f.kind] === 'fuel') {
      return D.fuel
        .map(x => fuelAsPlace(x, x.parkway_lat != null
          ? [x.parkway_lat, x.parkway_lon] : BRP.coordAtMp(x.mp)))
        .sort((a, b) => a.mp - b.mp);
    }
    // A live Google result the baked list already carries is a duplicate, not a find, and
    // it belongs at its own milepost rather than appended after everything else.
    const known = new Set((D.places || []).map(c => c.google_id).filter(Boolean));
    const fresh = (state[f.google] || []).filter(c => !known.has(c.google_id));
    return [...(D.places || []), ...fresh].sort((a, b) => (a.mp ?? 0) - (b.mp ?? 0));
  }

  function finderMatches(f, { excludeChosen = false } = {}) {
    const q = (state[f.query] || '').trim().toLowerCase();
    const kind = state[f.kind];
    return finderPool(f)
      .filter(c => !excludeChosen || !state.stops.some(st => st.id === c.id))
      // KOA is a brand, not a kind: it matches on the name across every source, so a KOA
      // arriving from OSM or Google is caught the same as a curated one.
      .filter(c => kind === 'all' || kind === 'fuel'
                || (kind === 'koa' ? /\bkoa\b/i.test(c.name) : c.kind === kind))
      // Google knows nothing about showers, so these stay strict: only places actually
      // recorded as having one. Untagged is unknown, and unknown is not "no".
      // Showers and toilets are a campsite question. Applied to somewhere you eat they
      // would silently empty the list, because nobody tags a diner with either.
      .filter(c => kind === 'fuel' || kind === 'food' || !state[f.showers]
                || c.showers === true)
      .filter(c => kind === 'fuel' || kind === 'food' || !state[f.toilets]
                || c.toilets === true)
      .filter(c => (c.off_parkway_mi ?? 0) <= state[f.within])
      .filter(c => !q || c.name.toLowerCase().includes(q)
                      || String(c.mp).includes(q)
                      || (c.address || '').toLowerCase().includes(q)
                      || (c.food || '').toLowerCase().includes(q)
                      || (c.cuisine || '').toLowerCase().includes(q)
                      || (c.access || '').toLowerCase().includes(q));
  }

  function finderChips(f, onChange) {
    const wrap = el('div');
    const row = (cls) => { const r = el('div', 'chip-row'); r.style.margin = cls; return r; };

    const kindRow = row('9px 0 6px');
    finderKinds(f).forEach(([key, label]) => {
      const c = el('button', `chip${state[f.kind] === key ? ' on' : ''}`, label);
      c.setAttribute('aria-pressed', String(state[f.kind] === key));
      c.onclick = () => { state[f.kind] = key; onChange(); };
      kindRow.append(c);
    });
    wrap.append(kindRow);

    // Fuel has no showers. Showing a dead filter is worse than showing none.
    if (state[f.kind] !== 'fuel') {
      const amen = row('0 0 6px');
      [['showers', 'Has showers', 'Only places recorded as having showers'],
       ['toilets', 'Has toilets', 'Only places recorded as having toilets']]
        .forEach(([k, label, hint]) => {
          const key = f[k];
          const c = el('button', `chip${state[key] ? ' on' : ''}`, label);
          c.title = hint;
          c.setAttribute('aria-pressed', String(!!state[key]));
          c.onclick = () => { state[key] = !state[key]; onChange(); };
          amen.append(c);
        });
      wrap.append(amen);
    }

    const dist = row('0');
    for (const mi of [2, 5, 10, 15, 999]) {
      const label = mi === 999 ? 'Any distance' : `Within ${mi} mi`;
      const c = el('button', `chip${state[f.within] === mi ? ' on' : ''}`, label);
      c.title = state[f.kind] === 'fuel'
        ? 'How far off the Parkway the pumps are' : 'Straight-line distance from the Parkway';
      c.onclick = () => { state[f.within] = mi; onChange(); };
      dist.append(c);
    }
    wrap.append(dist);
    return wrap;
  }

  /* One row. Tapping shows the place ON THE MAP -- the detail belongs where the rider is
   * looking at the location, and committing stays a second, deliberate press in the card. */
  /* The verb that belongs to a place.
   *
   * "Stay here" on a diner is the app admitting it has not understood what the rider just
   * picked, so the wording follows the category everywhere it appears -- the map card and
   * the list row read the same, because they do the same thing.
   */
  const addVerb = c => c.kind === 'fuel' ? 'Gas up here'
                     : c.kind === 'food' ? 'Eat here'
                     : 'Stay here';

  /* Put a place in the trip, from wherever it was chosen. */
  function commitStop(c) {
    const stop = c.kind === 'fuel' ? BRP.asStop(c._fuel) : BRP.placeStop(c);
    if (map) map.closePopup();
    if (layers.preview) layers.preview.clearLayers();
    state.previewId = null;
    state.destQuery = '';
    state.addingStop = false;
    addStop(stop);
  }

  function finderRow(c) {
    const b = el('button', 'row');
    b.dataset.mp = c.mp ?? 0;
    b.append(el('div', 'mp', c.mp != null ? `MP ${c.mp.toFixed(0)}` : ''));
    const body = el('div', 'body');
    body.append(el('div', 'name', c.name));
    body.append(el('div', 'meta', [
      c.kind === 'fuel' ? c.address : c.price, c.season,
      c.kind === 'fuel' ? null : c.address,
      c.off_parkway_mi != null && c.off_parkway_mi > 0 ? `${c.off_parkway_mi} mi off` : null
    ].filter(Boolean).join(' \u00b7 ')));

    const badges = el('div', 'badges');
    const add = (cls, text, title) => {
      const x = el('span', `badge ${cls}`, text);
      if (title) x.title = title;
      badges.append(x);
    };
    if (c.kind === 'fuel') {
      const g = { usable: ['ok', 'Fuel'], usable_via_detour: ['info', 'Via detour'],
                  usable_google: ['info', 'Google'],
                  unconfirmed: ['warn', 'Unconfirmed'], do_not_rely: ['danger', 'Do not rely'],
                  unreachable: ['danger', 'Unreachable'] }[c._fuel.plan_grade]
                || ['warn', c._fuel.plan_grade];
      add(g[0], g[1], c.watchout || '');
      // The grade badge already says "Google" for these; a second raw one in warning
      // colours reads as a different, worse problem than the one it is describing.
      if (c.fuelConfidence && c.fuelConfidence !== 'verified'
          && c.fuelConfidence !== 'google') add('warn', c.fuelConfidence);
      if ((c.stations || []).length) add('info', `${c.stations.length} station`
                                              + (c.stations.length > 1 ? 's' : ''));
    } else {
      if (c.kind === 'hotel') add('info', 'Lodging');
      if (c.moto) add('moto', 'Moto camp');
      if (c.tier === 'top') add('ok', 'Top pick');
      if (c.showers === true) add('ok', 'Showers');
      else if (c.showers === false) add('danger', 'No showers');
      else add('warn', 'Showers unknown');
      if (c.source === 'osm' && c.verified) add('ok', 'Google verified');
      else if (c.source === 'osm') add('', 'OSM');
      if (c.source === 'google') add('', 'Google');
      if (c.phone) add('info', 'Phone');
    }
    if (badges.childElementCount) body.append(badges);
    b.append(body);

    /* Tapping a row used to do nothing but open a card on the map -- which on a phone
     * showing the full list is a card the rider cannot see. The only way to add anything
     * was to switch to the map and find the pin again. So the chosen row carries the
     * action itself.
     *
     * A wrapper, because the row is a <button> and a button inside a button is invalid
     * markup that browsers quietly unpick.
     */
    const wrap = el('div', 'rowwrap');
    wrap.append(b);
    b.onclick = () => { state.previewId = c.id; render(); previewOnMap(c); };

    if (state.previewId === c.id) {
      b.classList.add('sel');
      const act = el('div', 'rowact');
      const go = el('button', 'btn sm primary', addVerb(c));
      go.onclick = e => { e.stopPropagation(); commitStop(c); };
      const shut = el('button', 'btn sm ghost', 'Not this one');
      shut.onclick = e => {
        e.stopPropagation();
        state.previewId = null;
        if (layers.preview) layers.preview.clearLayers();
        render();
      };
      act.append(go, shut);
      wrap.append(act);
    }
    return wrap;
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

    // Nights are numbered by the nights, not by position in the list: a lunch stop between
    // two campsites must not turn "night 2" into "night 3".
    let nights = 0;
    state.stops.forEach((st, i) => {
      const meal = st.kind === 'food';
      if (st.dayBreakAfter) nights++;
      const row = el('div', 'picked');
      const body = el('div', 's-body');
      const suffix = meal ? '  \u00b7  meal stop'
                   : st.dayBreakAfter && state.stops.filter(x => x.dayBreakAfter).length > 1
                     ? `  \u00b7  night ${nights}` : '';
      body.append(el('div', 's-name', `${st.name}${suffix}`));
      body.append(el('div', 's-meta',
        `MP ${st.mp.toFixed(1)}${st.label ? ' \u00b7 ' + st.label : ''}`));

      // Whether the rider sleeps here decides where the clock rolls to the next morning and
      // where the GPX splits into a new day's file. It has to be sayable, not inferred.
      if (!meal) {
        const night = el('button',
          `chip sm${st.dayBreakAfter ? ' on' : ''}`,
          st.dayBreakAfter ? 'Staying the night' : 'Riding on the same day');
        night.title = 'Whether the ride on from here starts the next morning';
        night.setAttribute('aria-pressed', String(!!st.dayBreakAfter));
        night.onclick = () => {
          st.dayBreakAfter = !st.dayBreakAfter;
          st.nightChosen = true;      // never overwrite this again
          render();
        };
        const wrap = el('div', 'chip-row');
        wrap.style.marginTop = '6px';
        wrap.append(night);
        body.append(wrap);
      }
      row.append(body);

      // Arrows rather than drag-and-drop: this gets used in gloves, on a phone, at the
      // roadside. A 44px button hits every time; a drag handle does not.
      if (state.stops.length > 1) {
        const nudge = (label, delta, hint) => {
          const b = el('button', 'icon-btn', label);
          b.title = hint;
          b.setAttribute('aria-label', `${hint}: ${st.name}`);
          b.disabled = delta < 0 ? i === 0 : i === state.stops.length - 1;
          b.onclick = () => moveStop(i, delta);
          return b;
        };
        const order = el('div', 'reorder');
        order.append(nudge('\u2191', -1, 'Move earlier in the trip'),
                     nudge('\u2193', 1, 'Move later in the trip'));
        row.append(order);
      }

      const del = el('button', 'icon-btn danger', '\u2715');
      del.title = 'Remove this stop';
      del.setAttribute('aria-label', `Remove ${st.name}`);
      del.onclick = () => removeStop(i);
      row.append(del);
      sec.append(row);
    });

    if (state.stops.length && !state.addingStop) {
      const more = el('button', 'btn sm ghost', '+ Add another stop');
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

    sec.append(finderChips(FINDER.plan, render));

    const count = el('div', 'tiny');
    count.style.marginTop = '8px';
    const list = el('div', 'scroller');
    sec.append(count, list);

    const matches = () => finderMatches(FINDER.plan, { excludeChosen: true });

    const draw = () => {
      list.textContent = '';
      const rows = matches();
      const total = (D.places || []).length + (state[FINDER.plan.google] || []).length;
      count.textContent = `${rows.length} of ${total} places`
        + (D.has_osm ? '' : ' \u00b7 curated list only, run build/fetch_osm.py to widen it');
      if (!rows.length) {
        list.append(emptyNote(FINDER.plan));
        return;
      }
      rows.slice(0, 300).forEach(c => list.append(finderRow(c)));
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
      // A gas station has no shower block, and printing "Showers: not recorded" against
      // one is noise pretending to be data.
      ['Showers', c.kind === 'fuel' ? null
                 : c.showers === true ? 'Yes' : c.showers === false ? 'No'
                 : 'Not recorded — nobody has said either way'],
      ['Toilets', c.kind === 'fuel' ? null
                 : c.toilets === true ? 'Yes' : c.toilets === false ? 'No'
                 : 'Not recorded'],
      ['Getting in', c.access], ['Why it works', c.standout],
      ['Watch out', c.watchout], ['Food', c.food], ['Phone', c.phone],
      // Fuel carries two independent answers and they must not be merged: does a pump
      // exist, and can you actually get to it in 2026.
      ['Fuel', c.fuelGrade],
      ['Checked', c.fuelConfidence
        ? (c.fuelConfidence === 'verified' ? 'Verified against published sources'
           : c.fuelConfidence === 'google'
             ? 'From Google Places. Phone it before you count on it after dark.'
           : `Confidence: ${c.fuelConfidence}`) : null],
      ['Stations', (c.stations || []).length
        ? c.stations.map(st => [st.name || st.brand,
                                st.hours ? `(${st.hours})` : null,
                                st.mi_straight != null ? `${st.mi_straight} mi` : null]
                               .filter(Boolean).join(' ')).join('\n')
        : null],
      // Google's contribution. A rating with no count behind it says nothing, so the
      // count travels with it.
      ['Rating', c.rating != null
        ? `${c.rating}/5${c.ratings ? ` from ${c.ratings} reviews` : ''}` : null],
      ['Hours', Array.isArray(c.hours) ? c.hours.join('\n') : c.hours],
      ['Status', c.business_status && c.business_status !== 'OPERATIONAL'
        ? c.business_status.replace(/_/g, ' ').toLowerCase() : null]
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
      c.kind === 'fuel'
        ? 'There is no fuel on the Parkway itself. Every one of these is a ride off it and '
          + 'back. Run build/verify_fuel.py to check these against Google.'
      : c.source === 'curated' ? 'Researched and verified for this planner.'
      : c.source === 'osm' && c.verified
        ? 'Located from OpenStreetMap, confirmed against Google. OpenStreetMap places the '
          + 'milepost; Google supplies the contact details.'
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
    const isFuel = c.kind === 'fuel';
    const isFood = c.kind === 'food';
    // "Stay here" on a diner is the app telling the rider it has not understood what they
    // just picked. Every category gets the verb that belongs to it.
    const add = el('button', 'btn primary', addVerb(c));
    add.onclick = () => commitStop(c);
    const shut = el('button', 'btn ghost',
                    (isFuel || isFood) ? 'Close' : 'Not this one');
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
    const kind = c.kind === 'fuel' ? 'fuel' : placeKind(c);
    const opts = c.kind === 'fuel' && c._fuel ? fuelOpts(c._fuel) : placeOpts(c);
    L.marker([c.lat, c.lon], { icon: selectedIcon(kind, opts), zIndexOffset: 600 })
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
                 { color: LINE.yourRoute.color, weight: 2, dashArray: '3 5', opacity: .9 })
        .addTo(layers.preview);
    }
  }

  /* Live Google Places lookup, along the WHOLE Parkway.
   *
   * This searched a single point -- the map centre snapped to the Parkway -- which
   * answered "what is near this bit" when the question is "what is anywhere along the
   * route". One circle cannot cover 469 miles, so it walks the rideable Parkway in steps
   * and merges the results.
   *
   * The step is sized from the rider's own distance filter -- a wider filter needs fewer,
   * larger circles -- and the step count is shown because it is what makes the press take
   * a few seconds rather than being instant. Results are session-only: Google's terms
   * restrict retaining Places content, so nothing is written to localStorage or the
   * bundle.
   */
  const knownGoogleIds = () =>
    new Set((D.places || []).map(c => c.google_id).filter(Boolean));

  function googleSearchRow(f = FINDER.plan) {
    const wrap = el('div');
    wrap.style.marginTop = '10px';
    const row = el('div', 'btn-row');
    const withinMi = Math.min(state[f.within], 25);
    const samples = parkwaySamples(withinMi);
    const kind = state[f.kind];
    const what = kind === 'fuel' ? 'gas stations'
               : kind === 'food' ? 'food'
               : kind === 'hotel' ? 'hotels & motels'
               : kind === 'koa' ? 'KOA campgrounds'
               : kind === 'campground' ? 'campgrounds' : 'places to stay';
    const btn = el('button', 'btn sm ghost',
      `Search Google for ${what} along the whole Parkway`);
    const status = el('div', 'tiny');
    status.style.marginTop = '6px';
    if (state[f.note]) status.textContent = state[f.note];
    row.append(btn);
    if (state[f.google]) {
      const clear = el('button', 'btn sm ghost', 'Clear Google results');
      clear.onclick = () => { state[f.google] = null; state[f.note] = null; render(); };
      row.append(clear);
    }
    wrap.append(row, status);
    const hint = el('div', 'tiny');
    hint.style.marginTop = '4px';
    hint.textContent = `Walks the Parkway end to end in ${samples.length} steps, `
                     + `${withinMi} mi either side.`;
    wrap.append(hint);

    btn.onclick = async () => {
      btn.disabled = true;
      const type = kind === 'fuel' ? 'gas_station'
                 : kind === 'food' ? 'restaurant'
                 : (kind === 'campground' || kind === 'koa') ? 'campground' : 'lodging';
      const radiusM = Math.round(withinMi * 1609);
      const found = new Map();
      let failed = null, raw = 0;
      for (let i = 0; i < samples.length; i++) {
        status.textContent = `Searching the Parkway… ${i + 1} of ${samples.length}`;
        const [lat, lon] = samples[i];
        try {
          const res = await fetch(`/api/places?lat=${lat}&lon=${lon}`
                                + `&radius_m=${radiusM}&type=${type}`);
          const data = await res.json();
          // Say what went wrong, in words, including the status code. "Nothing came up"
          // reads the same whether the key is missing, the type matched nothing, or every
          // result was filtered out afterwards -- and those need different fixes.
          if (!res.ok) {
            failed = `${data.error || 'Google search failed'} (HTTP ${res.status}`
                   + `${data.detail ? ': ' + String(data.detail).slice(0, 120) : ''})`;
            break;
          }
          raw += (data.places || []).length;
          (data.places || []).forEach(g => {
            if (found.has(g.id)) return;      // circles overlap; the same hotel recurs
            const n = BRP.nearestVertex(g.lat, g.lon);
            found.set(g.id, { ...g, id: `google-${g.id}`, google_id: g.id,
                              kind: type === 'campground' ? 'campground'
                                  : type === 'restaurant' ? 'food' : 'hotel',
                              mp: n.mp, off_parkway_mi: Math.round(n.distance * 100) / 100,
                              showers: null, toilets: null });
          });
        } catch (e) {
          failed = 'Google search needs a connection.';
          break;
        }
      }
      btn.disabled = false;
      const hits = [...found.values()]
        .filter(h => h.off_parkway_mi <= state[f.within])
        .sort((a, b) => a.mp - b.mp);
      const tooFar = found.size - hits.length;
      const already = hits.filter(h => knownGoogleIds().has(h.google_id)).length;
      state[f.google] = hits;

      // Every count that could explain an empty list, named. Nearly all of these places
      // are already in the baked list now that it is enriched, so "0 new" is the normal
      // answer and needs to read as success rather than as a failure.
      if (failed) {
        state[f.note] = `${failed}. `
          + (found.size ? `Kept the ${hits.length} found before it stopped.` : 'Nothing kept.');
      } else if (!raw) {
        state[f.note] = `${samples.length} searches, and Google returned no ${what} `
          + `anywhere along the Parkway. That is a Google-side result, not a connection `
          + `problem — try a wider distance, or a different category.`;
      } else {
        const parts = [`${samples.length} searches found ${raw} results, `
                     + `${found.size} distinct`];
        if (tooFar) parts.push(`${tooFar} beyond ${state[f.within]} mi`);
        if (already) parts.push(`${already} already in the list`);
        const brandNew = hits.length - already;
        parts.push(brandNew > 0
          ? `${brandNew} new, now merged in at their mileposts`
          : 'nothing new — the list already has them all');
        state[f.note] = parts.join(' · ') + '.';
      }
      render();
    };
    return wrap;
  }

  /* Points along the rideable Parkway to search around.
   *
   * Stepped at about 1.5x the search radius so the circles overlap rather than leaving
   * gaps between them, and capped so one press cannot fire an unbounded number of
   * requests. Only open segments: searching a closed stretch would return hotels nobody
   * can ride to.
   */
  function parkwaySamples(radiusMi, maxSamples = 22) {
    const stepMi = Math.max(8, radiusMi * 1.5);
    const pts = [];
    (D.segments || []).forEach(seg => {
      for (let mp = seg.from_mp; mp <= seg.to_mp; mp += stepMi) pts.push(mp);
      if (pts.length === 0 || pts[pts.length - 1] < seg.to_mp - 0.5) pts.push(seg.to_mp);
    });
    const stride = Math.max(1, Math.ceil(pts.length / maxSamples));
    return pts.filter((_, i) => i % stride === 0).map(mp => BRP.coordAtMp(mp));
  }

  /* ---- the clock ----------------------------------------------------------------
   *
   * Distance is the number this planner has always given, and on the Parkway it is the
   * misleading one. The limit is 45 mph and long stretches are 35; a rider whose instinct
   * is calibrated on interstates reads "469 miles" as a long day and it is closer to two.
   * Turning miles into a time of day is what makes that visible before the trip rather
   * than at dusk.
   *
   * Everything here is a stated assumption rather than a claim: a constant Parkway speed
   * the rider sets, 50 mph off it, and ten minutes standing at a pump. Overlooks, lunch
   * and photographs are the rider's to add, which the note under the inputs says plainly.
   * A clock that quietly padded itself would be worse than none -- it would be wrong in a
   * direction nobody could see.
   */
  const OFF_PARKWAY_MPH = 50;   // fallback only: secondary roads, when no router answered
  const FUEL_STOP_MIN = 10;     // off the bike, tank filled, back on
  const MEAL_STOP_MIN = 45;     // sat down, ordered, eaten, paid

  /* Minutes for a leg that leaves the Parkway.
   *
   * The router already answers this properly -- Google returns a duration for every leg,
   * and the turn-by-turn panel has been printing it all along -- but the clock was not
   * asking. It divided an ESTIMATED distance by a flat 50 mph, which is a guess laid on top
   * of a guess: the approach distance is itself a straight line multiplied by a road
   * factor. Two hundred miles of interstate and forty miles of switchbacks came out at the
   * same speed.
   *
   * So: the real routed duration where there is one, the flat rate only where there is not
   * -- which is the offline case, and a fuel detour, where all we have is a radius. */
  /* Miles for a leg that leaves the Parkway, preferring what the router actually measured.
   *
   * Same reasoning as legMinutes: the fallback is a straight line multiplied by a road
   * factor, and roads are not straight. The tilde stays on the estimate and comes off the
   * measurement, so the rider can tell which one they are reading. */
  function legMiles(leg, fallbackMi) {
    const road = leg && Directions.peek(leg.from, leg.to);
    if (road && road.ok && road.distance_mi > 0) return { mi: road.distance_mi, real: true };
    return { mi: fallbackMi || 0, real: false };
  }
  const miLabel = d => `${d.real ? '' : '~'}${d.mi} mi`;

  function legMinutes(leg, fallbackMi) {
    const road = leg && Directions.peek(leg.from, leg.to);
    if (road && road.ok && road.duration_min > 0) return road.duration_min;
    return ((fallbackMi || 0) / OFF_PARKWAY_MPH) * 60;
  }

  function hoursFor(parkwayMi, offParkwayMi = 0) {
    const mph = Math.max(5, state.parkwayMph || 40);
    return parkwayMi / mph + offParkwayMi / OFF_PARKWAY_MPH;
  }

  /* Minutes since midnight on the day the rider sets off. Overnights push the clock to the
   * next morning's start time rather than letting it run through the night. */
  const _clockMinutes = (text, fallback) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(text || '');
    return m ? (+m[1]) * 60 + (+m[2]) : fallback;
  };
  function startMinutes() { return _clockMinutes(state.startTime, 9 * 60); }
  /* The hour the rider rolls out of a campsite, which is not the hour they left the house.
   * Every leg after an overnight -- including the ride home -- is timed from this. */
  function campMinutes() { return _clockMinutes(state.campTime, startMinutes()); }

  function clockLabel(minutes) {
    const day = Math.floor(minutes / 1440);
    let mins = ((minutes % 1440) + 1440) % 1440;
    const h24 = Math.floor(mins / 60), mm = String(Math.round(mins % 60)).padStart(2, '0');
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const ampm = h24 < 12 ? 'am' : 'pm';
    return `${h12}:${mm}${ampm}` + (day > 0 ? ` (day ${day + 1})` : '');
  }

  function durationLabel(hours) {
    const total = Math.round(hours * 60);
    if (total < 1) return null;
    const h = Math.floor(total / 60), m = total % 60;
    return h ? `${h} hr${m ? ` ${m} min` : ''}` : `${m} min`;
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
    rowA.append(mk('arriveMinMi', 'Arrive at fuel with at least', 0, 150, 'miles left'));
    sec.append(rowA);
    const rowB = el('div', 'field-row');
    rowB.append(mk('maxFuelDetourMi', 'Furthest you will ride off the Parkway for fuel',
                   1, 30));
    sec.append(rowB);

    const rowC = el('div', 'field-row');
    const when = el('label', 'field');
    when.append(el('span', null, 'Setting off at'));
    const t = el('input');
    t.type = 'time';
    t.value = state.startTime;
    t.setAttribute('aria-label', 'Setting off at');
    t.onchange = e => {
      if (/^\d{2}:\d{2}$/.test(e.target.value)) { state.startTime = e.target.value; render(); }
      else { e.target.value = state.startTime; }
    };
    when.append(t);
    const camp = el('label', 'field');
    camp.append(el('span', null, 'Leaving camp at'));
    const t2 = el('input');
    t2.type = 'time';
    t2.value = state.campTime;
    t2.setAttribute('aria-label', 'Leaving camp at');
    t2.onchange = e => {
      if (/^\d{2}:\d{2}$/.test(e.target.value)) { state.campTime = e.target.value; render(); }
      else { e.target.value = state.campTime; }
    };
    camp.append(t2);
    camp.append(el('span', 'tiny', 'every morning after the first'));
    rowC.append(when, camp);
    sec.append(rowC);
    const rowD = el('div', 'field-row');
    rowD.append(mk('parkwayMph', 'Average speed on the Parkway', 15, 45, 'mph'));
    sec.append(rowD);
    sec.append(el('p', 'tiny',
      'The Parkway is signed at 45 mph and a lot of it is 35, so the clock matters more '
      + 'here than the mileage does: 469 miles at 40 mph is nearly twelve hours in the '
      + 'saddle before you stop to look at anything. Times below assume you keep moving, '
      + 'plus ten minutes at each fuel stop — overlooks, lunch and photographs are yours '
      + 'to add. Off-Parkway riding is estimated at 50 mph.'));
    sec.append(el('p', 'tiny',
      'The planner rides each tank as far as it goes, so without a buffer it will happily '
      + 'route you into a station on under a mile of range. Whatever you set here is still '
      + 'in the tank when you arrive — raise it and you get more stops, closer together.'));
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
  /* "US 21, Roaring Gap / Sparta, Roaring Gap / Sparta" -- many exit roads already carry
   * their town, so joining the two fields blindly says it twice. */
  const fuelLabel = stop => {
    const road = (stop.road || '').trim(), town = (stop.town || '').trim();
    if (!town) return road;
    if (!road) return town;
    return road.toLowerCase().includes(town.toLowerCase()) ? road : `${road}, ${town}`;
  };

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
    // "Top off before MP X" leads, because it is the one fuel instruction the rider acts
    // on before the ride starts, and it applies whether or not the Parkway itself needs a
    // stop. It used to be attached only to the branch that HAD stops, so the commonest
    // case -- a tank that covers the whole run -- said nothing about filling up at all.
    const fill = (f.ok && f.topOff) ? `Top off before MP ${f.topOff.accessMp}. ` : '';
    let fuelLine;
    if (!f.ok) fuelLine = '';
    else if (f.stops.length) {
      // "2 fuel stops on the way" is technically true of a round trip and reads as two
      // stops on the outbound leg. Split it, so the count matches what the list shows.
      const lastStay = (f.waypointPos || [])[state.stops.length];
      const home = lastStay == null ? 0
        : f.stops.filter(x => x.pos > lastStay + 1e-6).length;
      const out = f.stops.length - home;
      fuelLine = fill + (
        home && out
        ? `Then ${f.stops.length} fuel stops — ${out} on the way out, ${home} on the way home.`
        : home
        ? `Then ${home} fuel stop${home > 1 ? 's' : ''} on the way home.`
        : `Then ${out} fuel stop${out > 1 ? 's' : ''} on the way.`);
    } else if (thin) {
      fuelLine = fill
               + `After that it fits on one tank, but only just — you arrive with about `
               + `${f.arriveWithMi} mi left. Raise how far you will ride off the Parkway `
               + `for fuel, or shorten the day.`;
    } else {
      fuelLine = fill
               + `Nothing else needed — you arrive with about ${f.arriveWithMi} mi to spare.`;
    }
    const rideOut = trip.exitPoint ? trip.exitPoint.rideOutMi : 0;
    // Riding time, not elapsed time: overnights and lunch are the rider's own. At 40 mph a
    // 469 mile Parkway run is close to twelve hours, which is the fact the mileage hides
    // and the reason this line exists at all.
    // The same minutes the rows below add up to: real routed times for the ride in, the
    // hops off to each stop and the ride home; the flat rate only for a fuel detour, where
    // all anyone has is a radius.
    const legs = trip.roadLegs || [];
    const offMin = legs.reduce((a, l) => a + legMinutes(
      l, l.id === 'in' ? (c.approachMi || 0)
       : l.id === 'out' ? rideOut
       : (l.stop && l.stop.offParkwayMi) || 0), 0);
    const detourMin = f.ok
      ? f.stops.reduce((a, x) => a + (x.detourMi || 0) * 2, 0) / OFF_PARKWAY_MPH * 60 : 0;
    const movingMin = hoursFor(trip.parkwayMi || 0) * 60 + offMin + detourMin
                    + (f.ok ? f.stops.length * FUEL_STOP_MIN : 0)
                    + state.stops.filter(x => x.kind === 'food').length * MEAL_STOP_MIN;
    const timeLine = `About ${durationLabel(movingMin / 60)} moving at `
                   + `${state.parkwayMph} mph on the Parkway, before you stop to look at `
                   + `anything.`;
    const sumIn = legMiles(legs.find(l => l.id === 'in'), c.approachMi || 0);
    const sumOut = legMiles(legs.find(l => l.id === 'out'), rideOut);
    summary.textContent = `${miLabel(sumIn)} in, ${trip.parkwayMi} mi on the Parkway`
                        + (rideOut ? `, ${miLabel(sumOut)} out` : '')
                        + `. ${timeLine} ${fuelLine}`;
    sec.append(summary);
    // Say what the fuel plan does NOT cover. This dataset maps fuel at Parkway exits and
    // nothing else, so the ride in and the ride home are unplanned -- and a rider who
    // assumes otherwise runs the one risk the whole fuel model exists to remove.
    sec.append(el('p', 'tiny',
      'Fuel stops are worked out for the Parkway itself only. The ride to the Parkway and '
      + 'the ride home are on ordinary roads this planner does not map, so start with a '
      + 'full tank and find your own fuel once you are off.'));
    if (trip.severedNote) sec.append(el('div', 'alert warn', trip.severedNote));
    wrap.append(sec);

    /* The itinerary, in the order the rider actually meets each thing.
     *
     * This used to print every fuel stop in one block and then every overnight, which is
     * wrong the moment a trip doubles back -- and a round trip always does. Abingdon to
     * Devils Backbone and home is 556 miles of Parkway, and its two fuel stops fall at
     * mile 186 and mile 378: one on the way out, one on the way home. Listed together
     * they read as two stops twelve miles apart, which is nonsense, and they hid the
     * thing the rider most needed to see -- that there IS a fuel stop after camp.
     *
     * planJourney lays the whole journey out as one distance line and gives every stop a
     * position on it. So does every waypoint. Sorting by that position puts each step
     * where it happens.
     */
    const steps = el('div', 'day');
    /* Read back by each row's closure AFTER the clock walk below has filled the event in.
     * The rows are built before the walk -- they have to be, the walk needs them sorted --
     * so they close over the event object rather than over a value. */
    const timeSuffix = ev => {
      const leg = durationLabel(ev.legHours || 0);
      return ` \u00b7 ${leg ? `${leg} riding \u00b7 ` : ''}arrive about ${clockLabel(ev.atMin)}`;
    };
    const inMi = legMiles((trip.roadLegs || []).find(l => l.id === 'in'), c.approachMi || 0);
    steps.append(stepRow('HOME', state.start.label,
                         `${miLabel(inMi)} to the Parkway at MP ${c.mp}`
                         + ` \u00b7 leave about ${clockLabel(startMinutes())}`));

    const wpos = (f.ok && f.waypointPos) ? f.waypointPos : null;
    // Tank state at each waypoint comes from the journey simulation, so the figure shown
    // at camp is what the rider actually has for the morning -- campsites sell no fuel.
    const tankAt = (f.tankAt || []).map(t => t.tankMi);

    const events = [];
    // A 150 mile approach when a 64 mile one is visibly nearer reads as a broken planner.
    // It is not: the nearer entrance is on the far side of a Helene break and cannot reach
    // this stop on the Parkway at all. Say which entrance, and how much it would have
    // saved, so the rider can weigh moving the stop instead of just distrusting the plan.
    const sev = c.severedAlternative;
    /* Fill up before you join.
     *
     * order -1 puts it above "Get on the Parkway" at the same position, which is the whole
     * point: the Parkway has no fuel on it and the road in is covered with it, so the tank
     * is taken care of on the approach and never as a detour off the ride.
     *
     * It costs no time of its own -- it happens during the ride in, which is already on the
     * clock -- so it carries no offMi and no dwell.
     */
    if (f.ok && f.topOff) {
      const n = f.topOff.nearest;
      events.push({ pos: wpos ? wpos[0] : 0, order: -1, row: () => stepRow(
        'FUEL', 'Top off before you get on',
        `No fuel anywhere on the Parkway — fill up on the way in, before MP `
        + `${f.topOff.accessMp}`
        + (n ? ` \u00b7 if you arrive low, nearest mapped pump is ${n.town || n.road} `
             + `(MP ${n.mp}), about ${Math.round(f.topOff.nearestMi)} mi off` : ''),
        'fuel') });
    }

    const legIn = (trip.roadLegs || []).find(l => l.id === 'in');
    const onParkway = { pos: wpos ? wpos[0] : 0, order: 0, offMi: c.approachMi || 0,
                        leg: legIn };
    onParkway.row = () => stepRow(
      `MP ${c.mp}`, `Get on the Parkway — ${c.name}`,
      (sev ? `Closest entry that can actually reach your stop. MP ${sev.mp} (${sev.name}) `
           + `is ${sev.savedMi} mi nearer to you, but the Parkway is severed between there `
           + `and here, so it cannot get you to this stop.`
           : 'Closest entry from where you are starting')
      + ` \u00b7 ${miLabel(inMi)} from ${state.start.label.split(',')[0]}`
      + timeSuffix(onParkway));
    events.push(onParkway);

    state.stops.forEach((st, i) => {
      const t = tankAt[i + 1];
      const last = i === state.stops.length - 1;
      const meal = st.kind === 'food';
      // The ride back to the Parkway belongs to the leg AFTER this stop -- it happens
      // the next morning, after the overnight, not on the evening you arrive.
      const prev = state.stops[i - 1];
      const ev = { pos: wpos ? wpos[i + 1] : i + 1, order: 1,
                   preLeg: prev
                     ? (trip.roadLegs || []).find(l => l.id === `back-${prev.id}`) : null,
                   preMi: prev ? (prev.offParkwayMi || 0) : 0,
                   // offParkwayMi, not off_parkway_mi. A stop comes from BRP.placeStop,
                   // which writes the camelCase name -- so this read undefined and the ride
                   // out to a campsite six miles off the Parkway cost no time at all.
                   offMi: st.offParkwayMi || 0,
                   leg: (trip.roadLegs || []).find(l => l.id === `off-${st.id}`),
                   // Only a day break the rider actually set stops the clock. A stop they
                   // ride straight through is a waypoint, not a night -- and a meal never
                   // is one, whatever else it is.
                   overnight: !meal && !!st.dayBreakAfter,
                   // Long enough to sit down and eat. Not padding: a rider who plans lunch
                   // and then arrives everywhere 45 minutes early has been told a fiction.
                   dwellMin: meal ? MEAL_STOP_MIN : 0 };
      ev.row = () => stepRow(
        `MP ${st.mp.toFixed(1)}`, st.name,
        [meal ? 'Eat here'
              : last && !trip.exitPoint ? 'Arrive'
              : last ? 'Camp here' : `Overnight ${i + 1}`,
         t != null ? `about ${t} mi of fuel in the tank` : null]
        .filter(Boolean).join(' \u00b7 ') + timeSuffix(ev), meal ? 'food' : 'ok');
      events.push(ev);
    });

    if (f.ok) {
      // Anything past the last overnight is on the ride home. Saying so is the whole
      // point: a rider who cannot tell will read it as a stop they already made.
      const lastStayPos = wpos ? wpos[state.stops.length] : Infinity;
      f.stops.forEach(stop => {
        // Arriving on exactly the buffer is the plan WORKING, not a warning. The floor
        // is the rider's own; flagging it would be the app second-guessing a number they
        // just typed. So this fires only below the buffer -- or below 10 mi when they
        // have set no buffer at all, which is the case the buffer exists to prevent.
        const floor = Math.max(10, f.arriveMinMi || 0);
        // The top-off has no arrival figure and must not pretend to: what is in the tank
        // when the rider reaches the FIRST pump is the one number nobody has told us, and
        // saying "about null mi in the tank" is how a placeholder ships.
        const tight = !stop.topOff && stop.arriveTankMi < floor - 0.05;
        const homeward = stop.pos > lastStayPos + 1e-6;
        const detail = [
          homeward ? 'On the way home' : null,
          stop.detourMi ? `${stop.detourMi} mi off the Parkway` : 'right at the exit',
          stop.topOff
            ? 'fill up here — everything after this is planned from a full tank'
            : tight ? `cutting it fine — you arrive with about ${stop.arriveTankMi} mi in the tank`
                    : `about ${stop.arriveTankMi} mi in the tank on arrival`
        ].filter(Boolean).join(' \u00b7 ');
        // A detour is ridden twice, and the rider is off the bike at the pump.
        const ev = { pos: stop.pos, order: 2, offMi: (stop.detourMi || 0) * 2,
                     dwellMin: FUEL_STOP_MIN };
        ev.row = () => stepRow(
          `MP ${stop.mp}`,
          stop.topOff ? `Top off — ${fuelLabel(stop)}` : `Fuel — ${fuelLabel(stop)}`,
          detail + timeSuffix(ev),
          (tight || stop.grade === 'unconfirmed') ? 'alert' : 'fuel');
        events.push(ev);
      });
    }

    if (trip.exitPoint) {
      const t = tankAt[tankAt.length - 1];
      const last = state.stops[state.stops.length - 1];
      const ev = { pos: wpos ? wpos[wpos.length - 1] : 1e9, order: 3,
                   preLeg: last
                     ? (trip.roadLegs || []).find(l => l.id === `back-${last.id}`) : null,
                   preMi: last ? (last.offParkwayMi || 0) : 0 };
      ev.row = () => stepRow(
        `MP ${trip.exitPoint.mp}`, `Leave the Parkway — ${trip.exitPoint.name}`,
        [`${trip.exitPoint.parkwayMi} mi of Parkway from camp`,
         t != null ? `about ${t} mi of fuel left` : null].filter(Boolean).join(' \u00b7 ')
        + timeSuffix(ev));
      events.push(ev);
    }

    // `order` breaks ties at the same position: a fuel stop sitting exactly on an
    // overnight's milepost is reached after arriving, and leaving the Parkway is last.
    events.sort((a, b) => (a.pos - b.pos) || (a.order - b.order));

    /* Walk the sorted events once and put a clock on each.
     *
     * Parkway miles between events come from the journey line, which already accounts for
     * a round trip passing the same milepost twice. Off-Parkway miles are declared by the
     * event itself -- the ride in, a detour to a pump and back, the hop out to a campsite.
     * An overnight stops the clock and restarts it at the next morning's start time, so a
     * three-day trip does not report arriving at four in the morning.
     */
    let clock = startMinutes(), lastPos = 0;
    events.forEach(ev => {
      // The top-off happens during the ride in, which the "get on the Parkway" row already
      // charges for. Giving it a row of its own must not give it a duration of its own.
      if (ev.order === -1) { ev.legHours = 0; ev.atMin = clock; return; }
      const parkwayMin = hoursFor(Math.max(0, ev.pos - lastPos)) * 60;
      const offMin = ev.leg ? legMinutes(ev.leg, ev.offMi) : (ev.offMi || 0) / OFF_PARKWAY_MPH * 60;
      // Plus getting back to the Parkway from wherever the last stop was.
      const preMin = ev.preLeg ? legMinutes(ev.preLeg, ev.preMi)
                   : (ev.preMi || 0) / OFF_PARKWAY_MPH * 60;
      const legHours = (parkwayMin + offMin + preMin) / 60;
      ev.legHours = legHours;
      ev.routed = !!(ev.leg && (Directions.peek(ev.leg.from, ev.leg.to) || {}).ok);
      clock += legHours * 60;
      ev.atMin = clock;
      clock += ev.dwellMin || 0;
      if (ev.overnight) {
        // Next morning, at the hour the rider said they set off.
        clock = (Math.floor(clock / 1440) + 1) * 1440 + campMinutes();
      }
      lastPos = ev.pos;
    });
    events.forEach(e => steps.append(e.row()));

    if (trip.exitPoint) {
      const legOut = (trip.roadLegs || []).find(l => l.id === 'out');
      const outMin = legMinutes(legOut, trip.exitPoint.rideOutMi || 0);
      const finishMin = (events.length ? events[events.length - 1].atMin : startMinutes())
                      + outMin;
      const outLabel = durationLabel(outMin / 60);
      const outMi = legMiles(legOut, trip.exitPoint.rideOutMi || 0);
      steps.append(stepRow('FINISH', trip.endLabel,
        `${miLabel(outMi)} from the Parkway to here`
        + (outLabel ? ` \u00b7 ${outLabel} riding` : '')
        + ` \u00b7 arrive about ${clockLabel(finishMin)}`, 'ok'));
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
    state.stops.forEach((st, i) => {
      seq.push({ kind: 'parkway', from: atMp, to: st.mp, arriveAt: st, stopIndex: i });
      const off = legFor(`off-${st.id}`);
      if (off) seq.push({ kind: 'road', leg: off });
      const back = legFor(`back-${st.id}`);
      if (back) seq.push({ kind: 'road', leg: back });
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

    /* Fuel stops belong to a LEG, not to a milepost.
     *
     * This filtered by milepost alone, and a round trip passes every milepost twice -- so
     * a pump planned for the ride home was listed in the outbound directions, and again on
     * the way back. On a Waynesboro round trip the outbound leg advertised US 60 at MP
     * 45.6, which the rider does not stop at until the following day.
     *
     * planJourney lays the whole ride out as one distance line and gives every stop a
     * position on it, and waypointPos says where each leg begins and ends. Filtering on
     * that puts each stop on the one leg it actually happens on.
     */
    const wp = trip.fuel.waypointPos || [];
    const i = item.stopIndex;
    const posFrom = item.isExit ? wp[wp.length - 2] : wp[i];
    const posTo = item.isExit ? wp[wp.length - 1] : wp[i + 1];
    const passing = (trip.fuel.stops || []).filter(f => (posFrom == null || posTo == null)
      ? (f.mp >= lo && f.mp <= hi)                     // no journey line: fall back
      : (f.pos > posFrom - 1e-6 && f.pos < posTo + 1e-6));
    passing.sort((a, b) => a.pos - b.pos);
    /* Each line says how far into THIS leg it happens.
     *
     * A milepost on its own does not tell a rider whether something is on their path --
     * mileposts run one way, a leg may run the other, and a round trip covers the same
     * numbers twice. "31 mi into this leg" is checkable against the odometer; "MP 63.5" is
     * a fact about the road that the rider then has to place themselves. */
    const intoLeg = mp => Math.round(Math.abs(mp - item.from));

    /* A fuel stop and a closure are not steps you ride -- they are things you MEET while
     * riding the step above. Numbered in line with the turns, "Closure, MP 63.5-63.9" read
     * as an instruction of its own, on a stretch of road the rider had not been told they
     * were on. `leg-note` drops them out of the numbering and indents them under the leg
     * they describe. */
    passing.forEach(f => {
      const li = el('li', 'leg-note fuel');
      li.append(el('b', null, 'Fuel stop,'));
      li.append(document.createTextNode(
        ` ${intoLeg(f.mp)} mi into this leg — MP ${f.mp}, `
        + `${[f.road, f.town].filter(Boolean).join(', ')}`
        + `${f.detourMi ? `. Leave the Parkway ${f.detourMi} mi, then back on` : ''}.`));
      ol.append(li);
    });

    // A closure counts when the rider RIDES THROUGH it, so a range that merely touches the
    // end of this leg is not one -- and neither is anything on a stretch of Parkway this
    // leg does not cover.
    (D.closures || [])
      .filter(c => c.to_mp > lo + 1e-9 && c.from_mp < hi - 1e-9)
      .forEach(c => {
        const li = el('li', 'leg-note closed');
        // "None" arrives as a STRING from the closure feed, so a truthiness test printed
        // "Follow the signed detour: None." on the two stretches that have no detour at all.
        const detour = c.detour && String(c.detour).trim().toLowerCase() !== 'none'
          ? `Follow the signed detour: ${c.detour}.`
          : 'No detour — the Parkway is severed here.';
        li.append(el('b', null, 'Closure,'));
        li.append(document.createTextNode(
          ` ${intoLeg(c.from_mp)} mi into this leg — MP ${c.from_mp}\u2013${c.to_mp}, `
          + `${c.reason}. ${detour}`));
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

  /* `level` colours the step's title.
   *
   *   ok     a place you sleep -- green, the thing the trip is for
   *   fuel   every fuel stop -- amber, so the refuels stand out when scanning the list
   *   alert  a fuel stop with a problem: below the arrival buffer, or unconfirmed
   *   warn   anything else worth a second look
   *
   * "fuel" is unconditional. It used to inherit amber from the "cutting it fine" warning,
   * which fired on nearly every stop back when the planner rode each tank to empty. Fixing
   * that silenced the warning and took the colour with it -- the fuel stops went plain
   * grey and stopped being findable at a glance.
   */
  function stepRow(marker, title, detail, level) {
    const node = el('div', 'stop');
    node.append(el('div', 'grip', marker));
    const body = el('div', 's-body');
    const name = el('div', 's-name', title);
    if (level === 'ok') name.style.color = 'var(--ok)';
    if (level === 'warn' || level === 'fuel') name.style.color = 'var(--warn)';
    if (level === 'alert') name.style.color = 'var(--rust)';
    // The same purple the food glyph uses. A step's colour and its pin should agree, or
    // the itinerary and the map are two different keys for one trip.
    if (level === 'food') name.style.color = 'var(--food)';
    body.append(name);
    if (detail) body.append(el('div', 's-meta', detail));
    node.append(body);
    return node;
  }

  /* ---- rendering: browse --------------------------------------------------- */
  /* ---- rendering: browse ---------------------------------------------------
   *
   * The lookup tab. Same search, same filters, same cards as Plan step 2 -- because a
   * rider should not have to learn two interfaces to the same 478 places -- plus fuel,
   * which Plan does not offer because Plan picks the fuel stops for you.
   *
   * Nothing here commits to the trip. Tapping a row opens the place on the map, and the
   * card's own button is what adds it. Browse rows used to call addStop() on click, so a
   * rider skimming the list to see what was out there quietly built an itinerary.
   */
  function renderBrowse() {
    const pane = $('#pane-browse');
    pane.textContent = '';
    const f = FINDER.browse;

    const sec = el('div', 'section');
    const input = el('input');
    input.type = 'search';
    input.placeholder = state[f.kind] === 'fuel'
      ? 'Search by town, road or milepost\u2026'
      : 'Search by name, town or milepost\u2026';
    input.setAttribute('aria-label', 'Search places');
    input.value = state[f.query] || '';
    sec.append(input);

    sec.append(finderChips(f, renderBrowse));

    const extras = el('div', 'chip-row');
    extras.style.marginTop = '6px';
    if (state[f.kind] !== 'fuel') {
      for (const [key, label, hint] of [
        ['motoOnly', 'Moto camps', 'Places that cater to motorcyclists specifically'],
        ['topOnly', 'Top picks', 'The researched shortlist']]) {
        const c = el('button', `chip${state.filters[key] ? ' on' : ''}`, label);
        c.title = hint;
        c.setAttribute('aria-pressed', String(!!state.filters[key]));
        c.onclick = () => { state.filters[key] = !state.filters[key]; renderBrowse(); };
        extras.append(c);
      }
      sec.append(extras);
    }

    const count = el('div', 'tiny');
    count.style.marginTop = '8px';
    const list = el('div', 'scroller');
    sec.append(count, list);

    const matches = () => finderMatches(f)
      .filter(c => c.kind === 'fuel' || !state.filters.motoOnly || c.moto)
      .filter(c => c.kind === 'fuel' || !state.filters.topOnly || c.tier === 'top');

    const draw = () => {
      list.textContent = '';
      const rows = matches();
      const pool = state[f.kind] === 'fuel'
        ? D.fuel.length
        : (D.places || []).length + (state[f.google] || []).length;
      count.textContent = `${rows.length} of ${pool} `
        + (state[f.kind] === 'fuel' ? 'fuel exits' : 'places');
      if (!rows.length) {
        list.append(emptyNote(f));
        return;
      }
      rows.slice(0, 300).forEach(c => list.append(finderRow(c)));
    };
    input.oninput = e => { state[f.query] = e.target.value; draw(); };
    draw();

    sec.append(googleSearchRow(f));

    if (state[f.kind] === 'fuel') {
      sec.append(el('div', 'tiny',
        'There is no fuel anywhere on the Parkway itself \u2014 every one of these is a '
        + 'ride off it and back, and the mileage shown is one way. Grades separate two '
        + 'things on purpose: whether a pump exists, and whether you can reach it in 2026. '
        + 'A "Google" badge means Google lists it and nobody has stood in front of it.'));
    }

    pane.append(sec);
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
                       tankMi: state.tankMi, arriveMinMi: state.arriveMinMi,
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
    /* This version, and how to get another one.
     *
     * An installed app has no address bar, so "reload the page" is not an instruction
     * anybody can follow, and deleting the icon does not clear the storage -- which is why
     * a reinstall looks like nothing happened. The app updates itself now; this is here so
     * a rider can SEE which version they are on rather than take it on faith.
     */
    const about = el('div', 'section');
    about.append(el('h2', null, 'This app'));
    const ver = el('p', 'muted');
    ver.append(document.createTextNode('Version '));
    const code = el('strong', null, window.BRP_VERSION || 'unknown');
    ver.append(code);
    ver.append(document.createTextNode(
      '. It checks for a new one every time you open it and updates on its own — '
      + 'nothing to reload, nothing to reinstall. Tell me this number if something looks '
      + 'wrong and I will know exactly what you are running.'));
    about.append(ver);

    const btns = el('div', 'btn-row');
    const check = el('button', 'btn sm ghost', 'Check for an update now');
    check.onclick = async () => {
      check.disabled = true;
      check.textContent = 'Checking\u2026';
      try {
        const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      } catch (e) { /* offline, which is not an error worth shouting about */ }
      // A reload here is safe: the trip is written to storage on every render. If a new
      // version did arrive, this is the moment it takes over.
      setTimeout(() => location.reload(), 800);
    };
    btns.append(check);

    /* Your trip outlives the app icon.
     *
     * Deleting a home-screen app does not clear its storage, so a reinstall comes back with
     * the same trip and looks like nothing was reset. That is the RIGHT behaviour -- a
     * planned trip should survive a phone tidy-up -- but it needs a door, and there was
     * none.
     */
    const wipe = el('button', 'btn sm ghost', 'Start a new trip');
    wipe.onclick = () => {
      const n = state.stops.length;
      const what = state.start || n
        ? `Clear the trip${n ? ` and its ${n} stop${n > 1 ? 's' : ''}` : ''}?`
        : 'Clear the saved trip?';
      if (!confirm(`${what} This cannot be undone.`)) return;
      wiped = true;                  // stop any in-flight render writing it back
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* private mode */ }
      location.reload();
    };
    btns.append(wipe);
    about.append(btns);
    about.append(el('p', 'tiny',
      'Starting a new trip clears your stops and settings from this phone. It does not '
      + 'touch the campground, fuel or closure data, which ship with the app.'));
    pane.append(about);

    const acc = D.milepost_accuracy;
    const sections = [
      ['Riding with no signal', 'Add this to your home screen and it installs as an app: '
        + 'the whole planner, every campground, every fuel exit and the Parkway itself are '
        + 'already on the phone, so it opens and plans with the radio off. Two things are '
        + 'not. Map TILES are cached only as you look at them, so pan along your route at '
        + 'home and that corridor stays visible in a dead zone \u2014 anywhere you have not '
        + 'looked shows empty squares over a working map. And anything that asks Google, or '
        + 'looks up an address, needs signal by definition; the plan itself does not.'],
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
      L.polyline(geom, Object.assign({ opacity: .9 }, LINE.parkwayOpen))
        .bindPopup(`<h3>Parkway open</h3>MP ${seg.from_mp}–${seg.to_mp} · ${seg.length_mi} mi`)
        .addTo(layers.parkway);
    });
    layers.closed = L.layerGroup().addTo(map);
    D.closures.forEach(c => {
      const a = BRP.coordAtMp(c.from_mp), b = BRP.coordAtMp(c.to_mp);
      const i0 = BRP.indexAtMp(c.from_mp), i1 = BRP.indexAtMp(c.to_mp);
      const geom = [a, ...D.parkway.slice(i0, i1 + 1), b];
      L.polyline(geom, Object.assign({ opacity: .95 }, LINE.parkwayClosed))
        .bindPopup(`<h3>Closed · MP ${c.from_mp}–${c.to_mp}</h3>${c.reason}` +
                   (c.detour ? `<br><br>Detour: ${c.detour}` : '<br><br>No detour — this severs the Parkway.'))
        .addTo(layers.closed);
    });

    layers.stops = L.layerGroup().addTo(map);
    layers.spider = L.layerGroup().addTo(map);
    layers.me = L.layerGroup().addTo(map);
    layers.route = L.layerGroup().addTo(map);
    layers.preview = L.layerGroup().addTo(map);

    // A bare tap on the map used to open a browser prompt asking to name a custom stop.
    // On a phone, panning with one finger lands as a tap often enough that the prompt
    // became a regular interruption. It now only fires when the rider has explicitly
    // asked to drop a pin.
    map.on('click', e => {
      if (!state.pinMode) return;
      state.pinMode = false;
      state.start = { lat: +e.latlng.lat.toFixed(5), lon: +e.latlng.lng.toFixed(5),
                      label: `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}` };
      save();
      render();
    });
    // Clustering is computed in screen space, so it has to be recomputed whenever the
    // screen moves. placePins() bails early when the visible set has not changed.
    map.on('zoomend moveend', placePins);
    refreshLegend();
    drawMarkers();
    initMapToggle();
    initGps();
  }

  /* A message on the map itself. The GPS control lives over the map, and the sidebar
   * status line it would otherwise use can be on a different tab or scrolled off a phone
   * screen entirely -- a refused permission has to be said where the rider is looking. */
  let noteTimer = null;
  function mapNote(text) {
    const host = $('#map');
    if (!host) return;
    let n = host.querySelector('.mapnote');
    if (!n) { n = el('div', 'mapnote'); host.append(n); }
    n.textContent = text;
    n.classList.add('show');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => n.classList.remove('show'), 6000);
  }

  /* ---- where the rider is ---------------------------------------------------------
   *
   * A live position marker, which on this map is worth more than it would be on most:
   * the Parkway has no house numbers, the mileposts are small concrete posts, and phone
   * signal disappears for miles at a time. Geolocation reads the GPS chip and does not
   * need the network, so this keeps working in exactly the places the rest of the
   * internet does not.
   *
   * It is opt-in and it is stoppable, because watchPosition with high accuracy on is a
   * real battery cost on a long day.
   */
  let watchId = null, meMarker = null, meRing = null, lastFix = null;

  function gpsSupported() {
    return !!(navigator.geolocation
              && (location.protocol === 'https:' || location.hostname === 'localhost'
                  || location.protocol === 'file:'));
  }

  function startGps() {
    if (!gpsSupported() || watchId != null) return;
    state.gps = true;
    save();
    watchId = navigator.geolocation.watchPosition(onFix, onGpsError, {
      enableHighAccuracy: true,
      maximumAge: 5000,      // a five-second-old fix is fine at road speed
      timeout: 20000
    });
    renderGpsButton();
  }

  function stopGps() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    state.gps = false;
    lastFix = null;
    save();
    if (layers.me) layers.me.clearLayers();
    meMarker = meRing = null;
    renderGpsButton();
  }

  function onFix(pos) {
    const { latitude: lat, longitude: lon, accuracy, heading, speed } = pos.coords;
    lastFix = { lat, lon, accuracy, heading, speed, at: pos.timestamp };
    if (!map || !layers.me) return;

    // Phones report a heading only while actually moving; a parked bike gets a compass
    // reading of NaN or a stale value, and an arrow pointing the wrong way is worse than
    // no arrow. Below walking pace, don't claim a direction.
    const dir = (heading != null && !Number.isNaN(heading) && (speed || 0) > 1.5)
      ? heading : null;

    if (!meMarker) {
      meMarker = L.marker([lat, lon], { icon: meIcon(dir), zIndexOffset: 1000,
                                        interactive: true, keyboard: false })
        .bindTooltip('You, right now', { direction: 'top' })
        .addTo(layers.me);
    } else {
      meMarker.setLatLng([lat, lon]);
      meMarker.setIcon(meIcon(dir));
    }

    // The accuracy circle is the honest part: a 300 m fix under tree cover should not look
    // like a 5 m one, or the rider trusts a milepost reading that was never that precise.
    const r = Math.max(accuracy || 0, 8);
    if (!meRing) {
      // Not interactive: a 300 m accuracy circle is a very large tap target, and it would
      // otherwise swallow every press meant for a marker underneath it.
      meRing = L.circle([lat, lon], { radius: r, color: ME, weight: 1, interactive: false,
                                      opacity: .5, fillColor: ME, fillOpacity: .12 })
        .addTo(layers.me);
    } else {
      meRing.setLatLng([lat, lon]);
      meRing.setRadius(r);
    }

    if (state.gpsFollow) {
      followingProgrammatically = true;
      map.setView([lat, lon], Math.max(map.getZoom(), 13), { animate: false });
      followingProgrammatically = false;
    }
    renderGpsButton();
  }

  function onGpsError(err) {
    const why = err.code === 1 ? 'Location permission was refused.'
              : err.code === 3 ? 'No GPS fix yet — try again with a clear view of the sky.'
              : 'Location is unavailable right now.';
    stopGps();
    const btn = $('#gpsbtn');
    if (btn) btn.title = why;
    mapNote(why);
  }

  /* Panning by hand means the rider wants to look somewhere else, so stop dragging the map
   * back to them. This is the same mistake the popup's keepInView makes, and it is much
   * more annoying when it fires every second. */
  let followingProgrammatically = false;
  function watchForManualPan() {
    map.on('dragstart', () => {
      if (followingProgrammatically || !state.gpsFollow) return;
      state.gpsFollow = false;
      save();
      renderGpsButton();
    });
  }

  function renderGpsButton() {
    const btn = $('#gpsbtn');
    if (!btn) return;
    const on = watchId != null;
    btn.classList.toggle('on', on);
    btn.classList.toggle('following', on && state.gpsFollow);
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on
      ? (state.gpsFollow ? 'Following your location — tap to stop following'
                         : 'Showing your location — tap to follow it again')
      : 'Show where you are on the map');
    if (!btn.title || on) {
      btn.title = on
        ? (lastFix
            ? `You, ${Math.round(lastFix.accuracy)} m accuracy`
               + (state.gpsFollow ? ' — following' : ' — tap to follow')
            : 'Waiting for a GPS fix…')
        : 'Show where you are';
    }
  }

  function initGps() {
    const btn = $('#gpsbtn');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    if (!gpsSupported()) { btn.hidden = true; return; }
    btn.onclick = () => {
      if (watchId == null) { state.gpsFollow = true; startGps(); return; }
      // Already tracking: first tap re-centres and resumes following, second turns it off.
      if (!state.gpsFollow) {
        state.gpsFollow = true;
        save();
        if (lastFix) map.setView([lastFix.lat, lastFix.lon], Math.max(map.getZoom(), 13));
        renderGpsButton();
      } else {
        stopGps();
      }
    };
    watchForManualPan();
    renderGpsButton();
    // Resume only when the browser already holds the permission, so returning to the app
    // mid-ride picks straight back up without ever prompting out of the blue.
    if (state.gps && navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' })
        .then(p => { if (p.state === 'granted') startGps(); })
        .catch(() => {});
    }
  }

  /* Give the phone its whole screen for whichever half is being used.
   *
   * Split gives the map 42vh and the list what is left, which is the right default and the
   * wrong answer for both jobs when you are actually doing one of them: reading a list of
   * 478 places through a 400px window, or looking at where a campsite sits on a 350px map.
   *
   * Desktop never sees this -- there is room for both there, and the button is display:none.
   */
  function initMapToggle() {
    const btn = $('#maptoggle');
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = '1';
    btn.onclick = () => {
      // Split -> full map -> full list -> split. It used to flip between the two full
      // views only, so the first tap locked the rider out of the half-and-half default
      // for the rest of the session with no way back to it.
      state.mapView = state.mapView === 'split' ? 'map'
                    : state.mapView === 'map' ? 'list' : 'split';
      applyMapView();
    };
    applyMapView();
  }

  function applyMapView() {
    const app = $('#app'), btn = $('#maptoggle');
    if (!app || !btn) return;
    app.classList.toggle('map-full', state.mapView === 'map');
    app.classList.toggle('list-full', state.mapView === 'list');
    // The label names what the next tap GIVES you, so the cycle needs no explaining.
    const next = state.mapView === 'split' ? 'Full map'
               : state.mapView === 'map' ? 'Full list' : 'Split view';
    btn.textContent = next;
    btn.setAttribute('aria-label', next);
    // Leaflet caches the container size, so a pane that changed height behind its back
    // renders grey tiles and puts clicks in the wrong place until it is told.
    if (map) setTimeout(() => map.invalidateSize({ animate: false }), 60);
  }

  /* The palette lives in CSS and nowhere else.
   *
   * Leaflet takes colours as strings, so the map used to carry its own copy of every hex.
   * Two copies of a palette is one palette and one thing that is quietly wrong after a
   * rebrand -- so these read the CSS custom properties instead. Re-read on every draw, so
   * a system light/dark switch repaints the markers with the rest of the page.
   */
  const C = (name, fallback) =>
    (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim()
    || fallback;

  /* The map's whole vocabulary lives in map-pins.js, not here.
   *
   * It used to live in a MAPKEY() table next to a separate set of colour functions, and
   * the two said different things: a dot's colour meant "what kind of place is this" for
   * campgrounds and "how much do you trust this" for fuel, so amber was simultaneously
   * "top pick" and "unconfirmed". Nine meanings shared six colours, three of them exact
   * duplicates.
   *
   * The rule now is shape for category, fill for trust, a star for a top pick -- three
   * channels for three variables, and no colour doing two jobs. What is left in this file
   * is the mapping from OUR data to that vocabulary; the drawing and the legend both come
   * out of pinSvg(), so the key cannot describe a marker the map does not draw.
   */

  const placeKind = c => c.kind === 'hotel' ? 'hotel'
                       : c.kind === 'food' ? 'food'
                       : c.moto ? 'moto' : 'camp';

  /* Cream is the claim that a human checked this place for this planner. That is exactly
   * what `source: 'curated'` means -- 32 places out of 478 -- and it used to be encoded as
   * "a bigger dot", a fourth variable in a channel the key never demonstrated. The other
   * 446 come from OSM and Google: real places, nobody rode to them, so they get the
   * dashed slate ring that says listed-not-verified. */
  const placeOpts = c => ({
    trust: c.source === 'curated' ? 'verified' : 'listed',
    top: c.tier === 'top'
  });

  /* Fuel that is worth drawing, and how much to trust it.
   *
   * A pump that is gone, unreliable or cut off by a closure is not drawn at all. It was
   * red, and then struck through, and the honest question is what a rider was supposed to
   * do with that at 60mph: it is a marker whose entire content is "not this one". The two
   * on this map -- MP 248.1 Laurel Springs, on every official fuel list with nothing
   * verifiable behind it, and MP 344.1 NC 80, inside the severed MP 333.9-355.3 section --
   * are still in the Browse list with the reason, which is where you would go to find out
   * why a gap exists. They are already excluded from route planning.
   *
   * What is left splits two ways. The 34 exits researched by hand are green. The 247 the
   * Google sweep found are real listings nobody has ridden to, so they are grey: usable,
   * and visibly a weaker claim. That distinction is why the sweep was kept separate from
   * the curation in the first place.
   */
  const FUEL_ON_MAP = f =>
    f.plan_grade !== 'unreachable' && f.plan_grade !== 'do_not_rely'
    && !!(f.stations && f.stations.length);

  function fuelOpts(f) {
    if (f.plan_grade === 'usable_google') return { trust: 'listed' };
    if (f.confidence === 'likely' || f.confidence === 'unverified')
      return { trust: 'listed' };
    return { trust: 'verified' };
  }

  /* Selection scales and glows; it never recolours. Fill already carries trust, so an
   * amber selected pin would be claiming the place is a top pick. */
  function selectedIcon(kind, opts) {
    const icon = pinIcon(kind, Object.assign({ size: 38 }, opts));
    icon.options.className = 'brp-pin is-selected';
    return icon;
  }

  /* A legend the rider can collapse. Open by default the first time, because a map of
   * unexplained coloured dots is the thing being fixed; remembered thereafter. */
  function mapLegend() {
    const box = el('div', `legend${state.legendOpen ? '' : ' shut'}`);
    const head = el('button', 'legend-head');
    head.append(el('span', null, 'Map key'));
    head.append(el('span', 'legend-toggle', state.legendOpen ? '\u2715' : '?'));
    head.setAttribute('aria-expanded', String(!!state.legendOpen));
    head.onclick = () => { state.legendOpen = !state.legendOpen; save(); render(); };
    box.append(head);
    if (!state.legendOpen) return box;

    // Rows come from legendHtml(), which draws its swatches with the same pinSvg() the
    // markers use. Hand-written swatches are how a key goes stale; these physically
    // cannot.
    const body = el('div', 'legend-body');
    body.innerHTML = legendHtml(state.mapShow);

    // The four category rows double as switches. A key that only explains the map is
    // half a control panel: with 761 markers on one road, being able to drop the fuel
    // while looking for a campsite is worth more than the explanation is.
    body.querySelectorAll('[data-shape]').forEach(rowEl => {
      const kind = rowEl.getAttribute('data-shape');
      const toggle = () => {
        state.mapShow[kind] = !state.mapShow[kind];
        save();
        drawMarkers();
        refreshLegend();
      };
      rowEl.onclick = toggle;
      rowEl.onkeydown = e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      };
    });

    body.append(el('div', 'key-footer', LEGEND_FOOTER));
    box.append(body);
    return box;
  }

  function refreshLegend() {
    const host = $('#map');
    if (!host) return;
    const old = host.querySelector('.legend');
    if (old) old.remove();
    host.append(mapLegend());
  }

  /* Route furniture -- where the ride starts, and the shaping points on it.
   *
   * These stay plain dots on purpose. The glyph pins answer "what is this place and how
   * much do you trust it"; a start point and a via waypoint are neither. Giving them a
   * tent or a bed would invite a tap that adds them to the trip, and inventing a glyph
   * for each would put two more shapes in a key whose whole point is that it is short.
   * They are half the size of a pin, carry no ring colour from the trust scale, and the
   * vias take the route's own magenta so they read as belonging to the line. */
  function dot(color, size = 11) {
    return L.divIcon({
      className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
      html: `<div class="pin" style="width:${size}px;height:${size}px;background:${color}"></div>`
    });
  }

  /* Every marker behaves the same way: it says what it is on hover, and shows its card
   * on tap. Nothing joins the trip without a second, deliberate press.
   *
   * It did not used to. Campground markers had a tooltip and fuel markers had none, so
   * half the dots on the map explained themselves and half sat there silent. Worse, a tap
   * on a fuel dot called addStop() outright -- one stray touch on a phone and a fuel stop
   * appeared in the itinerary with no card, no confirmation and no obvious way to see what
   * had just happened.
   */
  /* Everything the map can draw as a place: the baked-in list, plus whatever a live
   * Google search has turned up in either tab.
   *
   * The Google hits used to exist only in the list. A rider who searched for somewhere to
   * eat got a column of names and a completely unchanged map -- and since food comes from
   * Google and nowhere else, the Food row in the map key was describing a pin that could
   * not occur. Deduped against the baked-in list by Google id, because a place that is in
   * both is one place.
   */
  function mapPlaces() {
    const known = new Set((D.places || []).map(c => c.google_id).filter(Boolean));
    const live = new Map();
    ['googleResults', 'browseGoogle'].forEach(key => {
      (state[key] || []).forEach(g => {
        if (!g || g.lat == null || known.has(g.google_id) || live.has(g.google_id)) return;
        live.set(g.google_id, g);
      });
    });
    return [...(D.places || []), ...live.values()];
  }

  function drawMarkers() {
    layers.stops.clearLayers();
    if (layers.spider) layers.spider.clearLayers();
    const pins = [];

    mapPlaces().forEach(c => {
      if (!state.mapShow[placeKind(c)]) return;
      const label = [c.name,
                     c.mp != null ? `MP ${c.mp.toFixed(1)}` : null,
                     c.kind === 'hotel' ? 'hotel or motel'
                       : c.kind === 'food' ? 'somewhere to eat'
                       : c.moto ? 'motorcycle camp' : 'campground',
                     c.off_parkway_mi != null && c.off_parkway_mi >= 0.3
                       ? `${c.off_parkway_mi} mi off the Parkway` : 'on the Parkway']
                    .filter(Boolean).join(' · ');
      pins.push({
        at: [c.lat, c.lon], label,
        icon: () => pinIcon(placeKind(c), placeOpts(c)),
        z: c.tier === 'top' ? 400 : 0,
        open: () => {
          state.previewId = c.id;
          state.tab = 'plan';
          state.addingStop = true;
          render();
          previewOnMap(c);
        }
      });
    });

    if (state.mapShow.fuel) {
      D.fuel.filter(FUEL_ON_MAP).forEach(f => {
        const grade = (f.plan_grade || '').replace(/_/g, ' ');
        const at = f.parkway_lat != null
          ? [f.parkway_lat, f.parkway_lon] : BRP.coordAtMp(f.mp);
        const label = [`FUEL ${f.exit_road}`, `MP ${f.mp}`, f.town, grade,
                       f.detour_plan_mi ? `${f.detour_plan_mi} mi off` : null]
                      .filter(Boolean).join(' · ');
        pins.push({
          at, label,
          icon: () => pinIcon('fuel', fuelOpts(f)),
          z: 200,
          open: () => {
            state.previewId = `fuel-${f.mp}`;
            render();
            previewOnMap(fuelAsPlace(f, at));
          }
        });
      });
    }

    allPins = pins;
    lastPlacement = '';
    placePins();
  }

  /* Everything the map could draw, and what it drew last time, so a pan does not have to
   * rebuild the labels and the icon options from scratch. */
  let allPins = [], lastPlacement = '';

  /* Draw only what is on screen, and only where the glyphs do not overlap.
   *
   * 478 places and 283 fuel exits is 761 markers strung along one 469-mile road. As 9px
   * dots that was merely crowded; as 30px glyphs the default view is a solid smear of
   * overlapping pins from Virginia to North Carolina, which is worse than the problem the
   * glyphs were drawn to fix.
   *
   * Shrinking them is not the way out -- below about 20px the tent and the pump stop being
   * separable, and then the shape channel carries nothing. So pins that would collide are
   * replaced by one neutral disc carrying the count, and tapping it zooms in far enough to
   * break the group apart. The disc is deliberately outside the pin vocabulary: no glyph,
   * no trust fill, so it can never be misread as a place.
   *
   * Off-screen pins are not drawn at all. On a phone that is the difference between a few
   * dozen DOM nodes and seven hundred.
   */
  function placePins() {
    if (!map) return;
    const zoom = map.getZoom();
    const bounds = map.getBounds().pad(0.25);

    // Highest priority first, because the first pin to claim a spot is the one that stays
    // a real pin -- so a top pick keeps its star and its tent, and the anonymous Google
    // hotel next door is the one that disappears into the count.
    const visible = allPins.filter(p => bounds.contains(p.at))
                           .sort((a, b) => b.z - a.z);

    /* Claim-a-spot clustering, in screen pixels.
     *
     * The obvious version buckets pins into a fixed grid, and it is wrong in a way that
     * only shows up on the map: two pins either side of a cell boundary land in different
     * buckets, both draw at their true position, and they overlap exactly as if nothing
     * had been done. Here each pin instead claims a spot, and any later pin closer than
     * MIN_PX joins it rather than drawing its own -- so no two markers can ever be nearer
     * than one marker's width, which is the property actually wanted.
     *
     * The hash is only an index over the claimed spots, so this stays linear rather than
     * comparing all 761 pins with each other.
     */
    const MIN_PX = 36;
    const anchors = [];
    const hash = new Map();
    visible.forEach(p => {
      const pt = map.project(p.at, zoom);
      const cx = Math.floor(pt.x / MIN_PX), cy = Math.floor(pt.y / MIN_PX);
      let host = null;
      for (let dx = -1; dx <= 1 && !host; dx++) {
        for (let dy = -1; dy <= 1 && !host; dy++) {
          (hash.get(`${cx + dx}:${cy + dy}`) || []).some(a => {
            if (pt.distanceTo(a.pt) < MIN_PX) { host = a; return true; }
            return false;
          });
        }
      }
      if (host) { host.group.push(p); return; }
      const anchor = { pt, at: p.at, group: [p] };
      anchors.push(anchor);
      const key = `${cx}:${cy}`;
      const bucket = hash.get(key);
      if (bucket) bucket.push(anchor); else hash.set(key, [anchor]);
    });

    // Redrawing hundreds of markers on every pan is the expensive part, so skip it when
    // the pan did not actually change what gets drawn.
    const stamp = zoom + '|' + anchors.map(a => `${Math.round(a.pt.x)},${Math.round(a.pt.y)},${a.group.length}`).join(';');
    if (stamp === lastPlacement) return;
    lastPlacement = stamp;

    layers.stops.clearLayers();
    anchors.forEach(a => {
      if (a.group.length === 1) {
        const p = a.group[0];
        L.marker(p.at, { icon: p.icon(), zIndexOffset: p.z,
                         keyboard: true, title: p.label, alt: p.label })
          .bindTooltip(p.label, { direction: 'top', sticky: true })
          .on('click', p.open)
          .addTo(layers.stops);
        return;
      }
      const label = `${a.group.length} markers here — tap to spread them out`;
      L.marker(a.at, { icon: clusterIcon(a.group.length), zIndexOffset: 100,
                       keyboard: true, title: label, alt: label })
        .bindTooltip(label, { direction: 'top' })
        .on('click', () => {
          if (separates(a.group)) {
            map.fitBounds(L.latLngBounds(a.group.map(q => q.at)), { padding: [40, 40] });
          } else {
            fanOut(a);
          }
        })
        .addTo(layers.stops);
    });
  }

  /* Would zooming in actually break this group apart?
   *
   * Usually yes, and then the tap should just zoom. But 56 groups on this map never
   * separate at any zoom the tiles go to, and the worst is twenty fuel stations sharing a
   * single Parkway anchor -- every pump the Google sweep found at one exit is recorded
   * against the same point on the road. Zooming into those forever is a dead end, and a
   * dead end over twenty fuel options is the kind that strands somebody. */
  function separates(group) {
    const z = map.getMaxZoom() || 17;
    const pts = group.map(p => map.project(p.at, z));
    return pts.some((a, i) => pts.some((b, j) => j > i && a.distanceTo(b) >= 36));
  }

  /* Fan the group out on a ring around where it sits, with a leader line back to the
   * middle, so co-located markers can still be read and tapped one at a time. Positions
   * are pixel offsets converted back to real coordinates, so panning keeps them honest;
   * a zoom recomputes the whole map anyway, so the ring is dropped then. */
  function fanOut(anchor) {
    layers.spider.clearLayers();
    const zoom = map.getZoom();
    const n = anchor.group.length;
    const r = Math.max(46, Math.round(n * 36 / (2 * Math.PI)));
    const centre = map.project(anchor.at, zoom);
    anchor.group.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      const at = map.unproject(
        L.point(centre.x + r * Math.cos(angle), centre.y + r * Math.sin(angle)), zoom);
      L.polyline([anchor.at, at],
                 { color: '#93a8b4', weight: 1, opacity: .8 }).addTo(layers.spider);
      L.marker(at, { icon: p.icon(), zIndexOffset: 500 + p.z,
                     keyboard: true, title: p.label, alt: p.label })
        .bindTooltip(p.label, { direction: 'top', sticky: true })
        .on('click', p.open)
        .addTo(layers.spider);
    });
    // The ring is drawn at one zoom's pixel offsets, so it stops meaning anything at any
    // other zoom.
    map.once('zoomend', () => layers.spider.clearLayers());
  }

  /* Neutral by design: a count, not a category. Sized by how much it is hiding, capped so
   * a 200-pin group does not become a dinner plate. */
  function clusterIcon(n) {
    const size = n < 10 ? 26 : n < 50 ? 30 : 34;
    return L.divIcon({
      className: 'brp-cluster', iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      html: `<div style="width:${size}px;height:${size}px;line-height:${size - 4}px">`
          + `${n > 999 ? '999+' : n}</div>`
    });
  }

  /* A fuel exit, shaped like a place so it can use the same card. The rider gets the same
   * read-then-decide flow they get for a campground, instead of a tap that silently
   * commits. */
  function fuelAsPlace(f, at) {
    const grade = {
      usable: 'Usable', usable_via_detour: 'Usable, via the signed detour',
      usable_google: 'Listed by Google — nobody has ridden to it',
      unconfirmed: 'Unconfirmed — nobody has checked this one',
      do_not_rely: 'Do not rely on this one',
      unreachable: 'Unreachable in 2026'
    }[f.plan_grade] || f.plan_grade;
    return {
      id: `fuel-${f.mp}`, name: `Fuel — ${f.exit_road}`, kind: 'fuel',
      lat: at[0], lon: at[1], mp: f.mp,
      off_parkway_mi: f.detour_plan_mi != null ? f.detour_plan_mi : null,
      address: f.town, state: f.state,
      showers: null, toilets: null, source: 'curated',
      fuelGrade: grade, fuelConfidence: f.confidence,
      watchout: f.warning || f.closure_note || null,
      stations: f.stations || [], _fuel: f
    };
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
          L.polyline(road.polyline, Object.assign({ opacity: .95 }, LINE.roadLeg))
            .bindTooltip(`${leg.label} — ${road.distance_mi} mi by road`, { sticky: true })
            .addTo(layers.route);
        } else {
          L.polyline([leg.from, leg.to], Object.assign({ opacity: .8 }, LINE.estimate))
            .bindTooltip(`${leg.label} — straight-line estimate, not a road route`,
                         { sticky: true })
            .addTo(layers.route);
        }
      });
      L.marker([state.start.lat, state.start.lon], { icon: dot(C('--fg', '#f2efe6'), 13) })
        .bindTooltip(state.start.label, { direction: 'top' })
        .addTo(layers.route);
    }

    buildDays().forEach(day => {
      (day.routes || []).forEach(r => {
        // One polyline per continuous run. Drawing r.track as a single line is what
        // produced the straight lines across the map: the array contains separate runs.
        const runs = r.trackSegments && r.trackSegments.length ? r.trackSegments
                   : (r.track.length ? [r.track] : []);
        runs.forEach(run => {
          if (run.length > 1) {
            L.polyline(run, Object.assign({ opacity: .95 }, LINE.yourRoute))
              .addTo(layers.route);
          }
        });
        r.rtepts.filter(p => p.type === 'via').forEach(p => {
          L.marker([p.lat, p.lon], { icon: dot(LINE.yourRoute.color, 12) })
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
    } catch (e) {
      // fetchLeg handles its own failures; this is the belt to that braces, so a surprise
      // here degrades to "no road directions" rather than an unhandled rejection.
      state.roadStatus = null;
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
    if (map) { drawMarkers(); drawRoute(); refreshLegend(); }
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
    // The version rides in the header, not just in the Notes tab.
    //
    // It was at the bottom of eight sections of prose, which is the one place a rider will
    // not look when the question is "have I even got the new version?" -- and that question
    // is asked precisely when something is wrong and patience is short. Here it is on every
    // screen, costs one line, and can be read out down a phone.
    $('#asof').textContent = `Closures as of ${D.as_of}`
                           + (window.BRP_VERSION ? ` \u00b7 ${window.BRP_VERSION}` : '');
    initMap();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
