/* Route slicing and route-point placement. Mirrors build/brp/route.py, which is the
 * reference implementation and carries the test suite.
 *
 * The governing idea: Garmin guarantees the route passes through every shaping and via
 * point, so the device cannot drift. It can only cut a corner by leaving the Parkway and
 * rejoining BETWEEN two consecutive route points, which takes two junctions inside the
 * same interval. So the budget goes to known junctions first -- a point 0.25 mi past a
 * junction makes that exit geometrically impossible -- then fills to spacing, which
 * bounds (not prevents) a bypass where junction data is missing.
 */
const Router = (() => {
  const JUNCTION_OFFSET_MI = 0.25;
  const MIN_POINT_SPACING_MI = 0.5;
  const CLOSURE_CLEARANCE_MI = 0.5;
  const ZERO_LEG_MI = 0.02;
  /* SPEC 5.4 designs to the intersection of four devices because the device was
   * unknown. It is known now (zumo XT2), so the budget can follow the actual hardware
   * — but only deliberately, and the universal profile stays one click away because
   * GPX gets shared with a group riding other devices.
   *
   * XT2 direct-to-GPX-folder transfer is bound by the via-point cap (~29-30) and the
   * shaping cap (125). The 62 total here is the Tread app's silent route-to-track
   * conversion threshold: we tell the rider not to use Tread, but staying under it
   * costs almost nothing and means a synced route does not quietly become a track. */
  const PROFILES = {
    xt2: { label: 'Garmin zumo XT2', total: 62, via: 25,
           note: 'Transfer to the GPX folder over USB. Do not use the Tread app — its '
               + 'cloud sync discards shaping points and silently converts routes over '
               + '62 points into tracks.' },
    universal: { label: 'Universal — all four candidate devices', total: 50, via: 25,
                 note: 'The intersection of zumo XT/XT2, Navigator VI and BMW '
                     + 'ConnectedRide Navigator. Use this if you are sharing files with '
                     + 'riders on other devices.' }
  };
  let profile = PROFILES.xt2;
  const setProfile = key => { profile = PROFILES[key] || PROFILES.universal; };

  const MAX_TRKPT = 10000;
  const DEFAULT_SPACING_MI = 5;

  class RouteError extends Error {}

  function placeable(mp, clearance = CLOSURE_CLEARANCE_MI) {
    const seg = BRP.segmentAtMp(mp);
    if (!seg) return false;
    return (mp - seg.from_mp) >= clearance && (seg.to_mp - mp) >= clearance;
  }

  function sliceParkway(mpA, mpB) {
    if (!BRP.connected(mpA, mpB)) {
      const blocking = BRP.blockingClosures(mpA, mpB);
      throw new RouteError(
        `MP ${mpA.toFixed(1)} and MP ${mpB.toFixed(1)} are not connected on the 2026 ` +
        `Parkway: ` + blocking.map(c => `MP ${c.from_mp}-${c.to_mp} (${c.reason})`).join('; '));
    }
    const lo = Math.min(mpA, mpB), hi = Math.max(mpA, mpB);
    const i0 = BRP.indexAtMp(lo), i1 = BRP.indexAtMp(hi);
    const pts = [BRP.coordAtMp(lo)];
    for (let i = i0; i <= i1; i++) {
      if (BRP.isOpen(BRP.data.parkway_mp[i])) pts.push(BRP.data.parkway[i]);
    }
    pts.push(BRP.coordAtMp(hi));
    return dedupeCoords(mpB < mpA ? pts.reverse() : pts);
  }

  /* Drop consecutive duplicate coordinates. A zero-length leg -- two stops sharing an
   * access milepost, which is exactly the campground-off-a-fuel-exit case -- otherwise
   * emits the same coordinate two or three times, and those duplicates land in the
   * track. */
  function dedupeCoords(points, tol = 1e-7) {
    const out = [];
    for (const p of points) {
      const last = out[out.length - 1];
      if (last && Math.abs(p[0] - last[0]) < tol && Math.abs(p[1] - last[1]) < tol) continue;
      out.push(p);
    }
    return out;
  }

  function placeLegPoints(mpA, mpB, spacingMi = DEFAULT_SPACING_MI) {
    const forward = mpB >= mpA;
    const lo = Math.min(mpA, mpB), hi = Math.max(mpA, mpB);
    const dir = forward ? 1 : -1;
    const pts = [];

    for (const j of BRP.data.junctions) {
      if (!(j.mp > lo && j.mp < hi)) continue;
      let at = j.mp + dir * JUNCTION_OFFSET_MI;
      if (!(at > lo && at < hi) || !placeable(at)) {
        // The junction may sit inside a closure, or so near a gate that the point past
        // it lands on the barricade. Push further into open road, or give up.
        let moved = false;
        for (const extra of [0.5, 1.0, 1.5]) {
          const cand = j.mp + dir * (JUNCTION_OFFSET_MI + extra);
          if (cand > lo && cand < hi && placeable(cand)) { at = cand; moved = true; break; }
        }
        if (!moved) continue;
      }
      const [lat, lon] = BRP.coordAtMp(at);
      pts.push({ mp: at, lat, lon, type: 'shaping', reason: `past ${j.road}`, junction: true });
    }

    const anchors = [lo, hi, ...pts.map(p => p.mp)].sort((a, b) => a - b);
    for (let k = 0; k < anchors.length - 1; k++) {
      const a = anchors[k], b = anchors[k + 1], span = b - a;
      if (span <= spacingMi) continue;
      const n = Math.floor(span / spacingMi);
      for (let m = 1; m <= n; m++) {
        const at = a + span * m / (n + 1);
        if (!placeable(at)) continue;
        const [lat, lon] = BRP.coordAtMp(at);
        pts.push({ mp: at, lat, lon, type: 'shaping', reason: 'spacing', junction: false });
      }
    }
    pts.sort((x, y) => forward ? x.mp - y.mp : y.mp - x.mp);
    return pts;
  }

  /* Thin shaping points that crowd, never via points. Two via points can share an access
   * milepost while sitting miles apart -- a fuel exit and a campground off the same
   * junction -- so deduping by milepost would delete a real destination. */
  function dedupe(points) {
    const out = [];
    for (const p of points) {
      if (p.type === 'via') {
        while (out.length && out[out.length - 1].type === 'shaping'
               && Math.abs(p.mp - out[out.length - 1].mp) < MIN_POINT_SPACING_MI) out.pop();
        out.push(p);
        continue;
      }
      if (out.length && Math.abs(p.mp - out[out.length - 1].mp) < MIN_POINT_SPACING_MI) continue;
      out.push(p);
    }
    return out;
  }

  function thinTrack(track, limit = MAX_TRKPT) {
    if (track.length <= limit) return track;
    const step = track.length / limit, out = [];
    for (let i = 0; i < limit - 1; i++) out.push(track[Math.floor(i * step)]);
    out.push(track[track.length - 1]);
    return out;
  }

  function buildDay(stops, spacingMi = DEFAULT_SPACING_MI) {
    if (stops.length < 2) throw new RouteError('A day needs at least a start and an end.');
    let rtepts = [{ ...stops[0], type: 'via', reason: 'day start' }];
    let track = [], parkwayMi = 0, detourMi = 0;

    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      rtepts.push(...placeLegPoints(a.mp, b.mp, spacingMi));
      rtepts.push({ ...b, type: 'via', reason: 'stop' });
      // A zero-length leg contributes no Parkway geometry. It happens whenever two stops
      // share an access milepost -- a campground reached from a fuel exit -- and slicing
      // it emits the same coordinates again, which lands in the track as a stutter.
      if (Math.abs(b.mp - a.mp) >= ZERO_LEG_MI) track.push(...sliceParkway(a.mp, b.mp));
      parkwayMi += Math.abs(b.mp - a.mp);
      detourMi += (a.offParkwayMi || 0) + (b.offParkwayMi || 0);
    }

    rtepts = dedupe(rtepts);
    track = thinTrack(dedupeCoords(track));

    const warnings = [];
    const signs = new Set();
    for (let i = 0; i < stops.length - 1; i++) {
      if (stops[i].mp !== stops[i + 1].mp) signs.add(stops[i + 1].mp > stops[i].mp ? 1 : -1);
    }
    if (signs.size > 1) {
      warnings.push({
        level: 'info',
        text: 'Stops are not in milepost order — this day backtracks. Legal (the Mt Mitchell '
            + 'spur is an out-and-back by definition) but easy to create by accident.'
      });
    }
    for (const s of stops) {
      if ((s.offParkwayMi || 0) >= 10) {
        warnings.push({
          level: 'warn',
          text: `${s.name} is ${s.offParkwayMi.toFixed(0)} mi off the Parkway — roughly `
              + `${(s.offParkwayMi * 2).toFixed(0)} mi round trip.`
        });
      }
    }
    for (const s of stops) {
      if (s.planGrade === 'do_not_rely') {
        warnings.push({ level: 'error', text: `${s.name}: ${s.note || 'no verifiable station here.'}` });
      }
    }

    const nVia = rtepts.filter(p => p.type === 'via').length;
    let maxSpan = 0;
    for (let i = 0; i < rtepts.length - 1; i++) {
      maxSpan = Math.max(maxSpan, Math.abs(rtepts[i + 1].mp - rtepts[i].mp));
    }

    return {
      rtepts, track, stops,
      parkwayMi: Math.round(parkwayMi * 10) / 10,
      detourMi: Math.round(detourMi * 10) / 10,
      totalMi: Math.round((parkwayMi + detourMi) * 10) / 10,
      nTotal: rtepts.length, nVia,
      nJunctionPoints: rtepts.filter(p => p.junction).length,
      maxUnprotectedSpanMi: Math.round(maxSpan * 100) / 100,
      warnings
    };
  }

  const fitsBudget = day => day.nTotal <= profile.total && day.nVia <= profile.via;

  /* SPEC 5.4: split the day, never thin the shaping points. Thinning trades a hard cap
   * for a silent increase in bypass risk, which is the failure the exporter exists to
   * prevent. */
  function splitDay(stops, spacingMi = DEFAULT_SPACING_MI) {
    const day = buildDay(stops, spacingMi);
    if (fitsBudget(day)) return [day];
    if (stops.length < 3) {
      throw new RouteError(
        `Cannot split: ${day.nTotal} points between two stops. Add an intermediate stop ` +
        `or shorten the day.`);
    }
    const mid = Math.floor(stops.length / 2);
    return [...splitDay(stops.slice(0, mid + 1), spacingMi),
            ...splitDay(stops.slice(mid), spacingMi)];
  }

  /* Fuel gaps across the WHOLE trip, not per day.
   *
   * SPEC 2.4 asks to flag the day where the plan puts too many miles between fuel exits,
   * but the arithmetic cannot be done a day at a time: a tank carries across an
   * overnight, so treating each day's first and last stop as though they were fuel
   * conjures refuelling points that do not exist and understates the real gap. Here the
   * marks are only genuine fuel exits; the caller attributes each gap to the day its
   * run begins in.
   *
   * The exits considered are those a rider could USE — reachable, and within the detour
   * he is willing to ride. Raising that threshold past MP 411.8's 18 mi detour is what
   * closes the 49.5 mi Asheville-to-Balsam gap, and it should be his decision, not a
   * default that hides it. */
  function tripFuelGaps(stops, maxDetourMi) {
    if (!stops.length) return [];
    const usable = BRP.data.fuel.filter(f => {
      if (!['usable', 'usable_via_detour', 'unconfirmed'].includes(f.plan_grade)) return false;
      if (maxDetourMi != null && f.detour_plan_mi != null && f.detour_plan_mi > maxDetourMi) return false;
      return true;
    });
    const lo = Math.min(...stops.map(s => s.mp)), hi = Math.max(...stops.map(s => s.mp));
    const comp = BRP.componentForStop(stops[0]);
    const marks = usable
      .filter(f => f.mp >= lo && f.mp <= hi && f.component === comp)
      .map(f => ({ mp: f.mp, name: f.town, fuel: true }))
      .sort((a, b) => a.mp - b.mp);

    const seq = [];
    // The run from the trip's start to the first usable exit counts: he begins on
    // whatever is in the tank, and the planner should not assume it is full.
    if (!marks.length || marks[0].mp - lo > 0.05) {
      seq.push({ mp: lo, name: 'trip start', edge: true });
    }
    seq.push(...marks);
    if (!marks.length || hi - marks[marks.length - 1].mp > 0.05) {
      seq.push({ mp: hi, name: 'trip end', edge: true });
    }

    const gaps = [];
    for (let i = 0; i < seq.length - 1; i++) {
      gaps.push({
        from: seq[i], to: seq[i + 1],
        gapMi: Math.round((seq[i + 1].mp - seq[i].mp) * 10) / 10
      });
    }
    return gaps.sort((a, b) => b.gapMi - a.gapMi);
  }

  return {
    RouteError, sliceParkway, buildDay, splitDay, fitsBudget, tripFuelGaps, placeable,
    PROFILES, setProfile, DEFAULT_SPACING_MI, MAX_TRKPT,
    get profile() { return profile; },
    get MAX_TOTAL_RTEPT() { return profile.total; },
    get MAX_VIA_RTEPT() { return profile.via; }
  };
})();
