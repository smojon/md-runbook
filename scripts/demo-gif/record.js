// Records the README demo: opens a demo runbook as a notebook in a throwaway VS Code with the dev
// build, clicks Run All, saves, reopens the file as plain Markdown, and writes a screenshot every
// ~250 ms to <outDir>/frames (frames.json has the timestamps). Then make_gif.py builds the GIF.
// Needs playwright-core (npm install it outside the repo and run from there), a compiled build
// (npm run compile) and Windows: the demo blocks are PowerShell. Usage:
//   node record.js <repo> <outDir> <Code.exe>
const { _electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [repo, out, exe] = process.argv.slice(2);
const work = path.join(out, 'work');
const ud = path.join(out, 'ud');
const framesDir = path.join(out, 'frames');
for (const d of [work, framesDir]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(framesDir, { recursive: true });
fs.mkdirSync(path.join(ud, 'User'), { recursive: true });
fs.rmSync(path.join(os.tmpdir(), 'md-runbook-gif'), { force: true });
fs.writeFileSync(
  path.join(ud, 'User', 'settings.json'),
  JSON.stringify(
    {
      'workbench.editorAssociations': { '*.md': 'md-runbook' },
      'workbench.startupEditor': 'none',
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.welcomePage.walkthroughs.openOnInstall': false,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'workbench.tips.enabled': false,
      'security.workspace.trust.enabled': false,
      'window.restoreWindows': 'none',
      'window.commandCenter': false,
      'chat.disableAIFeatures': true,
      'editor.minimap.enabled': false,
      'breadcrumbs.enabled': false,
      'notebook.globalToolbar': true,
      'mdRunbook.params.useDefaults': true,
      'update.mode': 'none',
      'extensions.autoCheckUpdates': false,
    },
    null,
    2,
  ),
);
const runbook = path.join(work, 'restart-checkout.md');
fs.writeFileSync(
  runbook,
  [
    '---',
    'params:',
    '  - NAMESPACE: shop-prod',
    '---',
    '',
    '# Restart the checkout service',
    '',
    '## 1. Find the pod',
    '',
    '```powershell capture="POD:/^(checkout-\\S+)/m" expect="Running"',
    '"NAME                       READY  STATUS   AGE"',
    '"checkout-7c9d5b6f4-x2kqp   1/1    Running  3d4h"',
    '"payments-5d8f7c9b8-9hjtw   1/1    Running  3d4h"',
    '```',
    '',
    '## 2. Restart it',
    '',
    '```powershell',
    '"deployment.apps/checkout restarted in ${param:NAMESPACE}"',
    '"pod ${out:POD} terminated"',
    '```',
    '',
    '## 3. Wait until it is ready',
    '',
    '```powershell retry=5 every=1s expect="successfully rolled out"',
    '$f = "$env:TEMP\\md-runbook-gif"; $n = [int](Get-Content $f -EA 0) + 1; Set-Content $f $n',
    'if ($n -lt 3) { "Waiting for rollout: 0 of 1 replicas available..."; exit 1 }',
    'Remove-Item $f; \'deployment "checkout" successfully rolled out\'',
    '```',
    '',
  ].join('\n'),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({
    executablePath: exe,
    env,
    args: [
      runbook,
      `--extensionDevelopmentPath=${repo}`,
      `--user-data-dir=${ud}`,
      `--extensions-dir=${path.join(out, 'ext')}`,
      '--disable-workspace-trust',
      '--skip-release-notes',
      '--skip-welcome',
      '--disable-telemetry',
      '--disable-renderer-backgrounding',
    ],
  });
  const frames = [];
  let recording = false;
  let loop;
  try {
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setSize(1000, 940);
      w.center();
    });
    const shot = (name) => win.screenshot({ path: path.join(out, name) });
    const cell = win.locator('.cell-list-container .code-cell-row').first();
    await cell.waitFor({ timeout: 90_000 }).catch(async (e) => { await shot('debug.png'); throw e; });
    await sleep(4000); // extension activation, kernel, first render

    // A visible pointer: Playwright moves the real mouse, but screenshots don't show it.
    await win.evaluate(() => {
      const c = document.createElement('div');
      c.id = 'demo-cursor';
      // VS Code enforces Trusted Types, so no innerHTML.
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      for (const [k, v] of Object.entries({ width: 22, height: 30, viewBox: '0 0 22 30' })) svg.setAttribute(k, v);
      const p = document.createElementNS(ns, 'path');
      const attrs = { d: 'M2 2 L2 24 L8 18 L12 28 L16 26 L12 17 L20 17 Z', fill: 'white', stroke: 'black', 'stroke-width': 1.5, 'stroke-linejoin': 'round' };
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
      svg.appendChild(p);
      c.appendChild(svg);
      Object.assign(c.style, { position: 'fixed', left: '700px', top: '420px', zIndex: 2147483647, pointerEvents: 'none', transition: 'none' });
      document.body.appendChild(c);
    });
    let at = { x: 700, y: 420 };
    const moveTo = async (x, y, ms = 700) => {
      const steps = Math.max(1, Math.round(ms / 40));
      const from = at;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const p = { x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e };
        await win.mouse.move(p.x, p.y);
        await win.evaluate(({ x, y }) => {
          const c = document.getElementById('demo-cursor');
          c.style.left = `${x}px`;
          c.style.top = `${y}px`;
        }, p);
        await sleep(40);
      }
      at = { x, y };
    };
    const clickAt = async (x, y) => {
      await moveTo(x, y);
      await sleep(250);
      await win.mouse.down();
      await sleep(80);
      await win.mouse.up();
    };

    recording = true;
    const t0 = Date.now();
    loop = (async () => {
      while (recording) {
        const t = Date.now();
        const file = `f${String(frames.length).padStart(4, '0')}.png`;
        await win.screenshot({ path: path.join(framesDir, file) });
        frames.push({ file, t: t - t0 });
        await sleep(Math.max(0, 250 - (Date.now() - t)));
      }
    })();

    await sleep(1500);
    const runAll = win.locator('.notebook-toolbar-container a.action-label[aria-label^="Run All"]').first();
    const rb = await runAll.boundingBox();
    if (!rb) throw new Error('Run All button not found');
    await clickAt(rb.x + rb.width / 2, rb.y + rb.height / 2);
    await moveTo(760, 600, 600); // off the toolbar, so its tooltip goes away
    // The progress item in the status bar counts finished cells: 0/3 … 3/3.
    const progress = (n) =>
      win
        .waitForFunction((n) => (document.querySelector('.part.statusbar')?.textContent ?? '').includes(`${n}/3`), n, { timeout: 30_000 })
        .catch(() => console.error(`progress ${n}/3 not seen`));
    await progress(2);
    await sleep(400);
    // Scroll so cell 3 and its retries are on screen.
    for (let i = 0; i < 6; i++) {
      await win.mouse.wheel(0, 30);
      await sleep(40);
    }
    await progress(3);
    await sleep(2500);

    // Save, then show the same file as plain Markdown: the output is in the file.
    await win.keyboard.press('Control+S');
    await sleep(800);
    await win.keyboard.press('F1');
    await sleep(300);
    await win.keyboard.type('Reopen Editor With Text Editor', { delay: 25 });
    await sleep(500);
    await win.keyboard.press('Enter');
    await moveTo(940, 880, 500);
    await win.locator('.monaco-editor .view-line', { hasText: 'md-runbook:output start' }).first().waitFor({ timeout: 15_000 }).catch(() => {});
    await sleep(4000);
    recording = false;
    await loop;
    fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify(frames, null, 1));
    fs.copyFileSync(runbook, path.join(out, 'saved.md'));
    console.log(`ok ${frames.length} frames over ${frames.at(-1).t} ms`);
  } finally {
    recording = false;
    const pid = app.process().pid;
    await Promise.race([app.close(), sleep(10_000)]);
    try { require('child_process').execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' }); } catch {}
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
