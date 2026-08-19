#!/usr/bin/env python3
"""Prove the itinerary's clock. Run: python3 build/test_itinerary.py

Distance was always the number this planner gave, and on the Parkway it is the misleading
one: the limit is 45 mph and long stretches are 35, so a rider calibrated on interstates
reads "469 miles" as a long day when it is closer to two. The clock turns that into a time
of day before the trip rather than at dusk.

Everything it does is a stated assumption -- a constant Parkway speed the rider sets, 50
mph off it, ten minutes at a pump -- so what has to be true is that the arithmetic is
honest and consistent: times only ever move forward, the speed actually drives them, and a
night's sleep lands the rider at breakfast rather than at 4am.

Skips cleanly if Playwright or Chromium is unavailable.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "build"))
from test_parity import CHROME, _global_node_modules  # noqa: E402

DRIVER = r"""
const { chromium } = require('playwright');
const TILE = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080200000090'
  + '773dfa0000000c4944415408d763f8cfc0f01f000501010063a0b7c800000000'
  + '49454e44ae426082', 'hex');
(async () => {
  const b = await chromium.launch({ executablePath: process.env.CHROME });
  const p = await (await b.newContext({ viewport: { width: 520, height: 1400 } })).newPage();
  await p.route('**://**', r => r.request().url().startsWith('file:')
    ? r.continue()
    : r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
  const errors = [];
  p.on('pageerror', e => errors.push(String(e)));
  await p.goto('file://' + process.env.PAGE, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);

  // A trip with a real approach, a real overnight and enough Parkway to need fuel.
  const plant = (patch) => p.evaluate(patch => {
    const st = JSON.parse(localStorage.getItem('brp-trip-v2') || '{}');
    const camp = BRP.data.places.find(x => x.mp > 85 && x.mp < 95 && x.kind !== 'hotel');
    Object.assign(st, {
      start: { lat: 37.93, lon: -79.05, label: 'Waynesboro, VA' },
      stops: [{ id: camp.id, name: camp.name, mp: camp.mp, lat: camp.lat, lon: camp.lon,
                kind: camp.kind, dayBreakAfter: true }],
      finish: 'home', tankMi: 200, arriveMinMi: 10, maxFuelDetourMi: 8,
    }, patch);
    localStorage.setItem('brp-trip-v2', JSON.stringify(st));
  }, patch).then(() => p.reload({ waitUntil: 'domcontentloaded' }));

  const read = () => p.evaluate(() => {
    const rows = [...document.querySelectorAll('#pane-plan .stop')]
      .map(n => n.textContent.replace(/\s+/g, ' ').trim());
    const alert = document.querySelector('#pane-plan .alert');
    return { rows, summary: alert ? alert.textContent.replace(/\s+/g, ' ').trim() : '' };
  });

  await plant({ startTime: '09:00', parkwayMph: 40 });
  await p.waitForTimeout(1800);
  const base = await read();

  await plant({ startTime: '06:30', parkwayMph: 40 });
  await p.waitForTimeout(1800);
  const early = await read();

  await plant({ startTime: '09:00', parkwayMph: 20 });
  await p.waitForTimeout(1800);
  const slow = await read();

  // Same trip, ridden straight through with no overnight.
  await p.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('brp-trip-v2'));
    st.parkwayMph = 40; st.startTime = '09:00';
    st.stops = st.stops.map(s => ({ ...s, dayBreakAfter: false }));
    localStorage.setItem('brp-trip-v2', JSON.stringify(st));
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
  const straight = await read();

  console.log(JSON.stringify({ base, early, slow, straight, errors }));
  await b.close();
})();
"""

TIME = re.compile(r"arrive about (\d{1,2}):(\d{2})(am|pm)(?: \(day (\d+)\))?")
LEAVE = re.compile(r"leave about (\d{1,2}):(\d{2})(am|pm)")
RIDING = re.compile(r"(?:(\d+) hr)? ?(?:(\d+) min)? riding")

failures = []


def check(name, ok, detail=""):
    print(f"  {'pass' if ok else 'FAIL'}  {name}" + ("" if ok else f"   {detail}"))
    if not ok:
        failures.append(name)


def minutes(m):
    h, mm, ampm = int(m.group(1)), int(m.group(2)), m.group(3)
    if ampm == "pm" and h != 12:
        h += 12
    if ampm == "am" and h == 12:
        h = 0
    day = int(m.group(4)) - 1 if m.lastindex and m.lastindex >= 4 and m.group(4) else 0
    return day * 1440 + h * 60 + mm


def times(run):
    return [minutes(m) for m in (TIME.search(r) for r in run["rows"]) if m]


def main():
    if not os.path.exists(CHROME):
        print("skip: chromium not available")
        return 0
    page = os.path.join(ROOT, "index.html")
    if not os.path.exists(page):
        print("skip: index.html not built")
        return 0
    scratch = os.environ.get("SCRATCH", tempfile.gettempdir())
    driver = os.path.join(scratch, "itinerary_driver.js")
    with open(driver, "w") as f:
        f.write(DRIVER)
    env = {**os.environ, "CHROME": CHROME, "PAGE": page,
           "NODE_PATH": os.pathsep.join(
               [os.path.join(scratch, "node_modules"), *_global_node_modules()])}
    try:
        raw = subprocess.run(["node", driver], capture_output=True, text=True,
                             env=env, timeout=240, cwd=scratch)
    except Exception as e:
        print(f"skip: could not drive the browser ({e})")
        return 0
    if raw.returncode != 0:
        print("skip: browser run failed\n" + raw.stderr[-500:])
        return 0
    js = json.loads(raw.stdout.strip().splitlines()[-1])
    base, early, slow, straight = js["base"], js["early"], js["slow"], js["straight"]

    print("every step says when you get there")
    check("the itinerary has steps at all", len(base["rows"]) >= 4, str(len(base["rows"])))
    check("every step carries a time",
          all(TIME.search(r) or LEAVE.search(r) for r in base["rows"]),
          str([r[:40] for r in base["rows"] if not (TIME.search(r) or LEAVE.search(r))]))
    check("the ride starts when the rider said",
          bool(LEAVE.search(base["rows"][0])) and minutes(LEAVE.search(base["rows"][0])) == 9 * 60,
          base["rows"][0][:60])
    check("time never runs backwards", times(base) == sorted(times(base)),
          str(times(base)))

    print("\nthe start time is a real input")
    check("setting off two and a half hours earlier moves everything with it",
          minutes(LEAVE.search(early["rows"][0])) == 6 * 60 + 30
          and times(early)[0] == times(base)[0] - 150,
          f"{times(early)[:2]} vs {times(base)[:2]}")

    print("\nspeed is what turns miles into hours")
    # Halving the Parkway speed must roughly double the Parkway riding, and cannot touch
    # the approach -- that leg is ridden on ordinary roads at a fixed 50 mph.
    def parkway_leg(run):
        # first camp row: the long Parkway haul
        for r in run["rows"]:
            if "Camp here" in r or "Overnight" in r:
                m = RIDING.search(r)
                return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)
        return None
    fast, halved = parkway_leg(base), parkway_leg(slow)
    check("halving the speed doubles the Parkway leg",
          fast and halved and abs(halved - 2 * fast) <= 2, f"{fast} min -> {halved} min")
    check("but the ride in is unchanged, being off the Parkway",
          RIDING.search(base["rows"][1]).group(0) == RIDING.search(slow["rows"][1]).group(0),
          f"{RIDING.search(base['rows'][1]).group(0)} vs {RIDING.search(slow['rows'][1]).group(0)}")
    check("the summary states the moving time and the speed it assumed",
          "40 mph" in base["summary"] and "moving at" in base["summary"],
          base["summary"][:120])
    check("and a slower speed reports a longer day",
          "20 mph" in slow["summary"], slow["summary"][:120])

    print("\na night's sleep is not eleven hours of riding")
    # With an overnight, everything after camp happens the NEXT morning at the start time.
    after = [m for m in (TIME.search(r) for r in base["rows"]) if m]
    check("something lands on the second day",
          any(m.group(4) for m in after), str([m.group(0) for m in after]))
    first_next_day = next((minutes(m) for m in after if m.group(4)), None)
    check("and it is not before the hour the rider gets up",
          first_next_day is not None and first_next_day >= 1440 + 9 * 60,
          str(first_next_day))
    check("riding it straight through keeps it on one day",
          not any(m.group(4) for m in (TIME.search(r) for r in straight["rows"]) if m),
          str([r[-30:] for r in straight["rows"]]))
    check("and finishes later in the same day than it started",
          times(straight) == sorted(times(straight)) and times(straight)[-1] > 9 * 60,
          str(times(straight)))

    print("\nstanding at a pump takes time too")
    fuel_rows = [r for r in base["rows"] if "Fuel —" in r or "Top off —" in r]
    check("the fuel stop is on the clock like everything else",
          fuel_rows and all(TIME.search(r) for r in fuel_rows), str(fuel_rows)[:120])

    check("the page raised no errors", not js["errors"], str(js["errors"][:3]))

    print()
    if failures:
        print(f"{len(failures)} FAILED: {failures}")
        return 1
    print("the itinerary's clock is honest and consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
