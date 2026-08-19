/* BRP Moto Camping — map pin system.
   Shape = what a place is.  Fill = how much to trust it.  Star = top pick.
   Drop-in for Leaflet: L.marker(latlng, { icon: pinIcon('camp', {top:true}) })
*/
const PIN_INK   = "#16344a";  // glyph
const PIN_NIGHT = "#0e1a22";  // ring / slash
const FILL = {
  verified: "#f2efe6",  // cream  — we researched and confirmed it
  listed:   "#93a8b4",  // slate  — listed somewhere, not verified  (always dashed)
  avoid:    "#e0623a",  // clay   — do not rely on it / unreachable
};
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
  warn: `<path d="M12 3.8 L21.6 20.2 H2.4 Z"/><path d="M12 9.6 V14.6"/>`
      + `<circle cx="12" cy="17.5" r="1.15"/>`,
};

/** Build the raw SVG string for a pin.
 *  kind:  'camp' | 'moto' | 'hotel' | 'fuel' | 'warn'
 *  opts:  { trust:'verified'|'listed'|'avoid', top:bool, struck:bool, size:number }
 */
export function pinSvg(kind, opts = {}) {
  const { trust = "verified", top = false, struck = false, size = 30 } = opts;
  const fill = FILL[trust] || FILL.verified;
  const dash = trust === "listed" ? ` stroke-dasharray="4.4 3.4"` : ``;
  const ring = `<circle cx="18" cy="18" r="15.9" fill="${fill}" stroke="${PIN_NIGHT}" stroke-width="2.2"${dash}/>`;
  const slash = struck
    ? `<path d="M7.6 28.4 L28.4 7.6" stroke="${PIN_NIGHT}" stroke-width="3.4" stroke-linecap="round"/>` : ``;
  const star = top
    ? `<g transform="translate(23.6,-1.2)"><circle cx="7" cy="7" r="8.2" fill="${PIN_NIGHT}"/>`
    + `<path d="M7 2.4 L8.42 5.5 L11.8 5.9 L9.3 8.2 L9.98 11.55 L7 9.88 L4.02 11.55 L4.7 8.2 L2.2 5.9 L5.58 5.5 Z"`
    + ` fill="#f0b44a"/></g>` : ``;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -3 42 42" width="${size}" height="${size}">`
    + ring
    + `<g transform="translate(6,6)" fill="none" stroke="${PIN_INK}" stroke-width="1.9" `
    + `stroke-linecap="round" stroke-linejoin="round">${GLYPH[kind]}</g>${slash}${star}</svg>`;
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

/* Selected state: don't change the colour (colour is already carrying trust).
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
 * Usage:  document.querySelector('#map-key').innerHTML = legendHtml();
 * ------------------------------------------------------------------ */
const LEGEND = [
  { head: "WHAT THE SHAPE MEANS" },
  { pin: ["camp"],                        label: "Campground",              note: "tent" },
  { pin: ["moto"],                        label: "Motorcycle camp",         note: "two wheels" },
  { pin: ["hotel"],                       label: "Hotel or motel",          note: "a bed" },
  { pin: ["fuel"],                        label: "Fuel",                    note: "a pump" },

  { head: "WHAT THE COLOUR MEANS" },
  { pin: ["fuel"],                              label: "Cream — researched",        note: "we verified this one" },
  { pin: ["fuel", {trust:"listed"}],            label: "Grey, dashed — listed only",note: "not verified, don’t count on it" },
  { pin: ["fuel", {trust:"avoid"}],             label: "Red — do not rely on it",   note: "reported gone or unreliable" },
  { pin: ["fuel", {trust:"avoid",struck:true}], label: "Red, struck through",       note: "unreachable in 2026" },
  { pin: ["camp", {top:true}],                  label: "Gold star",                 note: "a top pick — works on any shape" },

  { head: "LINES" },
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

export function legendHtml() {
  return LEGEND.map(r => {
    if (r.head) return `<div class="key-head">${r.head}</div>`;
    const icon = r.pin ? pinSvg(r.pin[0], { size: 26, ...(r.pin[1] || {}) }) : swatchLine(r.line);
    return `<div class="key-row"><div class="key-icon">${icon}</div>`
         + `<div class="key-label">${r.label}</div>`
         + `<div class="key-note">${r.note}</div></div>`;
  }).join("");
}

export const LEGEND_FOOTER =
  "Shape tells you what a place is. Colour tells you how much to trust it. " +
  "Tap any marker to see the detail; nothing joins your trip until you say so.";
