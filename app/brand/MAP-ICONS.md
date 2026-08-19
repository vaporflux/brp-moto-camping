# Map marker system — spec for Claude Code

Replaces the current colored-dot markers and the map key. Ships with `map-pins.js`
(drop-in) and `pin-*.svg` (static assets, if you'd rather reference files).

---

## 1. What's wrong with the current markers

The current key encodes **two independent variables in one channel**. What a place *is*
and how much we trust it are both expressed as dot color, so the same color means
different things depending on which section of the key you're reading:

| Color | Means this under "Places to stay" | …and this under "Fuel" |
|---|---|---|
| Amber | **Top pick** — the best options | **Unconfirmed** — don't count on it |
| Clay red | **Motorcycle camp** — a highlight | **Do not rely on it** |
| Light blue | **Hotel or motel** | **Researched** — verified |
| Grey | — | **Google listed** *and* **unreachable in 2026** (two near-identical greys) |

Amber meaning "best" in one place and "sketchy" in another is the worst case: the same
signal carries opposite instructions. Amber is *also* "Your route" in the lines section,
so it does three jobs.

There's a fourth variable hidden in there too — the note "a bigger dot is a place
researched for this planner" makes **size** a silent encoder that nothing in the key
visually demonstrates.

One more reason to fix it with shape: roughly 8% of men have some red-green color
deficiency. For a group riding together, the odds that nobody can separate the amber,
clay, and green dots are not good. Glyphs solve that outright.

---

## 2. The rule

> **Shape says what it is. Fill says how much to trust it. A gold star says top pick.**

Three channels, three variables, no overlap. Every marker is a circle of fixed size —
only the glyph inside and the fill change.

### Shape → category

| Glyph | Category | `kind` |
|---|---|---|
| Tent | Campground | `camp` |
| Two wheels | Motorcycle-only camp | `moto` |
| Bed | Hotel or motel | `hotel` |
| Fuel pump | Fuel stop | `fuel` |
| Warning triangle | Closure / hazard | `warn` |

### Fill → trust, and it means the same thing on every shape

| Fill | Hex | Ring | Meaning | `trust` |
|---|---|---|---|---|
| Cream | `#f2efe6` | solid | Researched and confirmed for this planner | `verified` |
| Slate | `#93a8b4` | **dashed** | Listed somewhere, not verified — don't count on it | `listed` |
| Clay | `#e0623a` | solid | Do not rely on it | `avoid` |
| Clay + diagonal strike | `#e0623a` | solid | Unreachable in 2026 | `avoid` + `struck:true` |

The dashed ring on `listed` is deliberate redundancy — it survives greyscale printing and
color-blind vision, so "unverified" never depends on hue alone.

### Star → top pick

A gold star badge in the upper-right, on a dark disc so it reads against any fill. It is a
**modifier, not a category** — a top pick is still a campground, so it keeps its tent. This
also removes the old contradiction where a place could be both "Top pick" and "Motorcycle
camp" but only got one dot.

---

## 3. Line colors — one change required

Markers and lines must not share hues. Only one line needs to move:

| Line | Old | New | Why |
|---|---|---|---|
| Your route | `#e0a33e` amber | **`#e86ec4` magenta** | Amber now belongs to the top-pick star. Magenta is also what Garmin paints an active route, so it'll match his GPS. |
| Parkway open | `#7fd3f5` | unchanged | |
| Parkway closed | `#e0623a` dashed | unchanged | Shares clay with "avoid" markers, which is fine — a dashed *line* and a filled *circle* are never confusable, and both mean "no." |
| Road legs | `#6fc08a` | unchanged | Green is now used by nothing else. |
| Straight-line estimate | `#8ea3ae` dashed | unchanged | |

---

## 4. Implementation

`map-pins.js` exports `pinSvg(kind, opts)`, `pinIcon(kind, opts)` (a Leaflet `divIcon`
wrapper), and a `LINE` object with the polyline styles above.

```js
import { pinIcon, LINE } from './map-pins.js';

L.marker([c.lat, c.lon], { icon: pinIcon('camp',  { top: c.tier === 'top' }) })
L.marker([f.lat, f.lon], { icon: pinIcon('fuel',  { trust: 'listed' }) })
L.marker([f.lat, f.lon], { icon: pinIcon('fuel',  { trust: 'avoid', struck: true }) })
L.polyline(coords, LINE.yourRoute)
```

Map the existing data straight across:

- `campgrounds.json` → `kind: c.moto ? 'moto' : 'camp'`, `top: c.tier === 'top'`
- `fuel.json` → `kind: 'fuel'`, and `confidence` maps to `trust`:
  `verified` → `verified`, `likely` → `listed`, `unverified` → `listed`,
  and anything with a `closure_note` marking it unreachable → `avoid` + `struck: true`

### Sizing

Default 30px, anchored at the ring center (the star overhangs the box — do **not**
anchor to the bounding box or pins will sit low). Tested legible from 40px down to 20px;
below 20px the glyphs mush, so if you cluster at low zoom, drop to plain dots with a
count rather than shrinking these.

### Selected state

Do **not** recolor on selection — fill already carries trust, and changing it would lie.
Scale up and add a glow:

```css
.brp-pin.is-selected svg { transform: scale(1.28); filter: drop-shadow(0 0 6px #f0b44a); }
```

### Remove

Delete the size-as-meaning behavior ("a bigger dot is a place researched"). That
information now lives in the cream fill, which the key actually explains.

---

## 5. Legend copy

Use these exact groupings — the headers are doing the teaching:

**WHAT THE SHAPE MEANS**
- Campground — *tent*
- Motorcycle camp — *two wheels*
- Hotel or motel — *a bed*
- Fuel — *a pump*

**WHAT THE COLOR MEANS**
- Cream — researched — *we verified this one*
- Grey, dashed — listed only — *not verified, don't count on it*
- Red — do not rely on it — *reported gone or unreliable*
- Red, struck through — *unreachable in 2026*
- Gold star — *a top pick, works on any shape*

**LINES**
- Parkway open — *rideable in 2026*
- Parkway closed — *Helene damage, roadworks*
- Your route — *the ride as planned*
- Road legs — *to camp, to fuel, home*
- Straight-line estimate — *no road route came back*

Footer: *Shape tells you what a place is. Color tells you how much to trust it. Tap any
marker to see the detail; nothing joins your trip until you say so.*

---

## 6. Files

| File | Use |
|---|---|
| `map-pins.js` | Drop-in module. Preferred — pins are generated, not stored. |
| `pin-*.svg` | Static SVGs of every state, if you'd rather reference files |
| `newkey.png` | Rendered mockup of the redesigned key panel |
| `glyph-test.png` | Every pin at 40 / 30 / 24 / 20 / 16 px, for checking legibility |

Glyphs are hand-authored on a 24×24 grid with 1.9px strokes. If you need a new category,
draw it on that grid at that weight — don't drop in an icon-font glyph, the weights won't
match and it'll show.

---

## Amendment — colour, switches, and unusable fuel

Three changes made after riding the map, which supersede parts of the spec above. The
reasoning behind each, so the original argument is not just overwritten:

**1. Category is shape *and* colour.** §2 and Step 8 said category must be shape alone,
because colour-per-category was the bug. That argument was about a map where colour was
the *only* channel — amber meaning "top pick" under one heading and "unconfirmed" under
another, with nothing else to fall back on. Shape carries category now, so colour on top
is reinforcement, not the sole signal, and a whole Parkway of identical cream discs turned
out to be genuinely harder to scan than one where campgrounds are green and hotels blue.

| Category | Fill |
|---|---|
| Campground | `#2e7d4f` dark green |
| Motorcycle camp | `#e8833a` orange |
| Hotel or motel | `#5aa9e6` blue |
| Fuel, researched | `#35d07f` bright green |
| Fuel, listed only | `#93a8b4` slate |

Trust keeps a channel of its own and it is still not a hue: **solid ring = researched,
dashed ring = listed only**. That survives greyscale and colour blindness, which is what
§2's dashed ring was for. Glyph ink is picked from the fill's luminance rather than fixed,
so a dark green pin gets cream strokes and a light one gets night blue.

Fuel is the one category whose colour moves with trust, because it is the one where being
wrong strands somebody. Lodging keeps its colour when unverified — 446 of 478 places came
from OSM and Google, so greying those would leave a map that is grey nearly everywhere and
make "blue means hotel" a lie.

**2. The four category rows are switches.** With 761 markers on one road, a key that only
explains is half a control panel. Tapping a row hides or shows that shape; the choice is
remembered. This is why the first heading is now "SHOW ON THE MAP" rather than "WHAT THE
SHAPE MEANS".

**3. Unusable fuel is not drawn at all.** The `avoid` fill and the diagonal strike are
gone, and with them the two rows that explained them. A marker whose entire content is
"not this one" is not worth a glance at 60mph. The two on this map — MP 248.1 Laurel
Springs, on every official fuel list with nothing verifiable behind it, and MP 344.1
NC 80, inside the severed MP 333.9–355.3 section — are still in the Browse list with the
reason, and were already excluded from route planning.

Everything else in the spec still holds: no icon fonts, no extra trust levels, no
recolouring on selection, and the legend and the markers still come out of one function.
`build/test_markers.py` enforces the lot, including the greyscale check.
