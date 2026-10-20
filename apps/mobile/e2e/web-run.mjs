// A cell runs from the web app in a real browser, through the relay (apps/relay), on the runner's
// OpenSSH server: the app's key is made in the browser and authorized on the server, the relay
// address and token are set, a host is added, its key trusted on first contact, then a whole
// cell and one line of it run. Fails on any console error.
//
//   node e2e/web-run.mjs <dist-dir>
// Environment: RELAY_URL, RELAY_TOKEN (the relay's), WEB_PORT (the relay's RELAY_ORIGINS must
// list http://127.0.0.1:<WEB_PORT>), SSH_USER, MD_RUNBOOK_SSH_AUTHORIZED_KEYS (from
// e2e/start-ssh-test-server.sh).
import { appendFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { serveDist } from './serve-dist.mjs';

const need = (name, value) => {
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
const relayUrl = need('RELAY_URL', process.env.RELAY_URL);
const relayToken = need('RELAY_TOKEN', process.env.RELAY_TOKEN);
const sshUser = need('SSH_USER', process.env.SSH_USER);
const authorizedKeys = need('MD_RUNBOOK_SSH_AUTHORIZED_KEYS', process.env.MD_RUNBOOK_SSH_AUTHORIZED_KEYS);
const { server, url } = await serveDist(process.argv[2] ?? 'dist', Number(process.env.WEB_PORT ?? 8081));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
let failed = false;
try {
  await page.goto(url);
  await page.getByTestId('hosts').click();
  const key = page.getByTestId('app-public-key');
  await key.filter({ hasText: /^ecdsa-sha2-nistp256 / }).waitFor({ timeout: 30_000 });
  appendFileSync(authorizedKeys, (await key.innerText()).trim() + '\n');

  await page.getByTestId('relay-url').fill(relayUrl);
  await page.getByTestId('relay-token').fill(relayToken);
  await page.getByTestId('relay-save').click();
  await page.getByText('Relay saved').waitFor({ timeout: 10_000 });

  await page.getByTestId('add-host').click();
  await page.getByTestId('host-name').fill('ci');
  await page.getByTestId('host-hostname').fill('127.0.0.1');
  await page.getByTestId('host-port').fill('2222');
  await page.getByTestId('host-username').fill(sshUser);
  await page.getByTestId('host-save').click();
  await page.getByTestId('add-host').waitFor({ timeout: 10_000 });
  await page.screenshot({ path: 'web-run-01-hosts.png' });

  await page.goto(url);
  await page.getByTestId('runbook-sample').click();
  await page.getByTestId('cell-1-run').click();
  await page.getByTestId('trust-accept').waitFor({ timeout: 60_000 });
  await page
    .getByTestId('trust-fingerprint')
    .filter({ hasText: /^SHA256:/ })
    .waitFor();
  await page.getByTestId('trust-accept').click();
  const output = page.getByTestId('cell-1-output');
  await output.filter({ hasText: /Output · ✓ exit 0 .*just now/ }).waitFor({ timeout: 60_000 });
  await output.filter({ hasText: /load average/ }).waitFor();
  await page.screenshot({ path: 'web-run-02-ran.png' });

  await page.getByTestId('cell-1-line-0').click();
  await page.getByTestId('cell-1-line-0-run').click();
  await output.filter({ hasText: /✓ exit 0 · lines 1 / }).waitFor({ timeout: 60_000 });
  await output.filter({ hasText: /\$ uptime/ }).waitFor();
  await page.screenshot({ path: 'web-run-03-line.png' });
  console.log('web run: a cell and a line ran over SSH through the relay');
} catch (e) {
  failed = true;
  console.error(e);
  await page.screenshot({ path: 'web-run-failure.png' }).catch(() => undefined);
}
if (errors.length) {
  failed = true;
  console.error('console errors:\n' + errors.join('\n'));
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
