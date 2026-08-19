# v2 — the trip planner

**This is what deploys.** The repo-root `index.html` is **generated** from this folder.
Edit the files in `app/src/`, then rebuild:

```
python3 build/derive.py     # only when data/ changes — rebuilds the data bundle
python3 build/build_app.py   # inlines src/ + vendor/ + data -> /index.html
```

There is deliberately no second copy of the built page under `v2/`. Two generated
artifacts drift, and only one of them is ever the thing that deployed.

The deploy stays one static file with no build step, which is what keeps it working from
a phone in a parking lot with no signal. The generator runs offline, in the repo, the way
`v1/build.py` did.

## Where things are

| File | What lives there | Touch it when |
|---|---|---|
| `src/shell.html` | Page skeleton, tab bar, panel markup | Adding or renaming a tab |
| `src/styles.css` | **All** styling, tokenised in `:root` | Any visual change |
| `src/app.js` | Trip state, rendering, map, downloads | Any UI or interaction change |
| `src/core.js` | Geometry, milepost lookup, reachability | Rarely — mirrors `build/brp/` |
| `src/route.js` | Route slicing, point placement, budgets | Rarely — mirrors `build/brp/route.py` |
| `src/gpx.js` | GPX export + in-page validation | Rarely — mirrors `build/brp/gpx.py` |
| `vendor/leaflet.*` | Leaflet 1.9.4, inlined at build | Upgrading Leaflet |

**For UI work you almost certainly want `styles.css` and `app.js` only.** The other three
are ports of the Python under `build/`, which is the reference implementation and carries
the test suite. `build/test_parity.py` drives the real page in Chromium and compares its
GPX against Python's, so if the two drift apart, that test fails.

### Restyling

Everything is a token in `:root` — palette, radii, tap-target size, sidebar width. There
are three palettes: the default (dark), a `prefers-color-scheme: light` override, and an
explicit `[data-theme]` override so a toggle can win in either direction. Change a colour
once at the top and it propagates.

Layout breakpoint is 860px: side-by-side sidebar and map above it, stacked below it with
the map taking 42vh. `--tap: 44px` is the minimum touch target and is applied to every
control; the mobile block raises icon buttons to 38px.

### Rendering

`app.js` has one `render()` that redraws the active tab and the map. Each tab is a
`renderX()` that clears its pane and rebuilds it — no diffing, no framework. State lives
in one `state` object and persists to `localStorage` on every render.

To add a panel: add a `<button data-tab="x">` in `shell.html`, a `<div class="pane"
id="pane-x">`, a `renderX()`, and a line in `render()`.

## The Plan tab

Four numbered steps and an itinerary. Nothing the planner works out is offered as a choice.

1. **Starting from** — address, town, `lat, lon`, or browser location.
2. **Camping at** — all 32 campgrounds, searchable and filterable in place (Top picks,
   Moto camps, KOA, within 2 mi of the Parkway, reachable from the Parkway). Add a second
   campsite for a second night.
3. **How you ride** — miles on a tank, max miles per day, furthest you will ride off the
   Parkway for fuel.
4. **Finishing at** — back home (round trip) or somewhere else.

Everything below is the answer: where you join the Parkway, where fuel comes from, how
much is in the tank at each point, where you leave the Parkway, and the ride to the finish.

**Fuel is simulated across the whole journey, never leg by leg.** A campsite sells no fuel
and neither does the Parkway, so the rider leaves camp with exactly what they arrived on.
Planning each leg from a full tank quietly refuels the bike overnight and yields a plan
that fails on the way home. `plan_journey` walks the entire waypoint list — entry,
overnights, exit — as one distance line, reversing direction where a round trip does, and
reports the tank at every waypoint.

**Access and exit points are chosen, not offered.** Entry is the nearest one that can
actually reach the campsite; exit is the nearest one to wherever the trip finishes. Both
keep the ride-in and ride-out short so the Parkway miles run long. Ranking by total
distance instead is defensible arithmetic and useless in practice — Charlotte→Cherokee
would enter at MP 469.1 and ride 0.1 mi of Parkway.

**Arriving with enough to get back out** is a hard constraint. The plan reserves enough
range at the end of the Parkway leg to reach the nearest pump, computed in either
direction with the detour included.

**There is no safety-percentage reserve.** "Miles on a tank" is already a rider's
conservative real figure, and the exit-fuel rule is a concrete margin rather than a round
number held back. A plan can therefore fit with very little spare, so a thin arrival is
stated as the headline — "it fits, but only just" — rather than the technically-true "no
fuel stop needed".

### Where places come from

Three sources, deliberately not interchangeable, and each row says which one it came from:

| Source | Coverage | Offline | Cost |
|---|---|---|---|
| **curated** — `data/campgrounds.json` | 32, researched, verified for hot showers and flush toilets | yes | none |
| **osm** — `data/osm_places.json` | wide: campgrounds, hotels, motels, hostels within 25 mi | yes | none |
| **google** — live via `api/places.js` | best, and current | **no** | per request |

Run the OSM pull once and it is baked in forever:

```
python3 build/fetch_osm.py --radius 25   # -> data/osm_places.json
python3 build/derive.py && python3 build/build_app.py
```

The app works before you ever run it — `places.py` handles a missing OSM file, and step 2
says the list is curated-only until you widen it.

Google is a supplement, never a dependency: a button in step 2, results held in memory for
the session only. Google's terms restrict retaining Places content, so nothing is written
to `localStorage` or into the bundle.

**Amenity flags are three-state and the filters respect it.** `true` means someone recorded
it, `false` means someone recorded its absence, `null` means nobody has looked. Treating
`null` as `false` would hide real campgrounds — the failure that makes crowd-sourced data
feel useless. "Has showers" keeps only places recorded as having them; everything else
shows *Showers unknown* rather than being silently dropped.

### Picking a place

A list row shows a name and a milepost, which tells a rider nothing about whether they want
to sleep there. So tapping a row previews it **on the map**: the view flies to the place, a
marker drops with a dashed line showing how far off the Parkway it really sits, and the
full card opens in the map popup — price, season, showers, toilets, access notes and the
honest "watch out", with *Stay here* / *Not this one* right there. The card deliberately
does not live in the sidebar: stacked under the form it pushed the list around and got
lost, and the rider was reading detail in one place while looking at the location in
another.

Inside the popup the name and the buttons are pinned and only the detail scrolls. On a
phone the map pane is barely 350px tall, and a card that overflows it hides exactly the two
things needed: what this place is, and how to say yes. The map move is deliberately
un-animated, because Leaflet's popup auto-pan measures against the map's current position
and a running animation makes that stale.

Every place also carries a hover tooltip and a click handler on the map itself, so the dots
are identifiable without going near the list.

### Roads off the Parkway

The Parkway needs no router: between junctions it has no alternatives, so the centerline
sliced between two mileposts *is* the route. Three legs are not on the Parkway and do need
one — the ride in from the rider's house, the hop off to a campsite or hotel that is not on
the Parkway, and the ride out to wherever the trip finishes.

Those were previously a straight dashed line on the map and **nothing at all in the
exported GPX**, which left the Garmin to invent its own way there. `api/route.js` fetches
real geometry from Google Directions, and it feeds three things:

- the map draws the actual roads, solid where they are real and dashed where they are still
  an estimate — the distinction is the point;
- the itinerary shows a collapsible turn list per leg;
- the exporter hangs shaping points along them, so the GPX pins the intended roads instead
  of leaving them to the device.

Placement is in travel order, which took a bug to learn: an earlier version appended the
ride-in points after the final via, routing the rider to the campground and then back down
their own driveway. The ride in and out get a light touch (4 points) since they are
ordinary roads the device handles well; the hop off the Parkway gets more (6), because it
is short, easy to get wrong, and the one the rider cannot work out from a milepost.

**Results are cached with the trip.** Routing needs signal and riding does not, so a trip
planned at home keeps its roads and its turn list in a dead zone.

### The two pieces of server-side code

They are `.mjs`, not `.js`, and that is load-bearing. Vercel's Node runtime treats a bare
`.js` file as CommonJS unless `package.json` declares `"type": "module"`, so `export
default` fails to parse, the function never deploys, and the route returns a bare 404 that
looks like a routing problem rather than a syntax one. Adding a `package.json` would also
fix it, but this repo deliberately has no build step and introducing one risks changing how
Vercel treats the whole project.



`api/places.mjs` and `api/route.mjs` exist because a Vercel environment variable is only a
secret if the code reading it runs on Vercel. A static page's JavaScript cannot read one, and inlining it at
build time puts the key in the page source. So the key lives in the function and the
browser never sees it.

Set `GOOGLE_PLACES_API_KEY` (and `GOOGLE_MAPS_API_KEY`, or reuse the same key) in the
Vercel project's environment variables, with the Places API and Directions API enabled, and
restrict the key in the Google Cloud console as well. Both endpoints bound what they will
proxy — allowed place types, capped radius, capped waypoints — because the URLs are public
even when the key is not, and without those bounds they are open proxies onto a billable
account.

## Behaviour worth knowing before you change it

- **Days are the rider's explicit breaks.** `autoSplit()` proposes them by mileage but
  never overrides one that is set — where you sleep depends on campsites and daylight,
  not a mileage heuristic.
- **Adding a stop inserts at milepost position** rather than re-sorting, so a manual
  reorder survives. Backtracking is legal and warned about, not prevented — the Mt
  Mitchell spur is an out-and-back by definition.
- **Fuel gaps are computed across the whole trip**, not per day, then attributed to the
  day each gap starts in. A tank carries across an overnight, so per-day arithmetic
  invents refuelling points that do not exist and understates the gap.
- **Export refuses to offer a file that fails validation.** SPEC §8 asks for the point
  budget enforced, not warned.
- **The point budget follows the device profile** (Export tab). Default is zumo XT2:
  62 total / 25 via. Switch to Universal (50/25) when sharing files with riders on other
  devices.

## Deploy

Push to `main`. Vercel serves the repo-root `index.html`, which `build/build_app.py`
generates from this folder — no build step runs on Vercel, so **the rebuilt `index.html`
has to be committed** alongside any `app/src/` change. If you edit source and forget to
rebuild, the site will not change.

`v1/index.html` is untouched and still reachable at `/v1/` as a fallback. Nothing in the
build depends on it any more — Leaflet now lives in `app/vendor/`.
