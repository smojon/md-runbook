// The app's icons from the extension's (images/icon.svg, the one source): the iOS and store icon
// (square, the system rounds it), Android's adaptive layers (background, foreground and
// monochrome, the glyph inside the launcher's safe zone) and the web favicon. Run after a change
// to icon.svg and commit the PNGs:
//
//   node e2e/make-icons.mjs
//
// Uses Playwright's Chromium (`npx playwright install chromium`), as the UI tour does;
// PW_CHANNEL=msedge (or chrome) uses an installed browser instead.
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const source = fs.readFileSync(fileURLToPath(new URL('../../../images/icon.svg', import.meta.url)), 'utf8');
const defs = source.match(/<defs>[\s\S]*?<\/defs>/)[0];
// The play bullets and the step lines: everything drawn on top of the rounded background.
const glyph = source
  .slice(source.indexOf('<rect'))
  .replace(/^<rect[^>]*\/>/, '')
  .replace(/<\/svg>\s*$/, '');
const background = '<rect width="256" height="256" fill="url(#bg)"/>';
// Android masks the foreground to a circle or squircle of 72 of its 108 dp, and only the middle
// 66 dp are sure to show: scale the glyph (centre 129,128) so its corners stay inside.
const safe = (g) => `<g transform="translate(128 128) scale(0.65) translate(-129 -128)">${g}</g>`;
const white = (g) => g.replace(/#[0-9a-fA-F]{6}/g, '#ffffff');

const icons = {
  'icon.png': [1024, defs + background + glyph],
  'android-icon-background.png': [512, defs + background],
  'android-icon-foreground.png': [512, safe(glyph)],
  'android-icon-monochrome.png': [432, safe(white(glyph))],
  'favicon.png': [48, source.replace(/^[\s\S]*?<defs>/, '<defs>').replace(/<\/svg>\s*$/, '')],
};

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const page = await browser.newPage();
for (const [name, [size, body]] of Object.entries(icons)) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">` +
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="${size}" height="${size}" style="display:block">${body}</svg>` +
      `</body></html>`,
  );
  const out = fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`${name} ${size}x${size}`);
}
await browser.close();
