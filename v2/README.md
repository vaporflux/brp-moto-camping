# v2 — the trip planner

**This is what deploys.** The repo-root `index.html` is **generated** from this folder.
Edit the files in `v2/src/`, then rebuild:

```
python3 build/derive.py     # only when data/ changes — rebuilds the data bundle
python3 build/build_v2.py   # inlines src/ + vendor/ + data -> /index.html
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

Three inputs and an itinerary. Nothing the planner works out is offered as a choice.

1. **Starting from** — address, town, `lat, lon`, or browser location.
2. **Camping at** — campgrounds searched inline. No trip to the Browse tab.
3. **How you ride** — miles on a tank, max miles per day, furthest you will ride off the
   Parkway for fuel.

Everything below that is the answer: which access point, where fuel comes from, what each
leg costs. An earlier version exposed access-point rankings and made the rider click fuel
stops onto the trip. That put the machinery in front of the answer, and it was the wrong
shape — a rider deciding a fuel stop has no idea where they will be in the trip when they
reach it.

**Access point is never a choice.** Always the nearest entry that can actually reach the
destination, so the ride in is short and the Parkway miles are long. Ranking by total
distance instead is defensible arithmetic and useless in practice: Charlotte→Cherokee
enters at MP 469.1 and rides 0.1 mi of Parkway.

**Fuel is never a choice.** Stops are found and placed. Greedy furthest-reachable, which
minimises stops. A detour burns range both ways — a 15 mi detour costs 30 mi of tank —
which is what makes MP 411.8 a trap.

**Arriving with enough to get back out** is a hard requirement, not advice. A campsite on
the Parkway sells no fuel and neither does the Parkway, so the plan reserves enough range
at camp to reach the nearest pump. Without it, a tank that "just reaches" camp looks fine
and strands you in the morning.

**There is no safety-percentage reserve.** "Miles on a tank" is already a rider's
conservative real figure, and the exit-fuel rule is a concrete margin rather than a round
number held back. The consequence is that a plan can fit on one tank with very little to
spare, so a thin arrival is stated as the headline — "it fits, but only just, you arrive
with about 3 mi left" — instead of the technically-true "no fuel stop needed".

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

Push to `main`. Vercel serves the repo-root `index.html`, which `build/build_v2.py`
generates from this folder — no build step runs on Vercel, so **the rebuilt `index.html`
has to be committed** alongside any `v2/src/` change. If you edit source and forget to
rebuild, the site will not change.

`v1/index.html` is untouched and still reachable at `/v1/` as a fallback. Nothing in the
build depends on it any more — Leaflet now lives in `v2/vendor/`.
