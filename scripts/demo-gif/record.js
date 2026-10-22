// Records the README demo: opens a demo runbook as a notebook in a throwaway VS Code with the dev
// build, clicks Run All, saves, opens the file as plain Markdown, selects the first saved output
// block, and writes a screenshot every ~250 ms to <outDir>/frames (frames.json has the timestamps).
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
    '$f = "$env:TEMP\\md-runbook-gif"; $n = [int](Get-Content $f -EA 0) + 1; Set-Content $f $n',
    'if ($n -lt 3) { "Waiting for rollout: 0 of 1 replicas available..."; exit 1 }',
    'Remove-Item $f; \'deployment "checkout" successfully rolled out\'',
    '```',
    '',
  ].join('\n'),
);

(async () => {
  const { win, close } = await launch({ repo, out, exe, file: runbook, width: 1000, height: 940 });
  const frames = [];
  let recording = false;
  let loop;
  try {
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
