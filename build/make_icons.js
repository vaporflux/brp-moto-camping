/* Rasterise the brand SVGs into the PNG sizes a phone home screen and a link card need.
 *
 *   node build/make_icons.js
 *
 * The SVGs in app/brand/ are the source, produced by app/brand/gen.py. Every PNG here is
 * derived from one of them, so nothing is redrawn by hand and the set cannot drift out of
 * step with the artwork. Re-run this after any gen.py change.
 *
 * Maskable variants are separate SOURCES, not resizes: gen.py draws the mark smaller
 * inside the square so it survives Android cropping the icon to a circle, squircle or
 * teardrop. Do not generate them by padding a normal icon.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BRAND = path.join(ROOT, 'app', 'brand');
const OUT = path.join(ROOT, 'icons');

// [source svg, output png, width, height]
const TARGETS = [
  ['favicon.svg', 'favicon-16.png', 16, 16],
  ['favicon.svg', 'favicon-32.png', 32, 32],
  ['favicon.svg', 'favicon-48.png', 48, 48],
  ['apple-touch-icon.svg', 'apple-touch-icon.png', 180, 180],
  ['icon-192.svg', 'icon-192.png', 192, 192],
  ['icon-512.svg', 'icon-512.png', 512, 512],
  ['icon-192-maskable.svg', 'icon-192-maskable.png', 192, 192],
  ['icon-512-maskable.svg', 'icon-512-maskable.png', 512, 512],
  ['og-image.svg', 'og-image.png', 1200, 630],
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();

  for (const [src, out, w, h] of TARGETS) {
    const file = path.join(BRAND, src);
    if (!fs.existsSync(file)) { console.log(`  SKIP ${out.padEnd(24)} (${src} not present)`); continue; }
    const svg = fs.readFileSync(file, 'utf8');
    await page.setViewportSize({ width: w, height: h });
    // No page background: apple-touch-icon and the tiles carry their own opaque square,
    // and anything that does not is meant to be transparent.
    await page.setContent(
      `<body style="margin:0;width:${w}px;height:${h}px;line-height:0">${svg}</body>`);
    await page.evaluate(([w, h]) => {
      const s = document.querySelector('svg');
      s.setAttribute('width', w); s.setAttribute('height', h);
    }, [w, h]);
    await page.screenshot({ path: path.join(OUT, out), omitBackground: true });
    console.log(`  ${out.padEnd(24)} ${w}x${h}  from ${src}`);
  }
  await browser.close();
})();
