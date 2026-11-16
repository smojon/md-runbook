// The exported web app in a real browser: serve dist/ and check the same things as the Maestro
// flow (the core works in the browser bundle, the sample runbook opens). Also fails on any
// console error.
//
//   node e2e/web-smoke.mjs [dist-dir]
import { Buffer } from 'node:buffer';
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

  // Edit as Text: a textarea over the highlighted text. The two must line up: same line breaks
  // (a long line wraps), same height, same scrolling. Typing, the browser's undo.
  await page.goto(url);
  await page.getByTestId('runbook-sample').click();
  await page.getByTestId('more-actions').filter({ visible: true }).first().click();
  await page.getByTestId('action-editAsText').click();
  const area = page.getByTestId('editor-text-input');
  await area.waitFor({ timeout: 10_000 });
  const before = await area.inputValue();
  await area.click();
  await page.keyboard.press('Control+End');
  const long = '\n**Bold** and `code` ' + 'a-very-long-word '.repeat(40) + 'x'.repeat(300) + '\n';
  await page.keyboard.insertText(long);
  await page.getByTestId('editor-state').filter({ hasText: 'Unsaved changes' }).waitFor({ timeout: 5_000 });
  const fit = await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="editor-text-input"]');
    const pre = ta.parentElement.querySelector('pre');
    const last = pre.lastElementChild;
    const padBottom = parseFloat(getComputedStyle(ta).paddingBottom);
    ta.scrollTop = ta.scrollHeight;
    ta.dispatchEvent(new Event('scroll'));
    return {
      drawn: last.offsetTop + last.offsetHeight + padBottom,
      field: ta.scrollHeight,
      lines: pre.children.length,
      scroll: [ta.scrollTop, pre.scrollTop],
      color: getComputedStyle(ta).color,
    };
  });
  if (Math.abs(fit.drawn - fit.field) > 1) throw new Error(`editor: the drawing is ${fit.drawn}px high, the textarea ${fit.field}px`);
  if (fit.scroll[0] !== fit.scroll[1]) throw new Error(`editor: scrolled ${fit.scroll[0]}px, the drawing ${fit.scroll[1]}px`);
  if (fit.color !== 'rgba(0, 0, 0, 0)') throw new Error(`editor: the textarea's letters show (${fit.color})`);
  await page.screenshot({ path: 'web-05-editor.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'web-06-editor-dark.png' });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.keyboard.press('Control+Z');
  if ((await area.inputValue()) !== before) throw new Error("editor: the browser's undo didn't take the typing back");
  console.log(`web: Edit as Text highlights ${fit.lines} lines in line with the textarea; undo works`);

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
