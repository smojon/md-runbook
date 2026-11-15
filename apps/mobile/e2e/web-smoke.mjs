// The exported web app in a real browser: serve dist/ and check the same things as the Maestro
// flow (the core works in the browser bundle, the sample runbook opens). Also fails on any
// console error.
//
//   node e2e/web-smoke.mjs [dist-dir]
import { deflateRawSync } from 'node:zlib';
import { chromium } from 'playwright';
import { serveDist } from './serve-dist.mjs';

const { server, url } = await serveDist(process.argv[2] ?? 'dist');

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
let failed = false;
try {
  await page.goto(url);
  await page.getByTestId('open-runbook').waitFor({ timeout: 30_000 });
  if (await page.getByTestId('core-error').count()) throw new Error(await page.getByTestId('core-error').innerText());
  await page.screenshot({ path: 'web-01-runbooks.png' });
  await page.getByTestId('runbook-sample').click();
  await page.getByTestId('cell-1-output').waitFor({ timeout: 30_000 });
  // Markdown cells are rendered (no "# " source), the icon font is in, code lines are tappable.
  await page.getByRole('heading', { name: 'Service' }).waitFor({ timeout: 10_000 });
  if ((await page.getByText('## Service').count()) > 0) throw new Error('Markdown shown as source');
  await page.waitForFunction(() => document.fonts.check('16px codicon'), null, { timeout: 15_000 });
  await page.getByTestId('task-0').click();
  await page.locator('[data-testid="task-0"][aria-checked="true"]').waitFor({ timeout: 5_000 });
  await page.getByTestId('cell-1-line-1').click();
  await page.getByTestId('cell-1-line-1-actions').waitFor({ timeout: 5_000 });
  await page.screenshot({ path: 'web-02-runbook.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'web-03-runbook-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  console.log('web: core OK, sample runbook opens, Markdown rendered, task box and line actions work');

  // Open a file, change it, save it back, reload: the runbook is remembered and still linked.
  // The browser's file picker can't be driven, so the page gets one that hands out a real file
  // handle from the origin-private file system (same API as a file the user picks).
  await page.addInitScript(() => {
    window.showOpenFilePicker = async () => {
      const root = await navigator.storage.getDirectory();
      return [await root.getFileHandle('deploy.md', { create: true })];
    };
  });
  await page.goto(url);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const w = await (await root.getFileHandle('deploy.md', { create: true })).createWritable();
    await w.write('# Deploy test\n\n- [ ] Ticked in the browser\n\n```bash\necho hi\n```\n');
    await w.close();
  });
  await page.getByTestId('open-runbook').click();
  // The list screen stays mounted (hidden) behind the runbook: wait for the visible title.
  await page.getByText('Deploy test').filter({ visible: true }).first().waitFor({ timeout: 10_000 });
  await page
    .getByTestId('save-state')
    .filter({ hasText: /^Saved$/ })
    .waitFor({ timeout: 10_000 });
  await page.getByTestId('task-0').click();
  await page.getByTestId('save-state').filter({ hasText: 'Not saved to the file' }).waitFor({ timeout: 5_000 });
  await page.getByTestId('save-runbook').click();
  await page
    .getByTestId('save-state')
    .filter({ hasText: /^Saved$/ })
    .waitFor({ timeout: 10_000 });
  const saved = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    return (await (await root.getFileHandle('deploy.md')).getFile()).text();
  });
  if (!saved.includes('- [x] Ticked in the browser')) throw new Error(`not saved to the file: ${JSON.stringify(saved)}`);
  await page.goto(url);
  await page.getByRole('link', { name: 'Deploy test' }).click();
  await page
    .getByTestId('save-state')
    .filter({ hasText: /^Saved$/ })
    .waitFor({ timeout: 10_000 });
  await page.locator('[data-testid="task-0"][aria-checked="true"]').waitFor({ timeout: 5_000 });
  await page.screenshot({ path: 'web-04-saved.png' });
  console.log('web: a runbook file opens, saves back to the file, and is remembered after a reload');

  // QR codes in the browser bundle (0.24.0: the bundle took qrcode-generator's ES module and
  // every code threw "n is not a function").
  await page.goto(url);
  await page.getByTestId('runbook-sample').click();
  await page.getByTestId('more-actions').filter({ visible: true }).first().click();
  await page.getByTestId('action-showQrCode').click();
  await page.getByTestId('qr-code').waitFor({ timeout: 10_000 });
  console.log('web: a runbook QR code is drawn');

  // A pairing link carries the relay token in its fragment: the pair screen asks first, and the
  // fragment leaves the address bar (and so the history) as the page loads, and stays gone.
  const pairing = JSON.stringify({ format: 'md-runbook pair v1', relay: 'wss://relay.example.net', token: 't'.repeat(32) });
  const payload = 'mdrb-pair.v1.' + deflateRawSync(Buffer.from(pairing), { level: 9 }).toString('base64url');
  await page.goto(new URL('/pair#' + payload, url).href);
  await page.getByTestId('pair-ask').waitFor({ timeout: 30_000 });
  const leftover = async (when) => {
    const href = await page.evaluate(() => window.location.href);
    if (href.includes('mdrb-pair')) throw new Error(`pairing fragment still in the address bar ${when}: ${href}`);
  };
  await leftover('after load');
  await page.waitForTimeout(2_000);
  await leftover('2 s after load');
  await page.getByTestId('pair-not-now').click();
  await page.waitForTimeout(500);
  await leftover('after Not now');
  console.log('web: a pairing link asks first, and its token leaves the address bar');
} catch (e) {
  failed = true;
  console.error(e);
  await page.screenshot({ path: 'web-failure.png' }).catch(() => undefined);
}
if (errors.length) {
  failed = true;
  console.error('console errors:\n' + errors.join('\n'));
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
