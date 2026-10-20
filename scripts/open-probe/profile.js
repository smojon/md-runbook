// Like probe.js, but records a CPU profile of the window (renderer) from launch until the cells
// show or 60 s pass. Stops after the first slow open (cells later than SLOW ms after the webview).
//   node profile.js <repo> <outDir> <Code.exe> <maxRuns>
const { _electron } = require('playwright-core');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const [repo, out, exe, maxArg] = process.argv.slice(2);
const SLOW = 15000;
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r('TIMEOUT'), ms))]);

async function once(i) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const t0 = Date.now();
  const at = () => Date.now() - t0;
  const events = [];
  const log = (e) => events.push(`${String(at()).padStart(6)} ${e}`);
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
  let slow = false;
  try {
    const win = await app.firstWindow();
    const cdp = await win.context().newCDPSession(win);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 2000 });
    await cdp.send('Profiler.start');
    log('profiling');
    for (let s = 0; s < 60; s++) {
      const st = await withTimeout(
        win.evaluate(() => ({
          webview: document.querySelectorAll('.notebook-editor .webview').length,
          lines: [...document.querySelectorAll('.notebook-editor .view-line')].filter((l) => l.textContent.includes('kubectl')).length,
        })),
        3000,
      );
      if (st === 'TIMEOUT') log('window not answering');
      else {
        if (st.webview && webviewAt === undefined) webviewAt = at();
        if (st.lines) {
          cellsAt = at();
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    slow = cellsAt === undefined || cellsAt - (webviewAt ?? 0) > SLOW;
    log(`webview ${webviewAt} cells ${cellsAt}`);
    const res = await withTimeout(cdp.send('Profiler.stop'), 30000);
    if (res === 'TIMEOUT') log('Profiler.stop timed out');
    else if (slow) fs.writeFileSync(path.join(out, `slow${i}.cpuprofile`), JSON.stringify(res.profile));
    else fs.writeFileSync(path.join(out, `ok${i}.cpuprofile`), JSON.stringify(res.profile));
  } catch (e) {
    log(`error ${String(e).slice(0, 300)}`);
  } finally {
    await withTimeout(app.close(), 10000);
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {}
  }
  fs.writeFileSync(path.join(out, `events${i}.txt`), events.join('\n') + '\n');
  console.log(`run ${i}: webview ${webviewAt} cells ${cellsAt ?? 'never'}${slow ? ' SLOW' : ''}`);
  return slow;
}

(async () => {
  for (let i = 1; i <= Number(maxArg || 6); i++) if (await once(i)) break;
})();
