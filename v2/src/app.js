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
        start: state.start, accessMp: state.accessMp
      }));
    } catch (e) { /* private mode: the trip still works, it just will not persist */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) Object.assign(state, JSON.parse(raw));
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
        const routes = Router.splitDay(stops);
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
    const dest = state.stops[state.stops.length - 1];
    const startLL = [state.start.lat, state.start.lon];

    let options = [];
    try {
      // Always "soonest": the point of the trip is to be ON the Parkway, so the ride in
      // is overhead to minimise. Ranking by total distance instead can enter a hundred
      // yards from the campsite and ride no Parkway at all.
      options = Access.bestAccessPoints(startLL, state.stops[0].mp, 4, 'soonest');
    } catch (e) {
      return { error: e.message };
    }
    if (!options.length) {
      return { error: 'No Parkway access point can reach that destination in 2026 — the '
                    + 'Helene closures have the Parkway in three disconnected pieces.' };
    }
    const chosen = (state.accessMp != null
      && options.find(o => Math.abs(o.mp - state.accessMp) < 0.05)) || options[0];

    const component = BRP.componentForStop(state.stops[0]);
    const fuel = Access.planFuel({
      accessMp: chosen.mp, destMp: dest.mp, tankMi: state.tankMi,
      approachLegMi: chosen.approachMi, maxDetourMi: state.maxFuelDetourMi, component
    });

    // Is the rider closer to a stretch of Parkway that cannot reach their destination?
    // Worth saying out loud rather than silently routing them 300 miles around.
    const allNearest = Access.accessPoints()
      .map(p => ({ ...p, d: Access.approachMi(startLL, [p.lat, p.lon]) }))
      .sort((a, b) => a.d - b.d)[0];
    const severedNote = allNearest && allNearest.component !== chosen.component
      ? `Closer Parkway access exists at MP ${allNearest.mp}, but Hurricane Helene closures `
      + `mean that stretch cannot reach your campsite. This entry is the nearest one that `
      + `connects.`
      : null;

    return { chosen, options, fuel, dest, severedNote,
             approachMi: chosen.approachMi,
             parkwayMi: Math.abs(dest.mp - chosen.mp) };
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
    pane.append(fieldStart(), fieldDestination(), fieldLimits());
    pane.append(sectionItinerary());
  }

  /* ---- input 1: where you start ------------------------------------------------- */
  function fieldStart() {
    const sec = el('div', 'section');
    sec.append(el('h2', null, '1 · Starting from'));

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

  /* ---- input 2: where you are going -------------------------------------------- */
  function fieldDestination() {
    const sec = el('div', 'section');
    sec.append(el('h2', null, '2 · Camping at'));

    if (state.stops.length) {
      state.stops.forEach((st, i) => {
        const row = el('div', 'picked');
        const body = el('div', 's-body');
        body.append(el('div', 's-name', st.name));
        body.append(el('div', 's-meta',
          `MP ${st.mp.toFixed(1)}${st.label ? ' \u00b7 ' + st.label : ''}`));
        row.append(body);
        const del = el('button', 'icon-btn danger', '\u2715');
        del.title = 'Remove';
        del.onclick = () => removeStop(i);
        row.append(del);
        sec.append(row);
      });
      const more = el('button', 'btn sm ghost', '+ Add another night');
      more.style.marginTop = '8px';
      more.onclick = () => { state.addingStop = true; render(); };
      if (!state.addingStop) { sec.append(more); return sec; }
    }

    const input = el('input');
    input.type = 'text';
    input.placeholder = 'Search campgrounds\u2026';
    input.setAttribute('aria-label', 'Destination campground');
    input.value = state.destQuery || '';
    sec.append(input);

    const list = el('div');
    list.style.marginTop = '6px';
    sec.append(list);

    const draw = () => {
      list.textContent = '';
      const q = (state.destQuery || '').trim().toLowerCase();
      const matches = D.campgrounds
        .filter(c => !state.stops.some(s => s.id === `camp-${c.id}`))
        .filter(c => !q || c.name.toLowerCase().includes(q)
                        || String(c.mp).includes(q) || (c.state || '').toLowerCase() === q)
        .slice(0, q ? 8 : 6);
      if (!matches.length) {
        list.append(el('div', 'tiny', 'No campground matches that.'));
        return;
      }
      matches.forEach(c => {
        const b = el('button', 'row');
        b.append(el('div', 'mp', `MP ${c.mp}`));
        const body = el('div', 'body');
        body.append(el('div', 'name', c.name));
        const bits = [c.price, c.moto ? 'Moto camp' : null,
                      c.tier === 'top' ? 'Top pick' : null].filter(Boolean);
        body.append(el('div', 'meta', bits.join(' \u00b7 ')));
        if (!c.reachable_from_parkway) {
          const badges = el('div', 'badges');
          const bd = el('span', 'badge info', 'Off-Parkway access');
          bd.title = c.blocking_closure ? c.blocking_closure.reason : '';
          badges.append(bd);
          body.append(badges);
        }
        b.append(body);
        b.onclick = () => {
          addStop(BRP.asStop(c));
          state.destQuery = '';
          state.addingStop = false;
          render();
        };
        list.append(b);
      });
    };
    input.oninput = e => { state.destQuery = e.target.value; draw(); };
    draw();
    return sec;
  }

  /* ---- input 3: how you ride ---------------------------------------------------- */
  function fieldLimits() {
    const sec = el('div', 'section');
    sec.append(el('h2', null, '3 · How you ride'));

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
    summary.textContent = `~${c.approachMi} mi to reach the Parkway, then ${c.parkwayMi} mi `
                        + `on it. ${fuelLine}`;
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
    state.stops.forEach((st, i) => {
      const last = i === state.stops.length - 1;
      steps.append(stepRow(`MP ${st.mp.toFixed(1)}`, st.name,
        last ? `Arrive${f.ok ? ` with ~${f.arriveWithMi} mi in the tank` : ''}` : 'Overnight',
        last ? 'ok' : null));
    });
    wrap.append(steps);

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
    const COL = { top: '#e0a33e', solid: '#7fa35c', backup: '#8d9683', moto: '#c8552f' };
    if (state.filters.campground) {
      D.campgrounds.forEach(c => {
        const col = c.moto ? COL.moto : (COL[c.tier] || COL.solid);
        L.marker([c.lat, c.lon], { icon: dot(col, 12) })
          .bindPopup(`<h3>${c.name}</h3>MP ${c.mp} · ${c.price || ''}<br>${c.access || ''}`)
          .on('click', () => addStop(BRP.asStop(c)))
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

    // The ride in, as a dashed straight line. There is no routing engine here, so this
    // is a hint about direction and rough distance, not a road route -- drawn dashed and
    // labelled so it never reads as turn-by-turn. The device works out the real roads.
    const trip = itinerary();
    if (trip && !trip.error && state.start) {
      const c = trip.chosen;
      L.polyline([[state.start.lat, state.start.lon], [c.lat, c.lon]],
                 { color: '#a9b39c', weight: 2, opacity: .75, dashArray: '4 7' })
        .bindTooltip(`Ride in ~${c.approachMi} mi to MP ${c.mp} (straight-line estimate)`,
                     { sticky: true })
        .addTo(layers.route);
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

  function render() {
    save();
    Router.setProfile(state.device === 'xt2' ? 'xt2' : 'universal');
    $('#pane-plan').hidden = state.tab !== 'plan';
    $('#pane-browse').hidden = state.tab !== 'browse';
    $('#pane-export').hidden = state.tab !== 'export';
    $('#pane-notes').hidden = state.tab !== 'notes';
    document.querySelectorAll('.tabs button').forEach(b =>
      b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
    if (state.tab === 'plan') renderPlan();
    if (state.tab === 'browse') renderBrowse();
    if (state.tab === 'export') renderExport();
    if (state.tab === 'notes') renderNotes();
    if (map) { drawMarkers(); drawRoute(); }
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
