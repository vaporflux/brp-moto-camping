# Blue Ridge Parkway — Trip Planner

A trip planner for riding the Blue Ridge Parkway (MP 0–469): pick campgrounds and fuel
stops, break the route into riding days, get warned about fuel gaps and 2026 closures,
and export GPX that a Garmin will actually follow along the Parkway.

The 32 campgrounds are all verified to have **hot showers and flush toilets**. The 29
fuel exits carry a confidence rating *and* a separate reachability rating — a verified
pump inside a closed segment is still unreachable, and the planner says so.

Each pin opens a card with: how to get in from the Parkway, shower and restroom detail,
pad surface, 2026 price, season, group-site availability, rating, nearby food, plus a
one-line "why it works" and an honest "watch out."

The current Blue Ridge Parkway closures (Hurricane Helene damage and construction) are
drawn on the map in red, accurate as of the NPS update of **August 16, 2026**.
Re-check <https://www.nps.gov/blri/planyourvisit/roadclosures.htm> before you ride.

## Running it

It's one self-contained file. Open `index.html` in any browser, or host it anywhere that
serves static files. Leaflet and all the data are embedded, so the page, the planner and
the GPX export all work with no connection — only the background map tiles need signal.

`index.html` is **generated**. Edit `v2/src/`, then run `python3 build/build_v2.py` and
commit the result. See `v2/README.md`.

The previous version is still at `v1/index.html` (`/v1/` when deployed).

## Tests

```
python3 build/test_data.py     # data layer: mileposts, closures, reachability
python3 build/test_gpx.py      # routing, point budgets, GPX validation
python3 build/test_parity.py   # browser port vs the Python reference (needs Chromium)
```

## Legend

| Pin | Meaning |
|---|---|
| 🔴 Red | Motorcycle camp |
| 🟠 Amber | Top pick |
| 🟢 Green | Solid option |
| ⚪ Grey | Backup |

Blue line = Parkway open. Dashed red line = closed.

The Parkway is in **three disconnected pieces** in 2026. The planner refuses to route
between them rather than quietly bridging a closed gate.

## A note on the data

Prices and seasons are 2026 published rates. Call ahead before you commit a group —
several of these places take group bookings by phone only, and a couple of the
motorcycle camps don't confirm their season online at all.
