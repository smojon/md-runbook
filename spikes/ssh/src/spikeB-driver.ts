/**
 * Spike step B driver (Node): opens the browser page in headless Chrome (puppeteer-core with
 * the Chrome installed on the machine) and reports what the page found.
 *
 * Environment: as spike A, plus RELAY_URL (ws://127.0.0.1:8022/ssh), RELAY_TOKEN,
 * RELAY_TARGET (host:port as the relay sees it), CHROME_PATH.
 */

import * as fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
};

async function main(): Promise<void> {
  const settings = {
    relay: env('RELAY_URL'),
    token: env('RELAY_TOKEN'),
    target: env('RELAY_TARGET'),
    user: env('SSH_USER'),
    keyPem: fs.readFileSync(env('SSH_KEY_FILE'), 'utf8'),
    pinned: fs.readFileSync(env('SSH_HOST_PUB'), 'utf8').trim().split(/\s+/).slice(0, 2).join(' '),
  };
  const browser = await puppeteer.launch({ executablePath: env('CHROME_PATH'), headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => console.log(`[page] ${m.text()}`));
    page.on('pageerror', (e) => console.log(`[page error] ${String(e)}`));
    const httpUrl = settings.relay.replace(/^ws/, 'http').replace(/\/ssh$/, '/');
    await page.goto(`${httpUrl}#${encodeURIComponent(JSON.stringify(settings))}`);
    await page.waitForFunction(() => window.__result !== undefined, { timeout: 60_000 });
    const result = (await page.evaluate(() => window.__result)) as { ok: boolean; lines: string[] };
    for (const l of result.lines) console.log(l);
    console.log(result.ok ? '\n✓ spike B passed' : '\n✗ spike B failed');
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error('✗ spike B crashed:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
