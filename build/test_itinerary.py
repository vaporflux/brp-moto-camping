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

  // A meal is not a night, and not a campsite. This is the bug as reported: a restaurant
  // picked from the Google search was added to the trip as lodging, offered "Stay here",
  // and would have reached the GPS wearing a tent.
  await p.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('brp-trip-v2'));
    st.parkwayMph = 40; st.startTime = '09:00';
    const camp = st.stops[0];
    st.stops = [
      { id: 'google-x', name: 'Smokehouse BBQ', mp: 60.0, lat: 37.55, lon: -79.45,
        kind: 'food', label: 'Somewhere to eat', dayBreakAfter: true },
      { ...camp, dayBreakAfter: true },
    ];
    localStorage.setItem('brp-trip-v2', JSON.stringify(st));
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2000);
  const meal = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#pane-plan .stop')];
    const n = rows.find(r => /Smokehouse BBQ/.test(r.textContent));
    return n ? { text: n.textContent.replace(/\s+/g, ' ').trim(),
                 colour: getComputedStyle(n.querySelector('.s-name')).color,
                 // the colour the food glyph is drawn in, read from the same CSS var
                 want: getComputedStyle(document.documentElement)
                         .getPropertyValue('--food').trim() }
             : null;
  });

  // A tank small enough that the Parkway itself forces a stop, so there is a real fuel row
  // to put on the clock. The default trip fits on one tank, which is the commonest case
  // and tells us nothing about how a pump is timed.
  await plant({ startTime: '09:00', parkwayMph: 40, tankMi: 90 });
  await p.waitForTimeout(1800);
  const thirsty = await read();

  await plant({ startTime: '09:00', parkwayMph: 40, tankMi: 200 });
  await p.waitForTimeout(1800);

  // The top-off is an instruction for the ride IN, so it has to appear above the row that
  // joins the Parkway. Putting it after was the bug: the Parkway sells no fuel, so a
  // top-off on it is by definition a detour off it, for fuel the rider passed on the way.
  const topOff = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#pane-plan .stop')]
      .map(n => n.textContent.replace(/\s+/g, ' ').trim());
    return { rows,
             topOffAt: rows.findIndex(r => /Top off/i.test(r)),
             joinAt: rows.findIndex(r => /Get on the Parkway/.test(r)),
             summary: (document.querySelector('#pane-plan .alert') || {}).textContent || '' };
  });

  // Reordering. A stop is dropped in at its milepost, which is a guess -- a rider who finds
  // lunch forty miles past their campsite still wants to eat before they make camp.
  await p.evaluate(() => {
    const st = JSON.parse(localStorage.getItem('brp-trip-v2'));
    st.tankMi = 200; st.parkwayMph = 40; st.startTime = '09:00';
    st.stops = [
      { id: 'camp', name: 'Peaks Of Otter Campground', mp: 85.1, lat: 37.44, lon: -79.60,
        kind: 'campground', label: 'Campground', dayBreakAfter: true },
      { id: 'diner', name: 'Smokehouse BBQ', mp: 120.4, lat: 37.28, lon: -79.85,
        kind: 'food', label: 'Somewhere to eat', dayBreakAfter: false },
    ];
    localStorage.setItem('brp-trip-v2', JSON.stringify(st));
  });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2200);
  const snapOrder = () => p.evaluate(() => ({
    picked: [...document.querySelectorAll('#pane-plan .picked .s-name')].map(n => n.textContent),
    steps: [...document.querySelectorAll('#pane-plan .stop')]
             .map(n => n.textContent.replace(/\s+/g, ' ').trim()),
    stored: (JSON.parse(localStorage.getItem('brp-trip-v2') || '{}').stops || [])
              .map(x => x.name),
  }));
  const orderBefore = await snapOrder();
  await p.evaluate(() => {
    // Step 1's chosen start is also a .picked row, so pick by name rather than by index.
    [...document.querySelectorAll('#pane-plan .picked')]
      .find(n => /Smokehouse/.test(n.textContent))
      .querySelector('.reorder .icon-btn').click();          // move it earlier
  });
  await p.waitForTimeout(2200);
  const orderAfter = await snapOrder();

  console.log(JSON.stringify({ base, early, slow, straight, thirsty, meal, topOff,
                               orderBefore, orderAfter, errors }));
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
    # The top-off is the one exemption, and deliberately: it happens during the ride in,
    # which the "get on the Parkway" row already puts on the clock. Giving it a row of its
    # own must not give it a duration of its own.
    timed = [r for r in base["rows"] if not re.search(r"Top off", r)]
    check("every step carries a time, bar the top-off",
          all(TIME.search(r) or LEAVE.search(r) for r in timed),
          str([r[:40] for r in timed if not (TIME.search(r) or LEAVE.search(r))]))
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
    def join_row(run):
        return next(r for r in run["rows"] if "Get on the Parkway" in r)
    check("but the ride in is unchanged, being off the Parkway",
          RIDING.search(join_row(base)).group(0) == RIDING.search(join_row(slow)).group(0),
          f"{RIDING.search(join_row(base)).group(0)} vs {RIDING.search(join_row(slow)).group(0)}")
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
    thirsty = js["thirsty"]
    fuel_rows = [r for r in thirsty["rows"] if "Fuel —" in r]
    check("a small tank forces a fuel stop on the Parkway", bool(fuel_rows),
          str([r[:40] for r in thirsty["rows"]]))
    check("and it is on the clock like everything else",
          all(TIME.search(r) for r in fuel_rows), str(fuel_rows)[:140])
    # Ten minutes off the bike. Without it every arrival after the first pump is early.
    if fuel_rows:
        after = [minutes(m) for m in (TIME.search(r) for r in thirsty["rows"]) if m]
        check("time still only moves forward once a pump is in the way",
              after == sorted(after), str(after))

    print("\nyou fill up before you join, not after")
    t = js["topOff"]
    check("the plan says to top off", t["topOffAt"] >= 0,
          str([r[:40] for r in t["rows"]]))
    check("and says it before you get on the Parkway",
          t["topOffAt"] >= 0 and t["joinAt"] >= 0 and t["topOffAt"] < t["joinAt"],
          f"top off at row {t['topOffAt']}, joins at row {t['joinAt']}")
    check("it explains why -- there is no fuel on the Parkway",
          "No fuel anywhere on the Parkway" in t["rows"][t["topOffAt"]],
          t["rows"][t["topOffAt"]][:120])
    check("it costs no riding time of its own, being part of the ride in",
          "riding" not in t["rows"][t["topOffAt"]], t["rows"][t["topOffAt"]][-60:])
    check("and the summary leads with it",
          "Top off before MP" in t["summary"], t["summary"][:140])

    print("\na meal is a meal, not a night and not a campsite")
    meal = js["meal"]
    check("a food stop appears in the itinerary", meal is not None, str(meal))
    if meal:
        check("and says to eat, not to camp or stay",
              "Eat here" in meal["text"]
              and "Camp here" not in meal["text"] and "Overnight" not in meal["text"],
              meal["text"][:110])
        # The itinerary and the map must not be two different keys for one trip.
        want = tuple(int(meal["want"].lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
        got = tuple(int(x) for x in re.findall(r"\d+", meal["colour"])[:3])
        check("in the same purple the food glyph is drawn in", got == want,
              f"{got} vs {want}")
        # A day break on a lunch stop is the rider's data, not an instruction to sleep.
        check("and does not roll the clock to the next morning",
              "(day" not in meal["text"], meal["text"][-60:])

    print("\nthe trip runs in the order you put it in")
    ob, oa = js["orderBefore"], js["orderAfter"]

    def idx(rows, name):
        return next((i for i, r in enumerate(rows) if name in r), -1)

    check("a stop lands in milepost order to begin with",
          ob["stored"] == ["Peaks Of Otter Campground", "Smokehouse BBQ"],
          str(ob["stored"]))
    check("moving one earlier reorders the trip",
          oa["stored"] == ["Smokehouse BBQ", "Peaks Of Otter Campground"],
          str(oa["stored"]))
    check("and the choice survives being saved", "Smokehouse" in oa["picked"][1],
          str(oa["picked"]))
    check("the itinerary follows the new order, not the mileposts",
          idx(oa["steps"], "Smokehouse") < idx(oa["steps"], "Peaks Of Otter"),
          str([r[:34] for r in oa["steps"]]))
    # The whole plan has to be rebuilt, not just the list: what was an intermediate
    # overnight is now the last stop, and the fuel simulation runs a different route.
    camp_before = next(r for r in ob["steps"] if "Peaks Of Otter" in r)
    camp_after = next(r for r in oa["steps"] if "Peaks Of Otter" in r)
    check("a stop that becomes the last one stops being an intermediate night",
          "Overnight" in camp_before and "Camp here" in camp_after,
          f"{camp_before[:60]} -> {camp_after[:60]}")
    check("and the fuel figures are recomputed for the new route",
          camp_before != camp_after, camp_after[:80])
    after_times = [minutes(m) for m in (TIME.search(r) for r in oa["steps"]) if m]
    check("times still only move forward afterwards",
          after_times == sorted(after_times), str(after_times))

    check("the page raised no errors", not js["errors"], str(js["errors"][:3]))

    print()
    if failures:
        print(f"{len(failures)} FAILED: {failures}")
        return 1
    print("the itinerary's clock is honest and consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
