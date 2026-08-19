# v2 — the trip planner

`v2/index.html` is **generated**. Edit the files in `v2/src/`, then rebuild:

```
python3 build/derive.py     # only when data/ changes — rebuilds the data bundle
python3 build/build_v2.py   # inlines src/ + leaflet + data -> v2/index.html
```

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

Not wired up. `v1` is still what deploys, as `index.html` at the repo root. Promoting v2
means copying `v2/index.html` over the root — ask first, it replaces the live site.
