/* BRP Moto Camping — map pin system.
   Shape = what a place is.  Colour = what a place is, again.  Ring = how much to trust it.
   Drop-in for Leaflet: L.marker(latlng, { icon: pinIcon('camp', {top:true}) })

   The original of this file made colour mean trust and nothing else, on the argument that
   a colour-per-category is what made the old key unreadable. That argument was about a map
   where colour was the ONLY channel: amber meant "top pick" under one heading and
   "unconfirmed" under another, and a rider with red-green deficiency had nothing else to
   go on. Shape carries category now, so colour on top of it is reinforcement rather than
   the sole signal, and a map of identical cream discs is genuinely harder to scan than a
   map where campgrounds are green and hotels are blue.

   Trust keeps its own channel, and it is deliberately not a hue: a solid ring means
   somebody checked this place for this planner, a dashed ring means it is listed
   somewhere and nobody has been. That survives greyscale and colour blindness both.
*/
const PIN_NIGHT = "#0e1a22";  // ring, and the ink on light fills
const PIN_CREAM = "#f2efe6";  // the ink on dark fills

/* Category is the fill. Fuel is the one category that changes colour with trust, because
   it is the one where being wrong strands somebody: a pump nobody has ridden to goes grey
   rather than wearing the same green as a verified one. Lodging keeps its colour when
   unverified -- 446 of 478 places came from OSM and Google, so greying those would leave a
   map that is grey almost everywhere and would make "blue means hotel" a lie. */
const CATEGORY = {
  camp:  { fill: "#2e7d4f", label: "Campground",      note: "tent" },
  moto:  { fill: "#e8833a", label: "Motorcycle camp", note: "two wheels" },
  hotel: { fill: "#5aa9e6", label: "Hotel or motel",  note: "a bed" },
  fuel:  { fill: "#35d07f", label: "Fuel",            note: "a pump" },
};
const UNVERIFIED = "#93a8b4";   // slate: listed, not visited

/* Ink that will actually read on the fill it sits on, rather than a colour chosen once and
   hoped for. Dark green needs cream strokes; the lighter fills need the night blue. */
function ink(fill) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(fill.substr(i, 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 130 ? PIN_CREAM : PIN_NIGHT;
}

/* Hand-drawn on a 24x24 grid at 1.9px. If you need a new category, draw it on that grid at
   that weight -- an icon-font glyph will have a different stroke weight and it will show. */
const GLYPH = {
  camp: `<path d="M12 4.2 L21.2 19.4 H2.8 Z"/><path d="M12 11.6 L16.2 19.4 H7.8 Z"/>`,
  moto: `<circle cx="5.1" cy="16.4" r="3.3"/><circle cx="18.9" cy="16.4" r="3.3"/>`
      + `<path d="M5.1 16.4 L9.2 10.2 H14.4 L18.9 16.4"/><path d="M8.4 10.2 H6.1"/>`
      + `<path d="M13.2 10.2 H17.6"/>`,
  hotel:`<path d="M3 18.6 V8.4"/><path d="M3 13.4 H14.6 a4.2 4.2 0 0 1 4.2 4.2 V18.6"/>`
      + `<path d="M21 18.6 V15.2"/><circle cx="7.4" cy="10.8" r="1.9"/>`,
  fuel: `<path d="M4.2 20.4 V5.4 a1.8 1.8 0 0 1 1.8-1.8 H12 a1.8 1.8 0 0 1 1.8 1.8 V20.4"/>`
      + `<path d="M2.8 20.4 H15.2"/><path d="M6.6 7.2 H11.4 V10.6 H6.6 Z"/>`
      + `<path d="M13.8 9.6 H17.4 a1.6 1.6 0 0 1 1.6 1.6 V16.6 a1.5 1.5 0 0 0 3 0 V10.4 L19.4 7.8"/>`,
};

/** Build the raw SVG string for a pin.
 *  kind:  'camp' | 'moto' | 'hotel' | 'fuel'
 *  opts:  { trust:'verified'|'listed', top:bool, size:number }
 */
export function pinSvg(kind, opts = {}) {
  const { trust = "verified", top = false, size = 30 } = opts;
  const cat = CATEGORY[kind] || CATEGORY.camp;
  const fill = (kind === "fuel" && trust === "listed") ? UNVERIFIED : cat.fill;
  const dash = trust === "listed" ? ` stroke-dasharray="4.4 3.4"` : ``;
  const ring = `<circle cx="18" cy="18" r="15.9" fill="${fill}" stroke="${PIN_NIGHT}" stroke-width="2.2"${dash}/>`;
  const star = top
    ? `<g transform="translate(23.6,-1.2)"><circle cx="7" cy="7" r="8.2" fill="${PIN_NIGHT}"/>`
    + `<path d="M7 2.4 L8.42 5.5 L11.8 5.9 L9.3 8.2 L9.98 11.55 L7 9.88 L4.02 11.55 L4.7 8.2 L2.2 5.9 L5.58 5.5 Z"`
    + ` fill="#f0b44a"/></g>` : ``;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 42 42" width="${size}" height="${size}">`
    + ring
    + `<g transform="translate(6,6)" fill="none" stroke="${ink(fill)}" stroke-width="1.9" `
    + `stroke-linecap="round" stroke-linejoin="round">${GLYPH[kind]}</g>${star}</svg>`;
}

/** Leaflet divIcon wrapper. Anchor is the ring centre, not the star. */
export function pinIcon(kind, opts = {}) {
  const size = opts.size || 30;
  return L.divIcon({
    className: "brp-pin",
    html: pinSvg(kind, opts),
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor:[0, -size / 2],
  });
}

/* Selected state: don't change the colour (colour is already carrying category).
   Scale up and add a halo instead:
     .brp-pin.is-selected svg { transform: scale(1.28); filter: drop-shadow(0 0 6px #f0b44a); }
*/

export const LINE = {
  parkwayOpen:   { color: "#7fd3f5", weight: 3.4 },
  parkwayClosed: { color: "#e0623a", weight: 4.4, dashArray: "7,6" },
  yourRoute:     { color: "#e86ec4", weight: 4.6 },   // magenta, Garmin convention
  roadLeg:       { color: "#6fc08a", weight: 3.2 },
  estimate:      { color: "#8ea3ae", weight: 2.6, dashArray: "5,6" },
};

/* ------------------------------------------------------------------ *
 * Legend, generated from the SAME pinSvg() the markers use, so the key
 * can never drift out of sync with what's actually on the map.
 * The four category rows are switches: legendHtml() is given the set
 * that is currently shown, and marks the rest off.
 * ------------------------------------------------------------------ */
export const SHAPES = ["camp", "moto", "hotel", "fuel"];

const TRUST_ROWS = [
  { pin: ["camp"],                    label: "Solid ring — researched",
    note: "checked for this planner" },
  { pin: ["hotel", { trust: "listed" }], label: "Dashed ring — listed only",
    note: "nobody has been, don’t count on it" },
  { pin: ["fuel", { trust: "listed" }],  label: "Grey pump — unverified",
    note: "a fuel listing nobody has ridden to" },
  { pin: ["camp", { top: true }],      label: "Gold star — top pick",
    note: "works on any shape" },
];

const LINE_ROWS = [
  { line: LINE.parkwayOpen,   label: "Parkway open",           note: "rideable in 2026" },
  { line: LINE.parkwayClosed, label: "Parkway closed",         note: "Helene damage, roadworks" },
  { line: LINE.yourRoute,     label: "Your route",             note: "the ride as planned" },
  { line: LINE.roadLeg,       label: "Road legs",              note: "to camp, to fuel, home" },
  { line: LINE.estimate,      label: "Straight-line estimate", note: "no road route came back" },
];

function swatchLine(s) {
  const d = s.dashArray ? ` stroke-dasharray="${s.dashArray.replace(',', ' ')}"` : "";
  return `<svg width="30" height="12" viewBox="0 0 30 12" aria-hidden="true">`
       + `<path d="M2 6 H28" stroke="${s.color}" stroke-width="${Math.max(3, s.weight)}" `
       + `stroke-linecap="round"${d}/></svg>`;
}

/* One row. `cls` is folded into the single class attribute rather than appended as a
   second one -- a tag with two class attributes keeps the first and silently drops the
   rest, so an "off" row went on looking exactly like an "on" one. */
function row(icon, label, note, { cls = "", attrs = "" } = {}) {
  return `<div class="key-row${cls ? " " + cls : ""}"${attrs}>`
       + `<div class="key-icon">${icon}</div>`
       + `<div class="key-label">${label}</div>`
       + `<div class="key-note">${note}</div></div>`;
}

/** show: { camp:bool, moto:bool, hotel:bool, fuel:bool } -- which shapes are on the map. */
export function legendHtml(show = {}) {
  let html = `<div class="key-head">SHOW ON THE MAP</div>`;
  SHAPES.forEach(k => {
    const on = show[k] !== false;
    html += row(pinSvg(k, { size: 26 }), CATEGORY[k].label, CATEGORY[k].note, {
      cls: on ? "" : "off",
      attrs: ` data-shape="${k}" role="switch" tabindex="0" aria-checked="${on}"`
    });
  });
  html += `<div class="key-head">HOW MUCH TO TRUST IT</div>`;
  TRUST_ROWS.forEach(r => html += row(pinSvg(r.pin[0], { size: 26, ...(r.pin[1] || {}) }),
                                      r.label, r.note));
  html += `<div class="key-head">LINES</div>`;
  LINE_ROWS.forEach(r => html += row(swatchLine(r.line), r.label, r.note));
  return html;
}

export const LEGEND_FOOTER =
  "Tap a row above to hide or show that kind of marker. Fuel stops that are gone, " +
  "unreliable or cut off by a closure are never drawn — they are still listed under " +
  "Browse, so you can see why.";
