// Alternates opens with and without Chromium's --disable-renderer-backgrounding; per open records
// when the webview and the cells appeared, when the Markdown renderer file loaded, and which
// process ids are the window and the other renderers (for sampler.ps1's priority log).
//   node exp.js <repo> <outDir> <Code.exe> <pairs>
const { _electron } = require('playwright-core');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [repo, out, exe, pairsArg] = process.argv.slice(2);
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);
const results = [];

async function once(label, extra) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const app = await _electron.launch({
    executablePath: exe,
    env,
    args: [
      path.join(out, 'work'),
      path.join(out, 'work', 'restart-web.ipynb'),
      '--disable-extensions',
      `--user-data-dir=${path.join(out, 'ud')}`,
      `--extensions-dir=${path.join(out, 'ext')}`,
      '--disable-workspace-trust',
      '--skip-release-notes',
      '--skip-welcome',
      '--disable-telemetry',
      ...extra,
    ],
  });
  const pid = app.process().pid;
  const r = { label, start: new Date(t0).toISOString() };
  try {
    const win = await app.firstWindow();
    for (let s = 0; s < 75; s++) {
      const st = await withTimeout(
        win.evaluate(() => ({
          webview: document.querySelectorAll('.notebook-editor .webview').length,
          lines: [...document.querySelectorAll('.notebook-editor .view-line')].filter((l) => l.textContent.includes('kubectl')).length,
        })),
        3000,
      );
      if (st !== 'TIMEOUT') {
        if (st.webview && r.webview === undefined) r.webview = at();
        if (st.lines) {
          r.cells = at();
          break;
        }
      }
      if (s === 8) {
        // Process ids while the notebook is opening: the window, and every other renderer.
        r.windowPid = await withTimeout(app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()), 3000);
        try {
          r.renderers = execSync(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='Code.exe'\\" | Where-Object { $_.CommandLine -like '*vscode-test*' -and $_.CommandLine -like '*--type=renderer*' } | ForEach-Object { $_.ProcessId }"`,
            { encoding: 'utf8', timeout: 20000 },
          ).trim().split(/\s+/).map(Number);
        } catch {}
      }
      await new Promise((res) => setTimeout(res, 1000));
    }
    for (const f of win.frames()) {
      if (!f.url().includes('fake.html')) continue;
      const md = await withTimeout(
        f.evaluate(() => {
          const e = performance.getEntriesByType('resource').find((x) => x.name.includes('markdown-language-features/notebook-out'));
          const next = performance.getEntriesByType('resource').find((x) => x.name.includes('markdown-math'));
          return { origin: performance.timeOrigin, mdStart: e?.startTime, mdDur: e?.duration, nextStart: next?.startTime };
        }),
        5000,
      );
      if (md !== 'TIMEOUT' && md.mdStart !== undefined) {
        const base = md.origin - t0;
        r.mdStart = Math.round(base + md.mdStart);
        r.mdLoad = Math.round(md.mdDur);
        r.nextRequest = md.nextStart !== undefined ? Math.round(base + md.nextStart) : undefined;
      }
    }
  } catch (e) {
    r.error = String(e).slice(0, 200);
  } finally {
    await withTimeout(app.close(), 10000);
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {}
  }
  r.wait = r.cells !== undefined && r.webview !== undefined ? r.cells - r.webview : 'never';
  results.push(r);
  console.log(JSON.stringify(r));
  fs.writeFileSync(path.join(out, 'exp.json'), JSON.stringify(results, null, 2));
}

(async () => {
  for (let k = 0; k < Number(pairsArg || 5); k++) {
    await once('ipynb-control', []);
    await once('ipynb-no-backgrounding', ['--disable-renderer-backgrounding']);
  }
})();
