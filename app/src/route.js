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

  /* Shaping points along an off-Parkway leg, from real road geometry.
   *
   * Without this the exported GPX has a via point at the campsite and nothing between, so
   * the device picks its own way off the Parkway -- which is exactly the failure the
   * Parkway shaping points exist to prevent, just on a different stretch of road. With the
   * router's polyline we can pin the intended roads the same way.
   *
   * Spaced by distance along the polyline, not by vertex, because a decoded polyline is
   * dense in corners and sparse on straights. */
  function shapeOffParkway(polyline, spacingMi = 3, maxPoints = 8) {
    if (!polyline || polyline.length < 3) return [];
    const cum = [0];
    for (let i = 1; i < polyline.length; i++) {
      cum.push(cum[i - 1] + BRP.haversine(polyline[i - 1], polyline[i]));
    }
    const total = cum[cum.length - 1];
    if (total <= spacingMi) return [];
    const n = Math.min(Math.floor(total / spacingMi), maxPoints);
    const out = [];
    for (let k = 1; k <= n; k++) {
      const target = total * k / (n + 1);
      let i = 1;
      while (i < cum.length - 1 && cum[i] < target) i++;
      out.push({ lat: polyline[i][0], lon: polyline[i][1], type: 'shaping',
                 reason: 'off-Parkway road', offParkway: true });
    }
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
      // The rider's start point is an origin, not a detour: its distance from the
      // Parkway is the ride in, not something they double back over.
      if (s.kind === 'start' || s.id === 'start') continue;
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
    if (stops.length >= 3) {
      const mid = Math.floor(stops.length / 2);
      return [...splitDay(stops.slice(0, mid + 1), spacingMi),
              ...splitDay(stops.slice(mid), spacingMi)];
    }
    // Two stops and over budget. Splitting by stop is impossible, but refusing to export
    // is worse: a long ride between two points is a perfectly reasonable thing to plan,
    // and SPEC 5.4 asks for more routes rather than thinner shaping. So chunk the points
    // themselves.
    return splitByPoints(day);
  }

  /* Chunk an over-budget day into consecutive routes that each fit.
   *
   * Each chunk repeats the previous chunk's last point as its own first point, so the
   * routes join end to end on the device instead of leaving a gap between files. The
   * track is divided at the same mileposts.
   */
  function splitByPoints(day) {
    const perRoute = Math.max(2, profile.total - 1);   // -1 for the repeated join point
    const chunks = [];
    for (let i = 0; i < day.rtepts.length - 1; i += perRoute - 1) {
      chunks.push(day.rtepts.slice(i, i + perRoute));
    }
    return chunks.map((rtepts, idx) => {
      const first = rtepts[0], last = rtepts[rtepts.length - 1];
      const lo = Math.min(first.mp ?? Infinity, last.mp ?? Infinity);
      const hi = Math.max(first.mp ?? -Infinity, last.mp ?? -Infinity);
      const track = Number.isFinite(lo) && Number.isFinite(hi)
        ? day.track.filter(pt => {
            const near = BRP.nearestVertex(pt[0], pt[1]);
            return near.mp >= lo - 0.5 && near.mp <= hi + 0.5;
          })
        : day.track;
      let maxSpan = 0;
      for (let i = 0; i < rtepts.length - 1; i++) {
        if (rtepts[i].mp != null && rtepts[i + 1].mp != null) {
          maxSpan = Math.max(maxSpan, Math.abs(rtepts[i + 1].mp - rtepts[i].mp));
        }
      }
      return {
        ...day, rtepts, track: thinTrack(track),
        nTotal: rtepts.length,
        nVia: rtepts.filter(p => p.type === 'via').length,
        nJunctionPoints: rtepts.filter(p => p.junction).length,
        maxUnprotectedSpanMi: Math.round(maxSpan * 100) / 100,
        partIndex: idx, partCount: chunks.length,
        warnings: idx === 0 ? day.warnings : []
      };
    });
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
    shapeOffParkway,
    PROFILES, setProfile, DEFAULT_SPACING_MI, MAX_TRKPT,
    get profile() { return profile; },
    get MAX_TOTAL_RTEPT() { return profile.total; },
    get MAX_VIA_RTEPT() { return profile.via; }
  };
})();

/* Getting onto the Parkway, and staying fuelled once you are.
 * Mirrors build/brp/access.py, which carries the tests.
 */
const Access = (() => {
  /* Median published-road / straight-line ratio across the 28 fuel records carrying both
   * numbers. The spread is wide (0.15-3.57), so this is a planning estimate and every
   * figure derived from it is shown with a "~". The device computes the real road route. */
  const ROAD_FACTOR = 1.36;

  const approachMi = (start, point) => BRP.haversine(start, point) * ROAD_FACTOR;

  /* Every place a rider can join the Parkway. A crossing strictly inside a severing
   * closure is not one -- joining there puts you on a stretch you cannot ride out of. */
  function accessPoints() {
    const pts = [];
    for (const j of BRP.data.junctions) {
      const seg = BRP.segmentAtMp(j.mp);
      if (!seg) continue;
      pts.push({ mp: j.mp, name: j.road, lat: j.lat, lon: j.lon,
                 component: seg.component, source: j.source });
    }
    for (const [mp, name] of [[0.0, 'Rockfish Gap (northern terminus)'],
                              [469.1, 'Cherokee US 441 (southern terminus)']]) {
      const seg = BRP.segmentAtMp(mp);
      if (!seg || pts.some(p => Math.abs(p.mp - mp) < 0.2)) continue;
      const [lat, lon] = BRP.coordAtMp(mp);
      pts.push({ mp, name, lat, lon, component: seg.component, source: 'terminus' });
    }
    return pts.sort((a, b) => a.mp - b.mp);
  }

  /* Rank the places a rider could join the Parkway. Two orderings, because they answer
   * different questions and the gap between them is large:
   *
   *   'soonest'  least road miles before you are ON the Parkway. The default: someone
   *              planning a Parkway trip wants to be on it, so the ride in is overhead
   *              and the Parkway miles are the point.
   *   'shortest' least total miles. Right when the campsite is the goal and the Parkway
   *              is incidental.
   *
   * From Charlotte to the Cherokee end, 'shortest' enters at MP 469.1 and rides a tenth
   * of a mile of Parkway -- optimal by distance, useless as a ride. 'soonest' enters
   * near Asheville and rides 80 miles of it. */
  function bestAccessPoints(start, destMp, topN = 3, mode = 'soonest') {
    const destSeg = BRP.segmentAtMp(destMp);
    if (!destSeg) throw new RouteErrorLite(`MP ${destMp} is not on open Parkway in 2026.`);
    return accessPoints()
      .filter(p => p.component === destSeg.component)
      .map(p => {
        const approach = approachMi(start, [p.lat, p.lon]);
        const parkway = Math.abs(destMp - p.mp);
        return { ...p, approachMi: Math.round(approach * 10) / 10,
                 parkwayMi: Math.round(parkway * 10) / 10,
                 totalMi: Math.round((approach + parkway) * 10) / 10 };
      })
      .sort((a, b) => mode === 'soonest'
        ? (a.approachMi - b.approachMi) || (a.totalMi - b.totalMi)
        : a.totalMi - b.totalMi)
      .slice(0, topN);
  }

  class RouteErrorLite extends Error {}

  /* Where to come off the Parkway when heading for a final destination. Mirror image of
   * the entry problem, and it wants the same answer for the same reason: the nearest exit
   * to where you are finishing, so the ride off is short and the Parkway runs long. */
  function bestExitPoints(endPoint, fromMp, topN = 3) {
    const seg = BRP.segmentAtMp(fromMp);
    if (!seg) throw new RouteErrorLite(`MP ${fromMp} is not on open Parkway in 2026.`);
    return accessPoints()
      .filter(p => p.component === seg.component)
      .map(p => ({ ...p,
        rideOutMi: Math.round(approachMi(endPoint, [p.lat, p.lon]) * 10) / 10,
        parkwayMi: Math.round(Math.abs(p.mp - fromMp) * 10) / 10 }))
      .sort((a, b) => (a.rideOutMi - b.rideOutMi) || (b.parkwayMi - a.parkwayMi))
      .slice(0, topN);
  }

  const usable = (f, maxDetourMi) => {
    if (!['usable', 'usable_via_detour', 'unconfirmed'].includes(f.plan_grade)) return false;
    if (maxDetourMi != null && f.detour_plan_mi != null) return f.detour_plan_mi <= maxDetourMi;
    return true;
  };

  /* Where this rider must stop for fuel, given the range of their bike.
   *
   * Greedy furthest-reachable, which is optimal for refuelling to full along a line.
   *
   * Reaching a pump costs the detour off the Parkway and back, and both halves burn fuel:
   * you arrive having spent the ride out, and leave with a full tank minus the ride back.
   * A 15-mile detour therefore costs 30 miles of range. That asymmetry is what makes
   * MP 411.8 Wagon Road Gap a trap rather than a convenience. */
  /* Miles needed to get from the destination back to fuel. A campsite on the Parkway
   * sells none, and neither does the Parkway: arriving on fumes is a plan that works
   * right up until the morning. */
  function exitReserve(destMp, component, maxDetourMi) {
    let best = null;
    for (const f of BRP.data.fuel) {
      if (!usable(f, maxDetourMi)) continue;
      if (component != null && f.component !== component) continue;
      const cost = Math.abs(f.mp - destMp) + (f.detour_plan_mi || 0);
      if (!best || cost < best.cost) best = { cost, f };
    }
    return best ? { mi: Math.round(best.cost * 10) / 10, stop: best.f } : { mi: null, stop: null };
  }

  /* Fuel for a whole journey, not a single leg.
   *
   * waypoints is the ordered list of mileposts the rider passes through: where they join
   * the Parkway, each overnight, and where they leave it. Direction may reverse between
   * them, which is exactly what a round trip does.
   *
   * This cannot be done a leg at a time. A campsite sells no fuel and neither does the
   * Parkway, so the rider leaves camp with exactly what they arrived on. Planning each leg
   * from a full tank quietly refuels the bike overnight and produces a plan that fails on
   * the way home. */
  function planJourney(opts) {
    const { waypoints, tankMi, approachLegMi = 0, reserveFrac = 0, maxDetourMi = null,
            component = null, requireExitFuel = true } = opts;
    if (!(tankMi > 0)) return { ok: false, stops: [], notes: [], error: 'Set your tank range first.' };
    if (!waypoints || waypoints.length < 2) {
      return { ok: false, stops: [], notes: [],
               error: 'A journey needs somewhere to start and somewhere to end.' };
    }
    const planningRange = tankMi * (1 - reserveFrac);

    const marks = [];
    let pos = 0;
    const waypointPos = [0];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i], b = waypoints[i + 1];
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (const f of BRP.data.fuel) {
        if (!usable(f, maxDetourMi)) continue;
        if (component != null && f.component !== component) continue;
        if (f.mp < lo || f.mp > hi) continue;
        marks.push({ mp: f.mp, town: f.town, road: f.exit_road,
                     detourMi: f.detour_plan_mi || 0, grade: f.plan_grade,
                     confidence: f.confidence, warning: f.warning || f.closure_note || '',
                     pos: pos + Math.abs(f.mp - a) });
      }
      pos += Math.abs(b - a);
      waypointPos.push(pos);
    }
    marks.sort((x, y) => x.pos - y.pos);
    const journeyMi = pos;

    const exit = requireExitFuel
      ? exitReserve(waypoints[waypoints.length - 1], component, maxDetourMi)
      : { mi: null, stop: null };
    const targetPos = journeyMi + (exit.mi || 0);

    let at = 0, remaining = planningRange;
    const stops = [], notes = [];
    let guard = 0;
    while (targetPos - at > remaining) {
      if (++guard > 200) {
        return { ok: false, stops, notes, error: 'Could not converge on a fuel plan.' };
      }
      const reachable = marks.filter(m => m.pos > at + 1e-9
                                       && (m.pos - at) + m.detourMi <= remaining);
      if (!reachable.length) {
        const ahead = marks.filter(m => m.pos > at + 1e-9);
        const nxt = ahead[0];
        const need = nxt ? (nxt.pos - at) + nxt.detourMi : targetPos - at;
        const where = nxt ? `MP ${nxt.mp} (${nxt.town})` : 'the end of the ride';
        return { ok: false, stops, notes,
                 error: `Out of range. You need about ${need.toFixed(0)} mi to reach ${where}, `
                      + `but you have about ${remaining.toFixed(0)} mi. Raise your tank range, `
                      + `allow a longer fuel detour, or shorten the ride.`,
                 shortfallMi: Math.round((need - remaining) * 10) / 10 };
      }
      const stop = reachable.reduce((m, e) => (e.pos > m.pos ? e : m));
      stops.push({ ...stop,
                   arriveWithMi: Math.round((remaining - (stop.pos - at) - stop.detourMi) * 10) / 10 });
      at = stop.pos;
      remaining = planningRange - stop.detourMi;
    }

    // Tank state at every waypoint -- the number that decides whether a rider can leave
    // camp in the morning at all.
    const tankAt = [];
    let cur = planningRange, cursor = 0;
    const queue = [...stops];
    waypoints.forEach((wp, i) => {
      const wpos = waypointPos[i];
      while (queue.length && queue[0].pos <= wpos + 1e-9) {
        const st = queue.shift();
        cur = planningRange - st.detourMi;
        cursor = st.pos;
      }
      tankAt.push({ mp: wp, tankMi: Math.round((cur - (wpos - cursor)) * 10) / 10 });
    });

    if (exit.mi != null && exit.stop) {
      notes.push(`Nearest fuel to where you leave the Parkway is `
               + `${exit.stop.town || 'the closest pump'} (MP ${exit.stop.mp}), about `
               + `${exit.mi.toFixed(0)} mi away. The plan keeps that much in the tank.`);
    }

    return { ok: true, stops, notes, tankAt,
             exitReserveMi: exit.mi,
             exitReserveStop: exit.stop ? { mp: exit.stop.mp, town: exit.stop.town } : null,
             arriveWithMi: Math.round((remaining - (journeyMi - at)) * 10) / 10,
             planningRangeMi: Math.round(planningRange * 10) / 10,
             parkwayMi: Math.round(journeyMi * 10) / 10,
             approachMi: Math.round(approachLegMi * 10) / 10,
             totalMi: Math.round((journeyMi + approachLegMi) * 10) / 10 };
  }

  function planFuel(opts) {
    const { accessMp, destMp, tankMi, approachLegMi = 0, reserveFrac = 0,
            maxDetourMi = null, component = null, requireExitFuel = true } = opts;
    // The approach does NOT consume range. This dataset maps fuel at Parkway exits and
    // nothing else, so it knows nothing about the gas stations between a rider's house
    // and the Parkway -- and there are plenty. Charging a 136-mile approach against the
    // tank reported "you cannot make it" for trips any rider completes by filling up on
    // the way in. The approach produces advice; the Parkway calculation starts full.
    if (!(tankMi > 0)) return { ok: false, stops: [], error: 'Set your tank range first.' };

    const planningRange = tankMi * (1 - reserveFrac);
    const forward = destMp >= accessMp;
    const dir = forward ? 1 : -1;

    const exits = BRP.data.fuel
      .filter(f => usable(f, maxDetourMi))
      .filter(f => component == null || f.component === component)
      .filter(f => forward ? (f.mp >= accessMp && f.mp <= destMp)
                           : (f.mp >= destMp && f.mp <= accessMp))
      .map(f => ({ mp: f.mp, town: f.town, road: f.exit_road,
                   detourMi: f.detour_plan_mi || 0, grade: f.plan_grade,
                   confidence: f.confidence, warning: f.warning || f.closure_note || '',
                   pos: dir * (f.mp - accessMp) }))
      .sort((a, b) => a.pos - b.pos);

    const destPos = Math.abs(destMp - accessMp);
    // Plan as though the ride continues past camp to the nearest pump. Requiring that
    // margin up front is what stops the planner delivering a rider to a campsite with an
    // empty tank and no fuel for 18 miles in any direction.
    const exit = requireExitFuel ? exitReserve(destMp, component, maxDetourMi)
                                 : { mi: null, stop: null };
    const targetPos = destPos + (exit.mi || 0);
    let pos = 0, remaining = planningRange;
    const stops = [], notes = [];

    if (approachLegMi > planningRange) {
      notes.push(`Your ride in is about ${approachLegMi.toFixed(0)} mi, longer than your `
               + `${planningRange.toFixed(0)} mi range, so you will need fuel on the way. This `
               + `planner only maps fuel at Parkway exits, so top up before you reach MP ${accessMp}.`);
    } else if (approachLegMi > planningRange * 0.6) {
      notes.push(`Your ride in is about ${approachLegMi.toFixed(0)} mi. Start the Parkway with a `
               + `full tank — there is no fuel on it anywhere.`);
    }

    let guard = 0;
    while (targetPos - pos > remaining) {
      if (++guard > 100) return { ok: false, stops, error: 'Could not converge on a fuel plan.' };
      const reachable = exits.filter(e => e.pos > pos + 1e-9
                                       && (e.pos - pos) + e.detourMi <= remaining);
      if (!reachable.length) {
        const ahead = exits.filter(e => e.pos > pos + 1e-9);
        const nxt = ahead[0];
        const need = nxt ? (nxt.pos - pos) + nxt.detourMi : targetPos - pos;
        const where = nxt ? `MP ${nxt.mp} (${nxt.town})` : 'your destination';
        return {
          ok: false, stops,
          error: `Out of range. You need about ${need.toFixed(0)} mi to reach ${where}, but `
               + `you only have ${remaining.toFixed(0)} mi of planning range. Raise your tank `
               + `range, accept a longer fuel detour, or carry fuel.`,
          shortfallMi: Math.round((need - remaining) * 10) / 10
        };
      }
      const stop = reachable.reduce((m, e) => (e.pos > m.pos ? e : m));
      stops.push({ ...stop,
                   arriveWithMi: Math.round((remaining - (stop.pos - pos) - stop.detourMi) * 10) / 10 });
      pos = stop.pos;
      remaining = planningRange - stop.detourMi;   // full tank, minus the ride back out
    }

    if (exit.mi != null) {
      notes.push(`Nearest fuel to camp is ${exit.stop.town || 'the closest pump'} `
               + `(MP ${exit.stop.mp}), about ${exit.mi.toFixed(0)} mi away. The plan keeps that `
               + `much in the tank so you can get back out.`);
    }
    return { ok: true, stops, notes, exitReserveMi: exit.mi,
             exitReserveStop: exit.stop ? { mp: exit.stop.mp, town: exit.stop.town } : null,
             arriveWithMi: Math.round((remaining - (destPos - pos)) * 10) / 10,
             planningRangeMi: Math.round(planningRange * 10) / 10,
             parkwayMi: Math.round(destPos * 10) / 10,
             approachMi: Math.round(approachLegMi * 10) / 10,
             totalMi: Math.round((destPos + approachLegMi) * 10) / 10 };
  }

  return { ROAD_FACTOR, approachMi, accessPoints, bestAccessPoints, bestExitPoints,
           planFuel, planJourney, exitReserve };
})();

/* Address lookup. The only part of this app that needs the network.
 *
 * Everything else -- the Parkway, closures, campgrounds, fuel, routing, GPX export --
 * is baked into this file and works with no signal. Geocoding cannot be, so it degrades
 * rather than breaks: if the lookup fails, the rider taps the map or types coordinates
 * and loses nothing but the convenience.
 */
const Geocode = (() => {
  const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
  // Bias results to the region the Parkway actually runs through, so "Franklin" finds
  // the one in NC rather than the one in Tennessee or Massachusetts.
  const VIEWBOX = '-84.5,34.5,-77.5,39.5';

  function parseLatLon(text) {
    const m = String(text).trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, source: 'coordinates' };
  }

  async function search(query, { signal } = {}) {
    const direct = parseLatLon(query);
    if (direct) return [direct];
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&format=jsonv2&limit=5`
              + `&countrycodes=us&viewbox=${VIEWBOX}&bounded=0`;
    const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Address lookup failed (${res.status}).`);
    const rows = await res.json();
    return rows.map(r => ({
      lat: parseFloat(r.lat), lon: parseFloat(r.lon),
      label: r.display_name, source: 'nominatim'
    }));
  }

  return { search, parseLatLon };
})();

/* Road routing for the legs that are not on the Parkway.
 *
 * The Parkway needs no router -- between junctions it has no alternatives. Everything else
 * does: the ride in from the rider's house, the ride out to wherever they finish, and the
 * hop off the Parkway to a campsite or hotel that is not on it. Those legs were previously
 * a straight dashed line on the map and nothing at all in the exported GPX, which left the
 * Garmin free to invent its own way there.
 *
 * Results are CACHED in the trip, deliberately. Routing needs signal and riding does not,
 * so a trip planned at home keeps its real geometry and turn list in a gap. That is also
 * why the cache is keyed on rounded coordinates: a jiggle of a few metres should reuse the
 * answer rather than spend another billable request.
 */
const Directions = (() => {
  const cache = new Map();
  const key = (a, b) => `${a[0].toFixed(4)},${a[1].toFixed(4)}->${b[0].toFixed(4)},${b[1].toFixed(4)}`;

  function seed(entries) {
    for (const [k, v] of Object.entries(entries || {})) cache.set(k, v);
  }
  const dump = () => Object.fromEntries(cache);
  const peek = (a, b) => cache.get(key(a, b)) || null;

  async function fetchLeg(a, b) {
    const k = key(a, b);
    if (cache.has(k)) return cache.get(k);
    const url = `/api/route?olat=${a[0]}&olon=${a[1]}&dlat=${b[0]}&dlon=${b[1]}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) {
      const err = { ok: false, error: data.error || 'Routing failed.', hint: data.hint };
      cache.set(k, err);
      return err;
    }
    const val = { ok: true, ...data };
    cache.set(k, val);
    return val;
  }

  // A failure is cached so a dead endpoint is not hammered on every render. Retrying
  // therefore has to clear it first.
  const forget = (a, b) => cache.delete(key(a, b));

  return { fetchLeg, seed, dump, peek, key, forget };
})();
