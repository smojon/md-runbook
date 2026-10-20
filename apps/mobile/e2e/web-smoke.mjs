// The exported web app in a real browser: serve dist/ and check the same things as the Maestro
// flow (the core works in the browser bundle, the sample runbook opens). Also fails on any
// console error.
//
//   node e2e/web-smoke.mjs [dist-dir]
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
  await page.getByTestId('core-status').filter({ hasText: 'Core OK' }).waitFor({ timeout: 30_000 });
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
  console.log('web: core OK, sample runbook opens, Markdown rendered, task box and line actions work');
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
