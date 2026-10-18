/**
 * PDF export: the HTML report printed by a Chromium-based browser that is already installed
 * (Chrome, Edge, Chromium), in headless mode with a throwaway profile. No browser is bundled.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { nodeShellEnv } from '../core';
import type { ShellEnv } from '../core';

/** Where to look for a browser, in order: an explicit path, then the usual install locations. */
export function browserCandidates(env: ShellEnv): string[] {
  const e = env.env;
  if (env.platform === 'win32') {
    const roots = [e.ProgramFiles, e['ProgramFiles(x86)'], e.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.flatMap((r) => [
      path.win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.win32.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.win32.join(r, 'Chromium', 'Application', 'chrome.exe'),
    ]);
  }
  if (env.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']
    .map((c) => env.which(c))
    .filter((c): c is string => c !== undefined);
}

/** The browser to print with: `explicit` (--browser or CHROME_PATH) if given, else the first found. */
export function findBrowser(explicit: string | undefined, env: ShellEnv = nodeShellEnv()): string | undefined {
  if (explicit) return explicit;
  return browserCandidates(env).find((c) => env.exists(c));
}

/** Print `html` to `outFile` with the browser at `browser`. Rejects with a readable message. */
export async function htmlToPdf(html: string, outFile: string, browser: string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-runbook-pdf-'));
  const page = path.join(dir, 'report.html');
  const out = path.resolve(outFile);
  fs.writeFileSync(page, html, 'utf8');
  try {
    fs.rmSync(out, { force: true });
    const args = [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      // Its own profile, so a browser that is already open is never reused or changed.
      `--user-data-dir=${path.join(dir, 'profile')}`,
      // Chromium refuses to start as root (containers) unless its sandbox is off.
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      '--no-pdf-header-footer',
      `--print-to-pdf=${out}`,
      pathToFileURL(page).href,
    ];
    await new Promise<void>((resolve, reject) => {
      execFile(browser, args, { timeout: 120_000, windowsHide: true }, (err, _stdout, stderr) => {
        if (fs.existsSync(out) && fs.statSync(out).size > 0) return resolve();
        reject(new Error(`${path.basename(browser)} did not write the PDF${err ? `: ${err.message}` : ''}${stderr.trim() ? `\n${stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`));
      });
    });
  } finally {
    fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }, () => undefined);
  }
}
