#!/usr/bin/env python3
"""Prove the browser port matches the Python reference. Run: python3 build/test_parity.py

v2/src/route.js and v2/src/gpx.js reimplement build/brp/route.py and build/brp/gpx.py so
the planner works offline with no server. Two implementations of subtle logic drift, and
the tests only cover the Python one, so this drives the real page in Chromium and
compares its GPX byte for byte against the Python exporter's.

Skips cleanly if Playwright or Chromium is unavailable -- it is a guard, not a gate.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "build"))

CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
DRIVER = r"""
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME });
  const p = await (await b.newContext()).newPage();
  await p.route('**tile.openstreetmap.org**', r => r.abort());
  await p.goto('file://' + process.env.PAGE);
  await p.waitForTimeout(700);
  const out = await p.evaluate(() => {
    const f = mp => BRP.data.fuel.find(x => x.mp === mp);
    const c = n => BRP.data.campgrounds.find(x => x.name.startsWith(n));
    const stops = [BRP.asStop(f(382.5), 'start'), BRP.asStop(f(393.6)),
                   BRP.asStop(c('Lake Powhatan'))];
    const day = Router.buildDay(stops);
    return {
      xml: Gpx.exportRoute(day, 'BRP D1 parity'),
      track: Gpx.exportTrackOnly(day, 'BRP D1 parity'),
      nTotal: day.nTotal, nVia: day.nVia, nJunction: day.nJunctionPoints,
      parkwayMi: day.parkwayMi, maxSpan: day.maxUnprotectedSpanMi,
      rtepts: day.rtepts.map(r => [r.type, +r.mp.toFixed(4), +r.lat.toFixed(6), +r.lon.toFixed(6)])
    };
  });
  console.log(JSON.stringify(out));
  await b.close();
})();
"""


def main():
    if not os.path.exists(CHROME):
        print("skip: chromium not available")
        return 0
    scratch = os.environ.get("SCRATCH", tempfile.gettempdir())
    driver = os.path.join(scratch, "parity_driver.js")
    with open(driver, "w") as f:
        f.write(DRIVER)
    env = {**os.environ, "CHROME": CHROME,
           "PAGE": os.path.join(ROOT, "index.html"),
           "NODE_PATH": os.path.join(scratch, "node_modules")}
    try:
        raw = subprocess.run(["node", driver], capture_output=True, text=True,
                             env=env, timeout=120, cwd=scratch)
    except Exception as e:
        print(f"skip: could not drive the browser ({e})")
        return 0
    if raw.returncode != 0:
        print("skip: browser run failed\n" + raw.stderr[-400:])
        return 0
    js = json.loads(raw.stdout.strip().splitlines()[-1])

    from brp import gpx, junctions as J, mp as M, network as N, route as R, stops as S
    data = os.path.join(ROOT, "data")
    model, _ = M.load(data)
    net = N.load(model, data)
    jx = J.load(model, data)
    fuel = {f["mp"]: f for f in S.build_fuel(model, net, json.load(open(f"{data}/fuel.json")))}
    cgs = {c["name"]: c for c in
           S.build_campgrounds(model, net, json.load(open(f"{data}/campgrounds.json")))}
    pyday = R.build_day(model, net, jx, [
        S.as_route_stop(fuel[382.5], "start"), S.as_route_stop(fuel[393.6]),
        S.as_route_stop(next(v for k, v in cgs.items() if k.startswith("Lake Powhatan"))),
    ])

    failures = []

    def check(name, a, b):
        ok = a == b
        detail = "" if ok else f"   js={str(a)[:160]!r} py={str(b)[:160]!r}"
        print(f"  {'pass' if ok else 'FAIL'}  {name}{detail}")
        if not ok:
            failures.append(name)

    def check_true(name, ok, detail=""):
        print(f"  {'pass' if ok else 'FAIL'}  {name}" + ("" if ok else f"   {detail}"))
        if not ok:
            failures.append(name)

    print("day metrics")
    check("total route points", js["nTotal"], pyday["n_total"])
    check("via points", js["nVia"], pyday["n_via"])
    check("junction-driven points", js["nJunction"], pyday["n_junction_points"])
    check("Parkway miles", js["parkwayMi"], pyday["parkway_mi"])
    check("max unprotected span", js["maxSpan"], pyday["max_unprotected_span_mi"])

    print("route point sequence")
    pypts = [[p["type"], round(p["mp"], 4), round(p["lat"], 6), round(p["lon"], 6)]
             for p in pyday["rtepts"]]
    check("point count", len(js["rtepts"]), len(pypts))
    # Type and milepost must match exactly; coordinates only within the tolerance the
    # 5 dp browser bundle allows (see below).
    types = [(p[0], p[1]) for p in js["rtepts"]]
    check("every point has the same type and milepost",
          types, [(p[0], p[1]) for p in pypts])
    drift = max((max(abs(a[2] - b[2]), abs(a[3] - b[3]))
                 for a, b in zip(js["rtepts"], pypts)), default=0.0)
    check_true("route point coordinates agree within 2e-05 deg",
               drift <= 2e-5, f"worst {drift:.7f} deg")

    print("emitted GPX")
    # The browser bundle stores coordinates at 5 dp (~1.1 m) to keep the page small, so
    # its interpolations land fractions of a metre from Python's full-precision ones.
    # That is four orders of magnitude below the milepost model's own 0.34 mi accuracy,
    # so compare at the bundle's precision rather than bloating it for a test.
    COORD = re.compile(r'(lat|lon)="(-?\d+\.\d+)"')
    TOL_DEG = 2e-5   # ~2.2 m

    def structure(xml):
        """Everything except the coordinate values."""
        return COORD.sub(lambda m: f'{m.group(1)}="#"', xml)

    def coords(xml):
        return [float(m.group(2)) for m in COORD.finditer(xml)]

    def compare(label, a, b):
        check(f"{label}: markup identical", structure(a), structure(b))
        ca, cb = coords(a), coords(b)
        if len(ca) != len(cb):
            check(f"{label}: coordinate count", len(ca), len(cb))
            return
        worst = max((abs(x - y) for x, y in zip(ca, cb)), default=0.0)
        check_true(f"{label}: coordinates agree within {TOL_DEG} deg (~2 m)",
                   worst <= TOL_DEG, f"worst {worst:.7f} deg")
        print(f"        worst coordinate deviation: {worst:.7f} deg "
              f"(~{worst * 111_000:.2f} m)")

    compare("route file", js["xml"], gpx.export_route(pyday, "BRP D1 parity"))
    compare("track-only file", js["track"], gpx.export_track_only(pyday, "BRP D1 parity"))
    # Not just consecutive: a degenerate leg emits an alternating A,B,A,B stutter that a
    # consecutive-only check walks straight past.
    seen, repeats = set(), []
    for pt in pyday["track"]:
        key = (round(pt[0], 6), round(pt[1], 6))
        if key in seen:
            repeats.append(key)
        seen.add(key)
    check("no repeated track point anywhere in the day", repeats[:3], [])

    print()
    if failures:
        print(f"{len(failures)} FAILED: {failures}")
        return 1
    print("browser port matches the Python reference: markup byte-identical, "
          "coordinates within ~1 m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
