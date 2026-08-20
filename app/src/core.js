/* Parkway geometry, network reachability, and stop helpers.
 *
 * The milepost model is NOT recomputed here. build/brp/mp.py decides it once, offline,
 * calibrating the centerline against control points, and ships the per-vertex result in
 * DATA.parkway_mp. Recomputing it in the browser would be a second implementation of a
 * subtle thing, free to drift from the one the tests cover.
 */
const BRP = (() => {
  const D = window.BRP_DATA;
  const MI_PER_RAD = 3958.7614;

  function haversine(a, b) {
    const [la1, lo1, la2, lo2] = [a[0], a[1], b[0], b[1]].map(v => v * Math.PI / 180);
    const h = Math.sin((la2 - la1) / 2) ** 2
      + Math.cos(la1) * Math.cos(la2) * Math.sin((lo2 - lo1) / 2) ** 2;
    return 2 * MI_PER_RAD * Math.asin(Math.sqrt(h));
  }

  /* ---- milepost <-> position ------------------------------------------------ */

  function indexAtMp(target) {
    const mp = D.parkway_mp;
    let lo = 0, hi = mp.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mp[mid] < target) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  function coordAtMp(target) {
    const i = indexAtMp(target);
    if (i === 0) return D.parkway[0].slice();
    const a = D.parkway[i - 1], b = D.parkway[i];
    const ma = D.parkway_mp[i - 1], mb = D.parkway_mp[i];
    if (mb - ma <= 0) return b.slice();
    const f = Math.max(0, Math.min(1, (target - ma) / (mb - ma)));
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  function nearestVertex(lat, lon) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < D.parkway.length; i++) {
      const d = haversine([lat, lon], D.parkway[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    return { index: bi, distance: bd, mp: D.parkway_mp[bi] };
  }

  /* ---- network -------------------------------------------------------------- */

  function segmentAtMp(mp) {
    return D.segments.find(s => mp >= s.from_mp - 1e-9 && mp <= s.to_mp + 1e-9) || null;
  }

  const isOpen = mp => segmentAtMp(mp) !== null;

  function componentAtMp(mp) {
    const s = segmentAtMp(mp);
    return s ? s.component : null;
  }

  /* A stop inside a closure that has a signed detour is still served by the component
   * on either side; the detour rejoins the same road. */
  function componentForStop(stop) {
    const direct = componentAtMp(stop.mp);
    if (direct !== null) return direct;
    const gap = D.closures.find(c => stop.mp >= c.from_mp && stop.mp <= c.to_mp);
    if (!gap || gap.severs) return null;
    const before = segmentAtMp(gap.from_mp - 0.05), after = segmentAtMp(gap.to_mp + 0.05);
    return (before || after || {}).component ?? null;
  }

  function connected(a, b) {
    const ca = componentAtMp(a), cb = componentAtMp(b);
    return ca !== null && ca === cb;
  }

  function blockingClosures(a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return D.closures.filter(c => c.severs && c.to_mp > lo && c.from_mp < hi);
  }

  /* ---- stops ---------------------------------------------------------------- */

  /* Two coordinate systems, deliberately separate. `mp` is the Parkway ACCESS milepost
   * and drives centerline slicing. lat/lon is where the rider is actually going -- the
   * campground, or the pump. Navigating to a point on the Parkway beside a fuel exit
   * does not put gasoline in the tank. */
  function asStop(rec, kind, opts = {}) {
    const useStation = opts.useStation !== false;
    if (rec.kind === 'fuel') {
      let [lat, lon] = [rec.parkway_lat, rec.parkway_lon];
      let detour = 0;
      const located = (rec.stations || []).filter(s => s.lat != null && s.lon != null);
      if (useStation && located.length) {
        const best = located.reduce((m, s) =>
          haversine([lat, lon], [s.lat, s.lon]) < haversine([lat, lon], [m.lat, m.lon]) ? s : m);
        lat = best.lat; lon = best.lon;
        detour = rec.detour_plan_mi || 0;
      }
      return {
        id: `fuel-${rec.mp}`, mp: rec.mp, lat, lon, kind: kind || 'fuel',
        name: `FUEL ${rec.exit_road || ''}`.trim(),
        label: rec.town, offParkwayMi: detour, planGrade: rec.plan_grade,
        confidence: rec.confidence, accessClass: rec.access_class,
        note: rec.warning || rec.closure_note || '',
        comment: `MP ${rec.mp} - ${rec.town || ''}`
          + (rec.warning ? ` - ${rec.warning}` : rec.closure_note ? ` - ${rec.closure_note}` : ''),
        ref: rec
      };
    }
    return {
      id: `camp-${rec.id}`, mp: rec.mp, lat: rec.lat, lon: rec.lon,
      kind: kind || 'campground', name: rec.name, label: rec.price,
      offParkwayMi: rec.off_parkway_mi || 0,
      comment: `MP ${rec.mp} - ${rec.price || ''}`.replace(/\s*-\s*$/, ''),
      accessClass: rec.access_class, reachableFromParkway: rec.reachable_from_parkway,
      note: rec.blocking_closure ? `Parkway closed at MP ${rec.mp}: ${rec.blocking_closure.reason}` : '',
      ref: rec
    };
  }

  /* A unified place record (curated, OSM, or Google) as a routable stop. */
  function placeStop(rec) {
    const near = rec.mp != null ? null : nearestVertex(rec.lat, rec.lon);
    return {
      id: rec.id || `place-${rec.lat.toFixed(4)},${rec.lon.toFixed(4)}`,
      mp: rec.mp != null ? rec.mp : near.mp,
      lat: rec.lat, lon: rec.lon,
      // Everything that was not a hotel used to land here as a campground, which is how a
      // diner ended up in the trip as a campsite -- and, worse, exported to the GPS with a
      // tent symbol on it.
      kind: rec.kind === 'hotel' ? 'town' : rec.kind === 'food' ? 'food' : 'campground',
      name: rec.name,
      label: rec.price || rec.address
             || (rec.kind === 'hotel' ? 'Lodging'
                 : rec.kind === 'food' ? 'Somewhere to eat' : 'Campground'),
      comment: `MP ${(rec.mp != null ? rec.mp : near.mp).toFixed(1)} - ${rec.price || rec.name}`,
      offParkwayMi: rec.off_parkway_mi != null ? rec.off_parkway_mi
                                              : Math.round(near.distance * 100) / 100,
      placeSource: rec.source,
      ref: rec
    };
  }

  function customStop(lat, lon, name) {
    const near = nearestVertex(lat, lon);
    return {
      id: `pin-${Date.now()}-${Math.round(Math.random() * 1e4)}`,
      mp: near.mp, lat, lon, kind: 'pin', name: name || 'Custom stop',
      label: `MP ${near.mp.toFixed(1)}`, offParkwayMi: Math.round(near.distance * 10) / 10,
      custom: true
    };
  }

  return {
    data: D, haversine, indexAtMp, coordAtMp, nearestVertex,
    segmentAtMp, isOpen, componentAtMp, componentForStop, connected, blockingClosures,
    asStop, customStop, placeStop
  };
})();
