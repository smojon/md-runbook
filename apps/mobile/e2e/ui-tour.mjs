// A tour of the exported web app at phone size (390x844): every screen and sheet, in light and
// dark, as screenshots to look through after a UI change. The app starts with the runbooks and
// hosts in ui-tour-seed.json (a runbook with outputs, coloured logs, a cloud view, a Windows
// host, a proposal; a signed runbook). Also lists any console error or step that failed.
//
//   npm run export:web && npm run ui-tour [-- dist-dir out-dir]
//
// Uses Playwright's Chromium (`npx playwright install chromium`); PW_CHANNEL=msedge (or chrome)
// uses an installed browser instead.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serveDist } from './serve-dist.mjs';

const [dist = 'dist', out = 'ui-tour'] = process.argv.slice(2);
const seed = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./ui-tour-seed.json', import.meta.url)), 'utf8'));
fs.mkdirSync(out, { recursive: true });

const { server, url } = await serveDist(dist);
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const errors = [];

async function tour(scheme) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    isMobile: true,
    hasTouch: true,
  });
  // Seeded once per context: later page loads keep what the tour changed.
  await ctx.addInitScript((s) => {
    if (localStorage.getItem('seeded')) return;
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    localStorage.setItem('seeded', '1');
  }, seed);
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`${scheme}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${scheme}: ${e}`));
  let n = 0;
  const shot = async (name) => {
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `${scheme}-${String(++n).padStart(2, '0')}-${name}.png`) });
  };
  const step = async (name, fn) => {
    try {
      await fn();
      await shot(name);
    } catch (e) {
      errors.push(`${scheme} ${name}: ${String(e).split('\n')[0]}`);
      await shot(`${name}-FAILED`).catch(() => undefined);
    }
  };
  const id = (t) => page.getByTestId(t);
  const home = async () => {
    await page.goto(url);
    await id('open-runbook').waitFor({ timeout: 30_000 });
  };

  await step('home', home);
  await step('open-link', async () => {
    await id('open-link').click();
    await id('open-link-url').waitFor();
  });
  await step('hosts', async () => {
    await home();
    await id('hosts').click();
    await id('host-h1').waitFor();
  });
  await step('hosts-key-secrets', async () => {
    await id('secrets').scrollIntoViewIfNeeded();
  });
  await step('hosts-history-colours', async () => {
    await id('color-settings').scrollIntoViewIfNeeded();
  });
  await step('hosts-signing', async () => {
    await id('signing').scrollIntoViewIfNeeded();
  });
  await step('toggles-closeup', async () => {
    await id('color-settings').screenshot({ path: path.join(out, `${scheme}-toggles.png`), scale: 'device' });
  });
  await step('host-form', async () => {
    await id('host-h1').click();
    await id('host-hostname').waitFor();
  });
  await step('add-host-form', async () => {
    await page.goBack();
    await id('add-host').click();
    await id('host-name').waitFor();
  });
  await step('sample-runbook', async () => {
    await home();
    await id('runbook-sample').click();
    await id('cell-1-output').waitFor({ timeout: 20_000 });
  });
  await step('line-actions', async () => {
    await id('cell-1-line-0').click();
    await id('cell-1-line-0-actions').waitFor();
  });
  await step('tour-top', async () => {
    await home();
    await id('runbook-tour').click();
    await id('params').waitFor({ timeout: 20_000 });
  });
  await step('tour-outputs', async () => {
    await id('cell-3-output').scrollIntoViewIfNeeded();
  });
  await step('tour-bottom', async () => {
    for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 600);
  });
  await step('cell-menu', async () => {
    const ids = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid$="-actions"]')]
        .map((e) => e.getAttribute('data-testid'))
        .filter((t) => /^cell-\d+-actions$/.test(t)),
    );
    await id(ids[ids.length - 1]).click();
  });
  await step('approve-card', async () => {
    await page
      .getByText(/^Approve/)
      .first()
      .click();
    await id('approve-card').waitFor({ timeout: 5000 });
    await id('approve-card').scrollIntoViewIfNeeded();
  });
  await step('more-sheet', async () => {
    await page.keyboard.press('Escape');
    await page.goto(page.url());
    await id('more-actions').waitFor({ timeout: 20_000 });
    await id('more-actions').click();
  });
  await step('sign-card', async () => {
    await id('action-signRunbook').click();
    await id('sign-card').waitFor({ timeout: 5000 });
  });
  // Opened by its URL (no history): the back arrow must still be there.
  await step('host-chips-windows', async () => {
    await page.goto(page.url());
    await id('host-chip-h2').waitFor({ timeout: 20_000 });
    await id('host-chip-h2').click();
  });
  await step('signed', async () => {
    await home();
    await id('runbook-signed').click();
    await id('signed-banner').waitFor({ timeout: 20_000 });
  });
  await step('open-link-error', async () => {
    await page.goto(`${url}open?url=${encodeURIComponent('http://not-https.example/x.md')}`);
    await id('open-link-state').waitFor({ timeout: 20_000 });
  });
  await ctx.close();
}

try {
  await tour('light');
  await tour('dark');
} finally {
  await browser.close();
  server.close();
}
console.log(`Screenshots in ${path.resolve(out)}; ${errors.length} problem(s)`);
for (const e of errors) console.log(' ', e);
process.exitCode = errors.length ? 1 : 0;
