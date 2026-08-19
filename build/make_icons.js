/* Rasterise app/brand/mark.svg into the PNG sizes a phone home screen needs.
 *
 *   node build/make_icons.js
 *
 * Run this after editing the mark. The SVG is the source; every PNG here is derived, so
 * nothing needs redrawing by hand and the set cannot drift out of step with the artwork.
 *
 * The maskable variant is a different image, not a resize. Android crops icons to whatever
 * shape the launcher wants -- circle, squircle, teardrop -- so a full-bleed icon loses its
 * corners. Maskable art keeps everything meaningful inside the middle 80% and lets the
 * background take the crop.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARK = fs.readFileSync(path.join(ROOT, 'app/brand/mark.svg'), 'utf8');
const OUT = path.join(ROOT, 'icons');
const BG = '#1b2118';

const TARGETS = [
  { file: 'icon-192.png', size: 192, inset: 0 },
  { file: 'icon-512.png', size: 512, inset: 0 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.20 },
  { file: 'apple-touch-icon.png', size: 180, inset: 0.06 },
  { file: 'favicon-32.png', size: 32, inset: 0 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await (await browser.newContext({ deviceScaleFactor: 1 })).newPage();

  for (const t of TARGETS) {
    const pad = Math.round(t.size * t.inset);
    const inner = t.size - pad * 2;
    // A maskable icon must fill its own square with the brand colour: the rounded corners
    // in the artwork would otherwise show through as notches once the launcher crops it.
    const art = t.inset > 0 ? MARK.replace(/rx="14"/, 'rx="0"') : MARK;
    await page.setViewportSize({ width: t.size, height: t.size });
    await page.setContent(
      `<body style="margin:0;width:${t.size}px;height:${t.size}px;background:${BG};` +
      `display:flex;align-items:center;justify-content:center">` +
      `<div style="width:${inner}px;height:${inner}px;line-height:0">${art}</div></body>`);
    await page.screenshot({ path: path.join(OUT, t.file), omitBackground: false });
    console.log(`  ${t.file.padEnd(24)} ${t.size}x${t.size}` +
                (t.inset ? `  (${Math.round(t.inset * 100)}% safe-zone inset)` : ''));
  }
  fs.writeFileSync(path.join(ROOT, 'favicon.svg'), MARK);
  console.log('  favicon.svg              vector, from the same source');
  await browser.close();
})();
