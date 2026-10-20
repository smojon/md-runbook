// Like probe.js; once the cells show (or after 60 s), dumps every frame's resource timings (the
// back-layer webview's scripts: markdown-it renderer, its extensions, preloads) on one timeline
// relative to the launch. Stops after the first open whose cells come > SLOW ms after the webview.
//   node frames.js <repo> <outDir> <Code.exe> <maxRuns>
const { _electron } = require('playwright-core');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [repo, out, exe, maxArg] = process.argv.slice(2);
const SLOW = 8000;
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);

async function once(i) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const lines = [];
  const app = await _electron.launch({
    executablePath: exe,
    env,
    args: [
      path.join(out, 'work'),
      path.join(out, 'work', 'restart-web.md'),
      `--extensionDevelopmentPath=${repo}`,
      `--user-data-dir=${path.join(out, 'ud')}`,
      `--extensions-dir=${path.join(out, 'ext')}`,
      '--disable-workspace-trust',
      '--skip-release-notes',
      '--skip-welcome',
      '--disable-telemetry',
    ],
  });
  const pid = app.process().pid;
  let webviewAt;
  let cellsAt;
  try {
    const win = await app.firstWindow();
    for (let s = 0; s < 60; s++) {
      const st = await withTimeout(
        win.evaluate(() => ({
          webview: document.querySelectorAll('.notebook-editor .webview').length,
          lines: [...document.querySelectorAll('.notebook-editor .view-line')].filter((l) => l.textContent.includes('kubectl')).length,
        })),
        3000,
      );
      if (st !== 'TIMEOUT') {
        if (st.webview && webviewAt === undefined) webviewAt = at();
        if (st.lines) {
          cellsAt = at();
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    lines.push(`webview at ${webviewAt} ms, cells at ${cellsAt ?? 'never'} ms (from launch)`);
    for (const f of win.frames()) {
      const r = await withTimeout(
        f.evaluate(() => ({
          origin: performance.timeOrigin,
          res: performance.getEntriesByType('resource').map((e) => ({ n: e.name, s: Math.round(e.startTime), d: Math.round(e.duration), rs: Math.round(e.responseStart), sz: e.transferSize || e.decodedBodySize || 0 })),
          marks: performance.getEntriesByType('mark').map((m) => ({ n: m.name, s: Math.round(m.startTime) })),
        })),
        5000,
      ).catch((e) => `ERR ${e}`);
      lines.push(`\n## frame ${f.url().slice(0, 140)}`);
      if (typeof r === 'string') {
        lines.push(`  ${r}`);
        continue;
      }
      const base = r.origin - t0; // frame origin relative to launch
      lines.push(`  frame created at ${Math.round(base)} ms`);
      for (const e of r.res.filter((e) => e.d > 50 || /renderer|markdown|mermaid|katex|webview\/index|preload|notebook-out|index\.js/i.test(e.n)).slice(0, 80)) {
        lines.push(`  ${String(Math.round(base + e.s)).padStart(6)} +${String(e.d).padStart(6)} ms  ${e.n.replace(/^.*?(extensions\/|md-runbook\/|resources\/app\/)/, '$1').slice(0, 130)}`);
      }
      for (const m of r.marks.slice(0, 40)) lines.push(`  mark ${String(Math.round(base + m.s)).padStart(6)} ${m.n}`);
    }
  } catch (e) {
    lines.push(`error ${String(e).slice(0, 300)}`);
  } finally {
    await withTimeout(app.close(), 10000);
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {}
  }
  const slow = cellsAt === undefined || cellsAt - (webviewAt ?? 0) > SLOW;
  fs.writeFileSync(path.join(out, `${slow ? 'frames-slow' : 'frames-ok'}${i}.txt`), lines.join('\n') + '\n');
  console.log(`run ${i}: webview ${webviewAt} cells ${cellsAt ?? 'never'}${slow ? ' SLOW' : ''}`);
  return slow;
}

(async () => {
  for (let i = 1; i <= Number(maxArg || 8); i++) if (await once(i)) break;
})();
