// Records the README demo: opens a demo runbook as a notebook in a throwaway VS Code with the dev
// build and the Steps view on the left, clicks Run All (the steps tick off, a check passes on the
// second attempt), saves, opens the file as plain Markdown, selects the first saved output block,
// and writes a screenshot every ~250 ms to <outDir>/frames (frames.json has the timestamps).
// Then make_gif.py builds the GIF. Needs playwright-core (npm install it outside the repo and point
// NODE_PATH at its node_modules), a compiled build (npm run compile) and Windows: the demo blocks
// are PowerShell. Usage:
//   node record.js <repo> <outDir> <Code.exe>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { launch, sleep } = require('./vscode');

const [repo, out, exe] = process.argv.slice(2);
const work = path.join(out, 'work');
const framesDir = path.join(out, 'frames');
for (const d of [work, framesDir]) fs.rmSync(d, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(framesDir, { recursive: true });
fs.rmSync(path.join(os.tmpdir(), 'md-runbook-gif'), { force: true });
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
    '$f = "$env:TEMP\\md-runbook-gif"',
    '$n = [int](Get-Content $f -EA 0) + 1; Set-Content $f $n',
    'if ($n -lt 2) { "Waiting for rollout: 0 of 1 ready"; exit 1 }',
    'Remove-Item $f; \'deployment "checkout" successfully rolled out\'',
    '```',
    '',
  ].join('\n'),
);

(async () => {
  const { win, close } = await launch({
    repo,
    out,
    exe,
    file: runbook,
    width: 1000,
    height: 940,
    // Run All starts right away (no launch form for NAMESPACE: its default is used).
    settings: { 'mdRunbook.execution.launchForm': false },
    keybindings: [
      { key: 'ctrl+alt+shift+j', command: 'mdRunbook.showSteps' },
      { key: 'ctrl+alt+shift+k', command: 'workbench.action.focusActiveEditorGroup' },
      { key: 'ctrl+alt+shift+n', command: 'notifications.toggleDoNotDisturbMode' },
    ],
  });
  const frames = [];
  let recording = false;
  let loop;
  try {
    // The Steps view on the left from the first frame (the Library collapsed), the notebook
    // focused, and Do Not Disturb on: the text view's "looks like a runbook" offer stays hidden.
    await win.keyboard.press('Control+Alt+Shift+J');
    await win.locator('.pane-header', { hasText: 'Steps' }).first().waitFor({ timeout: 15_000 }).catch(() => console.error('Steps view header not seen'));
    await sleep(1000);
    const library = win.locator('.pane-header', { hasText: 'Library' }).first();
    if ((await library.getAttribute('aria-expanded').catch(() => null)) === 'true') await library.click();
    await win.keyboard.press('Control+Alt+Shift+N');
    await sleep(500);
    await win.keyboard.press('Control+Alt+Shift+K');
    await sleep(500);
    await win.screenshot({ path: path.join(out, 'setup.png') });
    // The Steps view says who ran the runbook ("Last ran green: just now (by <login>)"): the
    // recording machine's login name shows as "ops" instead. A MutationObserver in each webview
    // frame rewrites the text before it's painted. Installed again before each screenshot, for a
    // frame the webview made since; a frame that still showed the name is reported.
    const login = os.userInfo().username;
    const mask = async () => {
      let shown = false;
      for (const frame of win.frames()) {
        shown =
          (await frame
            .evaluate((login) => {
              const re = new RegExp(`\\(by ${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'g');
              const seen = re.test(document.documentElement?.textContent ?? '');
              if (!window.__demoMask) {
                window.__demoMask = true;
                const fix = () => {
                  const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
                  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes(`(by ${login})`)) n.data = n.data.replace(re, '(by ops)');
                };
                fix();
                new MutationObserver(fix).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
              }
              return seen;
            }, login)
            .catch(() => false)) || shown;
      }
      return shown;
    };
    await mask();
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
        if (await mask()) console.error(`${file}: the login name was on screen before it was masked`);
        await win.screenshot({ path: path.join(framesDir, file) });
        frames.push({ file, t: t - t0 });
        await sleep(Math.max(0, 250 - (Date.now() - t)));
      }
    })();

    await sleep(2500); // the runbook and its steps, before anything runs
    const runAll = win.locator('.notebook-toolbar-container a.action-label[aria-label^="Run All"]').first();
    const rb = await runAll.boundingBox();
    if (!rb) throw new Error('Run All button not found');
    await clickAt(rb.x + rb.width / 2, rb.y + rb.height / 2);
    // The empty activity bar: no tooltip, no cell hover bar; not on the Steps webview, where the
    // side bar's sash would stay highlighted (it doesn't see the pointer leave).
    await moveTo(24, 600, 800);
    // Polled with evaluate: waitForFunction failed at once here (VS Code's CSP blocks eval, it seems).
    const until = async (what, fn) => {
      const end = Date.now() + 40_000;
      while (Date.now() < end) {
        if (await win.evaluate(fn).catch(() => false)) return;
        await sleep(150);
      }
      console.error(`not seen: ${what}`);
    };
    // The notebook scrolls to the running cell by itself (progress.ts). Done when the toolbar has
    // Run All again (Stop Execution while running).
    await until('run finished', () => !!document.querySelector('.notebook-toolbar-container a.action-label[aria-label^="Run All"]'));
    await sleep(3000);

    // Save, then show the same file as plain Markdown and select the first saved output block:
    // the output is in the file.
    await win.keyboard.press('Control+S');
    await sleep(400);
    await win.keyboard.press('Control+Alt+Shift+M');
    await win.locator('.monaco-editor .view-line', { hasText: 'md-runbook:output start' }).first().waitFor({ timeout: 15_000 });
    await sleep(300);
    // Monaco reuses line elements, so DOM order isn't screen order: take the topmost start line
    // and the first end line below it.
    const topmost = async (text, below) => {
      const boxes = [];
      for (const l of await win.locator('.monaco-editor .view-line', { hasText: text }).all()) {
        const b = await l.boundingBox();
        if (b && b.y > below) boxes.push({ l, b });
      }
      boxes.sort((a, b) => a.b.y - b.b.y);
      return boxes[0];
    };
    const { b: sb } = await topmost('md-runbook:output start', -1);
    const { l: endLine, b: eb } = await topmost('md-runbook:output end', sb.y);
    const endText = await endLine.textContent();
    // The end of the "output end" line: measure its text rather than the (full-width) line box.
    const endX = await endLine.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      return r.getBoundingClientRect().right;
    });
    await moveTo(sb.x + 2, sb.y + sb.height / 2, 400);
    await win.mouse.down();
    await moveTo(endX, eb.y + eb.height / 2, 700);
    await win.mouse.up();
    await moveTo(endX + 120, eb.y + eb.height + 60, 250); // off the text, so the selection reads
    console.log(`selected through: ${endText.trim()}`);
    await sleep(300); // make_gif.py holds the last frame
    recording = false;
    await loop;
    fs.writeFileSync(path.join(out, 'frames.json'), JSON.stringify(frames, null, 1));
    fs.copyFileSync(runbook, path.join(out, 'saved.md'));
    console.log(`ok ${frames.length} frames over ${frames.at(-1).t} ms`);
  } finally {
    recording = false;
    await close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
